import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateCalendarEvent,
  extractMeetingUrlFromEvent,
  normalizeMeetingUrl,
  type RawCalendarEvent,
} from '../src/calendar/extract-url.js';
import {
  __setCalendarStateForTests,
  loadCalendarLedger,
  runCalendarPollOnce,
  setCalendarEventSkipOverride,
  shouldDispatchCandidate,
} from '../src/calendar/watcher.js';
import { createApp } from '../src/app.js';
import { ownerCookieValue } from '../src/auth/owner.js';
import { __clearRegistry } from '../src/meeting/registry.js';
import type { Config } from '../src/config.js';

const OWNER = 'owner-token-calendar-tests';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8790,
    publicBaseUrl: 'https://ngrok.example.com',
    jarvisBotName: 'Jarvis',
    recallApiKey: 'rk-test',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: 7_200_000,
    maxConcurrentPerTeammate: 2,
    tokenRegistry: new Map([[OWNER, 'david']]),
    workScopeNamespaces: [],
    calendarAutoJoin: true,
    calendarPollIntervalMs: 60_000,
    calendarLeadTimeMs: 120_000,
    calendarPrimaryAccount: 'owner@example.com',
    calendarOptInAccounts: ['owner.personal@example.com'],
    ...overrides,
  } as unknown as Config;
}

describe('extractMeetingUrlFromEvent', () => {
  it('prefers conferenceData video entryPoint over hangoutLink, location, and description', () => {
    const event: RawCalendarEvent = {
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+123456789' },
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
        ],
      },
      hangoutLink: 'https://meet.google.com/zzz-zzzz-zzz',
      location: 'https://us06web.zoom.us/j/111111111',
      description: 'Join at https://teams.microsoft.com/l/meetup-join/19%3ameeting_123',
    };

    expect(extractMeetingUrlFromEvent(event)).toEqual({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      normalizedUrl: 'https://meet.google.com/abc-defg-hij',
      source: 'conferenceData',
    });
  });

  it('extracts Zoom links with password query parameters preserved in meetingUrl and stripped in normalizedUrl', () => {
    const event: RawCalendarEvent = {
      location: 'https://luma.com/join/some-event',
      description: 'Join Zoom: https://us06web.zoom.us/j/89123456789?pwd=SecretPassword123&amp;uname=David.',
    };

    const extracted = extractMeetingUrlFromEvent(event);
    expect(extracted).toEqual({
      meetingUrl: 'https://us06web.zoom.us/j/89123456789?pwd=SecretPassword123&uname=David',
      normalizedUrl: 'https://us06web.zoom.us/j/89123456789',
      source: 'description',
    });
  });

  it('extracts Microsoft Teams links and returns null for non-video links like Luma', () => {
    expect(
      extractMeetingUrlFromEvent({
        location: 'https://luma.com/abc',
        description: 'Physical address: 101 Main St',
      }),
    ).toBeNull();

    expect(
      extractMeetingUrlFromEvent({
        location: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123/0?context=%7b%22Tid%22%3a%221%22%7d',
      }),
    ).toMatchObject({
      source: 'location',
      normalizedUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123/0',
    });
  });

  it('normalizes Google Meet URLs case-insensitively and strips query params', () => {
    expect(normalizeMeetingUrl('https://meet.google.com/ABC-defg-HIJ?pli=1&authuser=0')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
  });
});

