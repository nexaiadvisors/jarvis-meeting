// In-memory meeting registry — replaces the DB `meetings` table for V1.
//
// A meeting is registered when a bot is dispatched, then looked up by the
// realtime-session / voice / meeting-state routes to source the teammate (and
// thus the SOUL). Module-level Map; process-local and ephemeral by design.

import { clearOwnerUtterances } from '../buzz/confirm.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PersonaMode } from '../soul/schema.js';

export type MeetingStatus = 'live' | 'completed' | 'failed';

export interface MeetingRecord {
  meetingId: string;
  botId?: string;
  teammate: string;
  persona: PersonaMode;
  title: string;
  status: MeetingStatus;
  /**
   * Why Recall reported the bot fatal (data.data.sub_code, else data.data.code), set
   * only by bot.fatal. Absent on every other meeting. Shown in the owner panel.
   */
  failureCode?: string;
  mutedAt?: number;
  /**
   * Random secret in the links to this meeting's page and artifacts. Anyone holding a
   * link can read and edit that meeting's page and artifacts, and nothing else.
   */
  shareToken?: string;
  /**
   * True when the bot only listens and takes notes in this meeting (an outside guest is
   * invited and EXTERNAL_GUEST_POLICY=notes_only): no spoken answers and no chat posts
   * except the join notice.
   */
  notesOnly?: boolean;
  /**
   * Epoch ms someone told the bot to stop listening. While set, nothing said or typed is
   * written to the transcript and the bot does not answer. Cleared when the wake word is
   * used again.
   */
  listeningPausedAt?: number;
  /** Epoch ms until which a knowledge lookup is approved (SOUL lookup_approval: ask). */
  lookupApprovedUntil?: number;
  /** Email addresses on the calendar invite (lowercased), when the calendar watcher started the meeting. */
  attendees?: string[];
  /** Epoch ms the owner (an owner name with the platform host flag and an id) was bound. Set once. */
  ownerSeenAt?: number;
  /** Epoch ms the owner left. Never cleared: the meeting keeps the guest scope to its end. */
  ownerLeftAt?: number;
  /** The platform participant id of the owner seen at ownerSeenAt. */
  ownerParticipantId?: string | number;
  /**
   * Epoch ms a participant who is neither the owner nor the bot was first seen (or one
   * with no name). Never cleared: once set, the meeting keeps the guest scope to its end.
   */
  outsiderSeenAt?: number;
  /**
   * Keys of the participants now in the call under an owner name (ownerPresenceKey).
   * Used only to decide when the bot should leave; a display name is not proof of the
   * owner, so nothing here widens what the bot may read or send.
   */
  ownerNamedPresent?: string[];
  /** Epoch ms the last participant with an owner name left. Cleared when one joins again. */
  ownerGoneAt?: number;
  /** True when the bot may look at the shared screen in this meeting (off unless asked for at join). */
  screenShare?: boolean;
  /** The name the bot shows in the call when it is not the service default (a facilitator SOUL uses its own name). */
  botName?: string;
  /**
   * The SOUL this meeting runs, when it is not the teammate's own (dispatch `soul`).
   * The voice session and the typed wake names load this one. Attribution stays with `teammate`.
   */
  soulSlug?: string;
  /** People in the call now: presence key -> the name they show. The bot is never in it. */
  participantNames?: Record<string, string>;
  /** True when the SOUL leads the call (mode: facilitator). */
  facilitator?: boolean;
  /** True when the SOUL speaks in the owner's place (mode: stand_in). */
  standIn?: boolean;
  /** Epoch ms the join notice was posted to the meeting chat. Set once. */
  noticeSentAt?: number;
  createdAt: number;
  /**
   * Last time the meeting showed activity (transcript.data OR a participant
   * presence/speech event). Seeded to createdAt at registration so a brand-new
   * meeting is never immediately idle. Drives the idle-timeout cost-control sweep.
   */
  lastActivityAt: number;
  /**
   * True once Recall reports the bot is actually IN the call (bot.in_call_recording).
   * Distinguishes "admitted and recording" from "still in the lobby / never joined".
   * The presence-aware sweep treats (inCall && participantCount > 0) as live even
   * across transcript gaps, so a present-but-silent bot is not idle-killed.
   */
  inCall: boolean;
  /**
   * Count of OTHER (human) participants currently in the call, maintained from
   * participant_events.join (++) / participant_events.leave (--). 0 means the bot
   * is alone. Never goes negative (clamped at 0).
   */
  participantCount: number;
}

