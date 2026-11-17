import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SWEEP_LEAVE_BACKSTOP_DELAY_MS,
  selectMeetingsToLeave,
  shouldWarnBackendUnhealthy,
  shouldEmitBackendWarning,
  startCostControlSweep,
} from './sweep.js';
import { __clearRegistry, getMeeting, registerMeeting } from '../meeting/registry.js';
import type { MeetingRecord } from '../meeting/registry.js';
import type { Config } from '../config.js';

const { mockLeaveBot, mockKickoffPipeline } = vi.hoisted(() => ({
  mockLeaveBot: vi.fn(),
  mockKickoffPipeline: vi.fn(),
}));
vi.mock('../recall/leave-bot.js', () => ({ leaveBot: mockLeaveBot }));
vi.mock('../postmeeting/pipeline.js', () => ({ kickoffPipeline: mockKickoffPipeline }));

function rec(partial: Partial<MeetingRecord> & { meetingId: string }): MeetingRecord {
  return {
    teammate: 'tester',
    persona: 'ai',
    title: 'Meeting',
    status: 'live',
    botId: `bot-${partial.meetingId}`,
    createdAt: 0,
    lastActivityAt: 0,
    inCall: false,
    participantCount: 0,
    ...partial,
  };
}

const NOW = 1_000_000;
const OPTS = { idleMs: 600_000, maxDurationMs: 7_200_000 };

describe('selectMeetingsToLeave', () => {
  it('picks the idle meeting (stale lastActivityAt) and leaves fresh ones alone', () => {
    const fresh = rec({ meetingId: 'fresh', createdAt: NOW - 60_000, lastActivityAt: NOW - 1_000 });
    const stale = rec({ meetingId: 'stale', createdAt: NOW - 60_000, lastActivityAt: NOW - 700_000 });

    const out = selectMeetingsToLeave([fresh, stale], NOW, OPTS);

    expect(out).toEqual([{ meetingId: 'stale', botId: 'bot-stale', reason: 'idle' }]);
  });

  it('picks the long-running meeting via max-duration even if recently active', () => {
    // created long ago, but lastActivityAt is recent => NOT idle, but over max.
    const longRun = rec({ meetingId: 'long', createdAt: NOW - 8_000_000, lastActivityAt: NOW - 1_000 });

    const out = selectMeetingsToLeave([longRun], NOW, OPTS);

    expect(out).toEqual([{ meetingId: 'long', botId: 'bot-long', reason: 'max_duration' }]);
  });

  it('reports max_duration when both idle and over-max apply (precedence)', () => {
    const both = rec({ meetingId: 'both', createdAt: NOW - 8_000_000, lastActivityAt: NOW - 700_000 });
    const out = selectMeetingsToLeave([both], NOW, OPTS);
    expect(out[0]?.reason).toBe('max_duration');
  });

  it('leaves fresh meetings untouched (empty selection)', () => {
    const a = rec({ meetingId: 'a', createdAt: NOW - 1_000, lastActivityAt: NOW - 500 });
    const b = rec({ meetingId: 'b', createdAt: NOW - 2_000, lastActivityAt: NOW - 100 });
    expect(selectMeetingsToLeave([a, b], NOW, OPTS)).toEqual([]);
  });

  it('skips meetings with no botId (nothing to leave)', () => {
    const noBot: MeetingRecord = {
      meetingId: 'nobot',
      teammate: 'tester',
      persona: 'ai',
      title: 'm',
      status: 'live',
      createdAt: NOW - 8_000_000,
      lastActivityAt: NOW - 700_000,
      inCall: false,
      participantCount: 0,
    };
    expect(selectMeetingsToLeave([noBot], NOW, OPTS)).toEqual([]);
  });

  it('keeps a present-but-silent bot alive (inCall + participantCount>0 + stale lastActivityAt => NOT swept)', () => {
    // The bot is admitted (inCall) with a human still present, but nobody has
    // spoken in well over the idle window. Presence overrides the transcript gap.
    const quiet = rec({
      meetingId: 'quiet',
      createdAt: NOW - 60_000,
      lastActivityAt: NOW - 5_000_000, // far past idleMs
      inCall: true,
      participantCount: 1,
    });

    expect(selectMeetingsToLeave([quiet], NOW, OPTS)).toEqual([]);
  });

  it('sweeps a truly-alone bot as idle (inCall but participantCount===0 + stale)', () => {
    // Bot is in-call but everyone left; the transcript gap now genuinely means idle.
    const alone = rec({
      meetingId: 'alone',
      createdAt: NOW - 60_000,
      lastActivityAt: NOW - 700_000,
      inCall: true,
      participantCount: 0,
    });

    expect(selectMeetingsToLeave([alone], NOW, OPTS)).toEqual([
      { meetingId: 'alone', botId: 'bot-alone', reason: 'idle' },
    ]);
  });

  it('still sweeps an occupied bot once it blows past max_duration (presence does NOT override the hard ceiling)', () => {
    const runaway = rec({
      meetingId: 'runaway',
      createdAt: NOW - 8_000_000, // over maxDurationMs
      lastActivityAt: NOW - 1_000, // recently active
      inCall: true,
      participantCount: 3,
    });

    expect(selectMeetingsToLeave([runaway], NOW, OPTS)).toEqual([
      { meetingId: 'runaway', botId: 'bot-runaway', reason: 'max_duration' },
    ]);
  });

  it('is deterministic for a fixed now (no Date.now in the selector)', () => {
    const m = rec({ meetingId: 'd', createdAt: NOW - 60_000, lastActivityAt: NOW - 700_000 });
    const first = selectMeetingsToLeave([m], NOW, OPTS);
    const second = selectMeetingsToLeave([m], NOW, OPTS);
    expect(first).toEqual(second);
  });
});

