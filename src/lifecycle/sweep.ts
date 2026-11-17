// Cost-control sweep — auto-leaves abandoned or runaway meetings.
//
// The expensive web_4_core Recall variant means a forgotten bot keeps billing
// until someone notices. This sweep periodically leaves any live meeting that is
// either idle (no transcript activity for idleMs) or has run past a hard ceiling
// (maxDurationMs).
//
// Design: the decision logic is a PURE function (selectMeetingsToLeave) that
// takes the live meetings + an injected `now`, so it is fully deterministic and
// unit-testable. Date.now() is read ONLY inside the interval callback of
// startCostControlSweep — never in the selector.

import type { Config } from '../config.js';
import type { MeetingRecord } from '../meeting/registry.js';
import { getMeeting, listLive, setInCall, setStatus } from '../meeting/registry.js';
import { leaveBot } from '../recall/leave-bot.js';
import { kickoffPipeline } from '../postmeeting/pipeline.js';

/** How long a probe of the knowledge-backend health URL may take before it is
 * treated as unhealthy. Short so it never delays the sweep tick. */
export const BACKEND_HEALTH_PROBE_TIMEOUT_MS = 1500;

/**
 * After the cost-control sweep auto-leaves a meeting, wait this long for Recall's
 * bot.done / bot.call_ended webhook to start the post-meeting pipeline, then start
 * it anyway as a backstop (kickoffPipeline is idempotent per botId).
 */
export const SWEEP_LEAVE_BACKSTOP_DELAY_MS = 90_000;

export interface StartSweepOptions {
  /** Delay before the sweep leave backstop starts the pipeline. Injectable for tests. */
  backstopDelayMs?: number;
}

export type LeaveReason = 'idle' | 'max_duration' | 'owner_left';

export interface LeaveSelection {
  meetingId: string;
  botId: string;
  reason: LeaveReason;
}

export interface SweepOpts {
  idleMs: number;
  maxDurationMs: number;
  /**
   * Leave this long after the last participant with an owner name left, even when other
   * people are still in the call. 0 or undefined turns the rule off.
   */
  ownerLeftGraceMs?: number;
}

/**
 * Pure selector: given the live meetings and the current time, decide which to
 * leave and why. A meeting is selected when it is over its max duration
 * (now - createdAt > maxDurationMs) OR idle (now - lastActivityAt > idleMs).
 * Meetings with no botId are skipped (there is nothing to leave). max_duration
 * takes precedence over idle when both apply.
 *
 * PRESENCE OVERRIDES IDLE: a meeting where the bot is actually in the call with
 * at least one human present (inCall && participantCount > 0) is treated as LIVE
 * regardless of how long it has been since the last transcript. This stops the
 * present-but-silent idle-kill — people often sit quietly (screen-share, thinking,
 * listening) for long stretches, and we are otherwise blind to that without the
 * participant_events presence signal. The hard max_duration ceiling still applies
 * (a genuinely runaway call is still swept), but idle alone cannot evict an
 * occupied call.
 */