describe('evaluateCalendarEvent eligibility rules', () => {
  const baseEvent: RawCalendarEvent = {
    id: 'evt-1',
    status: 'confirmed',
    summary: 'NexAI Client Discovery',
    start: { dateTime: '2026-10-23T14:00:00-04:00' },
    end: { dateTime: '2026-10-23T14:30:00-04:00' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    attendees: [{ email: 'owner@example.com', self: true, responseStatus: 'accepted' }],
  };

  it('marks confirmed video meetings on owner@example.com as eligible by default', () => {
    const c = evaluateCalendarEvent(baseEvent, 'owner@example.com', {
      defaultAutoJoinCalendars: ['owner@example.com'],
    });
    expect(c).not.toBeNull();
    expect(c?.eligible).toBe(true);
    expect(c?.skipReason).toBeUndefined();
  });

  it('skips personal calendar (owner.personal@example.com) events unless tagged [jarvis] or #jarvis', () => {
    const skipped = evaluateCalendarEvent(baseEvent, 'owner.personal@example.com', {
      defaultAutoJoinCalendars: ['owner@example.com'],
    });
    expect(skipped?.eligible).toBe(false);
    expect(skipped?.skipReason).toBe('personal_calendar_not_opted_in');

    const optedIn = evaluateCalendarEvent(
      { ...baseEvent, summary: 'Founder Chat [jarvis]' },
      'owner.personal@example.com',
      { defaultAutoJoinCalendars: ['owner@example.com'] },
    );
    expect(optedIn?.eligible).toBe(true);
  });

  it('skips events where self attendee declined or summary/description has #no-jarvis / [no-bot]', () => {
    const declined = evaluateCalendarEvent(
      {
        ...baseEvent,
        attendees: [{ email: 'owner@example.com', self: true, responseStatus: 'declined' }],
      },
      'owner@example.com',
      { defaultAutoJoinCalendars: ['owner@example.com'] },
    );
    expect(declined?.eligible).toBe(false);
    expect(declined?.skipReason).toBe('declined');

    const optOut = evaluateCalendarEvent(
      { ...baseEvent, description: 'Private 1:1 #no-jarvis' },
      'owner@example.com',
      { defaultAutoJoinCalendars: ['owner@example.com'] },
    );
    expect(optOut?.eligible).toBe(false);
    expect(optOut?.skipReason).toBe('opt_out_tag');
  });

  it('returns null for cancelled, all-day, or outOfOffice events', () => {
    expect(
      evaluateCalendarEvent({ ...baseEvent, status: 'cancelled' }, 'owner@example.com', {
        defaultAutoJoinCalendars: ['owner@example.com'],
      }),
    ).toBeNull();
    expect(
      evaluateCalendarEvent(
        { ...baseEvent, start: { date: '2026-10-23' }, end: { date: '2026-10-24' } },
        'owner@example.com',
        { defaultAutoJoinCalendars: ['owner@example.com'] },
      ),
    ).toBeNull();
  });
});

describe('shouldDispatchCandidate & runCalendarPollOnce + owner panel upcoming endpoints', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    __clearRegistry();
    tempDir = mkdtempSync(join(tmpdir(), 'cal-watcher-'));
    ledgerPath = join(tempDir, 'calendar-dispatched.json');
    __setCalendarStateForTests({ candidates: [], lastPollAt: null, lastError: null, ledgerPath });
  });

  afterEach(() => {
    __clearRegistry();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dispatches a meeting within the 2-minute lead window, deduplicates across polls and cross-calendar invites', async () => {
    const startMs = Date.parse('2026-10-23T15:00:00Z');
    const endMs = Date.parse('2026-10-23T15:30:00Z');
    const nowMs = startMs - 90_000; // 1.5m before start -> inside 2m lead window

    const workEvent: RawCalendarEvent = {
      id: 'work-1',
      status: 'confirmed',
      summary: 'AI Strategy Call',
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs).toISOString() },
      hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    };
    // Duplicate invite on personal calendar with [jarvis] pointing to the exact same Meet URL
    const dupPersonalEvent: RawCalendarEvent = {
      id: 'pers-1',
      status: 'confirmed',
      summary: 'AI Strategy Call [jarvis]',
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs).toISOString() },
      hangoutLink: 'https://meet.google.com/xyz-abcd-efg?pli=1',
    };

    const dispatchCalls: Array<{ meetingUrl: string; title: string }> = [];
    const config = makeConfig();

    const firstPoll = await runCalendarPollOnce(config, {
      nowMs: () => nowMs,
      ledgerPath,
      verifyIdentity: async () => 'owner@example.com',
      fetchEvents: async (calId) => (calId === 'owner@example.com' ? [workEvent] : [dupPersonalEvent]),
      dispatchMeeting: async (input) => {
        dispatchCalls.push(input);
        return { meetingId: 'mtg-auto-1', botId: 'bot-auto-1' };
      },
    });

    // Only dispatched ONCE even though both calendars had the same Meet room!
    expect(firstPoll.dispatched).toHaveLength(1);
    expect(dispatchCalls).toEqual([
      { meetingUrl: 'https://meet.google.com/xyz-abcd-efg', title: 'AI Strategy Call' },
    ]);

    // Second poll 30s later: does not re-dispatch
    const secondPoll = await runCalendarPollOnce(config, {
      nowMs: () => nowMs + 30_000,
      ledgerPath,
      verifyIdentity: async () => 'owner@example.com',
      fetchEvents: async (calId) => (calId === 'owner@example.com' ? [workEvent] : [dupPersonalEvent]),
      dispatchMeeting: async (input) => {
        dispatchCalls.push(input);
        return { meetingId: 'mtg-auto-2', botId: 'bot-auto-2' };
      },
    });
    expect(secondPoll.dispatched).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(1);
  });

  it('refuses to trust calendar reads when gws-sa identity does not match primaryAccount', async () => {
    const config = makeConfig();
    await expect(
      runCalendarPollOnce(config, {
        ledgerPath,
        verifyIdentity: async () => 'wrong@example.com',
        fetchEvents: async () => [],
      }),
    ).rejects.toThrow(/identity mismatch/);
  });

  it('exposes GET /api/owner/upcoming and POST /api/owner/upcoming/skip to toggle auto-join', async () => {
    const nowMs = Date.now();
    const startMs = nowMs + 2 * 60 * 60 * 1000; // 2h in the future -> not yet in 2m dispatch window
    const endMs = startMs + 30 * 60 * 1000;

    const futureEvent: RawCalendarEvent = {
      id: 'fut-1',
      status: 'confirmed',
      summary: 'Later Discovery Call',
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs).toISOString() },
      hangoutLink: 'https://meet.google.com/lat-ercd-efg',
    };

    const config = makeConfig();
    await runCalendarPollOnce(config, {
      nowMs: () => nowMs,
      ledgerPath,
      verifyIdentity: async () => 'owner@example.com',
      fetchEvents: async (calId) => (calId === 'owner@example.com' ? [futureEvent] : []),
    });

    const app = createApp(config);
    const cookieHeader = { Cookie: `jm_owner=${ownerCookieValue(config)}`, Origin: config.publicBaseUrl };

    const getRes = await app.request('/api/owner/upcoming', { headers: cookieHeader });
    expect(getRes.status).toBe(200);
    const body1 = (await getRes.json()) as {
      enabled: boolean;
      upcoming: Array<{ eventKey: string; willJoin: boolean; status: string }>;
    };
    expect(body1.enabled).toBe(true);
    expect(body1.upcoming).toHaveLength(1);
    const eventKey = body1.upcoming[0]!.eventKey;
    expect(body1.upcoming[0]).toMatchObject({ willJoin: true, status: 'scheduled' });

    // Toggle skip = true via POST /api/owner/upcoming/skip
    const skipRes = await app.request('/api/owner/upcoming/skip', {
      method: 'POST',
      headers: { ...cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventKey, skip: true }),
    });
    expect(skipRes.status).toBe(200);
    const body2 = (await skipRes.json()) as {
      upcoming: Array<{ eventKey: string; willJoin: boolean; status: string; skipReason?: string }>;
    };
    expect(body2.upcoming[0]).toMatchObject({
      eventKey,
      willJoin: false,
      status: 'skipped',
      skipReason: 'manual_skip',
    });

    // Verify shouldDispatchCandidate now returns false even inside the 2m window
    const ledger = loadCalendarLedger(ledgerPath);
    const candidate = evaluateCalendarEvent(futureEvent, 'owner@example.com', {
      defaultAutoJoinCalendars: ['owner@example.com'],
    })!;
    expect(shouldDispatchCandidate(candidate, startMs - 60_000, { leadTimeMs: 120_000 }, ledger)).toBe(false);

    // Toggle skip = false -> re-enables auto-join
    setCalendarEventSkipOverride(eventKey, false, ledgerPath);
    const ledgerAfter = loadCalendarLedger(ledgerPath);
    expect(shouldDispatchCandidate(candidate, startMs - 60_000, { leadTimeMs: 120_000 }, ledgerAfter)).toBe(true);
  });
});
