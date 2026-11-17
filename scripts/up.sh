#!/usr/bin/env bash
# jarvis-meeting up — start the local pilot stack together:
#   1. your second-brain CONNECTOR (optional auto-start via $CONNECTOR_CMD)
#   2. the jarvis-meeting SERVICE (Hono, :8790)
#   3. an ngrok tunnel so Recall can reach the agent-frame page + webhook
#
# Mirrors openbrain's scripts/start-dashboard.sh: idempotent (skips anything
# already listening), nohup + disown, polls /healthz, ASCII-light status lines.
#
# Secrets come from .env.local (RECALL_API_KEY, a realtime provider key, etc.) —
# this script never inlines key values. Keep secrets OUT of CONNECTOR_CMD: the connector
# inherits the exported .env.local variables (for example KB_SERVER_TOKEN). See docs/PLAYBOOK.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # agents/jarvis-meeting
cd "$HERE"

LOGS="${JARVIS_LOGS:-$HOME/Library/Logs/jarvis-meeting}"
mkdir -p "$LOGS"

# Load .env.local (exported so child processes inherit it).
if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi

PORT="${PORT:-8790}"
CONNECTOR_PORT="${CONNECTOR_PORT:-7411}"

# --- 1. connector -----------------------------------------------------------
if [ -n "${CONNECTOR_CMD:-}" ]; then
  if lsof -nP -iTCP:"${CONNECTOR_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "OK connector already on :${CONNECTOR_PORT}"
  else
    # Do not echo CONNECTOR_CMD: it can carry paths and, if someone ignored the warning, a secret.
    echo ">> starting connector on :${CONNECTOR_PORT}"
    nohup bash -c "${CONNECTOR_CMD}" > "$LOGS/connector.log" 2>&1 &
    disown
    for _ in $(seq 1 30); do
      curl -sf "http://127.0.0.1:${CONNECTOR_PORT}/healthz" >/dev/null 2>&1 && break
      sleep 1
    done
  fi
else
  echo "-- CONNECTOR_CMD unset; assuming your connector is already on :${CONNECTOR_PORT}"
fi
if curl -sf "http://127.0.0.1:${CONNECTOR_PORT}/healthz" >/dev/null 2>&1; then
  echo "OK connector healthy :${CONNECTOR_PORT}"
else
  echo "!! connector not reachable on :${CONNECTOR_PORT} (the agent will degrade to empty results)"
fi

# --- 1b. per-teammate folder connectors -------------------------------------
# EXTRA_CONNECTORS is a comma-separated list of `port:kb_root` pairs, one
# folder-connector instance per teammate brain (matches each SOUL's
# knowledge_backend.endpoint), e.g.:
#   EXTRA_CONNECTORS="7412:$HOME/.jarvis-meeting/brains/morgan,7413:$HOME/.jarvis-meeting/brains/riley"
if [ -n "${EXTRA_CONNECTORS:-}" ]; then
  IFS=',' read -ra _pairs <<< "${EXTRA_CONNECTORS}"
  for _pair in "${_pairs[@]}"; do
    _port="${_pair%%:*}"
    _root="${_pair#*:}"
    if [ -z "$_port" ] || [ -z "$_root" ] || [ "$_port" = "$_root" ]; then
      echo "!! EXTRA_CONNECTORS entry '${_pair}' is not port:kb_root; skipping"
      continue
    fi
    if [ ! -d "$_root" ]; then
      echo "!! connector :${_port} KB_ROOT missing (${_root}); skipping"
      continue
    fi
    if lsof -nP -iTCP:"${_port}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "OK connector already on :${_port} (${_root})"
    else
      echo ">> starting folder-connector :${_port} (${_root})"
      nohup bash -c "cd '$HERE' && KB_RETRIEVAL_PORT='${_port}' KB_ROOT='${_root}' exec npx tsx src/connector/folder-connector.ts" \
        > "$LOGS/connector-${_port}.log" 2>&1 &
      disown
      for _ in $(seq 1 30); do
        curl -sf "http://127.0.0.1:${_port}/healthz" >/dev/null 2>&1 && break
        sleep 1
      done
    fi
    if curl -sf "http://127.0.0.1:${_port}/healthz" >/dev/null 2>&1; then
      echo "OK connector healthy :${_port}"
    else
      echo "!! connector :${_port} not reachable (that teammate's delegate degrades to empty results)"
    fi
  done
fi

# --- 2. ngrok + PUBLIC_BASE_URL --------------------------------------------
# Reserved domain: set PUBLIC_BASE_URL (or NGROK_DOMAIN) in .env.local.
# Otherwise an ephemeral tunnel is started and its URL is scraped from ngrok's
# local API. PUBLIC_BASE_URL must be known before the service boots.
NGROK_DOMAIN="${NGROK_DOMAIN:-}"
if [ -z "$NGROK_DOMAIN" ] && [ -n "${PUBLIC_BASE_URL:-}" ]; then
  NGROK_DOMAIN="$(printf '%s' "$PUBLIC_BASE_URL" | sed -E 's#^https?://##; s#/.*$##')"
fi

