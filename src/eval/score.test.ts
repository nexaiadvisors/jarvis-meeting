import { describe, expect, it } from 'vitest';
import { factsFor, scoreCase, type EvalCase } from './score.js';

const facts = factsFor(new Date('2026-11-14T15:00:00Z'), 'America/New_York', ['Run payroll for jordan']);
const base: EvalCase = { id: 't', audience: 'alone', question: 'q', why: 'w' };

describe('factsFor', () => {
  it('names today and treats months other than this and last as stale', () => {
    expect(facts.todayMonthDay).toBe('November 14');
    expect(facts.otherMonths).toContain('June');
    expect(facts.otherMonths).not.toContain('November');
    expect(facts.otherMonths).not.toContain('October');
  });

  it('wraps the year in January', () => {
    const january = factsFor(new Date('2027-01-10T15:00:00Z'), 'America/New_York', []);
    expect(january.otherMonths).not.toContain('December');
    expect(january.otherMonths).not.toContain('January');
  });
});

describe('scoreCase', () => {
  it('passes when every rule holds', () => {
    const result = scoreCase({ ...base, any: ['Pat', 'Lee'], lookup: 'required', uses: 'notes' }, 'The client is Pat Lee.', ['ask_researcher', 'researcher:search_notes'], facts);
    expect(result).toEqual({ id: 't', pass: true, failures: [] });
  });

  it('fails a stale month in an answer about a recent period', () => {
    const result = scoreCase({ ...base, must_not: ['{{other_months}}'] }, 'You worked on the June 23 sync.', ['search_brain'], facts);
    expect(result.pass).toBe(false);
  });

  it('accepts today written with an ordinal', () => {
    expect(scoreCase({ ...base, must: ['{{today_month_day}}'] }, 'Today is November 14th.', [], facts).pass).toBe(true);
  });

  it('accepts a spelled-out day and typographic apostrophes', () => {
    expect(scoreCase({ ...base, must: ['{{today_month_day}}'] }, 'Today\u2019s date is November fourteenth, 2026.', [], facts).pass).toBe(true);
    expect(scoreCase({ ...base, any: ["can't"] }, 'I can\u2019t check the calendar here.', [], facts).pass).toBe(true);
  });

  it('fails small talk that ran a lookup, and does not count answer_directly as one', () => {
    expect(scoreCase({ ...base, lookup: 'none' }, 'Doing well.', ['answer_directly'], facts).pass).toBe(true);
    expect(scoreCase({ ...base, lookup: 'none' }, 'Doing well.', ['search_brain'], facts).pass).toBe(false);
  });

  it('requires the named source', () => {
    const result = scoreCase({ ...base, uses: 'calendar' }, 'You have one event.', ['search_brain'], facts);
    expect(result.failures).toEqual(['did not use calendar']);
  });

  it('checks the answer against today\'s calendar', () => {
    expect(scoreCase({ ...base, calendar_today: true }, 'You have "Run payroll for Jordan" at 9.', ['check_calendar'], facts).pass).toBe(true);
    expect(scoreCase({ ...base, calendar_today: true }, 'You have the parity retest call.', ['search_brain'], facts).pass).toBe(false);
    // A spoken answer rephrases the title.
    expect(scoreCase({ ...base, calendar_today: true }, 'You have one thing today: running payroll for Jordan at 9.', ['check_calendar'], facts).pass).toBe(true);
    const empty = factsFor(new Date('2026-11-14T15:00:00Z'), 'America/New_York', []);
    expect(scoreCase({ ...base, calendar_today: true }, 'Nothing is on your calendar today.', ['check_calendar'], empty).pass).toBe(true);
  });

  it('fails when an owner-only source ran for a case that must avoid it', () => {
    expect(scoreCase({ ...base, avoids: 'github' }, 'Two pull requests.', ['ask_researcher', 'researcher:search_notes'], facts).pass).toBe(true);
    expect(scoreCase({ ...base, avoids: 'github' }, 'Two pull requests.', ['ask_researcher', 'researcher:search_pull_requests'], facts).failures).toEqual(['used github']);
  });

  it('fails an empty answer', () => {
    expect(scoreCase(base, '  ', [], facts).failures).toContain('no answer');
  });
});
