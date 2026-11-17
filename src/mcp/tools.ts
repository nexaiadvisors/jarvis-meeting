// The MCP tools: every meeting function an outside agent can call.
//
// Each tool returns one text content block holding JSON. A tool that cannot do
// what was asked returns the same shape with isError set, so the calling model
// reads the reason instead of a transport error.

import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import {
  countLiveForTeammate,
  getMeeting,
  listMeetings,
  setMuted,
  type MeetingRecord,
} from '../meeting/registry.js';
import { enqueueCommand, type MeetingCommand } from '../meeting/commands.js';
import { leaveMeeting } from '../meeting/leave.js';
import { postChat } from '../meeting/chat.js';
import {
  ARTIFACT_CONTENT_MAX_CHARS,
  ARTIFACT_TITLE_MAX_CHARS,
  createArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact,
  type Artifact,
} from '../meeting/artifacts.js';
import { artifactUrl } from '../routes/artifacts.js';
import { WAIT_MAX_MS, answerRequest, getRequest, waitForRequest } from '../meeting/requests.js';
import { startMeeting } from '../routes/dispatch.js';
import { readMergedTranscript } from '../meeting/transcript.js';
import { rankTranscriptEntries } from '../meeting/transcript-search.js';
import { readNotes } from '../meeting/notes.js';
import { getCalendarWatcherStatus } from '../calendar/watcher.js';
import { readSummary } from '../postmeeting/summary-store.js';

