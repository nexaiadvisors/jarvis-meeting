import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerMeeting,
  getMeeting,
  getMeetingByBotId,
  touchActivity,
  listLive,
  countLiveForTeammate,
  summarizeLive,
  setStatus,
  setAttendees,
  adjustParticipantCount,
  recordParticipantIdentity,
  recordParticipantLeft,
  isOwnerOnly,
  enableRegistryPersistence,
  __clearRegistry,
} from './registry.js';

beforeEach(() => {
  __clearRegistry();
});

describe('registry activity tracking + cost-control helpers', () => {
  it('seeds lastActivityAt to createdAt at registration', () => {
    const rec = registerMeeting({ meetingId: 'm1', teammate: 'a', persona: 'ai', title: 't' });
    expect(rec.lastActivityAt).toBe(rec.createdAt);
  });

  it('touchActivity sets lastActivityAt to the injected now', () => {
    registerMeeting({ meetingId: 'm1', teammate: 'a', persona: 'ai', title: 't' });
    touchActivity('m1', 5_000_000);
    expect(getMeeting('m1')?.lastActivityAt).toBe(5_000_000);
  });

  it('touchActivity is a no-op for an unknown meeting', () => {
    expect(() => touchActivity('nope', 1)).not.toThrow();
  });

  it('getMeetingByBotId finds the record by botId', () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'a', persona: 'ai', title: 't' });
    expect(getMeetingByBotId('bot-1')?.meetingId).toBe('m1');
    expect(getMeetingByBotId('missing')).toBeUndefined();
  });

  it('listLive returns only live meetings', () => {
    registerMeeting({ meetingId: 'live1', teammate: 'a', persona: 'ai', title: 't' });
    registerMeeting({ meetingId: 'live2', teammate: 'b', persona: 'ai', title: 't' });
    registerMeeting({ meetingId: 'done', teammate: 'a', persona: 'ai', title: 't' });
    setStatus('done', 'completed');

    expect(listLive().map((m) => m.meetingId).sort()).toEqual(['live1', 'live2']);
  });

  it('countLiveForTeammate counts only that teammate live meetings', () => {
    registerMeeting({ meetingId: 'a1', teammate: 'alice', persona: 'ai', title: 't' });
    registerMeeting({ meetingId: 'a2', teammate: 'alice', persona: 'ai', title: 't' });
    registerMeeting({ meetingId: 'b1', teammate: 'bob', persona: 'ai', title: 't' });
    setStatus('a2', 'completed');

    expect(countLiveForTeammate('alice')).toBe(1);
    expect(countLiveForTeammate('bob')).toBe(1);
    expect(countLiveForTeammate('carol')).toBe(0);
  });
});

