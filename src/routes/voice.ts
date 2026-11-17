// POST /api/voice/ob-search, /api/voice/ob-context, /api/voice/ob-get-document
// (and the deep-answer route team-kb-answer)
//
// Server-side standalone replacement for the dashboard's voice retrieval routes.
// Persona/route comes from the SOUL (loaded via the meeting's teammate), not the
// request's personaMode field. In-process pgvector + fanout is replaced by the
// SOUL-driven /search knowledge-client.
//
// The delegate route (David's sidekick) reads a work-scoped kb-server with a
// bearer token. That server enforces the work scope; the bot filters again here
// (filterWorkScopedResults / isWorkSafe) so it never depends on one layer alone.

import { latestScreenFrame } from '../screen/frames.js';
import { anthropicScreenDescriber, type ScreenDescriber } from '../screen/describe.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { LOOKUP_APPROVAL_WINDOW_MS, approveLookup, getMeeting, isLookupApproved, isOwnerOnly } from '../meeting/registry.js';
import type { MeetingRecord } from '../meeting/registry.js';
import { appendNote } from '../meeting/notes.js';
import { loadSoul } from '../soul/loader.js';
import { DELEGATE_OWNER_REQUIRED, delegateAllowed } from '../soul/owner-gate.js';
import {
  backendBaseUrl,
  FORCED_RETRIEVAL_TIMEOUT_MS,
  retrieveForSoul,
} from '../retrieval/knowledge-client.js';
import type { LaneStatus, RankedChunk, RetrieveOptions, RetrieveResult, SearchWindow } from '../retrieval/knowledge-client.js';
import { fetchCalendarEvents } from '../calendar/watcher.js';
import { listDayEvents, localDayBounds, localYmd } from '../calendar/day-events.js';
import type { FetchCalendarEvents } from '../calendar/day-events.js';
import { runResearcher } from '../researcher/researcher.js';
import type { PreloadedLookup, ResearchClient } from '../researcher/researcher.js';
import { isCalendarQuestion } from '../agent/answer-route.js';
import { buildResearchTools } from '../researcher/tools.js';
import { gwsRunner, searchEmail } from '../researcher/email.js';
import { ghRunner, pullRequestStatus, searchPullRequests } from '../researcher/github.js';
import type { GhJson } from '../researcher/github.js';
import { delegatePrompt, parseDisallowedTools, runClaudeCode, splitDelegateResult } from '../delegate/claude-code.js';
import type { ClaudeCodeRunner } from '../delegate/claude-code.js';
import { releaseDelegateSlot, reserveDelegateSlot } from '../delegate/tasks.js';
import { enqueueCommand } from '../meeting/commands.js';
import { randomUUID } from 'node:crypto';
import { buzzRunner, channelMembers, listChannels, matchChannel, readMessages, sendMessage } from '../buzz/buzz.js';
import type { BuzzJson } from '../buzz/buzz.js';
import { agentSaidSince, ownerAnswerBetween, recordAgentSpoken } from '../buzz/confirm.js';
import { kbBearerFor } from '../retrieval/kb-bearer.js';
import { obMcpGetDocument, obMcpSearch } from '../retrieval/ob-mcp-client.js';
import {
  ARTIFACT_CONTENT_MAX_CHARS,
  createArtifact,
  updateArtifact,
  type ArtifactKind,
} from '../meeting/artifacts.js';
import { postChat } from '../meeting/chat.js';
import { artifactUrl } from './artifacts.js';
import {
  filterWorkScopedResults,
  formatWorkContext,
  isCompensationDoc,
  isWorkSafe,
  overfetchLimit,
} from '../agent/work-scope.js';
import Anthropic from '@anthropic-ai/sdk';
import type { Soul } from '../soul/schema.js';
import type { Config } from '../config.js';
import { requireMeetingAccess } from '../auth/meeting-session.js';

interface VoiceBody {
  query?: unknown;
  limit?: unknown;
  scope?: unknown;
  personaMode?: unknown;
  meetingId?: unknown;
  timeoutMs?: unknown;
}

interface DocumentBody {
  meetingId?: unknown;
  namespace?: unknown;
  doc_type?: unknown;
  entity_key?: unknown;
}

interface Resolved {
  soul: Soul;
  teammate: string;
  /** True when the owner is the only person in this call: retrieval uses the wider scope. */
  ownerOnly: boolean;
  meetingId: string;
}

/** The scope name reported in responses and logs. Never names a document. */
function scopeName(ownerOnly: boolean): 'owner_only' | 'guests' {
  return ownerOnly ? 'owner_only' : 'guests';
}

interface SaveBody {
  meetingId?: unknown;
  content?: unknown;
  tags?: unknown;
}

const MAX_NOTE_CHARS = 2000;
/** Evidence window for the deep-answer reasoner (after the work filter). */
const DEEP_ANSWER_RESULTS = 12;

/**
 * Shared guard: meetingId required -> session token for THIS meeting -> the meeting
 * record. Returns a Response on failure. The guard (404 unknown meeting / 401 no
 * valid session token) runs BEFORE any other validation or I/O. Every voice route
 * goes through this, directly or via resolveSoul; none admits the owner token.
 */
function resolveMeeting(c: Context, config: Config, body: { meetingId?: unknown }):
  | { ok: true; meeting: MeetingRecord }
  | { ok: false; response: Response } {
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : '';
  if (meetingId.trim() === '') {
    return { ok: false, response: c.json({ error: 'meetingId is required', code: 'BAD_REQUEST' }, 400) };
  }
  const denied = requireMeetingAccess(c, config, meetingId);
  if (denied) return { ok: false, response: denied };
  const meeting = getMeeting(meetingId);
  if (!meeting) {
    // Unreachable: the guard 404s an unknown meeting. Kept so the type narrows.
    return { ok: false, response: c.json({ error: 'Meeting not found', code: 'not_found' }, 404) };
  }
  return { ok: true, meeting };
}

/**
 * Shared resolution for the retrieval routes: the meeting guard (resolveMeeting),
 * then the meeting's SOUL. Returns a Response on failure.
 */
function resolveSoul(c: Context, config: Config, body: VoiceBody):
  | { ok: true; data: Resolved }
  | { ok: false; response: Response } {
  const resolved = resolveMeeting(c, config, body);
  if (!resolved.ok) return resolved;
  const { meeting } = resolved;
  let soul: Soul;
  try {
    // Same SOUL as the voice session (realtime-session.ts): the one chosen at join.
    soul = loadSoul(meeting.soulSlug ?? meeting.teammate, config.soulDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, response: c.json({ error: message, code: 'soul_load_failed' }, 500) };
  }
  // SOUL lookup_approval: ask. Enforced here, in the route, for every knowledge lookup:
  // without an approval recorded for this meeting (approve_lookup, valid for a short
  // window) nothing is fetched. The prompt explains the rule; it is not the boundary.
  if (soul.lookupApproval === 'ask' && !isLookupApproved(meeting.meetingId)) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'lookup not approved',
          code: 'LOOKUP_APPROVAL_REQUIRED',
          approval_required: true,
          instruction: LOOKUP_APPROVAL_REFUSAL,
          results: [],
          context: '',
          answer: '',
        },
        403,
      ),
    };
  }
  const ownerOnly = isOwnerOnly(meeting, {
    ownerNames: config.ownerParticipantNames ?? [],
    internalDomains: config.internalDomains ?? [],
  });
  return { ok: true, data: { soul, teammate: meeting.teammate, ownerOnly, meetingId: meeting.meetingId } };
}

type LaneMap = RetrieveResult['lanes'];
type FlatLaneStatusMap = { openbrain: LaneStatus; teamKb: LaneStatus };

function clampTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(5000, Math.max(100, Math.floor(parsed)));
}

/**
 * Retrieval options for one request. The kb-server bearer is attached only on the
 * delegate route, only when the SOUL's own backend is on the kb-server origin
 * (kbBearerFor), and is never sent to the team KB.
 *
 * On the delegate route a request that names no timeout waits FORCED_RETRIEVAL_TIMEOUT_MS,
 * not the client's 800 ms default: the work-scoped kb-server itself allows 1.5-1.8 s, so a
 * model-invoked search_brain (which sends no timeoutMs) must not abort a healthy answer.
 */
function retrievalOptions(
  config: Config,
  soul: Soul,
  timeoutMs: number | undefined,
): RetrieveOptions | undefined {
  const delegate = soul.knowledgeBackend.route === 'delegate';
  const ownToken = delegate ? kbBearerFor(config, soul.knowledgeBackend.endpoint) : undefined;
  const effectiveTimeoutMs = timeoutMs ?? (delegate ? FORCED_RETRIEVAL_TIMEOUT_MS : undefined);
  if (effectiveTimeoutMs === undefined && ownToken === undefined) return undefined;
  return {
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
    ...(ownToken !== undefined ? { ownToken } : {}),
  };
}

/**
 * One retrieval for a SOUL. With KNOWLEDGE_SOURCE=ob-mcp the delegate route reads
 * OpenBrain through the MCP gateway instead of the SOUL's kb-server; the team (jarvis)
 * route is a different corpus and always uses its own lane. Callers filter the results
 * (scopeResults) whichever lane answered.
 */
async function retrieve(
  config: Config,
  soul: Soul,
  query: string,
  k: number,
  timeoutMs: number | undefined,
  ownerOnly: boolean,
): Promise<RetrieveResult> {
  if (config.knowledgeSource === 'ob-mcp' && soul.knowledgeBackend.route === 'delegate') {
    const lane = await obMcpSearch(config, query, k, timeoutMs ?? FORCED_RETRIEVAL_TIMEOUT_MS);
    // The kb-server applies the work scope itself before the bot's own filter; the gateway
    // does not, so the full row (metadata included, for the audience rule) is checked here.
    // scopeResults then checks the mapped results again, as on the kb-server lane.
    const safe = lane.results
      .filter(({ doc }) => isWorkSafe(doc, config.workScopeNamespaces, config.personalDenyTerms, ownerOnly) && !isCompensationDoc(doc))
      .map(({ text, source, score }) => ({ text, source, score }));
    return {
      results: safe.slice(0, k),
      lanes: { openbrain: { status: lane.status, ms: lane.ms }, teamKb: { status: 'empty', ms: 0 } },
    };
  }
  return retrieveForSoul(soul, query, k, config.teamKbEndpoint, retrievalOptions(config, soul, timeoutMs));
}

/**
 * How many rows to ask the backend for. The delegate route drops non-work rows after the
 * fetch, so it asks for extra (overfetchLimit) and trims to `limit` after the filter; the
 * team route is not filtered and asks for exactly `limit`.
 */
function fetchSize(soul: Soul, limit: number): number {
  return soul.knowledgeBackend.route === 'delegate' ? overfetchLimit(limit) : limit;
}

/**
 * Second layer of the work scope. On the delegate route every result is checked
 * against the bot's own filter before it is returned, formatted or sent to a model.
 * The team (jarvis) route is a different corpus and is not filtered here.
 */
function scopeResults(config: Config, soul: Soul, results: RankedChunk[], limit: number, ownerOnly: boolean): RankedChunk[] {
  const scoped =
    soul.knowledgeBackend.route === 'delegate'
      ? filterWorkScopedResults(results, config.workScopeNamespaces, config.personalDenyTerms, ownerOnly)
      : results;
  return scoped.slice(0, limit);
}

/**
 * True only when the delegate's own backend FAILED (connection refused, non-2xx such as a
 * bad bearer). A timeout is a slow answer, not a dead server: it returns empty results
 * without this flag, so the bot does not tell a client that David's notes are down.
 */
function isUnreachable(lanes: LaneMap): boolean {
  return lanes.openbrain.status === 'error';
}

function flatLaneStatuses(lanes: LaneMap): FlatLaneStatusMap {
  return { openbrain: lanes.openbrain.status, teamKb: lanes.teamKb.status };
}

function staticLanes(openbrain: LaneStatus, teamKb: LaneStatus): LaneMap {
  return { openbrain: { status: openbrain, ms: 0 }, teamKb: { status: teamKb, ms: 0 } };
}

function topScore(results: RankedChunk[]): number | null {
  let top: number | null = null;
  for (const result of results) {
    if (!Number.isFinite(result.score)) continue;
    top = top === null ? result.score : Math.max(top, result.score);
  }
  return top;
}

function elapsedMs(started: number): number {
  return Math.max(0, Date.now() - started);
}

function logObSearch(lanes: LaneMap, count: number, top_score: number | null, elapsed_ms: number, scope: string, window?: string): void {
  console.info(JSON.stringify({ level: 'info', msg: 'ob-search', lanes, count, top_score, elapsed_ms, scope, ...(window ? { window } : {}) }));
}

/**
 * When the question named a period of time ("yesterday", "last week", a date), keep only
 * the notes dated inside it. The backend also returns older notes that mention the period;
 * handed to the model, those were reported as if they were from it. With nothing dated
 * inside the period the model gets no results and an instruction to say so.
 */
export function applySearchWindow(
  results: RankedChunk[],
  window: SearchWindow | undefined,
): { results: RankedChunk[]; instruction?: string } {
  if (!window) return { results };
  const inside = results.filter((result) => result.inWindow === true);
  if (inside.length > 0) return { results: inside };
  return {
    results: [],
    instruction: `No work notes are dated in the period asked about: ${window.label} (${window.start.slice(0, 10)} to ${window.end.slice(0, 10)}). Say that you found nothing recorded for that period. Do not report older notes as if they were from it.`,
  };
}

/**
 * A channel or member name as it is put into the spoken read-back. Names come from the
 * relay, where anyone in the community sets their own: only plain name characters are
 * kept and the length is capped, so a name cannot carry a sentence of instructions.
 */
export function speakableName(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ._&'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean === '' ? 'unnamed' : clean;
}

/** How long after the read-back ends the owner may still say "send it". */
export const BUZZ_CONFIRM_WINDOW_MS = 45_000;