export function selectMeetingsToLeave(
  live: MeetingRecord[],
  now: number,
  opts: SweepOpts,
): LeaveSelection[] {
  const out: LeaveSelection[] = [];
  for (const m of live) {
    if (m.botId === undefined) continue;
    const overMax = now - m.createdAt > opts.maxDurationMs;
    if (overMax) {
      out.push({ meetingId: m.meetingId, botId: m.botId, reason: 'max_duration' });
      continue;
    }
    // The owner left and did not come back within the grace period. This applies even
    // when other people are still in the call: the bot is the owner's, not theirs.
    const graceMs = opts.ownerLeftGraceMs ?? 0;
    if (graceMs > 0 && m.ownerGoneAt !== undefined && now - m.ownerGoneAt > graceMs) {
      out.push({ meetingId: m.meetingId, botId: m.botId, reason: 'owner_left' });
      continue;
    }
    // Present-but-quiet: bot is in-call AND a human is still here. Not idle no
    // matter the transcript gap. Only sweep as idle when the bot is truly alone.
    const occupied = m.inCall && m.participantCount > 0;
    if (occupied) continue;
    const idle = now - m.lastActivityAt > opts.idleMs;
    if (!idle) continue;
    out.push({ meetingId: m.meetingId, botId: m.botId, reason: 'idle' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 3: knowledge-backend health OBSERVATION (observe-and-report only).
//
// The sweep already runs every SWEEP_INTERVAL_MS, so it is the natural place to
// notice a silently-dead knowledge backend (the OpenBrain kb-server). We do NOT
// restart anything here — restart authority belongs to the OS-level supervisor
// (launchd), and a mid-answer restart would black out retrieval and race that
// supervisor. We only OBSERVE (probe the health URL) and REPORT (one structured
// warning line) so the outage is visible while delegate answers are ungrounded.
//
// The decision to warn is a PURE function so it is unit-testable with no IO, and
// the debounce (warn on healthy->unhealthy transition only, never every tick) is
// also pure — the mutable "previous state" lives in the interval closure.
// ---------------------------------------------------------------------------

/**
 * Pure decision: should we warn about the knowledge backend right now?
 * True only when the backend is down AND at least one meeting is live — a dead
 * backend with no live meeting is not worth a warning (nobody is being served an
 * ungrounded answer). Callers pair this with `shouldEmitBackendWarning` to
 * debounce repeat ticks.
 */
export function shouldWarnBackendUnhealthy(
  backendHealthy: boolean,
  liveMeetingCount: number,
): boolean {
  return !backendHealthy && liveMeetingCount > 0;
}

/**
 * Pure debounce: given whether this tick WANTS to warn (from
 * shouldWarnBackendUnhealthy) and whether the PREVIOUS tick already warned,
 * decide whether to actually emit now. Emits only on the healthy->unhealthy
 * transition (wantsToWarn && !alreadyWarned), so a sustained outage logs once,
 * not every SWEEP_INTERVAL_MS. Returns the emit decision plus the next
 * "already warned" state to carry into the following tick (so recovery re-arms
 * the warning for the next outage).
 */
export function shouldEmitBackendWarning(
  wantsToWarn: boolean,
  alreadyWarned: boolean,
): { emit: boolean; nextAlreadyWarned: boolean } {
  return { emit: wantsToWarn && !alreadyWarned, nextAlreadyWarned: wantsToWarn };
}

/**
 * Probe the knowledge-backend health URL. IO-only, NEVER throws, NEVER restarts.
 * Returns true iff the URL responds with a 2xx within the timeout; any error,
 * timeout, or non-2xx is treated as unhealthy (false). Kept separate from the
 * pure decision so tests need no network.
 */
export async function probeBackendHealthy(
  healthUrl: string,
  timeoutMs: number = BACKEND_HEALTH_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!healthUrl || healthUrl.trim() === '') return true; // unconfigured => nothing to warn about
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the recurring cost-control sweep. Every config.sweepIntervalMs it reads
 * the live meetings, runs the pure selector against Date.now(), and for each
 * selection leaves the bot (best-effort) and marks the meeting completed.
 * Returns a stop() that clears the interval.
 */
export function startCostControlSweep(config: Config, options: StartSweepOptions = {}): () => void {
  const opts: SweepOpts = { idleMs: config.idleTimeoutMs, maxDurationMs: config.maxDurationMs, ownerLeftGraceMs: config.ownerLeftGraceMs ?? 0 };
  const backstopDelayMs = options.backstopDelayMs ?? SWEEP_LEAVE_BACKSTOP_DELAY_MS;
  const backstopScheduled = new Set<string>();

  function scheduleBackstop(meeting: MeetingRecord & { botId: string }): void {
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
    }, backstopDelayMs);
    timer.unref?.();
  }

  // Debounce state for the backend-health warning (Layer 3). Lives in the
  // closure, not module scope, so multiple sweeps (tests) don't share it.
  let backendWarnedLastTick = false;

  const handle = setInterval(() => {
    // Layer 3: observe-and-report knowledge-backend health. Fire-and-forget so
    // it never delays the cost-control sweep below. Only runs when configured.
    if (config.kbBackendHealthCheckEnabled && config.kbBackendHealthUrl) {
      const healthUrl = config.kbBackendHealthUrl;
      const liveCount = listLive().length;
      void probeBackendHealthy(healthUrl).then((healthy) => {
        const wantsToWarn = shouldWarnBackendUnhealthy(healthy, liveCount);
        const { emit, nextAlreadyWarned } = shouldEmitBackendWarning(
          wantsToWarn,
          backendWarnedLastTick,
        );
        backendWarnedLastTick = nextAlreadyWarned;
        if (emit) {
          console.log(
            JSON.stringify({
              level: 'warn',
              msg: 'knowledge backend unhealthy while a meeting is live — delegate answers will be ungrounded (observe-only; no restart)',
              healthUrl,
              liveMeetingCount: liveCount,
            }),
          );
        }
      });
    }

    const selections = selectMeetingsToLeave(listLive(), Date.now(), opts);
    for (const sel of selections) {
      void leaveBot(config, sel.botId).then((result) => {
        // Recall already removed the bot (404/410): it is out of the call, so there is
        // nothing left to retry. Without this the meeting would stay 'live' and be
        // retried every sweep forever, counting against the concurrency cap.
        const gone = !result.ok && result.alreadyGone === true;
        console.log(
          JSON.stringify({
            level: result.ok || gone ? 'info' : 'warn',
            msg: result.ok
              ? 'cost-control sweep: left meeting'
              : gone
                ? 'cost-control sweep: bot already gone, retiring meeting'
                : 'cost-control sweep: leave FAILED, will retry next sweep',
            meetingId: sel.meetingId,
            botId: sel.botId,
            reason: sel.reason,
            ok: result.ok,
            ...(result.error !== undefined ? { error: result.error } : {}),
          }),
        );
        // Only retire the meeting once the leave actually succeeded (or the bot is
        // already gone). A failed leave stays 'live' so the NEXT sweep retries it —
        // otherwise a bot whose leave_call errored would keep billing AND drop out of
        // listLive() forever (defeating the cost control). A genuinely-ended meeting is
        // marked completed by the bot.done webhook, so this retry only spins on a
        // truly-stuck leave until Recall force-terminates the bot and fires bot.done.
        if (result.ok || gone) {
          const meeting = getMeeting(sel.meetingId);
          setInCall(sel.meetingId, false);
          setStatus(sel.meetingId, 'completed');
          if (meeting) {
            scheduleBackstop({ ...meeting, botId: sel.botId });
          }
        }
      });
    }
  }, config.sweepIntervalMs);

  // Don't keep the event loop alive solely for the sweep.
  handle.unref?.();

  return () => clearInterval(handle);
}