describe('summarizeLive — freshness probe for /healthz + the join preflight', () => {
  it('returns only live meetings, in the compact summary shape', () => {
    registerMeeting({ meetingId: 'live1', teammate: 'david', persona: 'first_person', title: 't' });
    registerMeeting({ meetingId: 'done', teammate: 'david', persona: 'first_person', title: 't' });
    setStatus('done', 'completed');

    const live = summarizeLive();
    expect(live.map((m) => m.meetingId)).toEqual(['live1']);
    expect(live[0]).toMatchObject({
      meetingId: 'live1',
      teammate: 'david',
      persona: 'first_person',
      status: 'live',
    });
    expect(typeof live[0]!.ageMs).toBe('number');
    expect(live[0]!.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('computes ageMs against the injected now', () => {
    const rec = registerMeeting({ meetingId: 'm', teammate: 'a', persona: 'ai', title: 't' });
    expect(summarizeLive(rec.createdAt + 10_000)[0]!.ageMs).toBe(10_000);
  });

  it('is empty when nothing is live (the fresh state the join preflight wants)', () => {
    expect(summarizeLive()).toEqual([]);
    registerMeeting({ meetingId: 'm', teammate: 'a', persona: 'ai', title: 't' });
    setStatus('m', 'completed');
    expect(summarizeLive()).toEqual([]);
  });
});

describe('enableRegistryPersistence', () => {
  it('persists registered meetings to disk and rehydrates them across clears, retiring stale live entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-persist-'));
    const file = join(dir, 'registry.json');
    try {
      enableRegistryPersistence(file);
      registerMeeting({ meetingId: 'fresh-live', botId: 'bot-fresh', teammate: 'david', persona: 'first_person', title: 'Fresh' });

      // Simulate restart: clear in-memory map, then rehydrate from file.
      __clearRegistry();
      expect(getMeeting('fresh-live')).toBeUndefined();

      enableRegistryPersistence(file);
      expect(getMeeting('fresh-live')).toMatchObject({
        meetingId: 'fresh-live',
        botId: 'bot-fresh',
        status: 'live',
      });

      // Simulate an ancient live meeting on disk (> maxLiveAgeMs old) that should retire on load.
      const staleRecord = {
        ...getMeeting('fresh-live')!,
        meetingId: 'ancient-live',
        createdAt: 1_000,
        status: 'live',
        inCall: true,
      };
      writeFileSync(file, JSON.stringify([staleRecord]), 'utf8');
      __clearRegistry();
      enableRegistryPersistence(file, { maxLiveAgeMs: 60_000, nowMs: 500_000 });
      expect(getMeeting('ancient-live')).toMatchObject({
        meetingId: 'ancient-live',
        status: 'completed',
        inCall: false,
      });
    } finally {
      __clearRegistry();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('owner-only detection', () => {
  const opts = { ownerNames: ['david', 'david he'], botName: 'Jarvis', internalDomains: ['example.com'] };
  const start = () => registerMeeting({ meetingId: 'o1', teammate: 'david', persona: 'first_person', title: 't' });
  const rec = () => getMeeting('o1')!;

  it('is false until the owner has been seen', () => {
    start();
    adjustParticipantCount('o1', +1);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('is true when the only name seen is the owner (case and spacing ignored)', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: '  David He ', isHost: true }, opts, 1000);
    expect(isOwnerOnly(rec(), opts)).toBe(true);
  });

  it('ignores the bot\'s own name', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { name: 'Jarvis' }, opts, 1000);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1001);
    expect(isOwnerOnly(rec(), opts)).toBe(true);
  });

  it('an outside name locks the meeting to the guest scope, even after that person leaves', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { name: 'Pat Lee' }, opts, 2000);
    adjustParticipantCount('o1', -1);
    expect(rec().participantCount).toBe(1);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('an owner name without the host flag is an outsider unless it is the confirmed host\'s id', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    recordParticipantIdentity('o1', { id: 7, name: 'David' }, opts, 1001);
    expect(isOwnerOnly(rec(), opts)).toBe(true);
    recordParticipantIdentity('o1', { id: 9, name: 'David' }, opts, 1002);
    expect(rec().outsiderSeenAt).toBe(1002);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('an owner name with no host flag and no confirmed host is an outsider', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 9, name: 'David' }, opts, 1000);
    expect(rec().ownerSeenAt).toBeUndefined();
    expect(rec().outsiderSeenAt).toBe(1000);
  });

  it('a second host-flagged owner name with a different id, or a non-host, is an outsider', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    recordParticipantIdentity('o1', { id: 8, name: 'David', isHost: true }, opts, 1001);
    expect(rec().outsiderSeenAt).toBe(1001);

    start();
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: false }, opts, 1000);
    expect(rec().outsiderSeenAt).toBe(1000);
  });

  it('the owner leaving ends the owner-only scope for whoever remains', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    // Someone using the bot's name joins: ignored as an identity, but counted.
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 9, name: 'Jarvis' }, opts, 1001);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
    adjustParticipantCount('o1', -1);
    recordParticipantLeft('o1', { id: 7, name: 'David' }, opts);
    expect(rec().participantCount).toBe(1);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('after the owner leaves nobody can be bound as the owner, and the owner coming back does not reopen the scope', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    adjustParticipantCount('o1', -1);
    recordParticipantLeft('o1', { id: 7, name: 'David' }, opts, 2000);
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 9, name: 'David', isHost: true }, opts, 3000);
    expect(rec().ownerParticipantId).toBe(7);
    expect(rec().outsiderSeenAt).toBe(3000);

    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    recordParticipantLeft('o1', { id: 7, name: 'David' }, opts, 2000);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 3000);
    expect(rec().outsiderSeenAt).toBeUndefined();
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('a host-flagged owner name with no participant id is an outsider', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { name: 'David', isHost: true }, opts, 1000);
    expect(rec().ownerSeenAt).toBeUndefined();
    expect(rec().outsiderSeenAt).toBe(1000);
  });

  it('is false with nobody counted as present', () => {
    start();
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('a participant with no name counts as an outsider', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    recordParticipantIdentity('o1', {}, opts, 1001);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('is false with more than one participant, with no owner names configured, or after the meeting ends', () => {
    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    expect(isOwnerOnly(rec(), { ...opts, ownerNames: [] })).toBe(false);
    adjustParticipantCount('o1', +1);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
    adjustParticipantCount('o1', -1);
    setStatus('o1', 'completed');
    expect(isOwnerOnly(rec(), opts)).toBe(false);
  });

  it('is false for a notes-only meeting or an invite with an outside address', () => {
    registerMeeting({ meetingId: 'o1', teammate: 'david', persona: 'first_person', title: 't', notesOnly: true });
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    expect(isOwnerOnly(rec(), opts)).toBe(false);

    start();
    adjustParticipantCount('o1', +1);
    recordParticipantIdentity('o1', { id: 7, name: 'David', isHost: true }, opts, 1000);
    setAttendees('o1', ['owner@example.com', 'pat@northwind.example']);
    expect(isOwnerOnly(rec(), opts)).toBe(false);
    setAttendees('o1', ['owner@example.com', 'ops@example.com']);
    expect(isOwnerOnly(rec(), opts)).toBe(true);
  });
});