describe('shouldWarnBackendUnhealthy', () => {
  it('warns when backend is down AND a meeting is live', () => {
    expect(shouldWarnBackendUnhealthy(false, 1)).toBe(true);
    expect(shouldWarnBackendUnhealthy(false, 3)).toBe(true);
  });

  it('does NOT warn when the backend is down but no meeting is live', () => {
    // A dead backend with nobody being served is not worth a warning.
    expect(shouldWarnBackendUnhealthy(false, 0)).toBe(false);
  });

  it('does NOT warn when the backend is healthy, regardless of live count', () => {
    expect(shouldWarnBackendUnhealthy(true, 0)).toBe(false);
    expect(shouldWarnBackendUnhealthy(true, 5)).toBe(false);
  });
});

describe('shouldEmitBackendWarning (debounce)', () => {
  it('emits on the healthy->unhealthy transition (first bad tick)', () => {
    expect(shouldEmitBackendWarning(true, false)).toEqual({ emit: true, nextAlreadyWarned: true });
  });

  it('stays quiet on a sustained outage (already warned)', () => {
    expect(shouldEmitBackendWarning(true, true)).toEqual({ emit: false, nextAlreadyWarned: true });
  });

  it('re-arms on recovery so the NEXT outage warns again', () => {
    // Recovered tick: does not want to warn, and clears the warned flag.
    expect(shouldEmitBackendWarning(false, true)).toEqual({ emit: false, nextAlreadyWarned: false });
    // Stays disarmed while healthy.
    expect(shouldEmitBackendWarning(false, false)).toEqual({ emit: false, nextAlreadyWarned: false });
  });

  it('logs exactly once across a down->down->up->down sequence', () => {
    // Simulate the debounce state machine across ticks.
    let warned = false;
    const emits: boolean[] = [];
    for (const wants of [true, true, false, true]) {
      const { emit, nextAlreadyWarned } = shouldEmitBackendWarning(wants, warned);
      emits.push(emit);
      warned = nextAlreadyWarned;
    }
    // down (emit), down (quiet), up (quiet), down again (emit).
    expect(emits).toEqual([true, false, false, true]);
  });
});

describe('startCostControlSweep: what a leave result does to the meeting', () => {
  const SWEEP_MS = 60_000;
  const config = {
    idleTimeoutMs: 600_000,
    maxDurationMs: 7_200_000,
    sweepIntervalMs: SWEEP_MS,
  } as unknown as Config;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __clearRegistry();
    mockLeaveBot.mockReset();
    mockKickoffPipeline.mockReset();
  });

  /** One live, idle meeting; run exactly one sweep tick with `leaveResult`. */
  async function sweepOnce(leaveResult: unknown): Promise<void> {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    __clearRegistry();
    registerMeeting({ meetingId: 'm-sweep', botId: 'bot-sweep', teammate: 'david', persona: 'first_person', title: 'Idle' });
    getMeeting('m-sweep')!.lastActivityAt = Date.now() - 700_000;
    getMeeting('m-sweep')!.inCall = true;
    mockLeaveBot.mockResolvedValue(leaveResult);
    const stop = startCostControlSweep(config);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    stop();
  }

  it('retires the meeting once Recall accepted the leave and schedules the 90s pipeline backstop', async () => {
    await sweepOnce({ ok: true });

    expect(getMeeting('m-sweep')).toMatchObject({ status: 'completed', inCall: false });
    expect(mockKickoffPipeline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SWEEP_LEAVE_BACKSTOP_DELAY_MS - 1);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
    expect(mockKickoffPipeline).toHaveBeenCalledWith(config, {
      botId: 'bot-sweep',
      meetingId: 'm-sweep',
      meetingTitle: 'Idle',
      teammate: 'david',
    });
  });

  it('retires the meeting when Recall says the bot is already gone (404/410) and still schedules the backstop', async () => {
    await sweepOnce({ ok: false, alreadyGone: true, error: 'recall leave failed (404): not found' });

    expect(getMeeting('m-sweep')).toMatchObject({ status: 'completed', inCall: false });
    await vi.advanceTimersByTimeAsync(SWEEP_LEAVE_BACKSTOP_DELAY_MS);
    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });

  it('keeps the meeting live after any other failure and schedules no backstop', async () => {
    await sweepOnce({ ok: false, error: 'recall leave failed (500): boom' });

    expect(getMeeting('m-sweep')).toMatchObject({ status: 'live', inCall: true });
    await vi.advanceTimersByTimeAsync(SWEEP_LEAVE_BACKSTOP_DELAY_MS * 2);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
  });
});
