// Owner-to-bot command channel.
//
//   POST /api/meetings/:id/commands          owner only; body is one MeetingCommand
//        -> 201 {seq} | 400 BAD_REQUEST | 401 OWNER_REQUIRED | 403 ORIGIN_MISMATCH (cookie, other origin)
//           | 404 not_found | 409 NOT_LIVE
//   POST /api/meetings/:id/requests          the bot page's session token; body {text, from?} -> 202 {requestId}
//   POST /api/meetings/:id/leave-request     the bot page's session token -> 202 | 409 | 502
//   POST /api/meetings/:id/listening         the bot page's session token; body {paused}
//   POST /api/meetings/:id/chat-reply        the bot page's session token; body {text}
//        -> 200 {ok} | 400 BAD_REQUEST | 401 | 404 | 409 NOT_LIVE | 502 CHAT_FAILED
//   GET  /api/meetings/:id/commands?after=<n> the bot page's meeting session token
//        -> 200 {commands, muted} | 400 BAD_REQUEST | 401 SESSION_REQUIRED | 404 not_found
//
// The owner panel POSTs; the bot's browser page polls GET once a second with the last
// seq it handled. `muted` is read from the registry rather than inferred from the
// queue, so the bot page learns the right state even after the mute command expired.
// The `say` text is meeting content: it is never logged, only the command type and seq.

import { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from '../config.js';
import { requireOwner } from '../auth/owner.js';
import { requireMeetingAccess } from '../auth/meeting-session.js';
import { getMeeting, getParticipantNames, getSpeakerState, setListeningPaused, setMuted } from '../meeting/registry.js';
import { leaveMeeting } from '../meeting/leave.js';
import { commandsAfter, enqueueCommand, type MeetingCommand } from '../meeting/commands.js';
import { getActiveAvatarProvider } from '../avatar/providers.js';
import { postChat } from '../meeting/chat.js';
import { queueForExternalBrain } from '../meeting/external-brain.js';

const SAY_TEXT_MAX_CHARS = 500;
const CHAT_REPLY_MAX_CHARS = 4000;
const REQUEST_MAX_CHARS = 1000;

const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('say'),
    text: z
      .string()
      .min(1)
      .max(SAY_TEXT_MAX_CHARS)
      .refine((text) => text.trim().length > 0, 'text must not be blank'),
  }),
  z.object({ type: z.literal('mute') }),
  z.object({ type: z.literal('unmute') }),
]);

export function createCommandRoutes(config: Config): Hono {
  const app = new Hono();

  app.post('/api/meetings/:id/commands', requireOwner(config), async (c) => {
    const id = c.req.param('id');
    const meeting = getMeeting(id);
    if (!meeting) {
      return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    }
    if (meeting.status !== 'live') {
      return c.json({ error: 'Meeting is not live', code: 'NOT_LIVE' }, 409);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid command', code: 'BAD_REQUEST' }, 400);
    }
    const command: MeetingCommand = parsed.data;

    if (command.type === 'mute') setMuted(id, true);
    if (command.type === 'unmute') setMuted(id, false);

    const queued = enqueueCommand(id, command);
    console.info(JSON.stringify({ level: 'info', msg: 'command enqueued', type: command.type, seq: queued.seq }));
    return c.json({ seq: queued.seq }, 201);
  });

  app.get('/api/meetings/:id/commands', (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;

    const rawAfter = c.req.query('after');
    let after = 0;
    if (rawAfter !== undefined) {
      after = /^\d+$/.test(rawAfter) ? Number(rawAfter) : Number.NaN;
      if (!Number.isSafeInteger(after)) {
        return c.json({ error: 'after must be a non-negative integer', code: 'BAD_REQUEST' }, 400);
      }
    }

    const meeting = getMeeting(id);
    // Unreachable: the guard 404s an unknown meeting. Kept so the type narrows.
    if (!meeting) return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);

    const includeState = c.req.query('include_state') === '1';
    return c.json({
      commands: commandsAfter(id, after),
      muted: meeting.mutedAt !== undefined,
      // "Stop listening" state, so the page follows a pause or resume typed in chat, and a reloaded page knows.
      listeningPaused: meeting.listeningPausedAt !== undefined,
      ...(includeState
        ? {
            speakerState: getSpeakerState(id),
            // The live count and names: the page's gate and a facilitator both need them.
            participantCount: meeting.participantCount,
            participants: getParticipantNames(id),
            avatarProvider: getActiveAvatarProvider(),
          }
        : {}),
    });
  });

  // SOUL brain: external. The bot page heard a wake-word request and hands it over here
  // instead of answering it. An MCP agent collects it; with no answer in time the server
  // sends it back to the page as an `ask` command. The text is never logged.
  app.post('/api/meetings/:id/requests', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const meeting = getMeeting(id);
    if (!meeting) return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    if (meeting.status !== 'live') return c.json({ error: 'Meeting is not live', code: 'NOT_LIVE' }, 409);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; from?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (text === '' || text.length > REQUEST_MAX_CHARS) {
      return c.json({ error: 'text must be 1 to 1000 characters', code: 'BAD_REQUEST' }, 400);
    }
    const from = typeof body?.from === 'string' ? body.from.slice(0, 80) : '';
    if (meeting.notesOnly === true) return c.json({ error: 'notes-only meeting', code: 'NOTES_ONLY' }, 409);
    const request = queueForExternalBrain(id, { text, from, source: 'voice' });
    return c.json({ requestId: request.id }, 202);
  });

  // Someone in the call told the bot to leave. The bot page heard it and posts here; the
  // bot leaves through the same code as the owner panel's Leave button.
  app.post('/api/meetings/:id/leave-request', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const meeting = getMeeting(id);
    if (!meeting) return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    if (meeting.status !== 'live') return c.json({ error: 'Meeting is not live', code: 'NOT_LIVE' }, 409);
    const result = await leaveMeeting(config, meeting);
    console.info(JSON.stringify({ level: 'info', msg: 'leave requested in the call', meetingId: id, ok: result.ok }));
    return result.ok ? c.json({ ok: true }, 202) : c.json({ ok: false, error: result.error, code: result.code }, 502);
  });

  // "Stop listening" / the wake word again: the bot page tells the server, which then
  // stops (or resumes) writing the transcript.
  app.post('/api/meetings/:id/listening', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (typeof body?.paused !== 'boolean') {
      return c.json({ error: 'paused (boolean) is required', code: 'BAD_REQUEST' }, 400);
    }
    setListeningPaused(id, body.paused);
    console.info(JSON.stringify({ level: 'info', msg: body.paused ? 'listening paused' : 'listening resumed', meetingId: id }));
    return c.json({ ok: true, paused: body.paused });
  });

  // The bot page posts its written answer here; the server sends it to the meeting chat
  // and records it in the transcript. The text is meeting content and is never logged.
  app.post('/api/meetings/:id/chat-reply', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const meeting = getMeeting(id);
    if (!meeting) return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    if (meeting.status !== 'live') return c.json({ error: 'Meeting is not live', code: 'NOT_LIVE' }, 409);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (text === '' || text.length > CHAT_REPLY_MAX_CHARS) {
      return c.json({ error: 'text must be 1 to 4000 characters', code: 'BAD_REQUEST' }, 400);
    }
    const result = await postChat(config, meeting, text);
    return result.ok ? c.json({ ok: true }) : c.json({ ok: false, error: result.error, code: 'CHAT_FAILED' }, 502);
  });

  return app;
}
