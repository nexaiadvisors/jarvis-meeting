// One day's calendar events, for the check_calendar tool. Reads the same
// calendars as the auto-join watcher, through the same gws-sa call.

import type { RawCalendarEvent } from './extract-url.js';

export type FetchCalendarEvents = (
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
) => Promise<RawCalendarEvent[]>;

export interface DayEvent {
  title: string;
  /** Local clock time, for example "9:00 AM". Empty for an all-day event. */
  start: string;
  end: string;
  all_day: boolean;
  calendar: string;
}

export interface DayEvents {
  date: string;
  events: DayEvent[];
  /** Calendars that could not be read. */
  failed: string[];
}

/** Minutes that `timeZone` is ahead of UTC at `utcMs`. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** UTC instant of local midnight on a calendar date. */
function localMidnightMs(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  // Second pass: the offset at the guess can differ from the offset at local midnight.
  return guess - offsetMinutes(first, timeZone) * 60_000;
}

/** The local date (YYYY-MM-DD) at an instant. */
export function localYmd(utcMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(utcMs),
  );
}

/** UTC start and end of a local day, or null when `ymd` is not a real YYYY-MM-DD date. */
export function localDayBounds(ymd: string, timeZone: string): { timeMinIso: string; timeMaxIso: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    timeMinIso: new Date(localMidnightMs(year, month, day, timeZone)).toISOString(),
    timeMaxIso: new Date(
      localMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
    ).toISOString(),
  };
}

function clock(iso: string | undefined, timeZone: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** Every event on one local day across the calendars, all-day events first, then by start time. */
export async function listDayEvents(input: {
  calendars: string[];
  date: string;
  timeZone: string;
  fetchEvents: FetchCalendarEvents;
}): Promise<DayEvents> {
  const bounds = localDayBounds(input.date, input.timeZone);
  if (!bounds) throw new Error(`not a date: ${input.date}`);
  const failed: string[] = [];
  const rows: Array<DayEvent & { sort: number }> = [];
  // The calendars are read at the same time: each read starts a gws-sa process.
  const reads = await Promise.all(
    input.calendars.map((calendar) =>
      input.fetchEvents(calendar, bounds.timeMinIso, bounds.timeMaxIso).then(
        (items) => ({ calendar, items }),
        () => ({ calendar, items: null }),
      ),
    ),
  );
  for (const { calendar, items } of reads) {
    if (items === null) {
      failed.push(calendar);
      continue;
    }
    for (const item of items) {
      if (item.status === 'cancelled') continue;
      if (item.attendees?.some((a) => a.self === true && a.responseStatus === 'declined')) continue;
      const allDay = item.start?.dateTime === undefined;
      const startMs = allDay ? Number.NEGATIVE_INFINITY : Date.parse(item.start?.dateTime ?? '');
      rows.push({
        title: (item.summary ?? '').trim() || '(no title)',
        start: allDay ? '' : clock(item.start?.dateTime, input.timeZone),
        end: allDay ? '' : clock(item.end?.dateTime, input.timeZone),
        all_day: allDay,
        calendar,
        sort: Number.isFinite(startMs) || allDay ? startMs : 0,
      });
    }
  }
  rows.sort((a, b) => (a.sort === b.sort ? 0 : a.sort < b.sort ? -1 : 1));
  return { date: input.date, events: rows.map(({ sort: _sort, ...event }) => event), failed };
}
