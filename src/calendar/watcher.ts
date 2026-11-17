// Google Calendar Auto-Join Watcher.
//
// Polls Google Calendar via `gws-sa` (verified as owner@example.com),
// evaluates timed video meetings across owner@example.com (auto-join by
// default) and opt-in calendars (e.g. owner.personal@example.com when tagged [jarvis]),
// and dispatches Jarvis 2 minutes before start via a caller-supplied dispatcher
// (or POST /v1/dispatch).
//
// Deduplication and owner-panel Skip/Auto-join overrides are persisted in
// .data/calendar-dispatched.json so restarts never double-dispatch the same
// meeting.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { countLiveForTeammate, setAttendees } from '../meeting/registry.js';
import {
  evaluateCalendarEvent,
  extractMeetingUrlFromEvent,
  type CalendarMeetingCandidate,
  type RawCalendarEvent,
} from './extract-url.js';

const execFileAsync = promisify(execFile);

/** Default lookahead window (24h) so the owner panel shows upcoming meetings for the day. */
export const DEFAULT_CALENDAR_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/** Default grace window after meeting start (15m) during which an in-progress meeting still auto-joins. */
export const DEFAULT_CALENDAR_GRACE_AFTER_START_MS = 15 * 60 * 1000;

export interface DispatchedCalendarRecord {
  meetingId: string;
  botId: string;
  dispatchedAt: string;
  normalizedUrl: string;
  startMs: number;
  endMs: number;
}

export interface CalendarLedger {
  dispatched: Record<string, DispatchedCalendarRecord>;
  skippedKeys: string[];
  forcedJoinKeys: string[];
}

export interface UpcomingCalendarItem {
  eventKey: string;
  title: string;
  calendarId: string;
  startIso: string;
  endIso: string;
  meetingUrl: string;
  /** The repeating series (or the event itself). Per-meeting persona settings key on it. */
  seriesId: string;
  /** The persona (SOUL slug) set for this meeting; absent = the default notetaker. */
  soul?: string;
  willJoin: boolean;
  status: 'scheduled' | 'skipped' | 'dispatched';
  meetingId?: string;
  skipReason?: string;
}

export interface CalendarWatcherStatus {
  enabled: boolean;
  /** The owner's join rule (see JoinMode). */
  joinMode: JoinMode;
  lastPollAt: string | null;
  lastError: string | null;
  upcoming: UpcomingCalendarItem[];
}

function defaultLedgerPath(): string {
  return join(process.cwd(), '.data', 'calendar-dispatched.json');
}

export function loadCalendarLedger(filePath: string = defaultLedgerPath()): CalendarLedger {
  if (!existsSync(filePath)) {
    return { dispatched: {}, skippedKeys: [], forcedJoinKeys: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CalendarLedger>;
    return {
      dispatched:
        parsed.dispatched && typeof parsed.dispatched === 'object' ? parsed.dispatched : {},
      skippedKeys: Array.isArray(parsed.skippedKeys)
        ? parsed.skippedKeys.filter((k): k is string => typeof k === 'string')
        : [],
      forcedJoinKeys: Array.isArray(parsed.forcedJoinKeys)
        ? parsed.forcedJoinKeys.filter((k): k is string => typeof k === 'string')
        : [],
    };
  } catch {
    return { dispatched: {}, skippedKeys: [], forcedJoinKeys: [] };
  }
}

export function saveCalendarLedger(
  ledger: CalendarLedger,
  filePath: string = defaultLedgerPath(),
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'calendar-watcher: failed to save ledger',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * The owner's join rule, set in the panel and kept beside the ledger:
 *   - `all`: join every eligible calendar meeting.
 *   - `internal_only`: skip a meeting with an invitee outside the owner's own domains.
 *   - `manual`: join nothing unless the owner switches that meeting on.
 * A per-meeting choice in the panel always wins over the rule.
 */
export type JoinMode = 'all' | 'internal_only' | 'manual';
export const JOIN_MODES: readonly JoinMode[] = ['all', 'internal_only', 'manual'];

export interface JoinRule {
  mode: JoinMode;
  /** True when someone outside the owner's own domains is invited. */
  outside: boolean;
}

const PUBLIC_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);

function joinModePath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'calendar-join-mode.json');
}

