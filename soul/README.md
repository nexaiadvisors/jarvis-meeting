# SOUL files

A SOUL.md defines a meeting teammate's persona, voice, knowledge backend, and
behavior — entirely from a file, no database. Each file is named
`<teammate>.md` (the slug passed as `teammate` to dispatch / routes).

## Format

YAML front-matter (between leading `---` fences) plus a prose body. The prose
body is appended to the realtime instructions as the teammate's persona text.

```yaml
---
owner: example            # required for first_person; the only teammate allowed to run it
name: Jarvis              # required — display name + wake-word fallback
wake_word: Jarvis         # activation phrase; falls back to name when empty
persona_mode: ai          # 'ai' (team Jarvis, team-KB-only) | 'first_person' (owner Delegate)
voice: marin              # realtime voice id
language: en
knowledge_backend:
  type: openbrain         # 'openbrain' | 'folder'
  endpoint: http://...    # BASE URL of this backend; /search, /document and /store are appended
delivery: [slack, ob]     # post-meeting delivery channels: slack | email | ob
ingest: false             # whether to ingest the meeting into the knowledge base
denied_topics: [compensation]
ai_disclosure: Jarvis - AI meeting assistant   # in-meeting tile subtitle (first_person uses this verbatim)
---

Prose persona text goes here...
```

## Field reference

| Field | Type | Meaning |
|-------|------|---------|
| `owner` | string | Owner slug. Required for `first_person` (gate fails closed without it). |
| `name` | string | Display name; wake-word fallback. **Required.** |
| `wake_word` | string | Activation phrase. Empty -> falls back to `name`. |
| `persona_mode` | `ai` \| `first_person` | `ai` = team Jarvis (team-KB-only, shareable). `first_person` = owner-only Delegate. |
| `voice` | string | Realtime voice id. |
| `language` | string | BCP-47-ish language code. |
| `knowledge_backend.type` | `openbrain` \| `folder` | Backend kind. |
| `knowledge_backend.endpoint` | string | Base URL of the backend (for example `http://127.0.0.1:7402`). The client appends `/search`, `/document` and `/store`; do not end it in `/search`. |

> Retrieval route is **not** a settable field — it is always derived from `persona_mode` (`ai` -> `jarvis` / team-KB-only, `first_person` -> `delegate` / owner backend). This keeps the two owner-gate checks (session + retrieval) from ever disagreeing; any `route:` key in front-matter is ignored.
| `reply_mode` | `voice` \| `chat` | Where answers to spoken requests go. Default `voice`. `chat` writes them to the meeting chat. Typed requests are always answered in chat. |
| `lookup_approval` | `none` \| `ask` | Default `none`. With `ask`, every knowledge lookup is refused until the agent has asked the requester and recorded a yes (valid for two minutes). |
| `mode` | `assistant` \| `facilitator` | Default `assistant`: the bot waits to be called by name. `facilitator`: the bot leads the call. It joins under the SOUL's `name`, opens the session itself, hears every turn, decides each time whether to speak, and speaks again after 20 seconds of silence (twice, then it waits). It has no lookup tools. "<name>, stop" pauses it and its name brings it back. The prose below the front matter is the agenda. |
| `mode: stand_in` | | The bot speaks in the owner's place (owner-only: use with `persona_mode: first_person`). It joins under the SOUL's `name`, waits for the other person to speak first, opens with `opening_line` (which must say it is an AI; empty = a built-in line that does), and then answers only what it is asked. It never leads and never fills a silence. Its only facts are in `soul/<slug>.briefing.md`, written before the call; a briefing older than 18 hours is ignored. It has no lookup tools and refuses new commitments for the owner. |
| `opening_line` | string | `stand_in` only: the first thing it says. |
| `brain` | `builtin` \| `external` | Default `builtin`: the realtime voice agent answers. `external`: requests wait for an MCP agent (`wait_for_request` / `respond`, see docs/MCP.md) and fall back to the built-in agent after 20 seconds. |
| `delivery` | (`slack`\|`email`\|`ob`)[] | Post-meeting delivery channels. |
| `ingest` | boolean | Ingest the meeting into the knowledge base. |
| `denied_topics` | string[] | Topics the persona must refuse. |
| `ai_disclosure` | string | In-meeting disclosure subtitle. |

## Persona modes & the owner gate

- **`ai` (team Jarvis):** reads only the team knowledge base. Always allowed,
  safe to share.
- **`first_person` (Delegate):** speaks AS the owner and reads the owner's full
  knowledge backend. Owner-only: the gate (`owner-gate.ts`) requires a non-empty
  `owner` and, when a request names a teammate, requires it to match `owner`.
  Fails CLOSED.

## Git

Real teammate SOULs are git-ignored (`soul/*.md` except `example.md` and this
README) so personal personas never get committed. Add your own as
`soul/<teammate>.md`.