/** The read-back the SERVICE speaks, from the stored draft. The model never words it. */
export function buzzReadBack(draft: { channelName: string; memberNames: string[]; mentionNames: string[]; content: string }): string {
  const shown = draft.memberNames.slice(0, 6).map(speakableName);
  const more = draft.memberNames.length - shown.length;
  const people = shown.length > 0 ? `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'nobody I could list';
  return [
    `Buzz draft for the ${speakableName(draft.channelName)} channel.`,
    `In that channel: ${people}.`,
    ...(draft.mentionNames.length > 0 ? [`It will notify ${draft.mentionNames.map(speakableName).join(' and ')}.`] : []),
    `The message says: ${draft.content}`,
    'To send it, say: send it. To drop it, say: cancel.',
  ].join(' ');
}

/** What the talker is told when Buzz sending is asked for in a call that is not owner-only. */
export const BUZZ_OWNER_ONLY_REFUSAL =
  'You cannot send Buzz messages in this call. That works only when David is the host and the only person in the call. Say so plainly.';

interface BuzzDraft {
  meetingId: string;
  channelId: string;
  channelName: string;
  content: string;
  mentions: Array<{ pubkey: string; name: string }>;
  /** Sorted member pubkeys at draft time. */
  memberKeys: string[];
  createdAt: number;
  /** The exact read-back the service queued for this draft. */
  readBack: string;
  /** A confirmation counts only if it is said after this moment (most of the read-back heard)... */
  confirmFromMs: number;
  /** ...and no later than this one. */
  confirmUntilMs: number;
}

/** What the talker is told when a task for Claude Code is asked for in a call that is not owner-only. */
export const DELEGATE_OWNER_ONLY_REFUSAL =
  'You cannot hand tasks to Claude Code in this call. That works only when David is the host and the only person in the call. Say so plainly.';

/** What the talker is told when someone joined the call while an owner-only lookup ran. */
export const RESEARCHER_SCOPE_NARROWED_INSTRUCTION =
  'Someone else joined the call while this was being looked up, so the answer is withheld. Say that you cannot share that now that others are in the call. Say nothing else about it.';

/** What the talker is told when the researcher returned no answer (no key, a timeout, an error). */
export const RESEARCHER_FAILED_INSTRUCTION =
  'The lookup did not finish. Say that you could not look that up just now. Do not guess the answer.';

/** What the model is told when the calendar is asked for in a call that is not owner-only. */
export const CALENDAR_OWNER_ONLY_REFUSAL =
  'You cannot read the calendar in this call. The calendar is only available when David is the host and the only person in the call. Say that you cannot check the calendar here. Do not guess what is on it.';

/** What the model is told when a lookup is refused for want of approval. */
export const LOOKUP_APPROVAL_REFUSAL =
  'You have not been given permission to look this up. Ask the person who asked whether you may look it up. If they say yes, call approve_lookup and then search again.';

export const SCREEN_OFF_REFUSAL =
  'Screen viewing is switched off for this meeting. Say you cannot see the screen in this meeting, in one sentence.';
export const SCREEN_NOT_SHARED_REFUSAL =
  'No screen is being shared right now. Say you do not see a shared screen at the moment, in one sentence.';
export const SCREEN_NO_MODEL_REFUSAL =
  'Screen viewing is not set up on this service. Say you cannot look at the screen, in one sentence.';
export const SCREEN_FAILED_REFUSAL =
  'Looking at the screen failed. Say you could not read the screen just now, in one sentence. Do not describe it.';

export interface VoiceRouteOptions {
  /** Where artifacts are stored. Defaults to <cwd>/.data. */
  dataDir?: string;
  /** Reads one calendar's events. Defaults to gws-sa (the auto-join watcher's reader). */
  calendarEvents?: FetchCalendarEvents;
  /** The researcher's model client. Defaults to the Anthropic SDK with ANTHROPIC_API_KEY. */
  researchClient?: ResearchClient;
  /** Read-only mailbox search for the researcher. Defaults to gws-sa. */
  emailSearch?: (query: string, max: number) => Promise<unknown>;
  /** Runs gh for the researcher's GitHub lookups. Defaults to the gh CLI at GH_BIN. */
  gh?: GhJson;
  /** Runs one task in Claude Code. Defaults to `claude -p` at CLAUDE_CODE_BIN. */
  claudeCode?: ClaudeCodeRunner;
  /** Runs the Buzz CLI. Defaults to BUZZ_BIN with BUZZ_PRIVATE_KEY and BUZZ_RELAY_URL. */
  buzz?: BuzzJson;
  /** How long a send waits for the owner's spoken yes to arrive. Tests shorten it. */
  buzzConfirmWaitMs?: number;
  /** Scales the estimated length of the spoken read-back. Tests set 0. */
  buzzReadBackScale?: number;
  /** Describes a shared-screen frame. Defaults to the Anthropic model with ANTHROPIC_API_KEY. */
  screenDescriber?: ScreenDescriber;
}

export function createVoiceRoutes(config: Config, options: VoiceRouteOptions = {}): Hono {
  const app = new Hono();
  const buzz: BuzzJson | undefined =
    options.buzz ??
    (config.buzzBin && config.buzzPrivateKey && config.buzzRelayUrl
      ? buzzRunner({ bin: config.buzzBin, privateKey: config.buzzPrivateKey, relayUrl: config.buzzRelayUrl })
      : undefined);
  // Buzz drafts waiting for the owner's spoken yes. The text lives here, on the server:
  // the model passes only an id to the send, so what is sent is what was read back.
  const buzzDrafts = new Map<string, BuzzDraft>();

  app.post('/api/voice/ob-search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody;
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { soul, teammate, ownerOnly } = resolved.data;
    const query = typeof body.query === 'string' ? body.query : '';
    if (query.trim() === '') {
      return c.json({ error: 'query is required', code: 'BAD_REQUEST' }, 400);
    }

    if (soul.knowledgeBackend.route === 'delegate' && !delegateAllowed(soul, teammate)) {
      const lanes = staticLanes('error', 'empty');
      return c.json(
        {
          results: [],
          lanes,
          lane_statuses: flatLaneStatuses(lanes),
          unreachable: false,
          code: 'DELEGATE_OWNER_REQUIRED',
        },
        403,
      );
    }

    const parsedLimit = Number(body.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 6;
    const timeoutMs = clampTimeoutMs(body.timeoutMs);
    const started = Date.now();
    const retrieved = await retrieve(config, soul, query, fetchSize(soul, limit), timeoutMs, ownerOnly);
    const { lanes } = retrieved;
    const windowed = applySearchWindow(scopeResults(config, soul, retrieved.results, limit, ownerOnly), retrieved.window);
    const results = windowed.results;
    const elapsed_ms = elapsedMs(started);
    const score = topScore(results);
    logObSearch(lanes, results.length, score, elapsed_ms, scopeName(ownerOnly), retrieved.window?.label);
    return c.json({
      results,
      count: results.length,
      scope: scopeName(ownerOnly),
      ...(retrieved.window ? { window: retrieved.window } : {}),
      ...(windowed.instruction ? { instruction: windowed.instruction } : {}),
      lanes,
      lane_statuses: flatLaneStatuses(lanes),
      unreachable: isUnreachable(lanes),
      top_score: score,
      elapsed_ms,
    });
  });

  app.post('/api/voice/ob-context', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody;
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { soul, teammate, ownerOnly } = resolved.data;
    const query = typeof body.query === 'string' ? body.query : '';
    if (query.trim() === '') {
      return c.json({ error: 'query is required', code: 'BAD_REQUEST' }, 400);
    }

    if (soul.knowledgeBackend.route === 'delegate' && !delegateAllowed(soul, teammate)) {
      const lanes = staticLanes('error', 'empty');
      return c.json(
        {
          context: '',
          lanes,
          lane_statuses: flatLaneStatuses(lanes),
          unreachable: false,
          code: 'DELEGATE_OWNER_REQUIRED',
        },
        403,
      );
    }

    const parsedLimit = Number(body.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 5;
    const timeoutMs = clampTimeoutMs(body.timeoutMs);
    const started = Date.now();
    const retrieved = await retrieve(config, soul, query, fetchSize(soul, limit), timeoutMs, ownerOnly);
    const { lanes } = retrieved;
    const windowed = applySearchWindow(scopeResults(config, soul, retrieved.results, limit, ownerOnly), retrieved.window);
    const results = windowed.results;
    const elapsed_ms = elapsedMs(started);
    const context = formatWorkContext(results.map((r) => ({ entity_key: r.source, content: r.text })));
    return c.json({
      context,
      ...(retrieved.window ? { window: retrieved.window } : {}),
      ...(windowed.instruction ? { instruction: windowed.instruction } : {}),
      lanes,
      lane_statuses: flatLaneStatuses(lanes),
      unreachable: isUnreachable(lanes),
      top_score: topScore(results),
      elapsed_ms,
    });
  });

  /**
   * One local day of the owner's calendars. `error: 'BAD_DATE'` for a value that is not
   * YYYY-MM-DD. Callers decide who may ask; this function reads whenever it is called.
   */
  const calendarDay = async (requested: string | undefined): Promise<Record<string, unknown>> => {
    const timeZone = config.calendarTimeZone ?? 'America/New_York';
    const date = requested === undefined || requested === '' ? localYmd(Date.now(), timeZone) : requested;
    if (localDayBounds(date, timeZone) === null) return { error: 'BAD_DATE' };
    const gwsBin = config.gwsSaBin ?? 'gws-sa';
    const fetchEvents: FetchCalendarEvents =
      options.calendarEvents ?? ((calendarId, timeMinIso, timeMaxIso) => fetchCalendarEvents(gwsBin, calendarId, timeMinIso, timeMaxIso));
    const calendars = [
      config.calendarPrimaryAccount ?? 'owner@example.com',
      ...(config.calendarOptInAccounts ?? []),
    ];
    const started = Date.now();
    const day = await listDayEvents({ calendars, date, timeZone, fetchEvents });
    console.info(
      JSON.stringify({ level: 'info', msg: 'calendar-lookup', date, count: day.events.length, failed: day.failed.length, elapsed_ms: elapsedMs(started) }),
    );
    if (day.failed.length === calendars.length) {
      return {
        available: false,
        instruction: 'The calendar could not be read just now. Say that you could not reach the calendar. Do not guess what is on it.',
      };
    }
    return {
      available: true,
      date,
      today: localYmd(Date.now(), timeZone),
      time_zone: timeZone,
      events: day.events,
      count: day.events.length,
      ...(day.failed.length > 0 ? { unread_calendars: day.failed.length } : {}),
    };
  };

  // One day of the owner's calendar (the check_calendar tool). Calendar entries are
  // private, so the route answers only in an owner-only call; anywhere else the model
  // is told it cannot check, and no calendar is read.
  // What is on the shared screen (the look_at_screen tool). Answers only in a meeting
  // joined with screen viewing on, and only while someone is sharing. The newest frame
  // goes to a vision model once per question; the frame itself is never stored or logged.
  const screenDescriber: ScreenDescriber | undefined =
    options.screenDescriber ??
    (config.anthropicApiKey ? anthropicScreenDescriber(config.anthropicApiKey, config.anthropicModel) : undefined);
  app.post('/api/voice/screen', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { meetingId?: unknown; question?: unknown };
    const resolved = resolveMeeting(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { meeting } = resolved;
    if (meeting.screenShare !== true) {
      return c.json({ available: false, instruction: SCREEN_OFF_REFUSAL });
    }
    if (screenDescriber === undefined) {
      return c.json({ available: false, instruction: SCREEN_NO_MODEL_REFUSAL });
    }
    const frame = latestScreenFrame(meeting.meetingId);
    if (frame === undefined) {
      return c.json({ available: false, instruction: SCREEN_NOT_SHARED_REFUSAL });
    }
    const question =
      typeof body.question === 'string' && body.question.trim() !== '' ? body.question.trim().slice(0, 500) : 'What is on the screen?';
    try {
      const description = await screenDescriber(frame, question);
      if (description === '') return c.json({ available: false, instruction: SCREEN_FAILED_REFUSAL });
      return c.json({
        available: true,
        description,
        ...(frame.sharedBy !== undefined ? { shared_by: frame.sharedBy } : {}),
        seconds_old: Math.max(0, Math.round((Date.now() - frame.atMs) / 1000)),
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'screen: describe failed', error: err instanceof Error ? err.message : String(err) }));
      return c.json({ available: false, instruction: SCREEN_FAILED_REFUSAL });
    }
  });

  app.post('/api/voice/calendar', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { date?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    if (!resolved.data.ownerOnly) {
      return c.json({ available: false, instruction: CALENDAR_OWNER_ONLY_REFUSAL });
    }
    const day = await calendarDay(typeof body.date === 'string' ? body.date.trim() : undefined);
    if (day['error'] === 'BAD_DATE') return c.json({ error: 'date must be YYYY-MM-DD', code: 'BAD_REQUEST' }, 400);
    return c.json(day);
  });

  // The talker's one knowledge tool in researcher mode. A Claude model looks the answer
  // up with typed tools and returns it ready to say. The same access rules apply as on
  // the direct routes: notes go through the work-scope and period filters, and the
  // calendar and mailbox are offered only in an owner-only call.
  app.post('/api/voice/ask-researcher', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { question?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { soul, teammate, ownerOnly } = resolved.data;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question === '') return c.json({ error: 'question is required', code: 'BAD_REQUEST' }, 400);
    if (soul.knowledgeBackend.route === 'delegate' && !delegateAllowed(soul, teammate)) {
      return c.json({ answer: '', code: 'DELEGATE_OWNER_REQUIRED' }, 403);
    }
    const client: ResearchClient | undefined =
      options.researchClient ?? (config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : undefined);
    if (!client) {
      return c.json({ answer: '', code: 'RESEARCHER_UNAVAILABLE', instruction: RESEARCHER_FAILED_INSTRUCTION });
    }
    const audience = ownerOnly ? 'owner_only' : 'guests';
    const timeZone = config.calendarTimeZone ?? 'America/New_York';
    const gwsBin = config.gwsSaBin ?? 'gws-sa';
    const rawEmailSearch = options.emailSearch ?? ((query: string, max: number) => searchEmail(gwsRunner(gwsBin), query, max));
    // Pay is never spoken in either scope. A message whose subject or snippet is about pay
    // is dropped here, before the model sees it; the prompt rule is the second layer.
    const emailSearch = async (query: string, max: number): Promise<unknown> => {
      const found = (await rawEmailSearch(query, max)) as { messages?: Array<Record<string, unknown>> };
      const messages = (Array.isArray(found?.messages) ? found.messages : []).filter(
        (m) => !isCompensationDoc({ namespace: 'email', doc_type: 'email', entity_key: '', content: `${String(m['subject'] ?? '')} ${String(m['snippet'] ?? '')}` }),
      );
      return { messages, count: messages.length };
    };
    const docKeys: string[] = [];
    const gh: GhJson | undefined = options.gh ?? (config.ghBin ? ghRunner(config.ghBin) : undefined);
    const tools = buildResearchTools(
      {
        searchNotes: async (query, limit) => {
          const retrieved = await retrieve(config, soul, query, fetchSize(soul, limit), FORCED_RETRIEVAL_TIMEOUT_MS, ownerOnly);
          const windowed = applySearchWindow(scopeResults(config, soul, retrieved.results, limit, ownerOnly), retrieved.window);
          logObSearch(retrieved.lanes, windowed.results.length, topScore(windowed.results), 0, scopeName(ownerOnly), retrieved.window?.label);
          for (const hit of windowed.results) docKeys.push(hit.source);
          return {
            results: windowed.results.map((hit) => ({ source: hit.source, text: hit.text, ...(hit.date ? { date: hit.date } : {}) })),
            ...(retrieved.window ? { window: retrieved.window } : {}),
            ...(windowed.instruction ? { instruction: windowed.instruction } : {}),
            unreachable: isUnreachable(retrieved.lanes),
          };
        },
        calendarDay,
        searchEmail: emailSearch,
        ...(buzz
          ? {
              readBuzz: async (input: { channel?: string; limit: number }) => {
                const channels = await listChannels(buzz);
                if (!input.channel) return { channels: channels.map((channel) => channel.name) };
                const match = matchChannel(channels, input.channel);
                if (!('channel' in match)) return { error: 'No single channel has that name.', channels: match.candidates };
                return { channel: match.channel.name, messages: await readMessages(buzz, match.channel, input.limit) };
              },
            }
          : {}),
        ...(gh
          ? {
              searchPullRequests: (input: { query?: string; state?: string; limit: number }) => searchPullRequests(gh, input),
              pullRequestStatus: (input: { repo: string; number: number }) => pullRequestStatus(gh, input),
            }
          : {}),
      },
      audience,
    );
    // The obvious first lookups run before the model is called, at the same time: a notes
    // search with the question as asked (the backend reads its time words), and today's
    // calendar for a calendar question. Most answers then take one model call.
    const preload = async (name: string, input: Record<string, unknown>): Promise<PreloadedLookup | null> => {
      const tool = tools.find((t) => t.def.name === name);
      if (!tool) return null;
      const startedAt = Date.now();
      try {
        return { name, input, output: await tool.run(input), ms: Date.now() - startedAt };
      } catch {
        return null;
      }
    };
    const preloaded = (
      await Promise.all([
        preload('search_notes', { query: question, limit: 6 }),
        isCalendarQuestion(question) ? preload('check_calendar', {}) : Promise.resolve(null),
      ])
    ).filter((lookup): lookup is PreloadedLookup => lookup !== null);
    const now = Date.now();
    const result = await runResearcher({
      preloaded,
      // Web search runs on Anthropic's side and is billed per search. Public facts only,
      // so it is offered in both scopes.
      ...(config.researcherWebSearch ? { serverTools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] } : {}),
      client,
      model: config.researcherModel ?? 'claude-opus-5-5',
      effort: config.researcherEffort ?? 'low',
      ...(config.researcherSpeed === 'fast' ? { speed: 'fast' } : {}),
      question,
      audience,
      today: localYmd(now, timeZone),
      weekday: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(new Date(now)),
      timeZone,
      ownerName: config.ownerParticipantNames?.[0]?.replace(/^./, (ch) => ch.toUpperCase()) ?? 'David',
      tools,
    });
    // The lookup takes seconds. If someone joined meanwhile, an answer built from the
    // calendar, the mailbox or the wider notes scope must not be spoken to them.
    const after = resolveSoul(c, config, body);
    const scopeNarrowed = ownerOnly && !(after.ok && after.data.ownerOnly);
    if (scopeNarrowed) {
      console.info(JSON.stringify({ level: 'info', msg: 'researcher', scope: 'owner_only', code: 'SCOPE_NARROWED', elapsed_ms: result.elapsedMs }));
      return c.json({ answer: '', code: 'SCOPE_NARROWED', instruction: RESEARCHER_SCOPE_NARROWED_INSTRUCTION, scope: 'guests', tool_calls: [], doc_keys: [], elapsed_ms: result.elapsedMs });
    }
    console.info(
      JSON.stringify({
        level: 'info',
        msg: 'researcher',
        scope: scopeName(ownerOnly),
        model: result.model,
        steps: result.steps,
        tools: result.toolCalls.map((call) => ({ name: call.name, ms: call.ms, ...(call.error ? { error: true } : {}) })),
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        chars: result.answer.length,
        elapsed_ms: result.elapsedMs,
        ...(result.code ? { code: result.code } : {}),
      }),
    );
    return c.json({
      answer: result.answer,
      ...(result.code ? { code: result.code, instruction: RESEARCHER_FAILED_INSTRUCTION } : {}),
      scope: scopeName(ownerOnly),
      tool_calls: result.toolCalls.map((call) => call.name),
      doc_keys: Array.from(new Set(docKeys)),
      elapsed_ms: result.elapsedMs,
    });
  });

  // What the agent actually said for a queued line (the transcript of its own audio),
  // reported by its page. A Buzz send checks the read-back against this.
  app.post('/api/voice/spoken', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { text?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    if (typeof body.text === 'string') recordAgentSpoken(resolved.data.meetingId, body.text);
    return c.json({ ok: true });
  });

  // Buzz, step one: keep a draft and say who would receive it. Nothing is sent.
  app.post('/api/voice/buzz-draft', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { channel?: unknown; message?: unknown; mention?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { ownerOnly, meetingId, soul, teammate } = resolved.data;
    const refuse = (code: string, instruction: string) => c.json({ drafted: false, code, instruction });
    if (!buzz) return refuse('BUZZ_OFF', 'You cannot send Buzz messages in this setup. Say so plainly.');
    if (soul.personaMode !== 'first_person' || !delegateAllowed(soul, teammate) || !ownerOnly) return refuse('OWNER_ONLY', BUZZ_OWNER_ONLY_REFUSAL);
    const spokenChannel = typeof body.channel === 'string' ? body.channel.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (spokenChannel === '' || message === '') return c.json({ error: 'channel and message are required', code: 'BAD_REQUEST' }, 400);
    if (message.length > 600) return refuse('TOO_LONG', 'That message is too long to send from a call. Say so and ask for a shorter one.');
    let channels;
    try {
      channels = await listChannels(buzz);
    } catch {
      return refuse('BUZZ_UNREACHABLE', 'Buzz could not be reached just now. Say so. Nothing was drafted or sent.');
    }
    const match = matchChannel(channels, spokenChannel);
    if (!('channel' in match)) {
      return c.json({ drafted: false, code: 'CHANNEL', channels: match.candidates, instruction: 'No single Buzz channel has that name. Read the channel names out and ask which one. Do not pick one yourself.' });
    }
    const members = await channelMembers(buzz, match.channel.id).catch(() => []);
    const wanted = Array.isArray(body.mention) ? body.mention.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
    const mentions: Array<{ pubkey: string; name: string }> = [];
    for (const name of wanted) {
      // First names, with short forms: "Nick" finds "Nicholas" (they share "nic"), "Dan"
      // finds "Daniel". Three shared opening letters, and it must fit exactly one member.
      const want = name.trim().toLowerCase().split(/\s+/)[0] ?? '';
      const hits = members.filter((member) => {
        const first = member.name.toLowerCase().split(/\s+/)[0] ?? '';
        let shared = 0;
        while (shared < want.length && shared < first.length && want[shared] === first[shared]) shared += 1;
        return shared >= 3;
      });
      if (hits.length !== 1) {
        return c.json({ drafted: false, code: 'MENTION', members: members.map((member) => member.name), instruction: `Nobody, or more than one person, in that channel is called ${name}. Read the member names out and ask who to notify.` });
      }
      mentions.push(hits[0]!);
    }
    // One draft per meeting: a new one replaces the old, so a stale text can never be sent.
    for (const [id, draft] of buzzDrafts) if (draft.meetingId === meetingId) buzzDrafts.delete(id);
    const draftId = randomUUID();
    // The service speaks the read-back itself, from the stored draft: the channel, the
    // people and the text David hears are exactly what would be sent, whatever the model
    // was told by a note, an email or a Buzz message it read. A confirmation counts only
    // once most of that read-back has been heard, and for a short time after it ends.
    const readBack = buzzReadBack({ channelName: match.channel.name, memberNames: members.map((member) => member.name), mentionNames: mentions.map((member) => member.name), content: message });
    const readBackMs = (1500 + (readBack.length / 14) * 1000) * (options.buzzReadBackScale ?? 1);
    const createdAt = Date.now();
    buzzDrafts.set(draftId, {
      meetingId,
      channelId: match.channel.id,
      channelName: match.channel.name,
      content: message,
      mentions,
      memberKeys: members.map((member) => member.pubkey).sort(),
      createdAt,
      readBack,
      confirmFromMs: createdAt + readBackMs * 0.75,
      confirmUntilMs: createdAt + readBackMs + BUZZ_CONFIRM_WINDOW_MS,
    });
    enqueueCommand(meetingId, { type: 'say', text: readBack });
    console.info(JSON.stringify({ level: 'info', msg: 'buzz draft', channel: match.channel.name, chars: message.length, members: members.length, mentions: mentions.length }));
    // The exact draft is also put in the meeting chat, where David can read it.
    const meeting = getMeeting(meetingId);
    if (meeting) await postChat(config, meeting, `Buzz draft for ${match.channel.name}: ${message}`.slice(0, 3500), options.dataDir).catch(() => undefined);
    return c.json({
      drafted: true,
      draft_id: draftId,
      channel: match.channel.name,
      members: members.map((member) => member.name),
      mention: mentions.map((member) => member.name),
      message,
      instruction: 'Nothing has been sent. The application is reading the draft back to David in your voice right now. Say nothing yourself. When David then says "send it", call send_buzz_message with this draft_id. If he says anything else, do what he asks.',
    });
  });

  // Buzz, step two: send the draft, but only after the owner said yes out loud. The
  // service checks the owner's own words (src/buzz/confirm.ts), not the model's claim.
  app.post('/api/voice/buzz-send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { draftId?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { ownerOnly, meetingId, soul, teammate } = resolved.data;
    const refuse = (code: string, instruction: string) => c.json({ sent: false, code, instruction });
    if (!buzz) return refuse('BUZZ_OFF', 'You cannot send Buzz messages in this setup. Say so plainly.');
    if (soul.personaMode !== 'first_person' || !delegateAllowed(soul, teammate) || !ownerOnly) return refuse('OWNER_ONLY', BUZZ_OWNER_ONLY_REFUSAL);
    const draftId = typeof body.draftId === 'string' ? body.draftId : '';
    const draft = buzzDrafts.get(draftId);
    if (!draft || draft.meetingId !== meetingId) return refuse('NO_DRAFT', 'There is no draft to send. Say nothing was sent, and offer to draft the message again.');
    // The spoken line reaches the service a moment after it reaches the model: wait briefly.
    const deadline = Date.now() + (options.buzzConfirmWaitMs ?? 4000);
    let answer = ownerAnswerBetween(meetingId, draft.confirmFromMs, draft.confirmUntilMs);
    while (answer === 'none' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      answer = ownerAnswerBetween(meetingId, draft.confirmFromMs, draft.confirmUntilMs);
    }
    if (answer === 'none' && Date.now() > draft.confirmUntilMs) {
      buzzDrafts.delete(draftId);
      return refuse('EXPIRED', 'The time to confirm that draft has passed. Say nothing was sent, and offer to draft it again.');
    }
    // The read-back is spoken by a language model told to say it word for word. Its page
    // reports what was actually said; unless that carried the whole read-back (channel,
    // people, who is notified, and the text), David has not heard this draft and nothing
    // he said can confirm it.
    if (!agentSaidSince(meetingId, draft.createdAt, [draft.readBack])) {
      return refuse('READBACK_NOT_HEARD', 'The draft has not been read back to David as written. Nothing was sent. Say that, and offer to draft it again.');
    }
    if (answer === 'no') {
      buzzDrafts.delete(draftId);
      return refuse('DECLINED', 'David did not approve it. Say the message was not sent.');
    }
    if (answer !== 'yes') {
      return refuse('NOT_CONFIRMED', 'David has not said "send it" since the read-back finished. Nothing was sent. Tell him to say "send it" to send, and wait.');
    }
    // The audience David heard must still be the audience.
    const membersNow = await channelMembers(buzz, draft.channelId).catch(() => null);
    if (membersNow === null || membersNow.map((member) => member.pubkey).sort().join(',') !== draft.memberKeys.join(',')) {
      buzzDrafts.delete(draftId);
      return refuse('AUDIENCE_CHANGED', 'The people in that channel changed since the read-back, or could not be checked. Nothing was sent. Offer to draft it again.');
    }
    buzzDrafts.delete(draftId);
    if (config.buzzDryRun) {
      console.info(JSON.stringify({ level: 'info', msg: 'buzz send (dry run)', channel: draft.channelName, chars: draft.content.length }));
      return c.json({ sent: false, dry_run: true, channel: draft.channelName, instruction: 'This is a test run: the message passed every check but was not sent. Say that.' });
    }
    let result: { accepted: boolean; eventId: string; verified: boolean };
    try {
      result = await sendMessage(buzz, { channelId: draft.channelId, content: draft.content, mentionPubkeys: draft.mentions.map((member) => member.pubkey) });
    } catch {
      console.info(JSON.stringify({ level: 'warn', msg: 'buzz send failed', channel: draft.channelName }));
      return refuse('SEND_FAILED', 'Buzz did not accept the message. Say it was not sent.');
    }
    console.info(JSON.stringify({ level: 'info', msg: 'buzz sent', channel: draft.channelName, chars: draft.content.length, accepted: result.accepted, verified: result.verified, event: result.eventId.slice(0, 12) }));
    if (!result.accepted) return refuse('SEND_FAILED', 'Buzz did not accept the message. Say it was not sent.');
    const meeting = getMeeting(meetingId);
    if (meeting) {
      appendNote(
        meeting.botId ?? meeting.meetingId,
        { kind: 'note', text: `Buzz message sent to ${draft.channelName}: ${draft.content}`, at: new Date().toISOString(), by: 'agent' },
        ...(options.dataDir !== undefined ? [options.dataDir] : []),
      );
    }
    return c.json({
      sent: true,
      verified: result.verified,
      channel: draft.channelName,
      instruction: result.verified
        ? 'The message was sent and is in the channel. Say so in one short sentence.'
        : 'Buzz accepted the message, but it could not be read back from the channel. Say it was sent but not confirmed in the channel.',
    });
  });

  // Hand a task to Claude Code on this machine (the ask_claude_code tool). Owner-only:
  // the run can reach everything David's Claude Code can. The route answers at once;
  // the result is spoken and posted when the run finishes, or kept in the notes if
  // someone else has joined by then.
  app.post('/api/voice/delegate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { task?: unknown };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { ownerOnly, meetingId, soul, teammate } = resolved.data;
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (task === '') return c.json({ error: 'task is required', code: 'BAD_REQUEST' }, 400);
    // An allowlist, the same one the session route uses to offer the tool: only the
    // owner's own first-person persona, on its owner's token, may reach his Claude Code.
    if (soul.personaMode !== 'first_person' || !delegateAllowed(soul, teammate)) {
      return c.json({ started: false, code: 'PERSONA', instruction: 'You cannot hand tasks to Claude Code. Say so plainly.' });
    }
    if (!config.delegateEnabled && !options.claudeCode) {
      return c.json({ started: false, code: 'DELEGATE_OFF', instruction: 'You cannot hand tasks to Claude Code in this setup. Say so plainly.' });
    }
    if (!ownerOnly) {
      return c.json({ started: false, code: 'OWNER_ONLY', instruction: DELEGATE_OWNER_ONLY_REFUSAL });
    }
    const refusal = reserveDelegateSlot(meetingId);
    if (refusal) {
      return c.json({
        started: false,
        code: refusal,
        instruction:
          refusal === 'BUSY'
            ? 'Claude Code is still working on the previous task. Say that, and that you will report back when it is done. Do not start another.'
            : 'This meeting has reached its limit of tasks for Claude Code. Say so plainly.',
      });
    }
    const ownerName = config.ownerParticipantNames?.[0]?.replace(/^./, (ch) => ch.toUpperCase()) ?? 'David';
    const run: ClaudeCodeRunner =
      options.claudeCode ??
      ((text) =>
        runClaudeCode(delegatePrompt(text, ownerName), {
          bin: config.claudeCodeBin ?? 'claude',
          cwd: config.claudeCodeCwd ?? process.cwd(),
          timeoutMs: config.claudeCodeTimeoutMs ?? 300_000,
          maxBudgetUsd: config.claudeCodeMaxBudgetUsd ?? 2,
          disallowedTools: parseDisallowedTools(config.claudeCodeDisallowedTools),
        }));
    console.info(JSON.stringify({ level: 'info', msg: 'delegate started', chars: task.length }));
    void run(task)
      .then(async (result) => {
        console.info(
          JSON.stringify({ level: 'info', msg: 'delegate finished', ok: result.ok, ...(result.error ? { error: result.error } : {}), elapsed_ms: result.durationMs, cost_usd: result.costUsd, denied_tools: result.deniedTools, chars: result.result.length }),
        );
        const meeting = getMeeting(meetingId);
        const stillOwnerOnly =
          meeting !== undefined &&
          isOwnerOnly(meeting, { ownerNames: config.ownerParticipantNames ?? [], internalDomains: config.internalDomains ?? [] });
        const { spoken, details } = result.ok
          ? splitDelegateResult(result.result)
          : { spoken: `Claude Code could not finish that task${result.error === 'TIMEOUT' ? ' in time' : ''}.`, details: '' };
        // The result always goes to the meeting's notes, where only the owner reads it.
        if (meeting) {
          appendNote(
            meeting.botId ?? meeting.meetingId,
            { kind: 'note', text: `Claude Code task: ${task}\n\n${result.ok ? result.result.slice(0, 8000) : spoken}`, at: new Date().toISOString(), by: 'agent' },
            ...(options.dataDir !== undefined ? [options.dataDir] : []),
          );
        }
        if (!meeting || meeting.status !== 'live') return;
        if (!stillOwnerOnly) {
          // Someone joined while it ran: say only that it is done.
          enqueueCommand(meetingId, { type: 'say', text: 'The task you gave Claude Code has finished. The result is in the meeting notes.' });
          return;
        }
        enqueueCommand(meetingId, { type: 'say', text: `Claude Code finished. ${spoken}`.slice(0, 500) });
        if (details !== '') {
          await postChat(config, meeting, `Claude Code: ${details}`.slice(0, 3500), options.dataDir).catch(() => undefined);
        }
      })
      .catch((err) => {
        console.info(JSON.stringify({ level: 'warn', msg: 'delegate failed', reason: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => releaseDelegateSlot(meetingId));
    return c.json({
      started: true,
      instruction: 'Claude Code has started on it. Say that in one short sentence, and that you will report back when it is done. Do not guess the result.',
    });
  });

  // Exact-document read (the get_exact_document tool): POST <backend base>/document
  // on the SOUL's own work-scoped kb-server, with the bearer. Delegate route only —
  // the team persona never reads David's OpenBrain. The backend is not the only
  // gate: the document it returns is checked again with isWorkSafe + isCompensationDoc,
  // and a withheld document answers 404 exactly like a missing one, so a guessed
  // entity_key can never confirm that a personal document exists.
  app.post('/api/voice/ob-get-document', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as DocumentBody;
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { soul, teammate, ownerOnly } = resolved.data;
    const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : '';
    const doc_type = typeof body.doc_type === 'string' ? body.doc_type.trim() : '';
    const entity_key = typeof body.entity_key === 'string' ? body.entity_key.trim() : '';
    if (namespace === '' || doc_type === '' || entity_key === '') {
      return c.json({ error: 'namespace, doc_type and entity_key are required', code: 'BAD_REQUEST' }, 400);
    }

    if (soul.knowledgeBackend.route !== 'delegate') {
      return c.json({ error: 'Document not found', code: 'not_found' }, 404);
    }
    if (!delegateAllowed(soul, teammate)) {
      return c.json({ error: DELEGATE_OWNER_REQUIRED.error, code: DELEGATE_OWNER_REQUIRED.code }, 403);
    }

    const unavailable = () =>
      c.json(
        { error: 'knowledge backend unavailable', code: 'BACKEND_UNAVAILABLE', unreachable: true },
        502,
      );
    // Check what the backend actually returned, not what was asked for. A withheld
    // document answers 404 exactly like a missing one.
    const scoped = (document: {
      namespace: string;
      doc_type: string;
      entity_key: string;
      content: string;
      metadata?: Record<string, unknown>;
    }) =>
      !isWorkSafe(document, config.workScopeNamespaces, config.personalDenyTerms, ownerOnly) || isCompensationDoc(document)
        ? c.json({ error: 'Document not found', code: 'not_found' }, 404)
        : c.json({
            document: {
              namespace: document.namespace,
              doc_type: document.doc_type,
              entity_key: document.entity_key,
              content: document.content,
            },
          });

    if (config.knowledgeSource === 'ob-mcp') {
      const got = await obMcpGetDocument(config, { namespace, doc_type, entity_key }, FORCED_RETRIEVAL_TIMEOUT_MS);
      if (got.status === 'error') return unavailable();
      if (got.status === 'not_found') return c.json({ error: 'Document not found', code: 'not_found' }, 404);
      return scoped(got.document);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORCED_RETRIEVAL_TIMEOUT_MS);
    const documentUrl = `${backendBaseUrl(soul.knowledgeBackend.endpoint)}/document`;
    const bearer = kbBearerFor(config, documentUrl);
    let data: unknown;
    try {
      const response = await fetch(documentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ namespace, doc_type, entity_key }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        return c.json({ error: 'Document not found', code: 'not_found' }, 404);
      }
      if (!response.ok) return unavailable();
      data = await response.json();
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
    }

    const raw = (data as { document?: unknown } | null)?.document;
    const got = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (
      typeof got['namespace'] !== 'string' ||
      typeof got['doc_type'] !== 'string' ||
      typeof got['entity_key'] !== 'string' ||
      typeof got['content'] !== 'string'
    ) {
      return unavailable();
    }
    return scoped({
      namespace: got['namespace'],
      doc_type: got['doc_type'],
      entity_key: got['entity_key'],
      content: got['content'],
    });
  });

  // create_doc / create_whiteboard / update_artifact. Stores the artifact and, for a new
  // one, posts its link to the meeting chat. Session-token only, like /api/voice/save.
  // The content is meeting content and is never logged.
  app.post('/api/voice/artifact', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const resolved = resolveMeeting(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { meeting } = resolved;
    const content = typeof body['content'] === 'string' ? body['content'] : '';
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    if (content.trim() === '' || content.length > ARTIFACT_CONTENT_MAX_CHARS) {
      return c.json({ error: 'content is required', code: 'BAD_REQUEST' }, 400);
    }

    if (body['action'] === 'update') {
      const artifactId = typeof body['artifactId'] === 'string' ? body['artifactId'] : '';
      // Without a version the bot cannot know whether people edited the artifact, so a
      // missing or malformed one is treated as stale (version 0 never matches).
      const version = typeof body['version'] === 'number' && Number.isInteger(body['version']) ? body['version'] : 0;
      const result = updateArtifact(
        meeting.meetingId,
        artifactId,
        { content, ...(title !== '' ? { title } : {}), baseVersion: version },
        ...(options.dataDir !== undefined ? [options.dataDir] : []),
      );
      if (!result.ok && result.code === 'conflict') {
        // People edited it since the bot last saw it. Hand back what is stored so the
        // model merges its change into their text instead of erasing it.
        return c.json({
          ok: false,
          conflict: true,
          artifact_id: result.current.id,
          version: result.current.version,
          current_content: result.current.content,
          instruction:
            'People edited this since you last saw it. Apply your change to current_content and call update_artifact again with this version.',
        });
      }
      if (!result.ok) return c.json({ error: 'artifact not found', code: 'not_found' }, 404);
      console.info(JSON.stringify({ level: 'info', msg: 'artifact updated', kind: result.artifact.kind, version: result.artifact.version }));
      return c.json({ ok: true, artifact_id: result.artifact.id, version: result.artifact.version });
    }

    const kind: ArtifactKind | undefined = body['kind'] === 'doc' || body['kind'] === 'whiteboard' ? body['kind'] : undefined;
    if (body['action'] !== 'create' || kind === undefined || title === '') {
      return c.json({ error: 'action, kind and title are required', code: 'BAD_REQUEST' }, 400);
    }
    const artifact = createArtifact(
      meeting.meetingId,
      { kind, title, content },
      ...(options.dataDir !== undefined ? [options.dataDir] : []),
    );
    const url = artifactUrl(config, meeting.meetingId, artifact.id);
    const label = kind === 'doc' ? 'Doc' : 'Whiteboard';
    const posted = await postChat(config, meeting, `${label}: ${artifact.title} ${url}`, options.dataDir);
    console.info(JSON.stringify({ level: 'info', msg: 'artifact created', kind, linkPosted: posted.ok }));
    return c.json({
      ok: true,
      artifact_id: artifact.id,
      version: artifact.version,
      link_posted_in_chat: posted.ok,
      // The model must not read a link aloud; it only needs to know where the link went.
      instruction: posted.ok
        ? 'Tell the meeting in one short sentence that the link is in the chat.'
        : 'The link could not be posted to the chat. Say that it is on the meeting page instead.',
    });
  });

  // approve_lookup: the model calls this after the requester said yes. It opens a short
  // window in which the knowledge routes answer. Session-token only.
  app.post('/api/voice/approve-lookup', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const resolved = resolveMeeting(c, config, body);
    if (!resolved.ok) return resolved.response;
    approveLookup(resolved.meeting.meetingId);
    console.info(JSON.stringify({ level: 'info', msg: 'lookup approved', meetingId: resolved.meeting.meetingId }));
    return c.json({ ok: true, approved_for_seconds: LOOKUP_APPROVAL_WINDOW_MS / 1000 });
  });

  // save_meeting_note / flag_for_david. Both tools post here; the tags tell them
  // apart. The item is written next to the transcript (notes.ts) and later shown in
  // GET /api/meetings/:id and the post-meeting OpenBrain notes document. Nothing goes
  // to OpenBrain during the call. Session-token only (resolveMeeting): the bot page
  // is the only caller, so there is no owner bypass. No SOUL is needed.
  app.post('/api/voice/save', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SaveBody;
    const resolved = resolveMeeting(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { meeting } = resolved;
    const text = typeof body.content === 'string' ? body.content.trim() : '';
    if (text.length < 1 || text.length > MAX_NOTE_CHARS) {
      return c.json({ error: `content must be 1-${MAX_NOTE_CHARS} characters`, code: 'BAD_REQUEST' }, 400);
    }
    const kind = Array.isArray(body.tags) && body.tags.includes('meeting-flag') ? 'flag' : 'note';
    try {
      appendNote(meeting.botId ?? meeting.meetingId, { kind, text, at: new Date().toISOString(), by: 'agent' });
    } catch (err) {
      // Never log the note text itself.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'voice-save: failed to write note',
          meetingId: meeting.meetingId,
          kind,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.json({ error: 'could not save the note', code: 'NOTE_WRITE_FAILED' }, 500);
    }
    return c.json({ ok: true });
  });

  // Deep strategic analysis: the tier-2 "strong reasoner" behind the
  // deep_answer tool. Basic facts stay on the low-latency realtime model; when
  // the model calls deep_answer for an opinion/strategy question, this route
  // assembles broad context (same SOUL-scoped, comp-denied retrieval) and hands
  // it to a stronger text model (Claude) with a strategic-analysis prompt, then
  // returns the synthesized take for the realtime model to speak. Degrades to an
  // empty answer (never throws) so a provider hiccup can't break the turn.
  app.post('/api/voice/team-kb-answer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as VoiceBody & { question?: string };
    const resolved = resolveSoul(c, config, body);
    if (!resolved.ok) return resolved.response;
    const { soul, teammate, ownerOnly } = resolved.data;
    const question = typeof body.question === 'string' ? body.question
      : typeof body.query === 'string' ? body.query : '';
    if (question.trim() === '') {
      return c.json({ error: 'question is required', code: 'BAD_REQUEST' }, 400);
    }
    if (soul.knowledgeBackend.route === 'delegate' && !delegateAllowed(soul, teammate)) {
      return c.json({ answer: '', code: 'DELEGATE_OWNER_REQUIRED' }, 403);
    }
    if (!config.anthropicApiKey) {
      // No reasoner configured: signal fallback so the model answers inline.
      return c.json({ answer: '', code: 'REASONER_UNAVAILABLE' });
    }
    const started = Date.now();
    // Broad context: strategic questions need the frame (plans, assumptions,
    // prior discussion), not a tight top-6. Comp/personal denies still apply
    // via the SOUL-scoped retrieval lane.
    const retrieved = await retrieveForSoul(
      soul,
      question,
      fetchSize(soul, DEEP_ANSWER_RESULTS),
      config.teamKbEndpoint,
      retrievalOptions(config, soul, FORCED_RETRIEVAL_TIMEOUT_MS),
    );
    const results = scopeResults(config, soul, retrieved.results, DEEP_ANSWER_RESULTS, ownerOnly);
    const evidence = results
      .map((r, i) => `[${i + 1}] (${r.source}) ${r.text.slice(0, 1200)}`)
      .join('\n');
    const model = process.env['MEETING_DEEP_ANSWER_MODEL']?.trim() || config.anthropicModel;
    const system = [
      'You are the strategic-reasoning brain behind a voice meeting assistant.',
      'A participant has asked for ANALYSIS or an OPINION, not a fact lookup. Reason rigorously and form a clear, useful view.',
      'Use the EVIDENCE below as your grounding, but you MAY reason beyond it: weigh trade-offs, surface risks or gaps no one raised, and take a position - including respectful disagreement.',
      'Be intellectually honest: separate what the evidence supports from what you are inferring, and flag genuine uncertainty instead of sounding confident when you are not.',
      'Do NOT fabricate specific numbers, dates, or figures as if they were established facts.',
      'COMPENSATION and SALARY are strictly off-limits: never state, estimate, or hint at any pay/comp figure even if it appears in the evidence.',
      'Output will be READ ALOUD: no markdown, lists, or headings. 4 to 7 spoken sentences. Lead with your take, then the reasoning. No preamble, no closing question.',
    ].join(' ');
    try {
      const client = new Anthropic({ apiKey: config.anthropicApiKey });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let answer = '';
      try {
        const msg = await client.messages.create(
          {
            model,
            max_tokens: 700,
            system,
            messages: [{
              role: 'user',
              content: `Question: ${question}\n\nEvidence:\n${evidence || '(no strong retrieval hits - reason from the question and general knowledge, and say where you are inferring)'}`,
            }],
          },
          { signal: controller.signal },
        );
        answer = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
      } finally {
        clearTimeout(timer);
      }
      const elapsed_ms = elapsedMs(started);
      console.info(JSON.stringify({ level: 'info', msg: 'team-kb-answer', model, evidence: results.length, chars: answer.length, elapsed_ms }));
      return c.json({ answer, elapsed_ms });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      console.info(JSON.stringify({ level: 'warn', msg: 'team-kb-answer failed', reason: aborted ? 'timeout' : (err instanceof Error ? err.message : String(err)) }));
      return c.json({ answer: '', code: aborted ? 'REASONER_TIMEOUT' : 'REASONER_ERROR' });
    }
  });

  return app;
}