export function loadJoinMode(ledgerPath: string = activeLedgerPath): JoinMode {
  try {
    const filePath = joinModePath(ledgerPath);
    // Never set: join everything, as before this setting existed.
    if (!existsSync(filePath)) return 'all';
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { mode?: unknown };
    // A saved rule that cannot be read must not turn into "join everything".
    return JOIN_MODES.includes(parsed.mode as JoinMode) ? (parsed.mode as JoinMode) : 'manual';
  } catch {
    return 'manual';
  }
}

export function saveJoinMode(mode: JoinMode, ledgerPath: string = activeLedgerPath): void {
  const filePath = joinModePath(ledgerPath);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode, at: new Date().toISOString() }, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

/**
 * Per-meeting settings, kept beside the ledger in calendar-personas.json and keyed by
 * series id (a repeating meeting's series, or a one-off event's id):
 *   - `soul`: the persona (SOUL slug) that auto-joins this meeting. Unset = the default
 *     notetaker. Example: the daily coaching call joins as the owner's stand-in.
 *   - `meetingUrl`: the join link, for an invite whose calendar copy carries none (the
 *     link was only in the organizer's email). Used only when the event has no link.
 */
export interface MeetingSetting {
  soul?: string;
  meetingUrl?: string;
  /** A label for the person reading the file; not used for matching. */
  title?: string;
}
export type MeetingSettings = Record<string, MeetingSetting>;

function meetingSettingsPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'calendar-personas.json');
}

export function loadMeetingSettings(ledgerPath: string = activeLedgerPath): MeetingSettings {
  try {
    const filePath = meetingSettingsPath(ledgerPath);
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { series?: unknown };
    if (!parsed.series || typeof parsed.series !== 'object') return {};
    const out: MeetingSettings = {};
    for (const [id, v] of Object.entries(parsed.series as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      const setting: MeetingSetting = {
        ...(typeof r['soul'] === 'string' && r['soul'] !== '' ? { soul: r['soul'] } : {}),
        ...(typeof r['meetingUrl'] === 'string' && r['meetingUrl'] !== '' ? { meetingUrl: r['meetingUrl'] } : {}),
        ...(typeof r['title'] === 'string' ? { title: r['title'] } : {}),
      };
      if (setting.soul !== undefined || setting.meetingUrl !== undefined) out[id] = setting;
    }
    return out;
  } catch {
    // A file that cannot be read sets nothing: every meeting keeps the default notetaker.
    return {};
  }
}

/**
 * Set or clear one meeting's persona and link. `soul: null` returns it to the default
 * notetaker; `meetingUrl: null` drops the saved link. A field left undefined is kept.
 */
export function saveMeetingSetting(
  seriesId: string,
  change: { soul?: string | null; meetingUrl?: string | null; title?: string },
  ledgerPath: string = activeLedgerPath,
): MeetingSettings {
  const all = loadMeetingSettings(ledgerPath);
  const next: MeetingSetting = { ...(all[seriesId] ?? {}) };
  if (change.soul === null) delete next.soul;
  else if (change.soul !== undefined) next.soul = change.soul;
  if (change.meetingUrl === null) delete next.meetingUrl;
  else if (change.meetingUrl !== undefined) next.meetingUrl = change.meetingUrl;
  if (change.title !== undefined) next.title = change.title;
  if (next.soul === undefined && next.meetingUrl === undefined) delete all[seriesId];
  else all[seriesId] = next;
  const filePath = meetingSettingsPath(ledgerPath);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ series: all, at: new Date().toISOString() }, null, 2), 'utf8');
  renameSync(tmp, filePath);
  return all;
}

/** A raw event with the saved link filled in, when the event itself has no link. */
export function withSavedMeetingUrl(raw: RawCalendarEvent, settings: MeetingSettings): RawCalendarEvent {
  const series = typeof raw.recurringEventId === 'string' && raw.recurringEventId !== '' ? raw.recurringEventId : raw.id;
  const url = series !== undefined ? settings[series]?.meetingUrl : undefined;
  if (url === undefined || extractMeetingUrlFromEvent(raw) !== null) return raw;
  return { ...raw, hangoutLink: url };
}

