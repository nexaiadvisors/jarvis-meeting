# Jarvis meeting MCP server

Any agent that speaks MCP (Model Context Protocol) can run the meeting bot through one
endpoint: join a call, read the transcript while the call is live, speak, and read the
summary afterwards.

- **Endpoint:** `POST <PUBLIC_BASE_URL>/mcp`
- **Transport:** streamable HTTP, stateless. Each POST carries one JSON-RPC message and
  gets a JSON reply. There is no session id, no server-to-client stream, and no stdio
  entry. `GET` and `DELETE` return 405.
- **Auth:** `Authorization: Bearer <OWNER_TOKEN>`, the same owner token the panel uses.
  Without it the reply is 401 and no tool list. Keep the token in an environment
  variable (the examples use `JARVIS_OWNER_TOKEN`); never write it into a config file
  that is committed.
- **Results:** every tool returns one text block holding JSON. A tool that cannot do
  what was asked returns `{"error": "..."}` with `isError` set.

`join_meeting` puts a paid bot in a call. It costs Recall bot time and realtime voice
minutes until the bot leaves.

## Connect: Claude Code

```bash
claude mcp add --transport http jarvis-meeting "$JARVIS_BASE_URL/mcp" --header "Authorization: Bearer $JARVIS_OWNER_TOKEN"
```

## Connect: Codex

In `~/.codex/config.toml`. Codex reads the token from the named environment variable.

```toml
[mcp_servers.jarvis-meeting]
url = "https://YOUR-HOST/mcp"
bearer_token_env_var = "JARVIS_OWNER_TOKEN"
```

## Connect: any HTTP MCP client

Most clients take a JSON entry of this shape. Use the client's own way to read the
token from the environment.

```json
{
  "mcpServers": {
    "jarvis-meeting": {
      "type": "http",
      "url": "https://YOUR-HOST/mcp",
      "headers": { "Authorization": "Bearer ${JARVIS_OWNER_TOKEN}" }
    }
  }
}
```

A client that only speaks stdio can reach the endpoint through a generic
stdio-to-HTTP MCP bridge.

Check the connection by hand:

```bash
curl -s "$JARVIS_BASE_URL/mcp" -H "Authorization: Bearer $JARVIS_OWNER_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Tools

`meeting_id` is the `meetingId` that `join_meeting` and `list_meetings` return.

### list_meetings

Meetings the bot joined, newest first.
Inputs: `status` (optional: `live`, `completed` or `failed`), `limit` (optional, 1-100, default 20).

### get_meeting

Status of one meeting: title, status, whether the bot is in the call, muted, participant count.
Inputs: `meeting_id`.

### get_transcript

The transcript in time order: what people said and what the bot said. Works during and after the call.
Inputs: `meeting_id`, `tail` (optional: only the last N lines).

### search_transcript

The transcript lines that best match a query.
Inputs: `meeting_id`, `query`, `k` (optional, 1-20, default 6).

### get_notes

Notes and flags saved during the meeting by the bot or the owner.
Inputs: `meeting_id`.

### list_upcoming

Calendar meetings in the next day that carry a meeting link, and whether the bot will join each.
Inputs: none.

### get_summary

The post-meeting summary: bottom line, decisions, action items. Written a few minutes after the call ends.
Inputs: `meeting_id`.

### get_action_items

Only the action items from the summary, each with owner, task and due date when known.
Inputs: `meeting_id`.

### join_meeting

Send the bot into a Google Meet, Zoom or Teams call. Returns `meetingId` and `botId`.
Refused when the live-meeting limit is reached.
Inputs: `meeting_url`, `title` (optional).

### leave_meeting

Take the bot out of the call. Notes and the summary are produced afterwards.
Inputs: `meeting_id`.

### say

Have the bot speak a line aloud. The line is dropped if the bot does not pick it up within 30 seconds. This is the owner speaking through the bot, so it also works in a notes-only meeting.
Inputs: `meeting_id`, `text` (1-500 characters).

### mute

Stop the bot from speaking until `unmute`. It keeps listening.
Inputs: `meeting_id`.

### unmute

Let the bot speak again.
Inputs: `meeting_id`.

### post_chat

Post a written message to the meeting chat as the bot. A long message is split into parts (Google Meet allows 500 characters each).
Inputs: `meeting_id`, `text` (1-4000 characters).

### create_artifact

Create a doc or a whiteboard for a meeting. Returns the artifact with its `id`, `version` and the `url` people open to edit it. Post the url with `post_chat` so the meeting sees it.
Inputs: `meeting_id`, `kind` (`doc` or `whiteboard`), `title`, `content` (a doc: markdown; a whiteboard: a Mermaid diagram, which the page turns into editable shapes).

### update_artifact

Replace the content of a doc or whiteboard. Pass the `version` you read; a stale version is refused and the reply holds the current content.
Inputs: `meeting_id`, `artifact_id`, `content`, `title` (optional), `version` (optional; omit to overwrite).

### get_artifact

Read a doc or whiteboard, including edits people made on its page.
Inputs: `meeting_id`, `artifact_id`.

### list_artifacts

The docs and whiteboards of a meeting, oldest first, without their content.
Inputs: `meeting_id`.

### wait_for_request

For a meeting whose SOUL sets `brain: external`. Waits up to 25 seconds for someone to ask the bot something, by voice or in chat, and returns the request (`id`, `text`, `from`, `source`) with the last 20 transcript lines. Returns `request: null` when nobody asked.
Inputs: `meeting_id`, `timeout_seconds` (optional, 0-25, default 25).

### respond

Answer a request from `wait_for_request`. `voice` has the bot speak the text (cut to 500 characters); `chat` posts it to the meeting chat. Refused when the request already timed out.
Inputs: `request_id`, `text`, `via` (optional: `voice` or `chat`; default is the way the request came in).

## Acting as the brain

By default the built-in realtime voice agent answers people in the meeting. To have your
own agent answer instead, set `brain: external` in the teammate's SOUL front matter.
Then run this loop from your agent while the meeting is live:

1. Call `wait_for_request` with the `meeting_id`. It returns when someone says or types the wake word and a request, or after 25 seconds with `request: null`.
2. Work out the answer. `recent_transcript` is the context; `get_transcript` and `search_transcript` give more.
3. Call `respond` with the `request_id` and the answer.
4. Go back to step 1.

A request that gets no `respond` within 20 seconds is answered by the built-in agent, so a
slow or disconnected agent does not leave the person waiting. `respond` after that point
is refused. Notes, the transcript, docs and whiteboards work the same in both modes.