const registry = new Map<string, MeetingRecord>();
let persistencePath: string | null = null;

function flushRegistry(): void {
  if (!persistencePath) return;
  try {
    mkdirSync(dirname(persistencePath), { recursive: true });
    const tmp = `${persistencePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...registry.values()], null, 2), 'utf8');
    renameSync(tmp, persistencePath);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'registry: failed to persist state',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Enable disk persistence for the meeting registry and rehydrate existing records.
 * Live meetings older than `maxAgeMs` (default 4h) are marked 'completed' on load
 * so an ancient crashed meeting never blocks the concurrency cap after a restart.
 */
export function enableRegistryPersistence(
  filePath: string = join(process.cwd(), '.data', 'registry.json'),
  opts: { maxLiveAgeMs?: number; nowMs?: number } = {},
): void {
  persistencePath = filePath;
  const maxLiveAgeMs = opts.maxLiveAgeMs ?? 4 * 60 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();
  if (!existsSync(filePath)) return;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return;
    let mutated = false;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as MeetingRecord;
      if (typeof rec.meetingId !== 'string' || !rec.meetingId) continue;
      if (rec.status === 'live' && nowMs - rec.createdAt > maxLiveAgeMs) {
        rec.status = 'completed';
        rec.inCall = false;
        mutated = true;
      }
      registry.set(rec.meetingId, rec);
    }
    if (mutated) flushRegistry();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'registry: failed to rehydrate state',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export function disableRegistryPersistence(): void {
  persistencePath = null;
}

/** Register (or replace) a meeting. Defaults status to 'live'. */
export function registerMeeting(
  r: Omit<MeetingRecord, 'createdAt' | 'status' | 'lastActivityAt' | 'inCall' | 'participantCount'> & {
    status?: MeetingStatus;
  },
): MeetingRecord {
  const now = Date.now();
  const record: MeetingRecord = {
    meetingId: r.meetingId,
    teammate: r.teammate,
    persona: r.persona,
    title: r.title,
    status: r.status ?? 'live',
    createdAt: now,
    lastActivityAt: now,
    inCall: false,
    participantCount: 0,
    shareToken: newShareToken(),
    ...(r.botId !== undefined ? { botId: r.botId } : {}),
    ...(r.mutedAt !== undefined ? { mutedAt: r.mutedAt } : {}),
    ...(r.notesOnly === true ? { notesOnly: true } : {}),
    ...(r.screenShare === true ? { screenShare: true } : {}),
    ...(typeof r.soulSlug === 'string' && r.soulSlug !== r.teammate ? { soulSlug: r.soulSlug } : {}),
    ...(r.facilitator === true ? { facilitator: true } : {}),
    ...(r.standIn === true ? { standIn: true } : {}),
    ...(typeof r.botName === 'string' && r.botName.trim() !== '' ? { botName: r.botName.trim() } : {}),
  };
  registry.set(r.meetingId, record);
  flushRegistry();
  return record;
}

function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The meeting's share token, or undefined for an unknown meeting. A record saved before
 * share tokens existed gets one on first use.
 */
export function shareTokenFor(id: string): string | undefined {
  const rec = registry.get(id);
  if (!rec) return undefined;
  if (rec.shareToken === undefined) {
    rec.shareToken = newShareToken();
    flushRegistry();
  }
  return rec.shareToken;
}

/** True when `presented` is this meeting's share token (constant-time). False for an unknown meeting. */
export function isShareToken(id: string, presented: string | undefined): boolean {
  const expected = shareTokenFor(id);
  if (expected === undefined || presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getMeeting(id: string): MeetingRecord | undefined {
  return registry.get(id);
}

/** Find a meeting by its Recall bot id. Linear scan — registry is small (live meetings). */
export function getMeetingByBotId(botId: string): MeetingRecord | undefined {
  for (const rec of registry.values()) {
    if (rec.botId === botId) return rec;
  }
  return undefined;
}

/**
 * Mark a meeting as active as of `nowMs`. Accepting the clock keeps callers
 * deterministic/testable. No-op when the meeting is unknown.
 */
export function touchActivity(id: string, nowMs: number): void {
  const rec = registry.get(id);
  if (rec) {
    rec.lastActivityAt = nowMs;
    flushRegistry();
  }
}

/** Every registered meeting (any status), newest first. Equal createdAt: the later registered first. */
export function listMeetings(): MeetingRecord[] {
  return [...registry.values()].reverse().sort((a, b) => b.createdAt - a.createdAt);
}

/** All meetings currently in the 'live' state. */
export function listLive(): MeetingRecord[] {
  const out: MeetingRecord[] = [];
  for (const rec of registry.values()) {
    if (rec.status === 'live') out.push(rec);
  }
  return out;
}

/** Count live meetings attributed to a teammate — the concurrency-cap input. */
export function countLiveForTeammate(teammate: string): number {
  let n = 0;
  for (const rec of registry.values()) {
    if (rec.status === 'live' && rec.teammate === teammate) n += 1;
  }
  return n;
}

/** Compact, dependency-free view of live meetings for /healthz (freshness probe). */
export interface LiveMeetingSummary {
  meetingId: string;
  teammate: string;
  persona: string;
  status: MeetingStatus;
  /** ms since the meeting was registered — a never-started/stale bot will be old. */
  ageMs: number;
  /** Whether Recall reports the bot is actually in the call (bot.in_call_recording). */
  inCall: boolean;
  /** Human participants currently in the call (0 = bot is alone). */
  participantCount: number;
  /**
   * ms since the last activity event (transcript OR presence). This is what makes
   * true bot state observable — a large value with inCall && participantCount>0
   * means "present but quiet", which the presence-aware sweep keeps alive.
   */
  msSinceLastTranscript: number;
}

/**
 * Summarize the live registry for the freshness probe. The registry is in-memory
 * and ephemeral, and `up.sh` is idempotent (won't clear it), so a kicked or
 * never-started bot lingers here and counts against the concurrency cap. The
 * join preflight reads this to decide whether to restart for a fresh state.
 */
export function summarizeLive(now: number = Date.now()): LiveMeetingSummary[] {
  return listLive().map((m) => ({
    meetingId: m.meetingId,
    teammate: m.teammate,
    persona: m.persona,
    status: m.status,
    ageMs: Math.max(0, now - m.createdAt),
    inCall: m.inCall,
    participantCount: m.participantCount,
    msSinceLastTranscript: Math.max(0, now - m.lastActivityAt),
  }));
}

export function setBotId(id: string, botId: string): void {
  const rec = registry.get(id);
  if (rec) {
    rec.botId = botId;
    flushRegistry();
  }
}

export function setStatus(id: string, status: MeetingStatus): void {
  const rec = registry.get(id);
  if (rec) {
    rec.status = status;
    flushRegistry();
  }
}

/** Record why a bot failed (the bot.fatal code). No-op when the meeting is unknown. */
export function setFailure(id: string, code: string): void {
  const rec = registry.get(id);
  if (rec) {
    rec.failureCode = code;
    flushRegistry();
  }
}

/** Mark whether the bot is actually in the call (set true on bot.in_call_recording). */
export function setInCall(id: string, inCall: boolean): void {
  const rec = registry.get(id);
  if (rec) {
    rec.inCall = inCall;
    flushRegistry();
  }
}

/**
 * Adjust the live human-participant count by `delta` (+1 on join, -1 on leave).
 * Clamps at 0 so a leave event that arrives without a matching join (or a
 * double-leave) can never drive the count negative. No-op when the meeting is
 * unknown. Returns the resulting count (or undefined when unknown).
 */
export function adjustParticipantCount(id: string, delta: number): number | undefined {
  const rec = registry.get(id);
  if (!rec) return undefined;
  rec.participantCount = Math.max(0, rec.participantCount + delta);
  flushRegistry();
  return rec.participantCount;
}

export interface SpeakerState {
  /** Names of participants currently marked speech_on within the active speech TTL. */
  activeSpeakers: string[];
  /** Most recent speaker observed via speech_on or transcript.data. */
  lastSpeaker?: string;
  /** Epoch ms when lastSpeaker was observed. */
  lastSpeakerAt?: number;
  /** True when 2+ participants are simultaneously in speech_on state. */
  overlappingSpeech: boolean;
}

/** Auto-expire speech_on entries after 15s if a speech_off webhook was dropped. */
const ACTIVE_SPEECH_TTL_MS = 15_000;
/** Consider lastSpeaker fresh for 10s after their last speech_on / transcript event. */
const LAST_SPEAKER_TTL_MS = 10_000;

interface InternalSpeakerTracker {
  activeSince: Map<string, number>;
  lastSpeaker?: string;
  lastSpeakerAt?: number;
}

const speakerTrackers = new Map<string, InternalSpeakerTracker>();

function getOrCreateSpeakerTracker(id: string): InternalSpeakerTracker {
  let t = speakerTrackers.get(id);
  if (!t) {
    t = { activeSince: new Map() };
    speakerTrackers.set(id, t);
  }
  return t;
}

function pruneStaleSpeakers(t: InternalSpeakerTracker, nowMs: number): void {
  for (const [name, since] of t.activeSince.entries()) {
    if (nowMs - since > ACTIVE_SPEECH_TTL_MS) {
      t.activeSince.delete(name);
    }
  }
}

export function recordParticipantSpeech(
  id: string,
  speakerName: string,
  speaking: boolean,
  nowMs: number = Date.now(),
): void {
  const clean = speakerName.trim();
  if (!clean || clean.toLowerCase() === 'unknown') return;
  if (!registry.has(id)) return;
  const t = getOrCreateSpeakerTracker(id);
  pruneStaleSpeakers(t, nowMs);
  if (speaking) {
    t.activeSince.set(clean, nowMs);
    t.lastSpeaker = clean;
    t.lastSpeakerAt = nowMs;
  } else {
    t.activeSince.delete(clean);
  }
}

export function recordTranscriptSpeaker(
  id: string,
  speakerName: string,
  nowMs: number = Date.now(),
): void {
  const clean = speakerName.trim();
  if (!clean || clean.toLowerCase() === 'unknown') return;
  if (!registry.has(id)) return;
  const t = getOrCreateSpeakerTracker(id);
  pruneStaleSpeakers(t, nowMs);
  t.lastSpeaker = clean;
  t.lastSpeakerAt = nowMs;
}

export function getSpeakerState(id: string, nowMs: number = Date.now()): SpeakerState {
  const t = speakerTrackers.get(id);
  if (!t) {
    return { activeSpeakers: [], overlappingSpeech: false };
  }
  pruneStaleSpeakers(t, nowMs);
  const activeSpeakers = [...t.activeSince.keys()];
  const freshLast =
    t.lastSpeaker !== undefined &&
    t.lastSpeakerAt !== undefined &&
    nowMs - t.lastSpeakerAt <= LAST_SPEAKER_TTL_MS
      ? t.lastSpeaker
      : activeSpeakers.length === 1
        ? activeSpeakers[0]
        : undefined;
  return {
    activeSpeakers,
    ...(freshLast !== undefined ? { lastSpeaker: freshLast } : {}),
    ...(t.lastSpeakerAt !== undefined ? { lastSpeakerAt: t.lastSpeakerAt } : {}),
    overlappingSpeech: activeSpeakers.length > 1,
  };
}

/**
 * Claim the one join notice for a meeting. Returns true the first time and false after,
 * so a repeated bot.in_call_recording never posts the notice twice.
 */
export function claimJoinNotice(id: string): boolean {
  const rec = registry.get(id);
  if (!rec || rec.noticeSentAt !== undefined) return false;
  rec.noticeSentAt = Date.now();
  flushRegistry();
  return true;
}

/** Pause or resume listening (see MeetingRecord.listeningPausedAt). No-op when the meeting is unknown. */
export function setListeningPaused(id: string, paused: boolean): void {
  const rec = registry.get(id);
  if (!rec) return;
  if (paused) {
    rec.listeningPausedAt = Date.now();
    // Nothing said before the pause may be used afterwards either.
    clearOwnerUtterances(id);
  }
  else delete rec.listeningPausedAt;
  flushRegistry();
}

/** How long one "yes, look it up" lasts: long enough for the lookups one answer needs. */
export const LOOKUP_APPROVAL_WINDOW_MS = 120_000;

/** Record that the requester approved a lookup. Returns false when the meeting is unknown. */
export function approveLookup(id: string, nowMs: number = Date.now()): boolean {
  const rec = registry.get(id);
  if (!rec) return false;
  rec.lookupApprovedUntil = nowMs + LOOKUP_APPROVAL_WINDOW_MS;
  flushRegistry();
  return true;
}

/** True while an approval recorded by approveLookup is still in force. */
export function isLookupApproved(id: string, nowMs: number = Date.now()): boolean {
  const until = registry.get(id)?.lookupApprovedUntil;
  return until !== undefined && nowMs < until;
}

export interface OwnerIdentityOptions {
  /** The owner's display names in a call, lowercase (config.ownerParticipantNames). */
  ownerNames: readonly string[];
  /** The bot's own display name; its events are neither owner nor outsider. */
  botName: string;
  /** Email domains that count as inside the company (config.internalDomains). */
  internalDomains?: readonly string[];
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The participant a webhook event names. `isHost` is the platform's host flag, when sent. */
export interface SeenParticipant {
  /** The platform's participant id, stable for one person within one call. */
  id?: string | number | undefined;
  name?: string | undefined;
  isHost?: boolean | undefined;
}

function isOwnerName(name: string | undefined, opts: OwnerIdentityOptions): boolean {
  const normalized = typeof name === 'string' ? normalizeName(name) : '';
  return normalized !== '' && opts.ownerNames.some((n) => normalizeName(n) === normalized);
}

/**
 * Note who a webhook event came from (a join, speech, a transcript line, a chat line).
 * A display name is chosen by the participant, so a name alone never proves the owner.
 * The owner is the participant with an owner name AND the platform's host flag; that
 * participant's id is remembered. Fail closed on everything else:
 *   - the bot's own name is ignored
 *   - an owner name with the host flag AND a participant id binds the owner: it sets
 *     ownerSeenAt and the owner's participant id, once per meeting (a second such
 *     participant with a different id is an outsider, and so is one with no id)
 *   - an owner name with no host flag counts as the owner only when its id is the
 *     remembered owner id; otherwise it is an outsider
 *   - any other name, or no name, is an outsider
 * outsiderSeenAt is never cleared. No-op for an unknown meeting.
 */
export function recordParticipantIdentity(
  id: string,
  participant: SeenParticipant,
  opts: OwnerIdentityOptions,
  nowMs: number = Date.now(),
): void {
  const rec = registry.get(id);
  if (!rec) return;
  const normalized = typeof participant.name === 'string' ? normalizeName(participant.name) : '';
  if (normalized !== '' && normalized === normalizeName(opts.botName)) return;
  // No id, no identity: an event that cannot be tied to one participant never binds or
  // matches the owner.
  const hasId = participant.id !== undefined;
  const sameAsOwner = hasId && rec.ownerParticipantId !== undefined && participant.id === rec.ownerParticipantId;
  let owner = false;
  if (hasId && isOwnerName(participant.name, opts)) {
    if (participant.isHost === true) owner = rec.ownerParticipantId === undefined || sameAsOwner;
    else if (participant.isHost === undefined) owner = sameAsOwner;
  }
  if (owner) {
    if (rec.ownerSeenAt !== undefined) return;
    rec.ownerSeenAt = nowMs;
    rec.ownerParticipantId = participant.id!;
  } else {
    if (rec.outsiderSeenAt !== undefined) return;
    rec.outsiderSeenAt = nowMs;
  }
  flushRegistry();
}

/** True when this participant id is the one bound as the meeting's owner. */
export function isOwnerParticipant(id: string, participantId: string | number | undefined): boolean {
  const rec = registry.get(id);
  return rec !== undefined && participantId !== undefined && rec.ownerParticipantId !== undefined && participantId === rec.ownerParticipantId;
}

/**
 * A participant left. When it is the owner (the bound id, or any participant with an
 * owner name), ownerLeftAt is set and never cleared: the meeting keeps the guest scope
 * to its end, even if the owner comes back. The bound id is kept, so nobody else can be
 * bound as the owner afterwards.
 */
export function recordParticipantLeft(id: string, participant: SeenParticipant, opts: OwnerIdentityOptions, nowMs: number = Date.now()): void {
  const rec = registry.get(id);
  if (!rec || rec.ownerLeftAt !== undefined) return;
  const isOwnerId = participant.id !== undefined && participant.id === rec.ownerParticipantId;
  if (!isOwnerId && !isOwnerName(participant.name, opts)) return;
  rec.ownerLeftAt = nowMs;
  flushRegistry();
}

/** One participant under an owner name: the platform id when sent, else the name. */
function ownerPresenceKey(participant: SeenParticipant): string {
  if (participant.id !== undefined) return `id:${String(participant.id)}`;
  return `name:${normalizeName(participant.name ?? '')}`;
}

/**
 * Track whether someone with an owner name is in the call, so the sweep can take the bot
 * out after the owner leaves (lifecycle/sweep.ts). A join adds the participant and clears
 * ownerGoneAt. A leave removes it; when nobody with an owner name remains, ownerGoneAt is
 * set. A leave by the participant bound as the owner (recordParticipantIdentity) counts
 * even when the event carries no name. Other participants never change anything.
 */
export function trackOwnerPresence(
  id: string,
  event: 'join' | 'leave',
  participant: SeenParticipant,
  opts: OwnerIdentityOptions,
  nowMs: number = Date.now(),
): void {
  const rec = registry.get(id);
  if (!rec) return;
  const boundOwner = participant.id !== undefined && participant.id === rec.ownerParticipantId;
  if (!boundOwner && !isOwnerName(participant.name, opts)) return;
  const key = ownerPresenceKey(participant);
  const present = new Set(rec.ownerNamedPresent ?? []);
  if (event === 'join') {
    present.add(key);
    delete rec.ownerGoneAt;
  } else {
    const known = present.delete(key);
    // A leave for someone never seen joining still means an owner-named person left.
    if (present.size === 0 && (known || rec.ownerGoneAt === undefined)) rec.ownerGoneAt = nowMs;
  }
  rec.ownerNamedPresent = [...present];
  flushRegistry();
}

/**
 * True only when the owner is positively the one person in a live call, so retrieval may
 * use the wider owner-only scope (agent/work-scope.ts). Every condition must hold; any
 * doubt keeps the guest scope:
 *   - owner names are configured (OWNER_PARTICIPANT_NAMES), else the feature is off
 *   - the meeting is live and not notes-only
 *   - the owner has been seen as the meeting host, has not left, and no outsider ever
 *     has been seen (in this meeting)
 *   - exactly one other participant is present
 *   - a calendar invite, when known, names nobody outside the internal domains
 */
export function isOwnerOnly(rec: MeetingRecord, opts: Pick<OwnerIdentityOptions, 'ownerNames' | 'internalDomains'>): boolean {
  if (opts.ownerNames.length === 0) return false;
  if (rec.status !== 'live' || rec.notesOnly === true) return false;
  if (rec.ownerSeenAt === undefined || rec.ownerLeftAt !== undefined || rec.outsiderSeenAt !== undefined) return false;
  if (rec.participantCount !== 1) return false;
  const attendees = rec.attendees ?? [];
  if (attendees.length > 1) {
    const domains = new Set((opts.internalDomains ?? []).map((d) => d.toLowerCase()));
    const allInside = attendees.every((email) => domains.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase()));
    if (!allInside) return false;
  }
  return true;
}

/** Record the calendar invite list on a meeting. No-op when the meeting is unknown. */
export function setAttendees(id: string, attendees: string[]): void {
  const rec = registry.get(id);
  if (rec) {
    rec.attendees = attendees;
    flushRegistry();
  }
}

export function setMuted(id: string, muted: boolean): void {
  const rec = registry.get(id);
  if (!rec) return;
  if (muted) {
    rec.mutedAt = Date.now();
  } else {
    delete rec.mutedAt;
  }
  flushRegistry();
}

/** Test-only: clear the registry between cases. */
export function __clearRegistry(): void {
  persistencePath = null;
  registry.clear();
  speakerTrackers.clear();
}

/**
 * Keep the list of people in the call. Called on every join and leave. The bot's own
 * name is never added. A participant with no name is not listed (the count still has them).
 */
export function trackParticipantName(
  id: string,
  event: 'join' | 'leave',
  participant: SeenParticipant,
  botName: string,
): void {
  const rec = registry.get(id);
  if (!rec) return;
  const name = typeof participant.name === 'string' ? participant.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (name !== '' && normalizeName(name) === normalizeName(botName)) return;
  const key = ownerPresenceKey(participant);
  const names = { ...(rec.participantNames ?? {}) };
  if (event === 'join') {
    if (name === '') return;
    names[key] = name;
  } else {
    delete names[key];
  }
  rec.participantNames = names;
  flushRegistry();
}

/** The names of the people in the call now, without duplicates, at most 12. */
export function getParticipantNames(id: string): string[] {
  const rec = registry.get(id);
  return [...new Set(Object.values(rec?.participantNames ?? {}))].slice(0, 12);
}