/** The join rule as it applies to one candidate, from the saved mode and the invite list. */
export function joinRuleFor(config: Config, ledgerPath: string = activeLedgerPath): (candidate: CalendarMeetingCandidate) => JoinRule {
  const mode = loadJoinMode(ledgerPath);
  const primary = config.calendarPrimaryAccount ?? 'owner@example.com';
  const own = [primary, ...(config.calendarOptInAccounts ?? ['owner.personal@example.com'])];
  // With no internal domain configured, the primary account's own domain is the company,
  // unless that is a public mail host: then nobody else counts as inside.
  const primaryDomain = primary.slice(primary.lastIndexOf('@') + 1).toLowerCase();
  const domains = (config.internalDomains ?? []).length > 0 ? config.internalDomains! : PUBLIC_MAIL_DOMAINS.has(primaryDomain) ? [] : [primaryDomain];
  return (candidate) => {
    // The organizer counts as a guest, and an invite list that may be incomplete counts as outside.
    const people = [...(candidate.attendeeEmails ?? []), ...(candidate.organizerEmail ? [candidate.organizerEmail] : [])];
    return { mode, outside: candidate.inviteListHidden === true || externalGuests(people, domains, own).length > 0 };
  };
}

/**
 * Effective auto-join decision for a candidate once owner-panel overrides
 * (`skippedKeys` and `forcedJoinKeys`) and the owner's join rule are applied.
 */
export function isCandidateWillJoin(
  candidate: CalendarMeetingCandidate,
  ledger: CalendarLedger,
  rule?: JoinRule,
): { willJoin: boolean; reason?: string } {
  if (ledger.skippedKeys.includes(candidate.eventKey)) {
    return { willJoin: false, reason: 'manual_skip' };
  }
  if (ledger.forcedJoinKeys.includes(candidate.eventKey)) {
    return { willJoin: true };
  }
  if (!candidate.eligible) {
    return {
      willJoin: false,
      ...(candidate.skipReason !== undefined ? { reason: candidate.skipReason } : {}),
    };
  }
  if (rule?.mode === 'manual') return { willJoin: false, reason: 'rule_manual' };
  if (rule?.mode === 'internal_only' && rule.outside) return { willJoin: false, reason: 'rule_outside_guest' };
  return { willJoin: true };
}

export interface DispatchDecisionOpts {
  leadTimeMs: number;
  graceAfterStartMs?: number;
}

/**
 * Pure decision: should this candidate be dispatched right now?
 * Checks:
 *   1. `isCandidateWillJoin` is true.
 *   2. Not already dispatched by `eventKey`.
 *   3. No overlapping event with the same `normalizedUrl` has already been dispatched.
 *   4. Current time `nowMs` is within `[startMs - leadTimeMs, min(endMs - 60_000, startMs + graceAfterStartMs)]`.
 */
export function shouldDispatchCandidate(
  candidate: CalendarMeetingCandidate,
  nowMs: number,
  opts: DispatchDecisionOpts,
  ledger: CalendarLedger,
  rule?: JoinRule,
): boolean {
  const { willJoin } = isCandidateWillJoin(candidate, ledger, rule);
  if (!willJoin) return false;

  if (ledger.dispatched[candidate.eventKey] !== undefined) return false;

  // Cross-calendar / duplicate invite dedupe: if another event with the same
  // normalized URL and overlapping time window was already dispatched, skip.
  for (const prev of Object.values(ledger.dispatched)) {
    if (
      prev.normalizedUrl === candidate.normalizedUrl &&
      prev.startMs < candidate.endMs &&
      prev.endMs > candidate.startMs
    ) {
      return false;
    }
  }

  const graceMs = opts.graceAfterStartMs ?? DEFAULT_CALENDAR_GRACE_AFTER_START_MS;
  const earliestMs = candidate.startMs - opts.leadTimeMs;
  const latestMs = Math.min(candidate.endMs - 60_000, candidate.startMs + graceMs);
  return nowMs >= earliestMs && nowMs <= latestMs;
}

/**
 * Build the owner-panel upcoming list from evaluated candidates and ledger state.
 */
