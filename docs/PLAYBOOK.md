# Teammate Playbook — fresh setup, end to end

This is an executable runbook for a teammate's coding agent (Cursor, Claude Code,
etc.). Follow it top to bottom to go from **nothing** to a meeting agent that
joins under **your own name**, answers from **your** second brain, and (after the
meeting) DMs you the transcript and ingests it back into your brain.

Everything runs **locally** (your brain + the service + ngrok). You implement no
code — `jarvis-meeting onboard` does the setup; you only fill in secret keys.

## 0. Prerequisites

- **Node 22** (`nvm use 22`).
- **A public HTTPS tunnel** to your local service so Recall can reach the
  agent-frame + webhook. **Recommended: a free ngrok account + its free static
  domain.** Sign up at ngrok.com, set your authtoken
  (`ngrok config add-authtoken <token>`), and use your assigned static domain
  (`https://<your-name>.ngrok-free.app`) as `PUBLIC_BASE_URL`. This is the tested
  setup, and it works with Recall's renderer. The static domain also gives you a
  stable URL across restarts (no ephemeral mismatch).
  - Note on the ngrok interstitial: ngrok's free tier *can* show a one-time
    browser warning on HTML traffic (it's per-endpoint + cookie-suppressed, and
    bypassed by a non-standard User-Agent or the `ngrok-skip-browser-warning`
    header — not tied to whether the domain is static). `up` probes the public
    agent-frame and warns if it sees one. If it actually blocks the bot on your
    account, bypass with a paid ngrok plan or a free **Cloudflare Tunnel**
    (`cloudflared`, no interstitial). An ephemeral ngrok URL also works (`up`
    resolves it), but the static domain is recommended.
- **Only the pgvector brain needs Postgres + `pgvector`.** The default bundled
  folder brain needs nothing (in-memory BM25).
- **Run ONE meeting stack at a time** — free ngrok allows a single tunnel, so
  don't run another agent's tunnel (e.g. a separate dashboard) alongside this one.
