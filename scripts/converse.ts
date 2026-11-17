// Talk to the meeting agent in text, without a meeting.
//
//   npx tsx scripts/converse.ts "Jarvis, how are you today?" "Jarvis, what is the status of Northwind?"
//   npx tsx scripts/converse.ts --file questions.txt        (one question per line)
//   npx tsx scripts/converse.ts --mode forced "..."         (lookup before every answer)
//   npx tsx scripts/converse.ts --alone "..."               (as if the owner were the only person in the call)
//
// What is real: the instructions, the tool list and the session settings come from the
// same route the bot's page calls (POST /api/meetings/:id/realtime-session); the answer
// routing is src/agent/answer-route.ts; tool calls go to the same /api/voice/* routes,
// so the knowledge lookups, the work-scope filter and the "no results" handling are the
// ones a live meeting uses; the model is the same OpenAI realtime model.
//
// What is not covered: audio in and out, speech recognition, the wake-word gate, and
// barge-in. Each question is sent as text, as if the wake gate had already opened, and
// the answer comes back as text. Timings are time to first text, not time to first audio.
//
//   RESEARCHER=on npx tsx scripts/converse.ts "..."     (a Claude researcher does the lookups)
//
// It registers a throwaway meeting in THIS process only. It creates no Recall bot and
// does not touch the running service's registry. It spends OpenAI tokens (text only).
// Run it where the knowledge backend is reachable, with the service's environment loaded.

import { readFileSync } from 'node:fs';
import { parseRetrievalMode, type RetrievalMode } from '../src/agent/answer-route.js';
import { openSession, type Turn } from './lib/session.js';

function parseArgs(argv: string[]): { questions: string[]; mode: RetrievalMode | undefined; json: boolean; alone: boolean } {
  const questions: string[] = [];
  let mode: RetrievalMode | undefined;
  let json = false;
  let alone = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--file') {
      const file = argv[(i += 1)];
      if (!file) throw new Error('--file needs a path');
      questions.push(...readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')));
    } else if (arg === '--mode') {
      mode = parseRetrievalMode(argv[(i += 1)]);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--alone') {
      alone = true;
    } else {
      questions.push(arg);
    }
  }
  return { questions, mode, json, alone };
}

async function main(): Promise<void> {
  const { questions, mode, json, alone } = parseArgs(process.argv.slice(2));
  if (questions.length === 0) {
    console.error('usage: npx tsx scripts/converse.ts [--mode model|forced] [--alone] [--json] [--file questions.txt] "question" ...');
    process.exit(2);
  }
  const session = await openSession({ alone, ...(mode ? { mode } : {}) });
  const turns: Turn[] = [];
  for (const question of questions) turns.push(await session.ask(question));
  session.close();

  if (json) {
    console.log(JSON.stringify({ model: session.model, mode: session.mode, persona: session.persona, knowledge: session.knowledgeMode, turns }, null, 2));
  } else {
    console.log(`model ${session.model} | retrieval mode ${session.mode} | persona ${session.persona} | knowledge ${session.knowledgeMode}\n`);
    for (const t of turns) {
      const tools = t.tools.map((x) => `${x.name}${x.query ? `("${x.query.slice(0, 60)}")` : ''}${x.results !== undefined ? ` -> ${x.results} results` : ''}`).join('; ') || 'none';
      console.log(`YOU:    ${t.question}`);
      console.log(`JARVIS: ${t.answer.trim() || '(nothing)'}`);
      console.log(`        route ${t.route} | lookups: ${tools} | first text ${t.firstTextMs ?? '-'} ms | total ${t.totalMs} ms${t.errors.length ? ` | ERRORS: ${t.errors.join(' / ')}` : ''}\n`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
