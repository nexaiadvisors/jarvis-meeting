// Meeting-state routes for the agent page (V1, file-backed, no DB). EVERY route
// calls requireMeetingAccess first: the bot page's session token for this meeting
// (GET also admits the owner). An unknown id is a 404 before any file is touched.
//
//   GET  /api/meetings/:id                     -> meeting + transcript + notes
//   POST /api/meetings/:id/agent-utterance     -> append agent speech
//   POST /api/meetings/:id/client-log          -> append client log line
//   POST /api/meetings/:id/retrieval-log       -> append retrieval log line
//   POST /api/meetings/:id/context-refresh      -> V1 no-op
//
// The transcript is the merged view from src/meeting/transcript.ts: the file the Recall
// webhook writes (.data/<botId or meetingId>.jsonl) interleaved by time with the bot's own
// lines (.data/<meetingId>.agent.jsonl plus an in-memory copy, so a refetch reflects them
// even before the disk flush). Logs append to sibling .data files.

import { Hono } from 'hono';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMeeting, getSpeakerState } from '../meeting/registry.js';
import { getActiveAvatarProvider } from '../avatar/providers.js';
import {
  listBackgroundTasks,
  upsertBackgroundTask,
  type BackgroundTaskStatus,
} from '../agent/background-tasks.js';
import { readNotes } from '../meeting/notes.js';
import { appendAgentUtterance, readMergedTranscript } from '../meeting/transcript.js';
import type { TranscriptEntry } from '../meeting/transcript.js';
import type { Config } from '../config.js';
import { requireMeetingAccess } from '../auth/meeting-session.js';

const DATA_DIR = join(process.cwd(), '.data');

function appendJsonl(file: string, obj: Record<string, unknown>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, file), JSON.stringify(obj) + '\n', 'utf8');
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'meeting-state: failed to write jsonl',
        file,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finiteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createMeetingStateRoutes(config: Config): Hono {
  const app = new Hono();

  app.get('/api/meetings/:id', (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id, { allowOwner: true });
    if (denied) return denied;
    const meeting = getMeeting(id);
    if (!meeting) {
      // Unreachable: the guard 404s an unknown meeting. Kept so the type narrows.
      return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    }
    const key = meeting.botId ?? meeting.meetingId;
    const transcript = readMergedTranscript(meeting, meeting.botName ?? config.jarvisBotName);
    return c.json({
      meeting: {
        id: meeting.meetingId,
        title: meeting.title,
        status: meeting.status,
        metadata: { muted: meeting.mutedAt !== undefined },
        // LIVE registry count (includes the bot — see registry semantics: it is
        // OTHER human participants, the bot itself is not counted, so the gate
        // adds 1 for the bot). Surfaced so the agent page can keep the wake gate's
        // participantCount fresh as people join/leave mid-meeting. Polled every
        // STATUS_POLL_MS by main.tsx — a one-time startup value would be ~1 (before
        // others join) and treat a full room as a 1:1.
        participantCount: meeting.participantCount,
        inCall: meeting.inCall,
        speakerState: getSpeakerState(id),
        avatarProvider: getActiveAvatarProvider(),
        backgroundTasks: listBackgroundTasks(id),
        transcript,
        notes: readNotes(key),
      },
    });
  });

  app.post('/api/meetings/:id/agent-utterance', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const speaker = typeof body['speaker'] === 'string' ? body['speaker'] : 'agent';
    const text = typeof body['text'] === 'string' ? body['text'] : '';
    const entry: TranscriptEntry = { speaker, text, timestamp: new Date().toISOString() };
    appendAgentUtterance(id, entry);
    return c.json({ ok: true });
  });

  app.post('/api/meetings/:id/client-log', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    appendJsonl(`${id}.client-log.jsonl`, {
      level: typeof body['level'] === 'string' ? body['level'] : 'info',
      message: typeof body['message'] === 'string' ? body['message'] : '',
      timestamp: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post('/api/meetings/:id/retrieval-log', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    appendJsonl(`${id}.retrieval-log.jsonl`, {
      tool: typeof body['tool'] === 'string' ? body['tool'] : '',
      query: typeof body['query'] === 'string' ? body['query'] : '',
      searched_query: typeof body['searched_query'] === 'string' ? body['searched_query'] : '',
      doc_keys: stringArray(body['doc_keys']),
      sources: stringArray(body['sources']),
      top_score: finiteNumberOrNull(body['top_score']),
      lanes: recordValue(body['lanes']),
      elapsed_ms: finiteNumberOrNull(body['elapsed_ms']),
      // 'prefetch' (served from the speculative cache) | 'live' (fresh fetch).
      served_from: typeof body['served_from'] === 'string' ? body['served_from'] : '',
      timestamp: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post('/api/meetings/:id/context-refresh', (c) => {
    const denied = requireMeetingAccess(c, config, c.req.param('id'));
    if (denied) return denied;
    // V1 no-op: the agent page polls this; we have no server-pushed context yet.
    return c.json({ contextText: null });
  });

  app.post('/api/meetings/:id/background-tasks', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const taskId = typeof body['id'] === 'string' && body['id'] ? body['id'] : `bg-${Date.now()}`;
    const rawStatus = body['status'];
    const status: BackgroundTaskStatus =
      rawStatus === 'completed' || rawStatus === 'failed' ? rawStatus : 'running';
    const task = upsertBackgroundTask({
      id: taskId,
      meetingId: id,
      label: typeof body['label'] === 'string' ? body['label'] : 'Background task',
      query: typeof body['query'] === 'string' ? body['query'] : '',
      status,
      startedAt: typeof body['startedAt'] === 'number' ? body['startedAt'] : Date.now(),
      ...(typeof body['completedAt'] === 'number' ? { completedAt: body['completedAt'] } : {}),
      ...(typeof body['elapsedMs'] === 'number' ? { elapsedMs: body['elapsedMs'] } : {}),
      delivered: Boolean(body['delivered']),
      ...(typeof body['summary'] === 'string' ? { summary: body['summary'] } : {}),
    });
    return c.json({ ok: true, task });
  });

  return app;
}
