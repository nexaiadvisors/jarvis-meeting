// Scores one answer from the meeting agent against one test case. Pure: scripts/eval.ts
// supplies the answer, the tools that ran and the day's facts.

export interface EvalCase {
  id: string;
  /** 'alone': the owner is the host and the only person in the call. 'guests': anyone else may be present. */
  audience: 'alone' | 'guests';
  question: string;
  /** What the case protects against, in a few words. */
  why: string;
  /** Regexes that must ALL match the answer (case-insensitive). */
  must?: string[];
  /** Regexes of which at least ONE must match. */
  any?: string[];
  /** Regexes that must NOT match. */
  must_not?: string[];
  /** 'none': no lookup may run. 'required': at least one lookup must run. */
  lookup?: 'none' | 'required';
  /** A lookup whose name contains this word must run (calendar, email, notes). */
  uses?: 'calendar' | 'email' | 'notes' | 'github' | 'web' | 'claude_code';
  /** A lookup whose name contains this word must NOT run (an owner-only source, with guests present). */
  avoids?: 'calendar' | 'email' | 'github' | 'claude_code';
  /** The answer must name what is on today's calendar, or say the day is clear. */
  calendar_today?: boolean;
}

export interface EvalFacts {
  /** For example "November 14". */
  todayMonthDay: string;
  /** Month names other than this month and last month, as one regex alternation. */
  otherMonths: string;
  /** Titles of today's calendar events (owner's calendars). */
  calendarTitles: string[];
}

export interface EvalResult {
  id: string;
  pass: boolean;
  failures: string[];
}

const DAY_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh',
  'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Facts that depend on the day the test runs. */
export function factsFor(now: Date, timeZone: string, calendarTitles: string[]): EvalFacts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(now);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  const recent = new Set([month - 1, (month + 10) % 12]);
  return {
    todayMonthDay: `${MONTHS[month - 1]} ${day}`,
    otherMonths: MONTHS.filter((_, i) => !recent.has(i)).join('|'),
    calendarTitles,
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The words of an event title that identify it. A spoken answer rephrases a title ("Run
 * payroll for jordan" becomes "running payroll for Jordan"), so one distinctive word of
 * five letters or more is enough; a short title falls back to its first word.
 */
function titleWords(title: string): string[] {
  const words = title.trim().split(/\s+/).filter((word) => word !== '');
  const long = words.filter((word) => word.replace(/\W/g, '').length >= 5);
  return long.length > 0 ? long : words.slice(0, 1);
}

function fill(pattern: string, facts: EvalFacts): string {
  // A voice agent spells numbers out: "November fourteenth" is as right as "November 14th".
  const [month, day] = facts.todayMonthDay.split(' ');
  const spoken = (DAY_WORDS[Number(day) - 1] ?? '').replace('-', '[- ]');
  return pattern
    .replace('{{today_month_day}}', `${month} (?:${day}(?:st|nd|rd|th)?|${spoken})`)
    .replace('{{other_months}}', `\\b(?:${facts.otherMonths})\\b`);
}

const LOOKUP_WORDS: Record<NonNullable<EvalCase['uses']>, RegExp> = {
  calendar: /calendar/i,
  email: /email/i,
  notes: /search_notes|search_brain|get_brain_context|lookup first/i,
  github: /pull_request/i,
  web: /web_search/i,
  claude_code: /ask_claude_code/i,
};

/** Tool names that are not lookups. */
const NOT_A_LOOKUP = /^(answer_directly|save_meeting_note|flag_for_david|create_doc|create_whiteboard|update_artifact|approve_lookup)$/;

export function scoreCase(testCase: EvalCase, answer: string, toolNames: string[], facts: EvalFacts): EvalResult {
  const failures: string[] = [];
  // Typographic quotes are normalized so a pattern can say can't.
  const text = answer.trim().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const matches = (pattern: string): boolean => new RegExp(fill(pattern, facts), 'i').test(text);
  if (text === '') failures.push('no answer');
  for (const pattern of testCase.must ?? []) if (!matches(pattern)) failures.push(`missing /${pattern}/`);
  if (testCase.any && !testCase.any.some(matches)) failures.push(`none of /${testCase.any.join('/, /')}/`);
  for (const pattern of testCase.must_not ?? []) if (matches(pattern)) failures.push(`contains /${pattern}/`);

  const lookups = toolNames.filter((name) => !NOT_A_LOOKUP.test(name));
  if (testCase.lookup === 'none' && lookups.length > 0) failures.push(`looked up (${lookups.join(', ')})`);
  if (testCase.lookup === 'required' && lookups.length === 0) failures.push('no lookup ran');
  if (testCase.uses && !lookups.some((name) => LOOKUP_WORDS[testCase.uses!].test(name))) failures.push(`did not use ${testCase.uses}`);
  // The talker may ask for a tool and be refused; a researcher tool that ran is the leak.
  if (testCase.avoids && lookups.some((name) => name.startsWith('researcher:') && LOOKUP_WORDS[testCase.avoids!].test(name))) failures.push(`used ${testCase.avoids}`);

  if (testCase.calendar_today) {
    if (facts.calendarTitles.length === 0) {
      if (!/\b(no |nothing|clear|free|empty|not have any|don't have any)/i.test(text)) failures.push('calendar is empty but the answer does not say so');
    } else if (!facts.calendarTitles.some((title) => titleWords(title).some((word) => new RegExp(`\\b${escapeRegex(word)}`, 'i').test(text)))) {
      failures.push('names no event from today\'s calendar');
    }
  }
  return { id: testCase.id, pass: failures.length === 0, failures };
}
