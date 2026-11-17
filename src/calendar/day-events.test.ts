import { describe, expect, it, vi } from 'vitest';
import { listDayEvents, localDayBounds, localYmd } from './day-events.js';

const TZ = 'America/New_York';

describe('localDayBounds', () => {
  it('returns the UTC start and end of a local day', () => {
    expect(localDayBounds('2026-11-14', TZ)).toEqual({
      timeMinIso: '2026-11-14T05:00:00.000Z',
      timeMaxIso: '2026-11-15T05:00:00.000Z',
    });
  });

  it('handles the day the clocks change', () => {
    expect(localDayBounds('2026-03-08', TZ)).toEqual({
      timeMinIso: '2026-03-08T05:00:00.000Z',
      timeMaxIso: '2026-03-09T04:00:00.000Z',
    });
  });

  it('rejects a value that is not a real date', () => {
    expect(localDayBounds('tomorrow', TZ)).toBeNull();
    expect(localDayBounds('2026-13-40', TZ)).toBeNull();
  });
});

describe('localYmd', () => {
  it('gives the local date, not the UTC date', () => {
    expect(localYmd(Date.parse('2026-11-15T02:30:00Z'), TZ)).toBe('2026-11-14');
  });
});

describe('listDayEvents', () => {
  it('merges the calendars, sorts by start and drops cancelled and declined events', async () => {
    const fetchEvents = vi.fn(async (calendarId: string) =>
      calendarId === 'work@example.com'
        ? [
            { summary: 'Client call', start: { dateTime: '2026-11-14T15:00:00-05:00' }, end: { dateTime: '2026-11-14T15:30:00-05:00' } },
            { summary: 'Gone', status: 'cancelled', start: { dateTime: '2026-11-14T09:00:00-05:00' } },
            { summary: 'Said no', start: { dateTime: '2026-11-14T10:00:00-05:00' }, attendees: [{ self: true, responseStatus: 'declined' }] },
          ]
        : [{ summary: 'Run payroll', start: { dateTime: '2026-11-14T09:00:00-05:00' }, end: { dateTime: '2026-11-14T09:15:00-05:00' } },
           { summary: 'Conference', start: { date: '2026-11-14' }, end: { date: '2026-11-15' } }],
    );

    const day = await listDayEvents({ calendars: ['work@example.com', 'me@example.com'], date: '2026-11-14', timeZone: TZ, fetchEvents });

    expect(fetchEvents).toHaveBeenCalledWith('work@example.com', '2026-11-14T05:00:00.000Z', '2026-11-15T05:00:00.000Z');
    expect(day.events.map((e) => e.title)).toEqual(['Conference', 'Run payroll', 'Client call']);
    expect(day.events[0]).toMatchObject({ all_day: true, calendar: 'me@example.com' });
    expect(day.events[1]).toMatchObject({ start: '9:00 AM', end: '9:15 AM', all_day: false });
    expect(day.failed).toEqual([]);
  });

  it('reports a calendar that could not be read and keeps the others', async () => {
    const fetchEvents = vi.fn(async (calendarId: string) => {
      if (calendarId === 'bad@example.com') throw new Error('403');
      return [{ summary: 'Standup', start: { dateTime: '2026-11-14T10:00:00-05:00' } }];
    });
    const day = await listDayEvents({ calendars: ['bad@example.com', 'ok@example.com'], date: '2026-11-14', timeZone: TZ, fetchEvents });
    expect(day.events.map((e) => e.title)).toEqual(['Standup']);
    expect(day.failed).toEqual(['bad@example.com']);
  });
});
