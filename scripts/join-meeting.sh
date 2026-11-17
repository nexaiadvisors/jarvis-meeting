#!/usr/bin/env bash
# join-meeting — the canonical way to put the agent into a meeting.
#
# WHY THIS EXISTS (lessons/2026-06-25-restart-meeting-service-for-fresh-state):
# the meeting registry is IN-MEMORY and ephemeral, and up.sh is IDEMPOTENT — it
# will NOT clear stale 'live' entries left by a kicked or never-started bot.
# Those stale entries count against the per-teammate concurrency cap and make the
# next dispatch fail with 429 CONCURRENCY_LIMIT. So a join must start from a
# FRESH control plane. This script:
#   1. ensures the stack is up (idempotent up.sh),
#   2. CHECKS freshness via /healthz liveCount; if anything is live it
#      RESTARTS the service to clear the in-memory registry (the connector and
#      ngrok keep running, and the reserved domain keeps the URL stable),
#   3. dispatches, and — as a backstop — on a 429 restarts and retries once.
#
# The restart is made RELIABLE: SIGTERM drains keep-alive connections behind an
# unref'd timeout, so the port can still be held after a blind sleep; up.sh would
# then see :PORT listening and skip the relaunch, silently preserving the stale
# registry. We instead kill by PORT, poll until the port is actually released,
# escalate to SIGKILL, and re-assert freshness after the restart.
#
# Usage:  scripts/join-meeting.sh <meeting_url> [soul]
#           soul defaults to the token's teammate (pass "david" for the
#           first-person delegate, "jarvis" for the team persona).
# Env:    JOIN_DRY_RUN=1   print what it WOULD do; create no bot, restart nothing.
#         OWNER_TOKEN      sent as the dispatch bearer when set (resolves to the
#                          default teammate); otherwise the first JARVIS_TOKENS secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

MEETING_URL="${1:-}"
SOUL="${2:-}"
if [ -z "$MEETING_URL" ]; then
  echo "usage: scripts/join-meeting.sh <meeting_url> [soul]" >&2
  exit 2
fi

PORT="${PORT:-8790}"
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
# Dispatch bearer: OWNER_TOKEN when set (config folds it into the token registry
# mapping to the default teammate), else the first JARVIS_TOKENS secret. Use the
# SOURCED env vars (quote-stripped by the dot-source above), not a re-grep of the
# raw file — a quoted value would otherwise yield a stray-quote token and a 401.
# JARVIS_TOKENS format is "token:teammate[,token2:teammate2]"; take the first
# token's secret. ${VAR:-} keeps it safe under `set -u`.
TOKEN="${OWNER_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="${JARVIS_TOKENS:-}"
  TOKEN="${TOKEN%%:*}"
fi
BASE="http://127.0.0.1:${PORT}"

json() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# Number of live meetings per /healthz (`liveCount`; the public endpoint no longer
# lists meeting ids). Robust to pipefail (a failed curl makes the pipeline non-zero
# even though python prints 0) and to a missing field: collapse to the last numeric
# line, default 0.
live_count() {
  local out
  out="$(curl -sf "${BASE}/healthz" 2>/dev/null | python3 -c 'import sys,json
try:
    print(int(json.load(sys.stdin).get("liveCount", 0)))
except Exception:
    print(0)' 2>/dev/null | tail -n1 | tr -dc '0-9' || true)"
  printf '%s' "${out:-0}"
}

ensure_up() {
  if ! curl -sf "${BASE}/healthz" >/dev/null 2>&1; then
    echo ">> stack not healthy on :${PORT} — starting via up.sh"
    bash scripts/up.sh >/dev/null 2>&1 || { echo "xx up.sh failed; run it manually" >&2; exit 1; }
  fi
}

