// POST /webhooks/recall — receives Recall.ai realtime events.
//
// Events handled:
//   transcript.data            — append {speaker, text, timestamp} to in-memory
//                                store and flush to .data/<botId>.jsonl on disk.
//   participant_events.join    — participantCount++ and touchActivity (presence
//                                keeps the meeting alive even when nobody speaks).
//   participant_events.leave   — participantCount-- and touchActivity.
//   participant_events.speech_on / .speech_off — touchActivity (speech is activity).
//   participant_events.chat_message — append the typed line to the transcript, kind 'chat'.
//   bot.*                      — account-level status events arrive for EVERY bot on the Recall
//                                account (the dashboard webhook). A bot this service did not
//                                create (no registry entry, no metadata.meeting_id) is ignored.
//   bot.in_call_recording      — mark the meeting inCall (admitted + recording).
//   bot.call_ended / bot.fatal — read data.data.{code,sub_code}, log the drop
//                                reason, mark failed/completed.
//   bot.done / bot.call_ended  — kick off the post-meeting pipeline (fire-and-forget).
//
// We subscribe to participant_events.* because true bot state is otherwise
// unobservable: we only ever saw transcript.data, and Recall's status_changes API
// is unreliable. Presence (join/leave) — not just speech — now keeps a meeting
// alive, so a present-but-quiet bot is not idle-killed.
//
// The route always responds 200 quickly (Recall requires <2s acknowledgement).
// The post-meeting pipeline runs entirely after the 200 is returned.
//
// Transcript parsing follows the PROVEN Recall webhook shape:
//   - New format: data.data.participant.name  +  data.data.words[].text
//   - Legacy format (fallback): data.transcript.speaker  +  data.transcript.words
// Both are handled; the new format takes priority.

import { Hono } from 'hono';
import { appendFileSync, mkdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { kickoffPipeline } from '../postmeeting/pipeline.js';
import { recordOwnerUtterance } from '../buzz/confirm.js';
import {
  getMeeting,
  getMeetingByBotId,
  touchActivity,
  setStatus,
  setFailure,
  setInCall,
  adjustParticipantCount,
  recordParticipantIdentity,
  recordParticipantLeft,
  trackOwnerPresence,
  trackParticipantName,
  recordParticipantSpeech,
  recordTranscriptSpeaker,
  isOwnerParticipant,
  claimJoinNotice,
  setListeningPaused,
} from '../meeting/registry.js';
import { joinNotice, postChat, withoutShareTokens } from '../meeting/chat.js';
import type { MeetingRecord } from '../meeting/registry.js';
import { meetingPageUrl } from './meeting-page.js';
import { enqueueCommand } from '../meeting/commands.js';
import { queueForExternalBrain, usesExternalBrain } from '../meeting/external-brain.js';
import { chatWakeRequest, isAddressedToAgent, isLeaveRequest, isStopCommand, isStopListeningCommand, isStopListeningRequest } from '../agent/wake-gate.js';
import { leaveMeeting } from '../meeting/leave.js';
import { loadSoul } from '../soul/loader.js';

/** Constant-time string compare (length-safe). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // dummy compare to avoid length timing side-channel
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface TranscriptEntry {
  speaker: string;
  text: string;
  timestamp: string;
  /** Set on a line typed in the meeting chat. */
  kind?: 'chat';
}

// In-memory buffer keyed by botId. Bounded to last 500 entries per bot to
// avoid unbounded growth on long calls; the JSONL file on disk is the durable record.
const transcriptBuffer = new Map<string, TranscriptEntry[]>();
const MAX_BUFFER = 500;

const DATA_DIR = join(process.cwd(), '.data');