export interface McpToolOptions {
  /** Where transcripts, notes and summaries live. Defaults to <cwd>/.data. */
  dataDir?: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const meetingId = z.string().min(1).describe('The meetingId returned by list_meetings or join_meeting');

/** The meeting fields an agent needs. */
export function meetingView(m: MeetingRecord): Record<string, unknown> {
  return {
    meetingId: m.meetingId,
    title: m.title,
    status: m.status,
    inCall: m.inCall,
    muted: m.mutedAt !== undefined,
    participantCount: m.participantCount,
    createdAt: new Date(m.createdAt).toISOString(),
    lastActivityAt: new Date(m.lastActivityAt).toISOString(),
    ...(m.failureCode !== undefined ? { failureCode: m.failureCode } : {}),
  };
}

export function registerTools(server: McpServer, config: Config, options: McpToolOptions = {}): void {
  const dataDir = options.dataDir ?? join(process.cwd(), '.data');
  const transcriptOf = (m: MeetingRecord) => readMergedTranscript(m, config.jarvisBotName, dataDir);

  server.registerTool(
    'list_meetings',
    {
      description: 'List meetings the bot joined, newest first. Filter by status to find the live one.',
      inputSchema: {
        status: z.enum(['live', 'completed', 'failed']).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      },
    },
    async ({ status, limit }) => {
      const all = listMeetings().filter((m) => status === undefined || m.status === status);
      return ok({ meetings: all.slice(0, limit ?? 20).map(meetingView) });
    },
  );

  server.registerTool(
    'get_meeting',
    { description: 'Status of one meeting.', inputSchema: { meeting_id: meetingId } },
    async ({ meeting_id }) => {
      const m = getMeeting(meeting_id);
      return m ? ok(meetingView(m)) : fail('meeting not found');
    },
  );

  server.registerTool(
    'get_transcript',
    {
      description:
        'The meeting transcript in time order: what people said and what the bot said. Works during and after the call.',
      inputSchema: {
        meeting_id: meetingId,
        tail: z.number().int().min(1).max(2000).optional().describe('Return only the last N lines'),
      },
    },
    async ({ meeting_id, tail }) => {
      const m = getMeeting(meeting_id);
      if (!m) return fail('meeting not found');
      const entries = transcriptOf(m);
      return ok({ total: entries.length, entries: tail === undefined ? entries : entries.slice(-tail) });
    },
  );

  server.registerTool(
    'search_transcript',
    {
      description: 'Find the transcript lines that best match a query (keyword overlap, newest first on ties).',
      inputSchema: {
        meeting_id: meetingId,
        query: z.string().min(1),
        k: z.number().int().min(1).max(20).optional().describe('Default 6'),
      },
    },
    async ({ meeting_id, query, k }) => {
      const m = getMeeting(meeting_id);
      if (!m) return fail('meeting not found');
      return ok({ results: rankTranscriptEntries(transcriptOf(m), query, k ?? 6) });
    },
  );

  server.registerTool(
    'get_notes',
    {
      description: 'Notes and flags saved during the meeting by the bot or the owner.',
      inputSchema: { meeting_id: meetingId },
    },
    async ({ meeting_id }) => {
      const m = getMeeting(meeting_id);
      if (!m) return fail('meeting not found');
      return ok({ notes: readNotes(m.botId ?? m.meetingId, dataDir) });
    },
  );

  server.registerTool(
    'list_upcoming',
    {
      description:
        'Calendar meetings in the next day that carry a meeting link, and whether the bot will join each one.',
    },
    async () => ok(getCalendarWatcherStatus(config)),
  );

  /** The stored summary, or the error to return. */
  const summaryOf = (id: string) => {
    const m = getMeeting(id);
    if (!m) return fail('meeting not found');
    const summary = m.botId === undefined ? undefined : readSummary(m.botId, dataDir);
    return summary ?? fail('no summary yet; it is written a few minutes after the meeting ends');
  };

  server.registerTool(
    'get_summary',
    {
      description:
        'The post-meeting summary: bottom line, decisions and action items. Available a few minutes after the call ends.',
      inputSchema: { meeting_id: meetingId },
    },
    async ({ meeting_id }) => {
      const s = summaryOf(meeting_id);
      return 'content' in s ? s : ok(s);
    },
  );

  server.registerTool(
    'get_action_items',
    {
      description: 'Only the action items from the post-meeting summary, each with owner, task and due date when known.',
      inputSchema: { meeting_id: meetingId },
    },
    async ({ meeting_id }) => {
      const s = summaryOf(meeting_id);
      // `generated` false means the summary step failed, so an empty list is not "nothing to do".
      return 'content' in s ? s : ok({ actionItems: s.actionItems, generated: s.generated });
    },
  );

  // ---- control tools ----

  /** The meeting when it is live, else the error to return. */
  const liveMeeting = (id: string): MeetingRecord | ToolResult => {
    const m = getMeeting(id);
    if (!m) return fail('meeting not found');
    if (m.status !== 'live') return fail('meeting is not live');
    return m;
  };
  const isResult = (v: MeetingRecord | ToolResult): v is ToolResult => 'content' in v;

  /** Queue a command for the bot page, exactly as the owner panel does. */
  const command = (id: string, cmd: MeetingCommand): ToolResult => {
    const m = liveMeeting(id);
    if (isResult(m)) return m;
    if (cmd.type === 'mute') setMuted(id, true);
    if (cmd.type === 'unmute') setMuted(id, false);
    const queued = enqueueCommand(id, cmd);
    console.info(JSON.stringify({ level: 'info', msg: 'mcp: command enqueued', type: cmd.type, seq: queued.seq }));
    return ok({ queued: true, seq: queued.seq });
  };

  server.registerTool(
    'join_meeting',
    {
      description:
        'Send the bot into a Google Meet, Zoom or Teams call. Costs money while the bot is in the call. Returns the meetingId the other tools take.',
      inputSchema: {
        meeting_url: z.string().url(),
        title: z.string().min(1).max(200).optional(),
      },
    },
    async ({ meeting_url, title }) => {
      const teammate = config.defaultTeammate;
      if (countLiveForTeammate(teammate) >= config.maxConcurrentPerTeammate) {
        return fail(`already ${config.maxConcurrentPerTeammate} live meeting(s); leave one first`);
      }
      const started = await startMeeting(config, {
        teammate,
        meetingUrl: meeting_url,
        soulSlug: teammate,
        ...(title !== undefined ? { title } : {}),
      });
      return started.ok ? ok({ meetingId: started.meetingId, botId: started.botId }) : fail(started.error);
    },
  );

  server.registerTool(
    'leave_meeting',
    {
      description: 'Take the bot out of the call. Notes and the summary are produced afterwards.',
      inputSchema: { meeting_id: meetingId },
    },
    async ({ meeting_id }) => {
      const m = liveMeeting(meeting_id);
      if (isResult(m)) return m;
      const result = await leaveMeeting(config, m);
      return result.ok ? ok({ left: true, alreadyGone: result.alreadyGone }) : fail(result.error);
    },
  );

  server.registerTool(
    'say',
    {
      description: 'Have the bot speak this text aloud in the call. Dropped if the bot does not pick it up within 30 seconds.',
      inputSchema: {
        meeting_id: meetingId,
        text: z.string().trim().min(1).max(500),
      },
    },
    async ({ meeting_id, text }) => command(meeting_id, { type: 'say', text }),
  );

  server.registerTool(
    'mute',
    { description: 'Stop the bot from speaking until unmute. It keeps listening.', inputSchema: { meeting_id: meetingId } },
    async ({ meeting_id }) => command(meeting_id, { type: 'mute' }),
  );

  server.registerTool(
    'unmute',
    { description: 'Let the bot speak again.', inputSchema: { meeting_id: meetingId } },
    async ({ meeting_id }) => command(meeting_id, { type: 'unmute' }),
  );

  server.registerTool(
    'post_chat',
    {
      description:
        'Post a written message to the meeting chat as the bot. Long messages are split (Google Meet allows 500 characters each).',
      inputSchema: { meeting_id: meetingId, text: z.string().trim().min(1).max(4000) },
    },
    async ({ meeting_id, text }) => {
      const m = liveMeeting(meeting_id);
      if (isResult(m)) return m;
      const result = await postChat(config, m, text, dataDir);
      return result.ok ? ok({ posted: true }) : fail(result.error ?? 'chat post failed');
    },
  );

  // ---- artifacts: docs and whiteboards ----

  const artifactContent = z
    .string()
    .max(ARTIFACT_CONTENT_MAX_CHARS)
    .describe('A doc: markdown. A whiteboard: a Mermaid diagram (for example "flowchart TD ..."), which the page turns into editable shapes.');
  const artifactId = z.string().min(1).describe('The id returned by create_artifact or list_artifacts');
  /** An artifact plus the link people open to edit it. */
  const withUrl = (a: Artifact) => ({ ...a, url: artifactUrl(config, a.meetingId, a.id) });

  server.registerTool(
    'create_artifact',
    {
      description:
        'Create a doc or a whiteboard for a meeting. Returns its id and the url people open to edit it. Post the url with post_chat so the meeting can see it.',
      inputSchema: {
        meeting_id: meetingId,
        kind: z.enum(['doc', 'whiteboard']),
        title: z.string().trim().min(1).max(ARTIFACT_TITLE_MAX_CHARS),
        content: artifactContent,
      },
    },
    async ({ meeting_id, kind, title, content }) => {
      if (!getMeeting(meeting_id)) return fail('meeting not found');
      return ok(withUrl(createArtifact(meeting_id, { kind, title, content }, dataDir)));
    },
  );

  server.registerTool(
    'update_artifact',
    {
      description:
        'Replace the content of a doc or whiteboard. Pass the version you read to avoid overwriting a newer edit; a stale version is refused with the current content.',
      inputSchema: {
        meeting_id: meetingId,
        artifact_id: artifactId,
        content: artifactContent,
        title: z.string().trim().min(1).max(ARTIFACT_TITLE_MAX_CHARS).optional(),
        version: z.number().int().min(1).optional().describe('The version this change is based on. Omit to overwrite.'),
      },
    },
    async ({ meeting_id, artifact_id, content, title, version }) => {
      const result = updateArtifact(
        meeting_id,
        artifact_id,
        { content, ...(title !== undefined ? { title } : {}), ...(version !== undefined ? { baseVersion: version } : {}) },
        dataDir,
      );
      if (result.ok) return ok(withUrl(result.artifact));
      if (result.code === 'not_found') return fail('artifact not found');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'conflict: the artifact changed since that version', current: withUrl(result.current) }) }],
        isError: true,
      };
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description: 'Read a doc or whiteboard, including edits people made on its page.',
      inputSchema: { meeting_id: meetingId, artifact_id: artifactId },
    },
    async ({ meeting_id, artifact_id }) => {
      const a = getArtifact(meeting_id, artifact_id, dataDir);
      return a ? ok(withUrl(a)) : fail('artifact not found');
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      description: 'The docs and whiteboards of a meeting, oldest first, without their content.',
      inputSchema: { meeting_id: meetingId },
    },
    async ({ meeting_id }) => {
      if (!getMeeting(meeting_id)) return fail('meeting not found');
      return ok({
        artifacts: listArtifacts(meeting_id, dataDir).map((a) => ({
          id: a.id,
          kind: a.kind,
          title: a.title,
          version: a.version,
          updatedAt: a.updatedAt,
          url: artifactUrl(config, a.meetingId, a.id),
        })),
      });
    },
  );

  // ---- acting as the brain (SOUL brain: external) ----

  server.registerTool(
    'wait_for_request',
    {
      description:
        'For a meeting whose SOUL sets brain: external. Waits up to 25 seconds for someone to ask the bot something (by voice or in chat) and returns the request with the recent transcript. Returns request: null when nobody asked; call it again in a loop. Answer with respond within 20 seconds of the request, or the built-in agent answers instead.',
      inputSchema: {
        meeting_id: meetingId,
        timeout_seconds: z.number().min(0).max(WAIT_MAX_MS / 1000).optional().describe('Default 25'),
      },
    },
    async ({ meeting_id, timeout_seconds }) => {
      const m = liveMeeting(meeting_id);
      if (isResult(m)) return m;
      const request = await waitForRequest(meeting_id, (timeout_seconds ?? WAIT_MAX_MS / 1000) * 1000);
      if (!request) return ok({ request: null });
      return ok({
        request: { id: request.id, text: request.text, from: request.from, source: request.source, asked_at: request.askedAt },
        recent_transcript: transcriptOf(m).slice(-20),
      });
    },
  );

  server.registerTool(
    'respond',
    {
      description:
        'Answer a request returned by wait_for_request. via "voice" has the bot speak the text (up to 500 characters); via "chat" posts it to the meeting chat. Default: the way the request came in. Refused when the request already timed out and the built-in agent answered.',
      inputSchema: {
        request_id: z.string().min(1),
        text: z.string().trim().min(1).max(4000),
        via: z.enum(['voice', 'chat']).optional(),
      },
    },
    async ({ request_id, text, via }) => {
      const refusal = (reason: 'not_found' | 'already_answered' | 'timed_out') =>
        fail(
          reason === 'timed_out'
            ? 'too late: the request timed out and the built-in agent answered it'
            : reason === 'already_answered'
              ? 'this request was already answered'
              : 'request not found',
        );
      const pending = getRequest(request_id);
      if (!pending) return refusal('not_found');
      if (pending.status === 'answered') return refusal('already_answered');
      if (pending.status === 'fallback') return refusal('timed_out');
      const m = liveMeeting(pending.meetingId);
      if (isResult(m)) return m;
      if (m.notesOnly === true) return fail('notes-only meeting: the bot does not answer');

      if ((via ?? pending.source) === 'chat') {
        // Post first. The request is closed only once the answer is in the chat, so a
        // failed post can be retried and the built-in fallback still stands behind it.
        const posted = await postChat(config, m, text, dataDir);
        if (!posted.ok) return fail(posted.error ?? 'chat post failed');
        answerRequest(request_id);
        return ok({ answered: true, via: 'chat' });
      }
      const closed = answerRequest(request_id);
      if (!closed.ok) return refusal(closed.reason);
      const queued = enqueueCommand(pending.meetingId, { type: 'say', text: text.slice(0, 500) });
      return ok({ answered: true, via: 'voice', seq: queued.seq, truncated: text.length > 500 });
    },
  );
}