# --- SOFT knowledge-backend preflight (Layer 2) --------------------------------
# The delegate soul's answers are grounded by an external knowledge backend (the
# OpenBrain kb-server, typically on :7401). If it is down at dispatch time, the
# delegate still answers — just UNGROUNDED. This preflight is entirely OPTIONAL
# and FAIL-OPEN: it NEVER exits non-zero and NEVER blocks a dispatch.
#
#   KB_BACKEND_HEALTH_URL   e.g. http://127.0.0.1:7401/healthz — if unset, this
#                           is a total no-op (unchanged behavior for existing users).
#   KB_BACKEND_ENSURE_CMD   optional shell command to start the backend when it is
#                           down. Started nohup/disown (like up.sh's connectors),
#                           then we poll KB_BACKEND_HEALTH_URL for up to ~20s.
#
# If still down after the wait (or if no ensure cmd is set), we print a loud
# WARNING and CONTINUE. Restart authority for the backend belongs to the OS-level
# supervisor; this is a best-effort nudge, not a supervisor.
ensure_kb_backend() {
  local health_url="${KB_BACKEND_HEALTH_URL:-}"
  [ -z "$health_url" ] && return 0   # unconfigured => no-op, no behavior change

  if curl -sf "$health_url" >/dev/null 2>&1; then
    echo "OK knowledge backend healthy (${health_url})"
    return 0
  fi

  local ensure_cmd="${KB_BACKEND_ENSURE_CMD:-}"
  if [ -z "$ensure_cmd" ]; then
    echo "!! knowledge backend DOWN (${health_url}) and no KB_BACKEND_ENSURE_CMD set."
    echo "!! Continuing anyway — delegate answers will be UNGROUNDED until it recovers."
    return 0
  fi

  if [ "${JOIN_DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] knowledge backend DOWN — would run KB_BACKEND_ENSURE_CMD and poll ${health_url}"
    return 0
  fi

  echo ">> knowledge backend DOWN — starting via KB_BACKEND_ENSURE_CMD"
  local kb_logs="${JARVIS_LOGS:-$HOME/Library/Logs/jarvis-meeting}"
  mkdir -p "$kb_logs" 2>/dev/null || true
  nohup bash -c "${ensure_cmd}" > "$kb_logs/kb-backend.log" 2>&1 &
  disown
  # Poll for up to ~20s (mirrors up.sh's connector wait-loop shape).
  for _ in $(seq 1 20); do
    curl -sf "$health_url" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf "$health_url" >/dev/null 2>&1; then
    echo "OK knowledge backend healthy after ensure (${health_url})"
  else
    echo "!! knowledge backend STILL DOWN after ensure + ~20s wait (${health_url})."
    echo "!! Continuing anyway — delegate answers will be UNGROUNDED until it recovers. See ${kb_logs}/kb-backend.log"
  fi
  return 0
}

# --- HARD agent-frame bundle preflight (never dispatch a stale bundle) --------
# public/agent-frame.js is bundled from web/agent-frame/main.tsx (+ src/agent/**)
# by `npm run build:web` and is gitignored — nothing else keeps it in sync with
# source. The service reads the bundle from disk per request, so rebuilding it
# here (no restart needed) is sufficient. Unlike the SOFT knowledge-backend
# check above, this one is fail-CLOSED: a stale bundle must never be dispatched
# to a live meeting.
ensure_web_bundle() {
  if node scripts/check-web-bundle.mjs >/dev/null 2>&1; then
    return 0
  fi

  echo ">> agent-frame bundle stale — rebuilding (build:web)"
  if [ "${JOIN_DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] would run: npm run build:web"
    return 0
  fi

  if ! npm run build:web; then
    echo "xx agent-frame bundle stale and rebuild failed — refusing to dispatch a stale bot" >&2
    exit 1
  fi
  echo "OK agent-frame bundle rebuilt"
}

port_held() { lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; }

restart_service() {
  echo ">> restarting jarvis-meeting service to clear the in-memory registry"
  # Kill whatever holds the port (process-chain agnostic) + the tsx patterns.
  local pids
  pids="$(lsof -ti tcp:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  pkill -f "jarvis-meeting.*tsx.*src/index.ts" 2>/dev/null || true
  # Wait for the port to ACTUALLY release — a blind sleep races SIGTERM drain.
  local freed=""
  for _ in $(seq 1 15); do
    if ! port_held; then freed=1; break; fi
    sleep 1
  done
  if [ -z "$freed" ]; then
    echo ">> :${PORT} still held after SIGTERM — escalating to SIGKILL"
    pids="$(lsof -ti tcp:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    pkill -9 -f "jarvis-meeting.*tsx.*src/index.ts" 2>/dev/null || true
    for _ in $(seq 1 10); do if ! port_held; then break; fi; sleep 1; done
  fi
  bash scripts/up.sh >/dev/null 2>&1 || { echo "xx up.sh failed after restart" >&2; exit 1; }
  # Catch a no-op restart: a fresh process MUST have an empty registry.
  local n
  n="$(live_count)"
  if [ "$n" != "0" ]; then
    echo "xx restart did not clear the registry (still ${n} live) — aborting the join" >&2
    exit 1
  fi
}

dispatch() {
  local body
  if [ -n "$SOUL" ]; then
    body="$(printf '{"meeting_url":%s,"soul":%s}' "$(json "$MEETING_URL")" "$(json "$SOUL")")"
  else
    body="$(printf '{"meeting_url":%s}' "$(json "$MEETING_URL")")"
  fi
  if [ "${JOIN_DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] would POST ${BASE}/v1/dispatch  body=${body}"
    echo "201" # pretend-success so the caller reports OK in dry-run
    return 0
  fi
  curl -sS -X POST "${BASE}/v1/dispatch" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "$body" -w $'\n%{http_code}' 2>/dev/null || true
}

# --- preflight: ensure a FRESH control plane before joining --------------------
ensure_up
# SOFT, fail-open knowledge-backend nudge (never blocks; no-op unless configured).
ensure_kb_backend
# HARD, fail-closed agent-frame bundle check — a stale bundle must never be dispatched.
ensure_web_bundle
n="$(live_count)"
if [ "$n" != "0" ]; then
  if [ "${JOIN_DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] control plane NOT fresh (${n} live) — would restart the service to clear it"
  else
    echo ">> control plane NOT fresh (${n} live meeting(s)) — restarting before join"
    restart_service
  fi
else
  echo "OK control plane is fresh (0 live meetings)"
fi

# --- dispatch (with a 429 restart-and-retry backstop) --------------------------
resp="$(dispatch)"
code="$(printf '%s' "$resp" | tail -n1)"
printf '%s\n' "$resp" | sed '$d'
if [ "$code" = "429" ]; then
  echo ">> dispatch hit the concurrency cap (429) — restarting + retrying once"
  restart_service
  resp="$(dispatch)"
  code="$(printf '%s' "$resp" | tail -n1)"
  printf '%s\n' "$resp" | sed '$d'
fi

if [ "$code" = "201" ]; then
  echo "OK joined (HTTP ${code})"
else
  echo "xx dispatch returned HTTP ${code:-<none>} — see output above" >&2
  exit 1
fi
