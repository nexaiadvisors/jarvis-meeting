import { describe, it, expect, beforeEach } from 'vitest';
import { __clearRegistry, getMeeting, registerMeeting, trackOwnerPresence } from './registry.js';
import { selectMeetingsToLeave } from '../lifecycle/sweep.js';

const OPTS = { ownerNames: ['david', 'david he'], botName: 'Jarvis' };
const SWEEP = { idleMs: 600_000, maxDurationMs: 7_200_000, ownerLeftGraceMs: 60_000 };

function start(): string {
  const id = 'm1';
  registerMeeting({ meetingId: id, teammate: 'david', persona: 'ai', title: 'Call', botId: 'bot-1' });
  return id;
}

function sweepAt(id: string, now: number, opts = SWEEP) {
  const m = getMeeting(id)!;
  // An occupied call: the idle rule alone would never remove the bot.
  return selectMeetingsToLeave([{ ...m, inCall: true, participantCount: 2, createdAt: 0, lastActivityAt: now }], now, opts);
}

describe('leave when the owner leaves', () => {
  beforeEach(() => __clearRegistry());

  it('leaves after the grace period once the owner has left, even with others present', () => {
    const id = start();
    trackOwnerPresence(id, 'join', { id: 7, name: 'David He' }, OPTS, 1_000);
    trackOwnerPresence(id, 'join', { id: 8, name: 'Nicholas Rivera' }, OPTS, 2_000);
    expect(getMeeting(id)!.ownerGoneAt).toBeUndefined();
    trackOwnerPresence(id, 'leave', { id: 7, name: 'David He' }, OPTS, 100_000);
    expect(getMeeting(id)!.ownerGoneAt).toBe(100_000);
    expect(sweepAt(id, 100_000 + 59_000)).toEqual([]);
    expect(sweepAt(id, 100_000 + 61_000)).toEqual([{ meetingId: id, botId: 'bot-1', reason: 'owner_left' }]);
  });

  it('stays when the owner comes back within the grace period', () => {
    const id = start();
    trackOwnerPresence(id, 'join', { id: 7, name: 'David He' }, OPTS, 1_000);
    trackOwnerPresence(id, 'leave', { id: 7, name: 'David He' }, OPTS, 100_000);
    trackOwnerPresence(id, 'join', { id: 9, name: 'David He' }, OPTS, 130_000);
    expect(getMeeting(id)!.ownerGoneAt).toBeUndefined();
    expect(sweepAt(id, 400_000)).toEqual([]);
  });

  it('stays while a second device under the owner name is still in the call', () => {
    const id = start();
    trackOwnerPresence(id, 'join', { id: 7, name: 'David He' }, OPTS, 1_000);
    trackOwnerPresence(id, 'join', { id: 9, name: 'David' }, OPTS, 2_000);
    trackOwnerPresence(id, 'leave', { id: 7, name: 'David He' }, OPTS, 100_000);
    expect(getMeeting(id)!.ownerGoneAt).toBeUndefined();
  });

  it('ignores other people joining and leaving, and a call the owner never joined', () => {
    const id = start();
    trackOwnerPresence(id, 'join', { id: 8, name: 'Nicholas Rivera' }, OPTS, 1_000);
    trackOwnerPresence(id, 'leave', { id: 8, name: 'Nicholas Rivera' }, OPTS, 2_000);
    trackOwnerPresence(id, 'leave', { id: 5, name: 'Davide' }, OPTS, 3_000);
    expect(getMeeting(id)!.ownerGoneAt).toBeUndefined();
    expect(sweepAt(id, 900_000)).toEqual([]);
  });

  it('counts a leave for an owner who was in the call before the bot saw a join', () => {
    const id = start();
    trackOwnerPresence(id, 'leave', { id: 7, name: 'david  he' }, OPTS, 50_000);
    expect(getMeeting(id)!.ownerGoneAt).toBe(50_000);
  });

  it('is off when the grace period is 0 or not set', () => {
    const id = start();
    trackOwnerPresence(id, 'join', { id: 7, name: 'David He' }, OPTS, 1_000);
    trackOwnerPresence(id, 'leave', { id: 7, name: 'David He' }, OPTS, 100_000);
    expect(sweepAt(id, 900_000, { ...SWEEP, ownerLeftGraceMs: 0 })).toEqual([]);
    expect(sweepAt(id, 900_000, { idleMs: 600_000, maxDurationMs: 7_200_000 } as typeof SWEEP)).toEqual([]);
  });
});
