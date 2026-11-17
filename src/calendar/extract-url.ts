// Pure URL extraction and eligibility logic for Google Calendar auto-join.
//
// Supported video-conferencing links:
//   - Google Meet: https://meet.google.com/xxx-xxxx-xxx
//   - Zoom:        https://*.zoom.us/j/... | /my/... | /w/...
//   - MS Teams:    https://teams.microsoft.com/l/meetup-join/... | https://teams.live.com/meet/...
//
// Extraction priority:
//   1. conferenceData.entryPoints (entryPointType === 'video')
//   2. hangoutLink
//   3. location
//   4. description

export interface RawCalendarEvent {
  id?: string;
  status?: string;
  eventType?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  /** Set on one occurrence of a repeating event: the id of the series. */
  recurringEventId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  /** True when the API left part of the invite list out. */
  attendeesOmitted?: boolean;
  /** False when guests cannot see each other, so this calendar's copy may not list everyone. */
  guestsCanSeeOtherGuests?: boolean;
  organizer?: { email?: string; self?: boolean };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

export interface ExtractedMeetingUrl {
  /** Full URL to pass to Recall createBot (preserves Zoom ?pwd=... etc.). */
  meetingUrl: string;
  /** Canonical origin + pathname (lowercased) for cross-calendar deduplication. */
  normalizedUrl: string;
  /** Which field supplied the URL. */
  source: 'conferenceData' | 'hangoutLink' | 'location' | 'description';
}

export interface CalendarMeetingCandidate {
  eventKey: string;
  eventId: string;
  /** The repeating series this occurrence belongs to, else the event id. Per-meeting settings key on it. */
  seriesId: string;
  calendarId: string;
  title: string;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
  meetingUrl: string;
  normalizedUrl: string;
  eligible: boolean;
  skipReason?: string;
  /** Lowercased email addresses on the event's invite list (people only; no rooms). */
  attendeeEmails?: string[];
  /** The event's organizer, when it is a person. */
  organizerEmail?: string;
  /** True when the invite list this calendar sees may be incomplete. */
  inviteListHidden?: boolean;
}

const MEET_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s<>"')\]\\]*)?/i;
const ZOOM_RE = /https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my|w)\/[A-Za-z0-9._-]+(?:\?[^\s<>"')\]\\]*)?/i;
const TEAMS_RE =
  /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"')\]\\]+/i;

const OPT_OUT_RE = /(?:^|\s|\[)(?:#no-jarvis|no-jarvis|#no-bot|no-bot)(?:\]|\s|$)/i;
const OPT_IN_RE = /(?:^|\s|\[)(?:#jarvis|jarvis)(?:\]|\s|$)/i;

function cleanTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;!?]+$/, '');
}

/**
 * Normalize a matched meeting URL into a canonical dedupe key (origin + pathname)
 * so two invites pointing to the same Meet/Zoom room deduplicate even if one
 * carries tracking or `?pli=1` query params.
 */
export function normalizeMeetingUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '');
    if (host === 'meet.google.com') {
      return `https://meet.google.com${path.toLowerCase()}`;
    }
    return `https://${host}${path}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/** Find the first supported video meeting URL in arbitrary text. */
export function findSupportedUrlInText(text: string | undefined): {
  meetingUrl: string;
  normalizedUrl: string;
} | null {
  if (!text || text.trim() === '') return null;
  // Decode common HTML entities in Google Calendar descriptions (&amp; -> &)
  const decoded = text.replace(/&amp;/gi, '&');
  for (const regex of [MEET_RE, ZOOM_RE, TEAMS_RE]) {
    const match = regex.exec(decoded);
    if (match?.[0]) {
      const meetingUrl = cleanTrailingPunctuation(match[0]);
      return {
        meetingUrl,
        normalizedUrl: normalizeMeetingUrl(meetingUrl),
      };
    }
  }
  return null;
}

/**
 * Extract a supported meeting URL from a Google Calendar event following the
 * priority order: conferenceData.entryPoints -> hangoutLink -> location -> description.
 */
export function extractMeetingUrlFromEvent(event: RawCalendarEvent): ExtractedMeetingUrl | null {
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  for (const ep of entryPoints) {
    if (ep.entryPointType === 'video' && typeof ep.uri === 'string') {
      const found = findSupportedUrlInText(ep.uri);
      if (found) return { ...found, source: 'conferenceData' };
    }
  }
  // Also check any entryPoint uri if none had entryPointType === 'video'
  for (const ep of entryPoints) {
    if (typeof ep.uri === 'string') {
      const found = findSupportedUrlInText(ep.uri);
      if (found) return { ...found, source: 'conferenceData' };
    }
  }

  if (typeof event.hangoutLink === 'string') {
    const found = findSupportedUrlInText(event.hangoutLink);
    if (found) return { ...found, source: 'hangoutLink' };
  }

  if (typeof event.location === 'string') {
    const found = findSupportedUrlInText(event.location);
    if (found) return { ...found, source: 'location' };
  }

  if (typeof event.description === 'string') {
    const found = findSupportedUrlInText(event.description);
    if (found) return { ...found, source: 'description' };
  }

  return null;
}

export interface EvaluateEventOptions {
  /** Calendar IDs where confirmed video meetings auto-join by default (e.g. ['owner@example.com']). */
  defaultAutoJoinCalendars: string[];
}

/** The invite list as lowercased addresses, without duplicates and without room/resource calendars. */
export function attendeeEmailsOf(event: RawCalendarEvent): string[] {
  const out = new Set<string>();
  for (const attendee of event.attendees ?? []) {
    const email = typeof attendee.email === 'string' ? attendee.email.trim().toLowerCase() : '';
    if (email === '' || !email.includes('@') || email.endsWith('resource.calendar.google.com')) continue;
    out.add(email);
  }
  return [...out];
}

/** evaluateCalendarEventCore plus the invite list, so every outcome carries it. */
export function evaluateCalendarEvent(
  ...args: Parameters<typeof evaluateCalendarEventCore>
): ReturnType<typeof evaluateCalendarEventCore> {
  const candidate = evaluateCalendarEventCore(...args);
  if (!candidate) return candidate;
  const event = args[0];
  const organizer = typeof event.organizer?.email === 'string' ? event.organizer.email.trim().toLowerCase() : '';
  return {
    ...candidate,
    attendeeEmails: attendeeEmailsOf(event),
    ...(organizer.includes('@') && !organizer.endsWith('calendar.google.com') ? { organizerEmail: organizer } : {}),
    ...(event.attendeesOmitted === true || event.guestsCanSeeOtherGuests === false ? { inviteListHidden: true } : {}),
  };
}

/**
 * Evaluate a raw Google Calendar event. Returns null when the event is not a
 * timed video meeting (cancelled, all-day, OOO, or no supported video URL).
 * Returns a CalendarMeetingCandidate with `eligible: true | false` and optional
 * `skipReason` when it is a timed video meeting.
 */
function evaluateCalendarEventCore(
  event: RawCalendarEvent,
  calendarId: string,
  opts: EvaluateEventOptions,
): CalendarMeetingCandidate | null {
  if (!event || event.status === 'cancelled') return null;
  if (
    event.eventType === 'outOfOffice' ||
    event.eventType === 'workingLocation' ||
    event.eventType === 'focusTime'
  ) {
    return null;
  }

  const startIso = event.start?.dateTime;
  const endIso = event.end?.dateTime;
  if (!startIso || !endIso) return null; // all-day or malformed

  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const extracted = extractMeetingUrlFromEvent(event);
  if (!extracted) return null;

  const eventId = typeof event.id === 'string' && event.id.trim() !== '' ? event.id.trim() : startIso;
  const title =
    typeof event.summary === 'string' && event.summary.trim() !== ''
      ? event.summary.trim()
      : 'Calendar Meeting';
  const eventKey = `${calendarId}::${eventId}::${startIso}`;
  const seriesId =
    typeof event.recurringEventId === 'string' && event.recurringEventId.trim() !== '' ? event.recurringEventId.trim() : eventId;

  // Check if self declined
  const calLower = calendarId.toLowerCase();
  const selfAttendee = (event.attendees ?? []).find(
    (a) => a.self === true || (typeof a.email === 'string' && a.email.toLowerCase() === calLower),
  );
  if (selfAttendee?.responseStatus === 'declined') {
    return {
      eventKey,
      eventId,
      seriesId,
      calendarId,
      title,
      startIso,
      endIso,
      startMs,
      endMs,
      meetingUrl: extracted.meetingUrl,
      normalizedUrl: extracted.normalizedUrl,
      eligible: false,
      skipReason: 'declined',
    };
  }

  const combinedText = `${event.summary ?? ''}\n${event.description ?? ''}`;
  if (OPT_OUT_RE.test(combinedText)) {
    return {
      eventKey,
      eventId,
      seriesId,
      calendarId,
      title,
      startIso,
      endIso,
      startMs,
      endMs,
      meetingUrl: extracted.meetingUrl,
      normalizedUrl: extracted.normalizedUrl,
      eligible: false,
      skipReason: 'opt_out_tag',
    };
  }

  const isDefaultAutoJoinCal = opts.defaultAutoJoinCalendars.some(
    (c) => c.toLowerCase() === calLower,
  );
  if (!isDefaultAutoJoinCal && !OPT_IN_RE.test(combinedText)) {
    return {
      eventKey,
      eventId,
      seriesId,
      calendarId,
      title,
      startIso,
      endIso,
      startMs,
      endMs,
      meetingUrl: extracted.meetingUrl,
      normalizedUrl: extracted.normalizedUrl,
      eligible: false,
      skipReason: 'personal_calendar_not_opted_in',
    };
  }

  return {
    eventKey,
    eventId,
    seriesId,
    calendarId,
    title,
    startIso,
    endIso,
    startMs,
    endMs,
    meetingUrl: extracted.meetingUrl,
    normalizedUrl: extracted.normalizedUrl,
    eligible: true,
  };
}
