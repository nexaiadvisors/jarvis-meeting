import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type { RawCalendarEvent } from './extract-url.js';
import { getCalendarWatcherStatus, loadJoinMode, runCalendarPollOnce, saveJoinMode, setCalendarEventSkipOverride } from './watcher.js';
import { __clearRegistry } from '../meeting/registry.js';

const NOW = Date.parse('2026-11-13T15:00:00.000Z');
let seq = 0;

function event(attendees: string[]): RawCalendarEvent {
  seq += 1;
  return {
    id: `join-${seq}`,
    status: 'confirmed',
    summary: 'Planning',
    start: { dateTime: new Date(NOW + 60_000).toISOString() },
    end: { dateTime: new Date(NOW + 31 * 60_000).toISOString() },
    hangoutLink: `https://meet.google.com/jmd-efgh-${'abcdefghij'[seq % 10]}${'klmnopqrst'[seq % 10]}x`,
    attendees: attendees.map((email) => ({ email })),
  };
}

// No internalDomains: the primary account's own domain counts as the company.
const cfg = {
  port: 8790,
  defaultTeammate: 'david',
  maxConcurrentPerTeammate: 5,
  calendarAutoJoin: true,
  calendarPrimaryAccount: 'david@nexai.test',
  calendarOptInAccounts: ['dave.personal@gmail.test'],
  calendarLeadTimeMs: 120_000,
} as unknown as Config;

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  __clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'jm-join-'));
  ledgerPath = join(dir, 'ledger.json');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function poll(ev: RawCalendarEvent): Promise<number> {
  let calls = 0;
  await runCalendarPollOnce(cfg, {
    nowMs: () => NOW,
    ledgerPath,
    verifyIdentity: async () => 'david@nexai.test',
    fetchEvents: async (calId) => (calId === 'david@nexai.test' ? [ev] : []),
    dispatchMeeting: async () => {
      calls += 1;
      return { meetingId: `m-${seq}`, botId: `b-${seq}` };
    },
  });
  return calls;
}

describe('join rule', () => {
  it('defaults to joining everything, and survives a bad file', () => {
    expect(loadJoinMode(ledgerPath)).toBe('all');
    saveJoinMode('manual', ledgerPath);
    expect(loadJoinMode(ledgerPath)).toBe('manual');
  });

  it('a saved rule that cannot be read joins nothing, rather than everything', () => {
    writeFileSync(join(dir, 'calendar-join-mode.json'), '{not json', 'utf8');
    expect(loadJoinMode(ledgerPath)).toBe('manual');
  });

  it('internal_only: an outside organizer or a hidden invite list counts as outside', async () => {
    saveJoinMode('internal_only', ledgerPath);
    expect(await poll({ ...event(['david@nexai.test']), organizer: { email: 'recruiter@talent.test' } })).toBe(0);
    expect(await poll({ ...event(['david@nexai.test']), guestsCanSeeOtherGuests: false })).toBe(0);
    expect(await poll({ ...event(['david@nexai.test']), attendeesOmitted: true })).toBe(0);
    expect(await poll({ ...event(['david@nexai.test']), organizer: { email: 'david@nexai.test', self: true } })).toBe(1);
  });

  it('all: joins a meeting with an outside guest', async () => {
    expect(await poll(event(['david@nexai.test', 'recruiter@talent.test']))).toBe(1);
  });

  it('internal_only: skips an outside guest, joins a meeting of colleagues', async () => {
    saveJoinMode('internal_only', ledgerPath);
    expect(await poll(event(['david@nexai.test', 'recruiter@talent.test']))).toBe(0);
    expect(getCalendarWatcherStatus(cfg, NOW).upcoming[0]).toMatchObject({ willJoin: false, skipReason: 'rule_outside_guest' });
    expect(await poll(event(['david@nexai.test', 'ann@nexai.test']))).toBe(1);
  });

  it('manual: joins nothing until the owner switches that meeting on', async () => {
    saveJoinMode('manual', ledgerPath);
    const ev = event(['david@nexai.test', 'ann@nexai.test']);
    expect(await poll(ev)).toBe(0);
    const status = getCalendarWatcherStatus(cfg, NOW);
    expect(status.joinMode).toBe('manual');
    expect(status.upcoming[0]).toMatchObject({ willJoin: false, skipReason: 'rule_manual' });
    setCalendarEventSkipOverride(status.upcoming[0]!.eventKey, false, ledgerPath);
    expect(await poll(ev)).toBe(1);
  });
});
