// Take the bot out of a call. One path for the owner panel, the MCP tools and the
// in-call "leave" request, so each retires the meeting the same way.

import type { Config } from '../config.js';
import { leaveBot } from '../recall/leave-bot.js';
import { kickoffPipeline } from '../postmeeting/pipeline.js';
import { setInCall, setStatus, type MeetingRecord } from './registry.js';

/**
 * After a successful Leave, wait this long for Recall's bot.done / bot.call_ended webhook
 * to start the post-meeting pipeline, then start it anyway. The webhook only arrives when
 * the Recall dashboard webhook is registered with the current WEBHOOK_SECRET; the backstop
 * keeps the notes document from depending on that. kickoffPipeline is idempotent per botId,
 * so when the webhook came first this is a no-op.
 */
export const LEAVE_BACKSTOP_DELAY_MS = 90_000;

export type LeaveMeetingResult =
  | { ok: true; alreadyGone: boolean }
  | { ok: false; code: 'NO_BOT' | 'LEAVE_FAILED'; error: string };

// Meetings whose backstop is already scheduled, so a second Leave adds no timer.
const backstopScheduled = new Set<string>();

function scheduleBackstop(config: Config, meeting: MeetingRecord & { botId: string }, delayMs: number): void {
  if (backstopScheduled.has(meeting.meetingId)) return;
  backstopScheduled.add(meeting.meetingId);
  const timer = setTimeout(() => {
    backstopScheduled.delete(meeting.meetingId);
    kickoffPipeline(config, {
      botId: meeting.botId,
      meetingId: meeting.meetingId,
      meetingTitle: meeting.title,
      teammate: meeting.teammate,
    });
  }, delayMs);
  // Never keep the process alive for a backstop.
  timer.unref?.();
}

export async function leaveMeeting(
  config: Config,
  meeting: MeetingRecord,
  backstopDelayMs: number = LEAVE_BACKSTOP_DELAY_MS,
): Promise<LeaveMeetingResult> {
  if (meeting.botId === undefined) {
    return { ok: false, code: 'NO_BOT', error: 'Meeting has no bot to remove yet' };
  }
  const { botId } = meeting;
  const result = await leaveBot(config, botId);
  // Recall answered 404/410: it already removed the bot. The bot is out, so this is a
  // success. Treating it as a failure would leave the meeting 'live' forever and, with
  // MAX_CONCURRENT_PER_TEAMMATE=1, block every later Join.
  const alreadyGone = !result.ok && result.alreadyGone === true;
  if (!result.ok && !alreadyGone) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'leave FAILED', meetingId: meeting.meetingId, error: result.error }),
    );
    return { ok: false, code: 'LEAVE_FAILED', error: result.error ?? 'leave failed' };
  }

  // Retire the meeting as the cost-control sweep does after a successful leave, so the
  // panel and the concurrency cap stop counting it as live without waiting for the
  // bot.done webhook; then make sure the notes document does not depend on that webhook.
  setInCall(meeting.meetingId, false);
  setStatus(meeting.meetingId, 'completed');
  scheduleBackstop(config, { ...meeting, botId }, backstopDelayMs);
  console.info(
    JSON.stringify({
      level: 'info',
      msg: alreadyGone ? 'bot already gone, meeting retired' : 'left meeting',
      meetingId: meeting.meetingId,
    }),
  );
  return { ok: true, alreadyGone };
}

/** Test-only: forget scheduled backstops between cases. */
export function __clearLeaveBackstops(): void {
  backstopScheduled.clear();
}