export function toUpcomingItems(
  candidates: CalendarMeetingCandidate[],
  ledger: CalendarLedger,
  nowMs: number = Date.now(),
  ruleFor?: (candidate: CalendarMeetingCandidate) => JoinRule,
  settings: MeetingSettings = {},
): UpcomingCalendarItem[] {
  return candidates
    .filter((c) => c.endMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((c) => {
      const dispatched = ledger.dispatched[c.eventKey];
      if (dispatched) {
        return {
          eventKey: c.eventKey,
          title: c.title,
          calendarId: c.calendarId,
          startIso: c.startIso,
          endIso: c.endIso,
          meetingUrl: c.meetingUrl,
          seriesId: c.seriesId,
          ...(settings[c.seriesId]?.soul !== undefined ? { soul: settings[c.seriesId]!.soul! } : {}),
          willJoin: true,
          status: 'dispatched' as const,
          meetingId: dispatched.meetingId,
        };
      }
      const { willJoin, reason } = isCandidateWillJoin(c, ledger, ruleFor?.(c));
      return {
        eventKey: c.eventKey,
        title: c.title,
        calendarId: c.calendarId,
        startIso: c.startIso,
        endIso: c.endIso,
        meetingUrl: c.meetingUrl,
        seriesId: c.seriesId,
        ...(settings[c.seriesId]?.soul !== undefined ? { soul: settings[c.seriesId]!.soul! } : {}),
        willJoin,
        status: willJoin ? ('scheduled' as const) : ('skipped' as const),
        ...(reason !== undefined ? { skipReason: reason } : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// Runtime state and gws-sa polling
// ---------------------------------------------------------------------------

let latestCandidates: CalendarMeetingCandidate[] = [];
let lastPollAt: string | null = null;
let lastError: string | null = null;
let activeLedgerPath: string = defaultLedgerPath();

export function __setCalendarStateForTests(state: {
  candidates?: CalendarMeetingCandidate[];
  lastPollAt?: string | null;
  lastError?: string | null;
  ledgerPath?: string;
}): void {
  if (state.candidates !== undefined) latestCandidates = state.candidates;
  if (state.lastPollAt !== undefined) lastPollAt = state.lastPollAt;
  if (state.lastError !== undefined) lastError = state.lastError;
  if (state.ledgerPath !== undefined) activeLedgerPath = state.ledgerPath;
}

export function getCalendarWatcherStatus(
  config: Config,
  nowMs: number = Date.now(),
): CalendarWatcherStatus {
  const ledger = loadCalendarLedger(activeLedgerPath);
  return {
    enabled: Boolean(config.calendarAutoJoin),
    joinMode: loadJoinMode(activeLedgerPath),
    lastPollAt,
    lastError,
    upcoming: toUpcomingItems(latestCandidates, ledger, nowMs, joinRuleFor(config, activeLedgerPath), loadMeetingSettings(activeLedgerPath)),
  };
}

/**
 * Toggle whether an upcoming calendar event is skipped or joined.
 * When `skip: true`, adds `eventKey` to `skippedKeys` and removes from `forcedJoinKeys`.
 * When `skip: false`, removes from `skippedKeys` and adds to `forcedJoinKeys` (so even
 * an event on a personal calendar or with a tag can be manually toggled ON in the panel).
 */
export function setCalendarEventSkipOverride(
  eventKey: string,
  skip: boolean,
  ledgerPath: string = activeLedgerPath,
): CalendarLedger {
  const ledger = loadCalendarLedger(ledgerPath);
  const skipped = new Set(ledger.skippedKeys);
  const forced = new Set(ledger.forcedJoinKeys);
  if (skip) {
    skipped.add(eventKey);
    forced.delete(eventKey);
  } else {
    skipped.delete(eventKey);
    forced.add(eventKey);
  }
  const updated: CalendarLedger = {
    dispatched: ledger.dispatched,
    skippedKeys: [...skipped],
    forcedJoinKeys: [...forced],
  };
  saveCalendarLedger(updated, ledgerPath);
  return updated;
}

export async function runGwsJson(gwsBin: string, args: string[]): Promise<Record<string, unknown>> {
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env['HOME'] ?? ''}/.local/bin:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
  };
  const { stdout, stderr } = await execFileAsync(gwsBin, args, {
    env,
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const braceIdx = stdout.indexOf('{');
  if (braceIdx < 0) {
    throw new Error(`gws-sa returned non-JSON output: ${(stderr || stdout).slice(0, 160).trim()}`);
  }
  const parsed = JSON.parse(stdout.slice(braceIdx)) as Record<string, unknown>;
  if (parsed['error'] !== undefined) {
    throw new Error(`gws-sa API error: ${JSON.stringify(parsed['error']).slice(0, 200)}`);
  }
  return parsed;
}

// Events already logged as skipped by the stay_out policy, so each is logged once, not every poll.
const stayOutLogged = new Set<string>();

/**
 * The invitees who count as outside the company: everyone whose email domain is not in
 * `internalDomains`, except the owner's own calendar accounts. With no internal domain
 * configured every other invitee is outside, so a guest policy can only err toward caution.
 */
export function externalGuests(attendees: string[], internalDomains: string[], ownAccounts: string[]): string[] {
  const domains = new Set(internalDomains.map((d) => d.toLowerCase()));
  const own = new Set(ownAccounts.map((a) => a.toLowerCase()));
  return attendees.filter((raw) => {
    const email = raw.trim().toLowerCase();
    if (own.has(email)) return false;
    return !domains.has(email.slice(email.lastIndexOf('@') + 1));
  });
}

export interface PollCalendarDependencies {
  fetchEvents?: (calendarId: string, timeMinIso: string, timeMaxIso: string) => Promise<RawCalendarEvent[]>;
  verifyIdentity?: () => Promise<string>;
  dispatchMeeting?: (input: {
    meetingUrl: string;
    title: string;
    notesOnly?: boolean;
    /** The persona set for this meeting; absent = the service default. */
    soul?: string;
  }) => Promise<{ meetingId: string; botId: string }>;
  nowMs?: () => number;
  ledgerPath?: string;
}

/**
 * Execute one poll cycle: verify identity, read events across configured calendars,
 * update the cached upcoming list, and dispatch any meeting now inside the join window.
 */
/** Events on one calendar between two instants, read through gws-sa. */
export async function fetchCalendarEvents(
  gwsBin: string,
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<RawCalendarEvent[]> {
  const data = await runGwsJson(gwsBin, [
    'calendar',
    'events',
    'list',
    '--params',
    JSON.stringify({
      calendarId,
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    }),
  ]);
  return Array.isArray(data['items']) ? (data['items'] as RawCalendarEvent[]) : [];
}

export async function runCalendarPollOnce(
  config: Config,
  deps: PollCalendarDependencies = {},
): Promise<{ candidates: CalendarMeetingCandidate[]; dispatched: string[] }> {
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const ledgerPath = deps.ledgerPath ?? activeLedgerPath;
  activeLedgerPath = ledgerPath;
  const gwsBin = config.gwsSaBin ?? 'gws-sa';
  const primaryAccount = config.calendarPrimaryAccount ?? 'owner@example.com';
  const optInAccounts = config.calendarOptInAccounts ?? ['owner.personal@example.com'];
  const leadTimeMs = config.calendarLeadTimeMs ?? 120_000;

  const verifyIdentity =
    deps.verifyIdentity ??
    (async () => {
      const data = await runGwsJson(gwsBin, [
        'drive',
        'about',
        'get',
        '--params',
        JSON.stringify({ fields: 'user(emailAddress)' }),
      ]);
      const user = data['user'] as { emailAddress?: string } | undefined;
      return user?.emailAddress ?? '';
    });

  const fetchEvents =
    deps.fetchEvents ??
    ((calendarId: string, timeMinIso: string, timeMaxIso: string) =>
      fetchCalendarEvents(gwsBin, calendarId, timeMinIso, timeMaxIso));

  const dispatchMeeting =
    deps.dispatchMeeting ??
    (async ({ meetingUrl, title, notesOnly, soul }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.ownerToken) {
        headers['Authorization'] = `Bearer ${config.ownerToken}`;
      } else if (config.jarvisApiToken) {
        headers['Authorization'] = `Bearer ${config.jarvisApiToken}`;
      }
      const res = await fetch(`http://127.0.0.1:${config.port}/v1/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ meeting_url: meetingUrl, title, ...(notesOnly === true ? { notes_only: true } : {}), ...(soul !== undefined ? { soul } : {}) }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`dispatch HTTP ${res.status}: ${errText.slice(0, 160)}`);
      }
      return (await res.json()) as { meetingId: string; botId: string };
    });

  // 1. Verify gws-sa identity matches primary account
  const who = await verifyIdentity();
  if (who.toLowerCase() !== primaryAccount.toLowerCase()) {
    throw new Error(
      `gws-sa identity mismatch: got "${who}", expected "${primaryAccount}"`,
    );
  }

  // 2. Fetch events across primary + opt-in calendars
  const timeMinIso = new Date(now - 30 * 60_000).toISOString();
  const timeMaxIso = new Date(now + DEFAULT_CALENDAR_LOOKAHEAD_MS).toISOString();
  const calendars = [primaryAccount, ...optInAccounts.filter((c) => c !== primaryAccount)];

  const settings = loadMeetingSettings(ledgerPath);
  const allCandidates: CalendarMeetingCandidate[] = [];
  for (const calId of calendars) {
    try {
      const rawEvents = await fetchEvents(calId, timeMinIso, timeMaxIso);
      for (const raw of rawEvents) {
        const candidate = evaluateCalendarEvent(withSavedMeetingUrl(raw, settings), calId, {
          defaultAutoJoinCalendars: [primaryAccount],
        });
        if (candidate) allCandidates.push(candidate);
      }
    } catch (err) {
      // If an opt-in secondary calendar fails (e.g. not shared), log a warning and continue;
      // if the primary calendar fails, propagate the error so lastError reflects it.
      if (calId.toLowerCase() === primaryAccount.toLowerCase()) {
        throw err;
      }
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'calendar-watcher: opt-in calendar fetch failed',
          calendarId: calId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  latestCandidates = allCandidates;
  lastPollAt = new Date(now).toISOString();
  lastError = null;

  // 3. Dispatch eligible candidates inside the join window
  const ledger = loadCalendarLedger(ledgerPath);
  const dispatchedNow: string[] = [];

  const ruleFor = joinRuleFor(config, ledgerPath);
  for (const candidate of allCandidates) {
    if (!shouldDispatchCandidate(candidate, now, { leadTimeMs }, ledger, ruleFor(candidate))) {
      continue;
    }
    if (countLiveForTeammate(config.defaultTeammate) >= config.maxConcurrentPerTeammate) {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'calendar-watcher: concurrency cap reached, deferring auto-join',
          eventKey: candidate.eventKey,
          title: candidate.title,
        }),
      );
      continue;
    }

    // External-guest policy: an invitee outside the internal domains changes what the bot does.
    const policy = config.externalGuestPolicy ?? 'allow';
    const outside =
      policy === 'allow'
        ? []
        : externalGuests(candidate.attendeeEmails ?? [], config.internalDomains ?? [], [primaryAccount, ...optInAccounts]);
    if (policy === 'stay_out' && outside.length > 0) {
      if (!stayOutLogged.has(candidate.eventKey)) {
        stayOutLogged.add(candidate.eventKey);
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'calendar-watcher: staying out, an outside guest is invited',
            eventKey: candidate.eventKey,
            outsideCount: outside.length,
          }),
        );
      }
      continue;
    }
    const notesOnly = policy === 'notes_only' && outside.length > 0;

    try {
      const soul = settings[candidate.seriesId]?.soul;
      const { meetingId, botId } = await dispatchMeeting({
        meetingUrl: candidate.meetingUrl,
        title: candidate.title,
        ...(notesOnly ? { notesOnly: true } : {}),
        ...(soul !== undefined ? { soul } : {}),
      });
      ledger.dispatched[candidate.eventKey] = {
        meetingId,
        botId,
        dispatchedAt: new Date(now).toISOString(),
        normalizedUrl: candidate.normalizedUrl,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
      };
      saveCalendarLedger(ledger, ledgerPath);
      // Keep the invite list on the meeting record: the recap and the guest policy read it.
      setAttendees(meetingId, candidate.attendeeEmails ?? []);
      dispatchedNow.push(candidate.eventKey);
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'calendar-watcher: auto-joined calendar meeting',
          eventKey: candidate.eventKey,
          title: candidate.title,
          ...(soul !== undefined ? { soul } : {}),
          meetingId,
          botId,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'calendar-watcher: dispatch failed',
          eventKey: candidate.eventKey,
          title: candidate.title,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return { candidates: allCandidates, dispatched: dispatchedNow };
}

/**
 * Start the recurring Google Calendar auto-join watcher when config.calendarAutoJoin
 * is true. Runs an immediate first poll, then polls every config.calendarPollIntervalMs.
 */
export function startCalendarAutoJoinWatcher(
  config: Config,
  deps: PollCalendarDependencies = {},
): () => void {
  if (!config.calendarAutoJoin) {
    return () => {};
  }
  const pollIntervalMs = config.calendarPollIntervalMs ?? 60_000;

  const tick = () => {
    void runCalendarPollOnce(config, deps).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'calendar-watcher: poll failed',
          error: msg,
        }),
      );
    });
  };

  tick();
  const handle = setInterval(tick, pollIntervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
