import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { attendeeEmailsOf, evaluateCalendarEvent, type RawCalendarEvent } from './extract-url.js';
import { runCalendarPollOnce } from './watcher.js';
import { __clearRegistry, getMeeting, registerMeeting } from '../meeting/registry.js';

const NOW = Date.parse('2026-11-13T15:00:00.000Z');
const EVENT: RawCalendarEvent = {
  id: 'evt-1',
  status: 'confirmed',
  summary: 'Launch planning',
  start: { dateTime: new Date(NOW + 60_000).toISOString() },
  end: { dateTime: new Date(NOW + 31 * 60_000).toISOString() },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  attendees: [
    { email: 'Owner@Example.com', self: true, responseStatus: 'accepted' },
    { email: 'nick@client.test' },
    { email: 'nick@client.test' },
    { email: 'room-1@resource.calendar.google.com' },
    {},
  ],
};

let dir: string;
beforeEach(() => {
  __clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'jm-cal-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('calendar invite list', () => {
  it('attendeeEmailsOf lowercases, drops duplicates, rooms and blanks', () => {
    expect(attendeeEmailsOf(EVENT)).toEqual(['owner@example.com', 'nick@client.test']);
    expect(attendeeEmailsOf({})).toEqual([]);
  });

  it('every evaluated candidate carries the invite list', () => {
    const c = evaluateCalendarEvent(EVENT, 'owner@example.com', { defaultAutoJoinCalendars: ['owner@example.com'] });
    expect(c).toMatchObject({ eligible: true, attendeeEmails: ['owner@example.com', 'nick@client.test'] });
  });

  it('the watcher stores the invite list on the meeting record it dispatched', async () => {
    const config = {
      port: 8790,
      defaultTeammate: 'david',
      maxConcurrentPerTeammate: 2,
      calendarPrimaryAccount: 'owner@example.com',
      calendarOptInAccounts: [],
      calendarLeadTimeMs: 120_000,
    } as unknown as Config;

    const poll = await runCalendarPollOnce(config, {
      nowMs: () => NOW,
      ledgerPath: join(dir, 'ledger.json'),
      verifyIdentity: async () => 'owner@example.com',
      fetchEvents: async () => [EVENT],
      dispatchMeeting: async ({ title }) => {
        registerMeeting({ meetingId: 'mtg-cal-1', botId: 'bot-cal-1', teammate: 'david', persona: 'first_person', title });
        return { meetingId: 'mtg-cal-1', botId: 'bot-cal-1' };
      },
    });

    expect(poll.dispatched).toHaveLength(1);
    expect(getMeeting('mtg-cal-1')?.attendees).toEqual(['owner@example.com', 'nick@client.test']);
  });
});