if pgrep -f "ngrok http" >/dev/null 2>&1; then
  # ngrok is already up. Free ngrok allows ONE tunnel — verify the running one
  # forwards to OUR port, not another stack's (e.g. the openbrain dashboard on
  # :3000). Otherwise the bot would render the wrong page. Run ONE meeting stack.
  fwd="$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | python3 -c 'import sys,json; print(",".join(str(t.get("config",{}).get("addr","")) for t in json.load(sys.stdin).get("tunnels",[])))' 2>/dev/null || true)"
  if printf '%s' "$fwd" | grep -q ":${PORT}\b"; then
    echo "OK ngrok already tunneling :${PORT}"
  else
    echo "xx an ngrok tunnel is already running but forwards to [${fwd:-unknown}], NOT :${PORT}."
    echo "   Free ngrok allows ONE tunnel. Stop the other stack's ngrok (e.g. the dashboard), then re-run."
    exit 1
  fi
else
  if [ -n "$NGROK_DOMAIN" ]; then
    echo ">> starting ngrok tunnel (reserved: ${NGROK_DOMAIN}) -> :${PORT}"
    nohup ngrok http --url="${NGROK_DOMAIN}" "${PORT}" --log=stdout > "$LOGS/ngrok.log" 2>&1 &
  else
    echo ">> starting ngrok tunnel (ephemeral) -> :${PORT}"
    nohup ngrok http "${PORT}" --log=stdout > "$LOGS/ngrok.log" 2>&1 &
  fi
  disown
  sleep 2
fi

if [ -z "${PUBLIC_BASE_URL:-}" ]; then
  for _ in $(seq 1 20); do
    PUBLIC_BASE_URL="$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | python3 -c 'import sys,json; ts=json.load(sys.stdin).get("tunnels",[]); print(next((t["public_url"] for t in ts if str(t.get("public_url","")).startswith("https")), ""))' 2>/dev/null || true)"
    [ -n "$PUBLIC_BASE_URL" ] && break
    sleep 1
  done
fi
if [ -z "${PUBLIC_BASE_URL:-}" ]; then
  echo "xx could not resolve a public URL; set PUBLIC_BASE_URL in .env.local or check $LOGS/ngrok.log"
  exit 1
fi
export PUBLIC_BASE_URL
echo "OK PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"

# --- 2b. agent-frame bundle freshness ---------------------------------------
# public/agent-frame.js is bundled from web/agent-frame/main.tsx (+ src/agent/**)
# by `npm run build:web` and is gitignored — nothing else keeps it in sync with
# source. Rebuild it here, before the service starts, so a fixed main.tsx is
# never served from a stale/absent bundle (see scripts/check-web-bundle.mjs).
if ! node scripts/check-web-bundle.mjs; then
  echo ">> agent-frame bundle stale — rebuilding (build:web)"
  if ! npm run build:web; then
    echo "xx build:web failed — refusing to start with a stale/absent agent-frame bundle" >&2
    exit 1
  fi
fi

# --- 3. jarvis-meeting service ---------------------------------------------
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "OK jarvis-meeting already on :${PORT}"
else
  echo ">> starting jarvis-meeting service on :${PORT}"
  nohup bash -c "cd '$HERE' && exec npx tsx src/index.ts" > "$LOGS/service.log" 2>&1 &
  disown
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "xx service failed to come up; last lines of $LOGS/service.log:"
  tail -20 "$LOGS/service.log" || true
  exit 1
fi
echo "OK service healthy :${PORT}"

# Verify the PUBLIC agent-frame loads clean to a browser — catch a tunnel
# interstitial (e.g. free ngrok's browser warning) that would block Recall's
# headless renderer. See lessons/2026-06-24-probe-public-url-as-a-browser-...
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
probe="$(curl -s -m8 -A "$UA" -H "Accept: text/html" "${PUBLIC_BASE_URL%/}/meetings/agent-frame/preflight" 2>/dev/null || true)"
if printf '%s' "$probe" | grep -qiE 'you are about to visit|ERR_NGROK|ngrok-free.*interstitial'; then
  echo "!! public agent-frame shows a tunnel interstitial to a standard browser UA."
  echo "   Recall's renderer MAY bypass it (non-standard UA), but if the bot loads blank, this is why."
  echo "   Fixes: set your ngrok authtoken + static domain, a paid ngrok plan, or a Cloudflare Tunnel. See docs/PLAYBOOK.md prereqs."
elif printf '%s' "$probe" | grep -qiE 'agent-frame|<div id="root"'; then
  echo "OK public agent-frame loads clean (no interstitial)"
else
  echo "-- could not verify the public agent-frame; open ${PUBLIC_BASE_URL} in a browser before dispatch"
fi

echo ""
echo "Service:   http://localhost:${PORT}"
echo "Public:    ${PUBLIC_BASE_URL}"
echo "Webhook:   ${PUBLIC_BASE_URL}/webhooks/recall"
echo "Dispatch:  curl -X POST ${PUBLIC_BASE_URL}/v1/dispatch \\"
echo "             -H \"Authorization: Bearer <OWNER_TOKEN or a JARVIS_TOKENS token>\" \\"
echo "             -d '{\"meeting_url\":\"<google-meet-or-zoom-url>\"}'"
echo "Logs:      ${LOGS}/"
