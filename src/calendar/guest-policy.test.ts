import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type { RawCalendarEvent } from './extract-url.js';
import { externalGuests, runCalendarPollOnce } from './watcher.js';
import { __clearRegistry } from '../meeting/registry.js';

const NOW = Date.parse('2026-11-13T15:00:00.000Z');
let seq = 0;

function event(attendees: string[]): RawCalendarEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    status: 'confirmed',
    summary: 'Planning',
    start: { dateTime: new Date(NOW + 60_000).toISOString() },
    end: { dateTime: new Date(NOW + 31 * 60_000).toISOString() },
    hangoutLink: `https://meet.google.com/abc-defg-${String(seq).padStart(3, 'a').slice(-3).replace(/\d/g, 'x')}`,
    attendees: attendees.map((email) => ({ email })),
  };
}

function config(overrides: Record<string, unknown>): Config {
  return {
    port: 8790,
    defaultTeammate: 'david',
    maxConcurrentPerTeammate: 5,
    calendarPrimaryAccount: 'david@nexai.test',
    calendarOptInAccounts: ['dave.personal@gmail.test'],
    calendarLeadTimeMs: 120_000,
    internalDomains: ['nexai.test'],
    ...overrides,
  } as unknown as Config;
}

let dir: string;
beforeEach(() => {
  __clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'jm-guest-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function poll(cfg: Config, ev: RawCalendarEvent) {
  const calls: { meetingUrl: string; title: string; notesOnly?: boolean }[] = [];
  const result = await runCalendarPollOnce(cfg, {
    nowMs: () => NOW,
    ledgerPath: join(dir, `ledger-${seq}.json`),
    verifyIdentity: async () => 'david@nexai.test',
    fetchEvents: async (calId) => (calId === 'david@nexai.test' ? [ev] : []),
    dispatchMeeting: async (input) => {
      calls.push(input);
      return { meetingId: `m-${seq}`, botId: `b-${seq}` };
    },
  });
  return { calls, dispatched: result.dispatched };
}

const INTERNAL = ['david@nexai.test', 'nick@nexai.test'];
const WITH_GUEST = ['david@nexai.test', 'client@outside.test'];

describe('externalGuests', () => {
  it('lists invitees outside the internal domains, never the owner’s own accounts', () => {
    expect(externalGuests(['a@nexai.test', 'C@Outside.test', 'me@gmail.test'], ['nexai.test'], ['me@gmail.test'])).toEqual(['C@Outside.test']);
    expect(externalGuests(['a@sub.nexai.test', 'a@evilnexai.test'], ['nexai.test'], [])).toHaveLength(2);
  });

  it('with no internal domain configured, every other invitee is outside', () => {
    expect(externalGuests(['a@nexai.test', 'me@x.test'], [], ['me@x.test'])).toEqual(['a@nexai.test']);
  });
});

describe('EXTERNAL_GUEST_POLICY in the calendar watcher', () => {
  it('allow (default): joins normally even with an outside guest', async () => {
    const { calls } = await poll(config({}), event(WITH_GUEST));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('notesOnly');
  });

  it('stay_out: skips the dispatch when an outside guest is invited, joins an internal-only meeting', async () => {
    const skipped = await poll(config({ externalGuestPolicy: 'stay_out' }), event(WITH_GUEST));
    expect(skipped.calls).toEqual([]);
    expect(skipped.dispatched).toEqual([]);

    const joined = await poll(config({ externalGuestPolicy: 'stay_out' }), event(INTERNAL));
    expect(joined.calls).toHaveLength(1);
  });

  it('notes_only: joins with notesOnly when an outside guest is invited, normally otherwise', async () => {
    const guest = await poll(config({ externalGuestPolicy: 'notes_only' }), event(WITH_GUEST));
    expect(guest.calls).toEqual([expect.objectContaining({ notesOnly: true })]);

    const internal = await poll(config({ externalGuestPolicy: 'notes_only' }), event(INTERNAL));
    expect(internal.calls[0]).not.toHaveProperty('notesOnly');
  });

  it('the owner’s opt-in personal account is not an outside guest', async () => {
    const { calls } = await poll(config({ externalGuestPolicy: 'stay_out' }), event(['david@nexai.test', 'dave.personal@gmail.test']));
    expect(calls).toHaveLength(1);
  });
});
