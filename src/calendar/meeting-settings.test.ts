import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import type { RawCalendarEvent } from './extract-url.js';
import { loadMeetingSettings, runCalendarPollOnce, saveMeetingSetting, toUpcomingItems, withSavedMeetingUrl } from './watcher.js';
import { evaluateCalendarEvent } from './extract-url.js';
import { __clearRegistry } from '../meeting/registry.js';

const NOW = Date.parse('2026-11-17T13:59:00.000Z');

function checkinCall(overrides: Partial<RawCalendarEvent> = {}): RawCalendarEvent {
  return {
    id: 'series1_20261117T140000Z',
    recurringEventId: 'series1',
    status: 'confirmed',
    summary: 'Morning Check-in',
    start: { dateTime: '2026-11-17T09:00:00-05:00' },
    end: { dateTime: '2026-11-17T09:10:00-05:00' },
    attendees: [{ email: 'david@nexai.test', self: true }],
    ...overrides,
  };
}

const config = {
  port: 8790,
  defaultTeammate: 'david',
  maxConcurrentPerTeammate: 5,
  calendarPrimaryAccount: 'david@nexai.test',
  calendarOptInAccounts: [],
  calendarLeadTimeMs: 120_000,
} as unknown as Config;

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  __clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'jm-settings-'));
  ledgerPath = join(dir, 'calendar-dispatched.json');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function poll(ev: RawCalendarEvent) {
  const calls: { meetingUrl: string; title: string; soul?: string }[] = [];
  await runCalendarPollOnce(config, {
    nowMs: () => NOW,
    ledgerPath,
    verifyIdentity: async () => 'david@nexai.test',
    fetchEvents: async () => [ev],
    dispatchMeeting: async (input) => {
      calls.push(input);
      return { meetingId: 'm1', botId: 'b1' };
    },
  });
  return calls;
}

describe('per-meeting settings', () => {
  it('a meeting with no setting joins as the default notetaker', async () => {
    const calls = await poll(checkinCall({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.soul).toBeUndefined();
  });

  it('a series set to a persona joins every occurrence with that persona', async () => {
    saveMeetingSetting('series1', { soul: 'owner-standin' }, ledgerPath);
    const calls = await poll(checkinCall({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }));
    expect(calls[0]!.soul).toBe('owner-standin');
  });

  it('an invite with no link joins on the saved link; without one it is not a meeting', async () => {
    expect(await poll(checkinCall())).toHaveLength(0);
    saveMeetingSetting('series1', { meetingUrl: 'https://meet.google.com/abc-defg-hij', soul: 'owner-standin' }, ledgerPath);
    const calls = await poll(checkinCall({ id: 'series1_x' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.meetingUrl).toContain('meet.google.com/abc-defg-hij');
  });

  it('the saved link never replaces a link the event already has', () => {
    const settings = { series1: { meetingUrl: 'https://meet.google.com/aaa-bbbb-ccc' } };
    const ev = checkinCall({ hangoutLink: 'https://meet.google.com/abc-defg-hij' });
    expect(withSavedMeetingUrl(ev, settings)).toBe(ev);
  });

  it('null clears a setting; an empty setting is removed', () => {
    saveMeetingSetting('series1', { soul: 'owner-standin' }, ledgerPath);
    saveMeetingSetting('series1', { soul: null }, ledgerPath);
    expect(loadMeetingSettings(ledgerPath)).toEqual({});
  });

  it('the upcoming list shows the series and its persona', () => {
    const c = evaluateCalendarEvent(checkinCall({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }), 'david@nexai.test', {
      defaultAutoJoinCalendars: ['david@nexai.test'],
    })!;
    const items = toUpcomingItems([c], { dispatched: {}, skippedKeys: [], forcedJoinKeys: [] }, NOW, undefined, {
      series1: { soul: 'owner-standin' },
    });
    expect(items[0]!.seriesId).toBe('series1');
    expect(items[0]!.soul).toBe('owner-standin');
  });
});
