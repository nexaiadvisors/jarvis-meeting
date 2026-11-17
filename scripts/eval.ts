// Scores the meeting agent on a fixed question set, by text, without a meeting.
//
//   npx tsx scripts/eval.ts                      (every case in evals/questions.json)
//   npx tsx scripts/eval.ts --only cal-today,time-yesterday
//   npx tsx scripts/eval.ts --out .data/evals/researcher.json
//   RESEARCHER=on npx tsx scripts/eval.ts        (score the researcher design)
//
// Each case runs in a fresh conversation, so one answer cannot leak facts into the next.
// It spends OpenAI realtime tokens (text only) and, in researcher mode, Claude tokens.
// Run it where the knowledge backend and gws-sa are reachable, with the service's
// environment loaded. Exit code 0 when every case passes, 1 otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { factsFor, scoreCase, type EvalCase } from '../src/eval/score.js';
import { openSession } from './lib/session.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg('--only')?.split(',').map((id) => id.trim());
  const out = arg('--out');
  const all = JSON.parse(readFileSync(arg('--cases') ?? 'evals/questions.json', 'utf8')) as EvalCase[];
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  const config = loadConfig();
  const timeZone = config.calendarTimeZone ?? 'America/New_York';

  // Today's calendar, read through the same route the agent uses, as the owner alone.
  const probe = await openSession({ alone: true });
  const calendar = (await (await probe.post('/api/voice/calendar', {})).json().catch(() => ({}))) as { events?: Array<{ title?: string }> };
  const knowledge = probe.knowledgeMode;
  const model = probe.model;
  probe.close();
  const facts = factsFor(new Date(), timeZone, (calendar.events ?? []).map((e) => e.title ?? '').filter((t) => t !== ''));

  const rows: Array<Record<string, unknown>> = [];
  for (const testCase of cases) {
    const session = await openSession({ alone: testCase.audience === 'alone' });
    const turn = await session.ask(testCase.question);
    session.close();
    const tools = turn.tools.map((t) => t.name);
    const result = scoreCase(testCase, turn.answer, tools, facts);
    const failures = [...result.failures, ...turn.errors.map((e) => `error: ${e}`)];
    const pass = failures.length === 0;
    rows.push({ id: testCase.id, audience: testCase.audience, pass, failures, tools, first_text_ms: turn.firstTextMs, total_ms: turn.totalMs, question: testCase.question, answer: turn.answer.trim() });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.id.padEnd(30)} ${String(turn.totalMs).padStart(6)} ms  ${pass ? '' : failures.join('; ')}`);
  }

  const passed = rows.filter((r) => r['pass'] === true).length;
  const times = rows.map((r) => Number(r['total_ms'])).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  const summary = { knowledge, model, researcher_model: knowledge === 'researcher' ? config.researcherModel : undefined, cases: rows.length, passed, median_ms: median, max_ms: times[times.length - 1] ?? 0, ran_at: new Date().toISOString() };
  console.log(`\n${passed}/${rows.length} passed | knowledge ${knowledge} | median ${median} ms | max ${summary.max_ms} ms`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
    console.log(`written: ${out}`);
  }
  process.exit(passed === rows.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