function appendToJSONL(botId: string, entry: TranscriptEntry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, `${botId}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'webhook: failed to write JSONL',
        botId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** The name and host flag of the participant an event names. */
function seenParticipant(participant: Record<string, unknown> | undefined): { id?: string | number; name?: string; isHost?: boolean } {
  const id = participant?.['id'];
  const name = participant?.['name'];
  const isHost = participant?.['is_host'];
  return {
    ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof isHost === 'boolean' ? { isHost } : {}),
  };
}

/** Who counts as the owner and the bot when a webhook event names a participant. */
function identityOptions(config: Config, meeting?: { botName?: string }): { ownerNames: string[]; botName: string } {
  return { ownerNames: config.ownerParticipantNames ?? [], botName: meeting?.botName ?? config.jarvisBotName };
}

/**
 * Nobody should be recorded without knowing: say so in chat, once per meeting. Called on
 * bot.in_call_recording and also on the first transcript or participant event, because
 * the status event comes from the Recall dashboard webhook, which an account may not
 * have registered (the us-west-2 account on 2026-11-14 did not). Not awaited, so a slow
 * Recall call never delays the webhook's 200.
 */
function announceOnce(config: Config, meeting: MeetingRecord): void {
  if (!claimJoinNotice(meeting.meetingId)) return;
  void postChat(config, meeting, joinNotice(meeting.botName ?? config.jarvisBotName, meetingPageUrl(config, meeting.meetingId), meeting.screenShare === true, meeting.facilitator === true, meeting.standIn === true), undefined, {
    joinNotice: true,
  });
}

/** A typed request is cut to this length before it reaches the model. */
const ASK_MAX_CHARS = 1000;

/**
 * The names a typed request may start with: the SOUL's wake word and the bot name. Not
 * the SOUL's own name: a delegate SOUL can be named after its owner, and "David, can
 * you..." typed to the person must not wake the bot.
 */
function wakeNames(config: Config, soulSlug: string, botName?: string): string[] {
  const shown = botName ?? config.jarvisBotName;
  try {
    const soul = loadSoul(soulSlug, config.soulDir);
    return [soul.wakeWord, shown];
  } catch {
    return [shown];
  }
}

export function createWebhookRoute(config: Config): Hono {
  const app = new Hono();

  if (!config.webhookSecret) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'WEBHOOK_SECRET not set — /webhooks/recall is unauthenticated (dev mode); set it before exposing publicly',
      }),
    );
  }

  app.post('/webhooks/recall', async (c) => {
    // Webhook auth: when WEBHOOK_SECRET is set, Recall is configured (in
    // create-bot) to call us with ?s=<secret>. Reject anything else so a forged
    // bot.done cannot spoof the metadata-based teammate attribution that drives
    // auto-ingest + delivery. Unset = dev-mode allow (warned at startup).
    if (config.webhookSecret) {
      const provided = c.req.query('s') ?? '';
      if (!constantTimeEqual(provided, config.webhookSecret)) {
        // A stale or mistyped secret in the Recall dashboard URL would otherwise fail
        // silently (no bot.done ever arrives). Log the event type and the path only:
        // never the secret, the presented value or the query string.
        const rejected = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const rejectedEvent = typeof rejected?.['event'] === 'string' ? rejected['event'].slice(0, 64) : undefined;
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'webhook: rejected request, bad or missing secret',
            ...(rejectedEvent !== undefined ? { event: rejectedEvent } : {}),
            path: c.req.path,
          }),
        );
        return c.json({ ok: false, reason: 'unauthorized' }, 401);
      }
    }

    const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      return c.json({ ok: false, reason: 'invalid json' }, 400);
    }

    const event = typeof payload['event'] === 'string' ? payload['event'] : 'unknown';
    const data = payload['data'] as Record<string, unknown> | undefined;

    // Bot ID: new format has data.bot.id, legacy has data.bot_id.
    const botData = data?.['bot'] as Record<string, unknown> | undefined;
    const botId: string =
      typeof botData?.['id'] === 'string'
        ? botData['id']
        : typeof data?.['bot_id'] === 'string'
          ? (data['bot_id'] as string)
          : 'unknown';

    // Recall metadata echoed on the bot object (set by createBot): the spoof-proof way to
    // tell this service's bots from the other bots on the same Recall account.
    const metadata = botData?.['metadata'] as Record<string, unknown> | undefined;
    const metadataMeetingId =
      typeof metadata?.['meeting_id'] === 'string' && metadata['meeting_id'] !== ''
        ? metadata['meeting_id']
        : undefined;

    // The account-level dashboard webhook delivers bot.* events for every bot on the
    // account, not only the ones this service created. A foreign bot.done must not fall
    // back to DEFAULT_TEAMMATE and store an empty document in David's OpenBrain.
    if (event.startsWith('bot.') && getMeetingByBotId(botId) === undefined && metadataMeetingId === undefined) {
      console.info(JSON.stringify({ level: 'info', msg: 'ignored foreign bot', botId }));
      return c.json({ ok: true });
    }

    if (event === 'transcript.data') {
      // New Recall format: data.data.participant.name + data.data.words[].text
      // Legacy fallback: data.transcript.speaker + data.transcript.words
      const innerData = data?.['data'] as Record<string, unknown> | undefined;
      const legacyTranscript = data?.['transcript'] as Record<string, unknown> | undefined;
      const transcriptSource = innerData ?? legacyTranscript;

      const participantObj = innerData?.['participant'] as Record<string, unknown> | undefined;
      const speaker: string =
        typeof participantObj?.['name'] === 'string'
          ? participantObj['name']
          : typeof legacyTranscript?.['speaker'] === 'string'
            ? legacyTranscript['speaker']
            : 'Unknown';

      const wordsRaw = transcriptSource?.['words'];
      const text: string = Array.isArray(wordsRaw)
        ? (wordsRaw as Array<Record<string, unknown>>)
            .map((w) => (typeof w['text'] === 'string' ? w['text'] : ''))
            .join(' ')
            .trim()
        : typeof wordsRaw === 'string'
          ? wordsRaw
          : '';

      const timestamp = new Date().toISOString();
      const entry: TranscriptEntry = { speaker, text, timestamp };

      // "Stop listening": while paused, what is said is not kept anywhere.
      const paused = getMeetingByBotId(botId)?.listeningPausedAt !== undefined;
      if (!paused) {
        const buf = transcriptBuffer.get(botId) ?? [];
        buf.push(entry);
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
        transcriptBuffer.set(botId, buf);

        appendToJSONL(botId, entry);
      }

      // Mark the meeting active so the idle-timeout cost-control sweep sees
      // progress and does not leave a call that is still producing transcript.
      const nowMs = Date.now();
      const activeMeeting = getMeetingByBotId(botId);
      if (activeMeeting) {
        announceOnce(config, activeMeeting);
        touchActivity(activeMeeting.meetingId, nowMs);
        recordTranscriptSpeaker(activeMeeting.meetingId, speaker, nowMs);
        // Who spoke decides the retrieval scope: anyone but the owner locks the guest scope.
        recordParticipantIdentity(activeMeeting.meetingId, seenParticipant(participantObj), identityOptions(config, activeMeeting), nowMs);
        // What the owner says is the only thing that can confirm a send (src/buzz/confirm.ts).
        // "Stop listening" covers this too: while paused, nothing said is kept anywhere.
        if (!paused && isOwnerParticipant(activeMeeting.meetingId, seenParticipant(participantObj).id)) {
          recordOwnerUtterance(activeMeeting.meetingId, text, nowMs);
          // Quiet mode ends when the owner calls the agent by name. The page listens for
          // that in its own transcript of the mixed audio, which can miss it; this
          // transcript is per speaker, so the service tells the page too.
          const [wake = '', ...aliases] = wakeNames(config, activeMeeting.soulSlug ?? activeMeeting.teammate, activeMeeting.botName);
          if (wake !== '' && isAddressedToAgent(text, wake, aliases) && !isStopCommand(text, wake, aliases) && !isStopListeningCommand(text, wake, aliases)) {
            enqueueCommand(activeMeeting.meetingId, { type: 'wake', text: text.slice(0, 500) });
          }
        }
      }

      console.log(
        JSON.stringify({ level: 'info', msg: 'transcript.data', botId, speaker, chars: text.length }),
      );
    } else if (event === 'participant_events.chat_message') {
      // A line typed in the meeting chat: data.data.participant.name + data.data.data.text.
      // Stored in the same transcript file as speech, marked kind 'chat'. The text is
      // meeting content and is never logged.
      const innerData = data?.['data'] as Record<string, unknown> | undefined;
      const participantObj = innerData?.['participant'] as Record<string, unknown> | undefined;
      const speaker = typeof participantObj?.['name'] === 'string' ? participantObj['name'] : 'Unknown';
      const chat = innerData?.['data'] as Record<string, unknown> | undefined;
      const text = typeof chat?.['text'] === 'string' ? chat['text'].trim() : '';
      const stamp = innerData?.['timestamp'] as Record<string, unknown> | undefined;
      const absolute = typeof stamp?.['absolute'] === 'string' ? Date.parse(stamp['absolute']) : Number.NaN;
      const meeting = getMeetingByBotId(botId);
      // The bot's own posts are recorded when it sends them; an echo must not be stored twice.
      const ownEcho = speaker === (meeting?.botName ?? config.jarvisBotName);
      if (meeting) {
        recordParticipantIdentity(meeting.meetingId, seenParticipant(participantObj), identityOptions(config, meeting));
      }
      // A typed line that starts with the wake word is a request. Two requests are handled
      // here and never reach the model: leave, and stop listening. Any wake-word line ends
      // a "stop listening" pause.
      const typed = meeting && text !== '' && !ownEcho ? chatWakeRequest(text, wakeNames(config, meeting.soulSlug ?? meeting.teammate, meeting.botName)) : undefined;
      let handled = false;
      if (meeting && typed !== undefined && meeting.status === 'live') {
        if (isLeaveRequest(typed)) {
          handled = true;
          void leaveMeeting(config, meeting);
        } else if (isStopListeningRequest(typed)) {
          handled = true;
          setListeningPaused(meeting.meetingId, true);
        } else if (meeting.listeningPausedAt !== undefined) {
          setListeningPaused(meeting.meetingId, false);
        }
      }
      const pausedNow = meeting ? getMeetingByBotId(botId)?.listeningPausedAt !== undefined : false;
      if (meeting && text !== '' && !ownEcho && !pausedNow) {
        const entry: TranscriptEntry = {
          speaker,
          // Someone may paste a meeting or artifact link back into the chat: keep it without its token.
          text: withoutShareTokens(text),
          timestamp: new Date(Number.isFinite(absolute) ? absolute : Date.now()).toISOString(),
          kind: 'chat',
        };
        const buf = transcriptBuffer.get(botId) ?? [];
        buf.push(entry);
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
        transcriptBuffer.set(botId, buf);
        appendToJSONL(botId, entry);
        touchActivity(meeting.meetingId, Date.now());
        // A line that starts with the wake word is a request: queue it for the bot
        // page, which answers in the chat.
        const request = handled ? undefined : typed;
        if (request !== undefined && meeting.status === 'live' && meeting.notesOnly !== true) {
          const ask = { text: request.slice(0, ASK_MAX_CHARS), from: speaker };
          if (usesExternalBrain(config, meeting.teammate)) {
            queueForExternalBrain(meeting.meetingId, { ...ask, source: 'chat' });
          } else {
            enqueueCommand(meeting.meetingId, { type: 'ask', ...ask });
          }
        }
      }
      console.log(JSON.stringify({ level: 'info', msg: 'chat message', botId, chars: text.length, stored: Boolean(meeting && text !== '' && !ownEcho && !pausedNow) }));
    } else if (
      event === 'participant_events.join' ||
      event === 'participant_events.leave' ||
      event === 'participant_events.speech_on' ||
      event === 'participant_events.speech_off'
    ) {
      // Presence + speech are ACTIVITY. touchActivity on every one of these so a
      // present-but-silent bot (people listening / screen-sharing) is not idle-killed.
      // join/leave additionally maintain the live human-participant count, which the
      // presence-aware cost-control sweep reads to decide "truly alone vs occupied".
      const innerData = data?.['data'] as Record<string, unknown> | undefined;
      const participantObj =
        (innerData?.['participant'] as Record<string, unknown> | undefined) ??
        (data?.['participant'] as Record<string, unknown> | undefined);
      const participantName =
        typeof participantObj?.['name'] === 'string' ? participantObj['name'] : undefined;
      const nowMs = Date.now();
      const meeting = getMeetingByBotId(botId);
      if (meeting) {
        announceOnce(config, meeting);
        // A join or speech from anyone but the owner locks the guest scope. The owner
        // leaving ends the owner-only scope for whoever remains.
        if (event === 'participant_events.leave') {
          recordParticipantLeft(meeting.meetingId, seenParticipant(participantObj), identityOptions(config, meeting));
        } else {
          recordParticipantIdentity(meeting.meetingId, seenParticipant(participantObj), identityOptions(config, meeting), nowMs);
        }
        if (event === 'participant_events.join') {
          adjustParticipantCount(meeting.meetingId, +1);
          trackParticipantName(meeting.meetingId, 'join', seenParticipant(participantObj), meeting.botName ?? config.jarvisBotName);
          trackOwnerPresence(meeting.meetingId, 'join', seenParticipant(participantObj), identityOptions(config, meeting), nowMs);
        } else if (event === 'participant_events.leave') {
          adjustParticipantCount(meeting.meetingId, -1);
          trackParticipantName(meeting.meetingId, 'leave', seenParticipant(participantObj), meeting.botName ?? config.jarvisBotName);
          trackOwnerPresence(meeting.meetingId, 'leave', seenParticipant(participantObj), identityOptions(config, meeting), nowMs);
          if (participantName) {
            recordParticipantSpeech(meeting.meetingId, participantName, false, nowMs);
          }
        } else if (event === 'participant_events.speech_on' && participantName) {
          recordParticipantSpeech(meeting.meetingId, participantName, true, nowMs);
        } else if (event === 'participant_events.speech_off' && participantName) {
          recordParticipantSpeech(meeting.meetingId, participantName, false, nowMs);
        }
        touchActivity(meeting.meetingId, nowMs);
      }
      console.log(
        JSON.stringify({
          level: 'info',
          msg: event,
          botId,
          participantCount: meeting?.participantCount,
          hostFlag: typeof participantObj?.['is_host'] === 'boolean' ? participantObj['is_host'] : null,
          ownerSeen: meeting?.ownerSeenAt !== undefined,
          outsiderSeen: meeting?.outsiderSeenAt !== undefined,
          ownerNamedPresent: meeting?.ownerNamedPresent?.length ?? 0,
          ownerGone: meeting?.ownerGoneAt !== undefined,
        }),
      );
    } else if (event === 'bot.in_call_recording') {
      // The bot is admitted and recording. Mark inCall so the presence-aware sweep
      // treats an occupied-but-quiet call as live, and touchActivity so the clock
      // resets at the moment we actually joined.
      const meeting = getMeetingByBotId(botId);
      if (meeting) {
        setInCall(meeting.meetingId, true);
        touchActivity(meeting.meetingId, Date.now());
        announceOnce(config, meeting);
      }
      console.log(JSON.stringify({ level: 'info', msg: 'bot admitted', botId }));
    } else if (event === 'bot.fatal') {
      // The bot crashed/was force-terminated. Recall puts the reason in
      // data.data.{code,sub_code}. Log the drop and mark the meeting failed so it
      // drops out of listLive() and stops counting against the concurrency cap.
      const statusData = data?.['data'] as Record<string, unknown> | undefined;
      const code = typeof statusData?.['code'] === 'string' ? statusData['code'] : undefined;
      const subCode =
        typeof statusData?.['sub_code'] === 'string' ? statusData['sub_code'] : undefined;
      const meeting = getMeetingByBotId(botId);
      if (meeting) {
        setInCall(meeting.meetingId, false);
        setStatus(meeting.meetingId, 'failed');
        const failureCode = subCode ?? code;
        if (failureCode !== undefined) setFailure(meeting.meetingId, failureCode);
      }
      console.log(
        JSON.stringify({ level: 'warn', msg: `bot dropped ${subCode ?? code ?? 'unknown'}`, event, botId, code, sub_code: subCode }),
      );
    } else if (event === 'bot.done' || event === 'bot.call_ended') {
      // bot.call_ended carries the drop reason in data.data.{code,sub_code}
      // (e.g. timeout_exceeded_everyone_left). Surface it so a premature leave is
      // diagnosable instead of silent. bot.done is a clean finish with no sub_code.
      if (event === 'bot.call_ended') {
        const statusData = data?.['data'] as Record<string, unknown> | undefined;
        const code = typeof statusData?.['code'] === 'string' ? statusData['code'] : undefined;
        const subCode =
          typeof statusData?.['sub_code'] === 'string' ? statusData['sub_code'] : undefined;
        console.log(
          JSON.stringify({
            level: 'info',
            msg: `bot dropped ${subCode ?? code ?? 'unknown'}`,
            event,
            botId,
            code,
            sub_code: subCode,
          }),
        );
      }

      console.log(
        JSON.stringify({ level: 'info', msg: 'meeting complete, kicking off pipeline', event, botId }),
      );

      // Attribution from Recall-echoed metadata (the spoof-proof path set by
      // createBot). bot.done shape: data.bot.metadata = { meeting_id, teammate,
      // persona, soul_slug }. Fall back chain per field:
      //   meeting_id: metadata -> data.bot.external_id -> botId
      //   teammate:   metadata -> registry(meeting_id) -> config.defaultTeammate
      //   soul_slug:  metadata -> registry has no soulSlug, so omit when absent
      const meetingId =
        metadataMeetingId !== undefined
          ? metadataMeetingId
          : typeof botData?.['external_id'] === 'string'
            ? botData['external_id']
            : botId; // fallback: use botId as meetingId

      const registryRecord = getMeeting(meetingId);

      // The meeting is over: mark it completed so it drops out of listLive() and
      // no longer counts against the concurrency cap or the cost-control sweep.
      setInCall(meetingId, false);
      setStatus(meetingId, 'completed');

      const teammate =
        typeof metadata?.['teammate'] === 'string'
          ? metadata['teammate']
          : (registryRecord?.teammate ?? config.defaultTeammate);

      const soulSlug =
        typeof metadata?.['soul_slug'] === 'string' ? metadata['soul_slug'] : undefined;

      const meetingTitle =
        registryRecord?.title ??
        (typeof botData?.['bot_name'] === 'string' ? botData['bot_name'] : 'Meeting');

      kickoffPipeline(config, {
        botId,
        meetingId,
        meetingTitle,
        teammate,
        ...(soulSlug !== undefined ? { soulSlug } : {}),
      });
    } else {
      console.log(
        JSON.stringify({ level: 'debug', msg: 'unhandled recall event', event, botId }),
      );
    }

    return c.json({ ok: true });
  });

  return app;
}