- Two shared secrets from the meeting-agent owner, out-of-band (reference BY NAME,
  never paste values into a tracked file):
  - `RECALL_API_KEY` (+ `RECALL_API_BASE` for the key's region, e.g. `us-west-2`)
  - a realtime key — `OPENAI_API_KEY`
- Optional, for the extra features: `ANTHROPIC_API_KEY` (post-meeting summary +
  ingest) and your own `SLACK_BOT_TOKEN` (transcript DM'd to you).

## 1. Run onboarding

```bash
cd agents/jarvis-meeting
npm run cli -- onboard
```

`onboard` will:
1. **Env preflight** — print every key as `[set]` / `[MISSING]` with what it's
   for, so you know exactly what to fill.
2. **Detect your second brain** — give it your connector's base URL
   (e.g. OpenBrain at `http://127.0.0.1:7411`; `/search` and `/store` are appended)
   and it probes it. **No brain?**
   It sets up the **folder-of-docs brain**: pick a folder, and it prints the
   `kb-retrieval` commands to index + serve it (your default brain).
3. **Interview** — your **bot name** (this is BOTH the display name AND the wake
   word — pick something UNIQUE, *not* "Jarvis", so multiple bots in one meeting
   don't collide), persona (`ai` generic team assistant, or `first_person` your
   delegate), your role + goals (seed the SOUL), denied topics, and optional
   Slack transcript delivery.
   > The `ai` persona serves its brain to **all meeting participants** as team
   > knowledge — point it at shared team content, not a personal brain. The
   > `first_person` persona is owner-gated and answers as you.
4. **Write** `soul/<you>.md` + patch `.env.local` (`JARVIS_BOT_NAME`,
   `TEAM_KB_RETRIEVAL_URL` for the team persona, `SLACK_BOT_TOKEN` +
   `MEETING_SLACK_CHANNEL` if you opted in).

Agents can run it **headless** instead:

```bash
# For transcript DMs, export your Slack USER token first — it is read from the env,
# NOT passed as a flag (argv is world-readable via ps / shell history):
export JARVIS_SLACK_TOKEN=xoxp-...           # optional; channel auto-resolved via auth.test
npm run cli -- onboard --non-interactive \
  --bot-name Nova --owner riley --persona ai \
  --role "data platform" --goals "sprint planning + decisions recall" \
  --endpoint http://127.0.0.1:7412           # omit --endpoint to wire the folder default brain (--kb-folder <path>)
```

## 2. Fill the missing keys

Open `.env.local` and fill every `[MISSING]` key the preflight flagged:
- **Required:** `RECALL_API_KEY`, `RECALL_API_BASE` (region-matched).
- **Realtime:** `OPENAI_API_KEY`.
- **For post-meeting summary + ingest:** `ANTHROPIC_API_KEY`. Without it,
  in-meeting Q&A still works, but there's no summary and no auto-ingest.
- `PUBLIC_BASE_URL` — leave blank; `up` resolves the ngrok URL at boot. `doctor`
  reports it as a **WARN** (not a failure) until then.
- `JARVIS_TOKENS` — optional for a local pilot: with it unset, `/v1/dispatch`
  runs in dev-mode and ignores the bearer token (any placeholder works). Set it
  (`token:teammate`) only when exposing the service to multiple people.

## 3. Start your brain

- **Existing brain:** make sure your `/search` connector is running at the URL
  you gave onboarding (must satisfy `docs/CONNECTOR.md`).
- **Folder brain (default, zero-infra):** this repo **ships a bundled folder
  connector** — point it at your folder and run it:
  ```bash
  KB_ROOT=/your/folder npm run connector      # serves http://127.0.0.1:7412
  ```
  Pure keyword BM25 over your `.md`/`.txt` files — **no Postgres, no pgvector, no
  embedding key**. The folder **is your scope boundary** — only put work-safe docs
  in it. Onboarding set `CONNECTOR_PORT=7412` so `up` health-checks the right port.
  For semantic recall instead of keyword, swap in a pgvector connector per
  `docs/CONNECTOR.md` (e.g. the openbrain `kb-retrieval` / `ob-retrieval`
  references).

## 4. Verify, then bring it up

```bash
npm run cli -- doctor --teammate <you>     # loop until green (green = no [FAIL])
# `up` starts the service + ngrok; set CONNECTOR_CMD to also auto-start your brain:
CONNECTOR_CMD="KB_ROOT=/your/folder npm run connector" CONNECTOR_PORT=7412 npm run up
```

`doctor` checks the whole chain and your onboarding choices: required env,
realtime provider (`OPENAI_API_KEY`), your SOUL, brain
reachability, the Recall key, your **bot name** (warns if it's still "Jarvis"),
ingest readiness (`ANTHROPIC_API_KEY`), and Slack delivery config. "Green" means
**no `[FAIL]`** — `[WARN]`s (e.g. `PUBLIC_BASE_URL` before `up`, or a skipped
optional feature) are fine for a pilot.

## 5. Join a meeting

**Canonical path — always use `join-meeting.sh`** (Zoom / Google Meet /
Microsoft Teams — Slack Huddle is unsupported):

```bash
scripts/join-meeting.sh "<your-meeting-url>" [soul]   # soul e.g. "david" (delegate) or "jarvis" (team)
# JOIN_DRY_RUN=1 scripts/join-meeting.sh "<url>"      # preview the dispatch, create no bot
```

Why a script and not a raw `curl`: the meeting **registry is in-memory** and
`up.sh` is **idempotent**, so a kicked or never-started bot leaves a stale
`live` entry that `up` will NOT clear. Stale entries count against the
per-teammate concurrency cap and make the next dispatch fail with
`429 CONCURRENCY_LIMIT`. `join-meeting.sh` enforces a **fresh control plane**: it
ensures the stack is up, checks `GET /healthz` `liveCount`, **restarts the
service to clear the registry if anything is live** (connector + ngrok stay up),
then dispatches — and restarts-and-retries once on a 429.

> **Agents:** when asked to join the agent to a meeting, run `join-meeting.sh`.
> Do NOT call `/v1/dispatch` directly — you'll skip the freshness preflight.

The underlying primitive (what the script calls):

```bash
curl -X POST "$PUBLIC_BASE_URL/v1/dispatch" \
  -H "Authorization: Bearer <your-JARVIS_TOKENS-token>" \
  -d '{"meeting_url":"<your-meeting-url>"}'
```

The bot joins as **your bot name**. If the meeting has a lobby, **admit it**
(or set the meeting's lobby to let everyone bypass). It activates when someone
says your **wake word** (your bot name), then answers from your brain.

## 6. After the meeting

- **Slack:** if you configured `SLACK_BOT_TOKEN` + `MEETING_SLACK_CHANNEL`, you
  get a DM with the AI summary followed by the **full transcript** (chunked).
- **Ingest:** with `ANTHROPIC_API_KEY` set, the transcript is summarized and
  **ingested into your brain** via the connector's `/store` (folder brain writes
  a `.md` file; OpenBrain stores a `meeting-transcript` doc). Next meeting, the
  agent can recall it.

> Both post-meeting lanes are summary-gated: no `ANTHROPIC_API_KEY` → no summary,
> so no Slack send and no ingest. In-meeting Q&A is unaffected.

## 7. Companion (sidekick) mode: the owner's own laptop

Sidekick mode is the single-owner setup: the owner is in the call, the bot listens, keeps
notes, answers from his **work-scoped** OpenBrain when addressed by name, and speaks lines
he types in a private panel. The README has the step-by-step quick start (`.env.local`,
`soul/david.md`, `scripts/up.sh`). This section is the runbook around it.

**Never put a secret inline in `CONNECTOR_CMD`** (`.env.local` is exported by `up.sh`, so the `kb-server` child inherits `KB_SERVER_TOKEN` from it; `up.sh` does not echo the command).

**Stack and ports.** `jarvis-meeting` on `:8790`, a second OpenBrain `kb-server` on `:7402`
(started by `up.sh` from `CONNECTOR_CMD` with `KB_RETRIEVAL_SCOPE=work`), and an ngrok tunnel
to `:8790`. The everyday `kb-server` on `:7401` stays as it is. Do not point
`KB_BACKEND_HEALTH_URL` or the SOUL at `:7401`: this setup relies on `:7402` having been
started with `KB_RETRIEVAL_SCOPE=work`.

**Open the panel at the public URL** (`https://<NGROK_DOMAIN>/panel`), never at
`http://localhost:8790/panel`. The owner cookie is `Secure`, and a cookie-authenticated write
(join, leave, say, mute) is accepted only when its `Origin` is the origin of `PUBLIC_BASE_URL`.
From localhost the same click returns `403 ORIGIN_MISMATCH`. That is deliberate. Scripts that
use the bearer (`OWNER_TOKEN`) are not affected by the origin rule.

**Register the Recall dashboard webhook** (once, and again after every change to `WEBHOOK_SECRET` or `NGROK_DOMAIN`). Create-bot subscribes each bot to `transcript.data` and `participant_events.*` only. The status events `bot.in_call_recording`, `bot.call_ended`, `bot.done` and `bot.fatal` arrive only through the account-level webhook in the Recall dashboard. Without it the panel never shows "in call" or a failure reason, and a call that ends without a panel Leave (the host ends it, everyone leaves, the bot is removed) never starts the notes document. Panel Leave starts it by itself 90 seconds after a successful Leave, as a backstop; a second kickoff for the same bot is a no-op, so whichever arrives first wins.

1. Open the Recall dashboard for the region that matches `RECALL_API_BASE` (the `us-east-1` in `https://us-east-1.recall.ai/api/v1`), then Webhooks, then add an endpoint.
2. URL: `https://<NGROK_DOMAIN>/webhooks/recall?s=<WEBHOOK_SECRET>`, both values from `.env.local`. Enter the secret in the dashboard only.
3. Events: `bot.in_call_recording`, `bot.call_ended`, `bot.done`, `bot.fatal`.
4. Verify with Recall's "Send test event". Recall's delivery log shows 200, and `~/Library/Logs/jarvis-meeting/service.log` gets one `"msg":"ignored foreign bot"` line (the test event is not one of this service's bots, so it is answered 200 and dropped). A `"msg":"webhook: rejected request, bad or missing secret"` line means 401: fix the `s=` value in the dashboard URL.

**Rotating `WEBHOOK_SECRET` means updating the dashboard URL too.** New bots get the new secret on their own, but the dashboard keeps sending the old one and every status event is rejected with 401 until it is changed. The webhook is account-wide: the service ignores the bots it did not create (no registry entry and no `meeting_id` in the bot metadata), so another app's bots on the same Recall account never reach David's OpenBrain. On a Recall account shared with other services, only one service can own the dashboard webhook; the others rely on the Leave backstop alone.

**Join.** Paste the meeting link in the panel and press Join (the panel dispatches with
`soul/david.md`). Command-line equivalent: `scripts/join-meeting.sh "<url>" david`, which
sends `OWNER_TOKEN` as the bearer. Never call `/v1/dispatch` by hand: `join-meeting.sh` also
clears stale in-memory meetings that would otherwise trip `429 CONCURRENCY_LIMIT`
(`MAX_CONCURRENT_PER_TEAMMATE=1` in this setup).

**Verify, in this order.**

1. `curl -s http://127.0.0.1:8790/healthz` and `curl -s https://<NGROK_DOMAIN>/healthz` return `{"ok":true,"liveCount":0}` before a meeting.
2. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7402/healthz` returns 200.
   Then Recall's "Send test event" on the dashboard webhook (see above) returns 200 and logs `ignored foreign bot`.
3. Replay without Recall: `npx tsx scripts/replay-meeting.ts` ends in `replay: PASS` and lists `## BLUF`, `## Noted`, `## Transcript`. Read its `summary:` line too: `PASS with WARNING` means the notes document landed but the summary step failed.
4. Live test (Google Meet, owner present): join in about a minute; panel transcript within 5 seconds of speech; "Jarvis, what did I work on this week?" answered from work notes; a "Say this" line spoken verbatim within 3 seconds; muted bot ignores its name while "Say this" still works; after Leave, `meeting-<id>` readable in OpenBrain with summary, Noted items and transcript.

**Work-scope boundary.** Two layers, neither of them the prompt. OpenBrain's `kb-server` on
`:7402` filters `/search`, `/document` and `/v1/retrieve` to the work scope. The bot then filters
again in `/api/voice/ob-search`, `/api/voice/ob-context` and `/api/voice/ob-get-document`
(`src/agent/work-scope.ts`), and that second filter is deliberately stricter:

- Only `second-brain` documents of these types pass: `work-output`, `lesson-learned`, `lesson`,
  `plan`, `implementation-plan`, `task-plan`, `prd`, `report`, `analysis`, `analysis-report`,
  `research`, `research-report`, `runbook`, `playbook`, `engineering-artifact`, `pr-merge-event`,
  `investigation`, `handoff`, `agent-run`, `skill-doc`. Transcripts, meeting prep and notes,
  Slack drafts, decisions and the daily/weekly rollups are not spoken: they mix work with
  personal content. (The notes document the bot writes after a meeting is a `meeting-transcript`
  and therefore is not read back by the bot; read it in OpenBrain.)
- The bot asks the `kb-server` for four times the requested number of results (at most 40) before it filters, then keeps the requested number, so a query whose top hits are filtered out still returns clean results when enough exist.
- `WORK_SCOPE_NAMESPACES` stays **empty**. OpenBrain's work scope admits the whole `initech`
  namespace, and the bot's own filter drops every `initech/...` result.
- Personal-life terms. The built-in stems are `milo, robin, pediatric, nann, sideshop, preschool,
  babysit, mortgage`; `PERSONAL_DENY_TERMS` ADDS terms to them and can never replace or switch off
  a default. A document is dropped when any term appears at the START of a word, case-insensitively,
  in its entity_key **or** its content, after `_` is turned into a space and a space is inserted at
  each lowercase-to-uppercase boundary. So nanny, nannies, babysitters, pediatricians, mortgages,
  sideshop.com, SideshopPets, RobinLee, milo_fever, miloFever and Milo's are all dropped, while
  "Napoleon" (no word start) is kept. Stems are deliberately broad: "Leonard" is dropped too.

Check it against the real `:7402` and print only `source` strings and counts, never document text.

**Known issues.**

- *Personal transcripts passed the work scope* (found 2026-10-16): the query "Milo bedtime"
  returned a pediatrician-call `meeting-transcript` as the top result. Fixed by the doc-type
  allowlist and the personal-term stems above (round 2 widened the match to word-start prefixes so
  plurals and joined forms are caught); the post-fix proof is in the Task 9 report.
  `denied_topics` in the SOUL is still a prompt-level guard only.
- *The summary came back as a refusal* (found 2026-10-16): `claude-sonnet-5-5` returned
  `stop_reason: refusal` (category `cyber`, no output) for a harmless replay transcript.
  `src/postmeeting/summary.ts` now retries ONCE on `ANTHROPIC_FALLBACK_MODEL`
  (default `claude-opus-5-5`) when the first answer is a refusal or has no structured output,
  and a second refusal stores the BLUF `summary unavailable (model refused)` together with the
  Noted items and the full transcript. Verified with a mocked client only; the live check is
  still to be done (Task 10).

**Troubleshooting.**

| Symptom | Cause and fix |
|---|---|
| `up.sh` prints `!! connector not reachable (the agent will degrade to empty results)` | The bot `kb-server` did not start. `tail ~/Library/Logs/jarvis-meeting/connector.log`; Postgres must be running and `~/your-brain/.env` must have `DATABASE_URL`. |
| The bot says it cannot reach the owner's notes; `/api/voice/ob-search` returns `unreachable: true` | `unreachable` is true only when the backend FAILED (connection refused, or a non-2xx such as a 401): the SOUL endpoint ends in `/search` (use `http://127.0.0.1:7402`), `:7402` is down, or `KB_BACKEND_TOKEN` differs from `KB_SERVER_TOKEN`. A slow answer is not unreachable: a search with no `timeoutMs` waits up to 2.5 s, and a lane timeout returns empty results with `lane_statuses.openbrain: "timeout"` and `unreachable: false`. |
| `service.log` shows `webhook: rejected request, bad or missing secret` | The Recall dashboard webhook URL carries a stale or mistyped `s=` value (for example after a `WEBHOOK_SECRET` rotation). Update it to the current `WEBHOOK_SECRET`. |
| The panel never shows "in call", or no notes document appears after a call that ended without a panel Leave | The Recall dashboard webhook is not registered, or it is rejected (see the row above). Register it as described above. |
| Leave says `alreadyGone` | Recall had already removed the bot (HTTP 404/410 on the leave call). The meeting is retired, the next Join is not blocked, and the notes document starts 90 seconds later if the webhook has not already started it. |
| Search works but the bearer is not sent | `KB_BACKEND_HEALTH_URL` and the SOUL endpoint use different origins (for example `localhost` against `127.0.0.1`). Use the same spelling. |
| Panel button returns 403 `ORIGIN_MISMATCH` | The panel was opened on `http://localhost:8790`. Open the public URL. |
| Panel login returns 401 `OWNER_TOKEN_INVALID` | Wrong token. The service sets no cookie on a wrong token. |
| `loadConfig` refuses to start: `OWNER_TOKEN and WEBHOOK_SECRET must be set` | `PUBLIC_BASE_URL` is not localhost. Set both. |
| The stored notes say `summary unavailable (model refused)` or `summary generation failed` | The summary model refused or returned nothing, twice. The transcript, Noted items and flags are still stored. Check `ANTHROPIC_MODEL` and `ANTHROPIC_FALLBACK_MODEL`; the logs show `stop_reason` and `model` only. |
| `429 CONCURRENCY_LIMIT` on join | A stale live meeting. Use `scripts/join-meeting.sh`, which restarts the service to clear it. |
| Recall `401` or `404` on the free read `GET <base>/bot/?page_size=1` | Wrong region. Try `us-west-2`, `eu-central-1`, `ap-northeast-1` and set `RECALL_API_BASE` to the one that returns 200 (`us-east-1` worked for David's key). |

**Stop what you started** (leaves `:7401` running): `kill $(lsof -ti tcp:8790 -sTCP:LISTEN)`,
`kill $(lsof -ti tcp:7402 -sTCP:LISTEN)`, and `pkill -f 'ngrok http( .*)? 8790( |$)'` (only the
tunnel to `:8790`, never another stack's tunnel), then confirm
`lsof -nP -iTCP:8790 -iTCP:7402 -sTCP:LISTEN` prints nothing.

## Safety (non-negotiable)

- The **connector** is the scope boundary, not the prompt. For a brain with mixed
  content, filter personal/out-of-scope server-side; for the folder brain, curate
  what you export. Set the SOUL's `denied_topics` as a secondary guard.
- Keep your connector bound to `127.0.0.1`; only the service is exposed via ngrok,
  and only with `WEBHOOK_SECRET` set.
- `.env.local` is git-ignored — never commit secrets.

## Local topology

```
Recall.ai bot ──► ngrok ($PUBLIC_BASE_URL) ──► jarvis-meeting service (:8790)
                                                  │  /search (mid-meeting), /store (after)
                                                  ▼
                                    your connector (127.0.0.1:7411 OB / 7412 folder)
                                                  │
                                                  ▼
                                          your second brain
```

See `docs/CONNECTOR.md` for the connector contract a custom brain must implement.
```
