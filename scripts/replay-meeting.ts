// Replay a meeting through the in-process app, with no Recall bot and no phone.
//
//   npx tsx scripts/replay-meeting.ts
//
// What it does, in order:
//   1. loads config from the environment (and from .env.local when that file exists;
//      variables already in the environment win),
//   2. builds the app in this process with createApp(config),
//   3. registers a meeting with a fake botId and mints its session token,
//   4. sends two transcript.data webhooks (with ?s=<WEBHOOK_SECRET>), one
//      /api/voice/save note, and a bot.done webhook through app.fetch,
//   5. waits for the fire-and-forget post-meeting pipeline by polling the OpenBrain
//      kb-server `POST /document {entity_key: "meeting-<id>"}` every 2 s for up to 120 s,
//   6. checks that the stored document has the `## BLUF`, `## Noted` and
//      `## Transcript` sections.
//
// It never calls POST /v1/dispatch and never talks to Recall: every request to a
// recall.ai host is refused. The only paid call is the Anthropic summary request the
// pipeline makes: one request, plus at most one retry on ANTHROPIC_FALLBACK_MODEL when
// the first answer is a refusal or has no structured output (so at most two requests are
// allowed). The run writes one test document into the OpenBrain behind the SOUL's
// knowledge_backend.endpoint.
//
// It prints statuses, counts and section headings only. Never document text, never a key.
//
// Exit codes: 0 = document found with all required sections; 1 = replay ran but the
// check failed; 2 = could not start (config, SOUL or working directory).

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { registerMeeting } from '../src/meeting/registry.js';
import { mintMeetingSessionToken } from '../src/routes/session-token.js';
import { kbBearerFor } from '../src/retrieval/kb-bearer.js';
import { backendBaseUrl } from '../src/retrieval/knowledge-client.js';
import { loadSoul } from '../src/soul/loader.js';

export const REQUIRED_HEADINGS = ['## BLUF', '## Noted', '## Transcript'] as const;

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 120_000;
/** One summary request plus at most one retry. */
const MAX_ANTHROPIC_REQUESTS = 2;

/** A Recall `transcript.data` webhook body, in the shape src/routes/webhook.ts parses. */
export function transcriptEvent(botId: string, speaker: string, text: string): Record<string, unknown> {
  return {
    event: 'transcript.data',
    data: {
      bot: { id: botId },
      data: {
        participant: { name: speaker },
        words: text.split(/\s+/).filter(Boolean).map((word) => ({ text: word })),
      },
    },
  };
}

/** A Recall `bot.done` webhook body. `metadata` is what createBot echoes back from Recall. */
export function botDoneEvent(botId: string, meetingId: string, teammate: string): Record<string, unknown> {
  return {
    event: 'bot.done',
    data: { bot: { id: botId, metadata: { meeting_id: meetingId, teammate } } },
  };
}

/** The markdown headings (`#` to `###`) of a document, in order. */
export function headingsOf(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => /^#{1,3} \S/.test(line)).map((line) => line.trimEnd());
}

/** The required headings the document does not have. */
export function missingHeadings(content: string): string[] {
  const have = new Set(headingsOf(content));
  return REQUIRED_HEADINGS.filter((heading) => !have.has(heading));
}

export interface LogLine {
  level: string;
  msg: string;
  error?: string;
}

/**
 * Whether the pipeline produced a real summary. A failed summary still ingests a
 * document (BLUF is a failure stub), so the section check alone cannot tell.
 */
export function summaryStatus(lines: readonly LogLine[]): 'generated' | 'not-generated' {
  return lines.some((l) => l.msg === 'summary: generated') ? 'generated' : 'not-generated';
}

/**
 * Keep the app's structured logs instead of printing them: only `level`, `msg` and a short
 * `error` survive. The capture stays on until the process exits (it is never undone), so a
 * pipeline step that logs after the check has finished cannot print a raw log line. The
 * script prints through `say`, which writes to stdout directly.
 */
function captureLogs(): { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const take = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first !== 'string' || !first.startsWith('{')) return;
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      const line: LogLine = {
        level: typeof parsed['level'] === 'string' ? parsed['level'] : 'info',
        msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : '(no msg)',
      };
      if (typeof parsed['error'] === 'string') line.error = parsed['error'].slice(0, 160);
      lines.push(line);
    } catch {
      // not a structured line
    }
  };
  console.log = take;
  console.info = take;
  console.warn = take;
  console.error = take;
  return { lines };
}

interface RequestCounts {
  anthropic: number;
  recallBlocked: number;
}

/** Count Anthropic requests, cap them, and refuse every recall.ai host. */
function guardFetch(): RequestCounts {
  const counts: RequestCounts = { anthropic: 0, recallBlocked: 0 };
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      // relative or malformed: let fetch report it
    }
    if (host === 'recall.ai' || host.endsWith('.recall.ai')) {
      counts.recallBlocked += 1;
      throw new Error('replay-meeting refuses to call Recall');
    }
    if (host === 'api.anthropic.com') {
      counts.anthropic += 1;
      if (counts.anthropic > MAX_ANTHROPIC_REQUESTS) {
        throw new Error('replay-meeting: Anthropic request budget used up');
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return counts;
}

function loadEnvLocal(): void {
  if (!existsSync('.env.local')) return;
  // Does not override variables that are already set.
  process.loadEnvFile('.env.local');
}

function isRepoRoot(): boolean {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name?: string };
    return pkg.name === 'jarvis-meeting';
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface StoredDocument {
  namespace: string;
  doc_type: string;
  entity_key: string;
  content: string;
}

type ReadResult = { status: number; document?: StoredDocument };

async function readDocument(url: string, bearer: string | undefined, entityKey: string): Promise<ReadResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ entity_key: entityKey }),
    });
    if (response.status !== 200) return { status: response.status };
    const data = (await response.json()) as { document?: Partial<StoredDocument> };
    const d = data.document;
    if (
      d !== undefined &&
      typeof d.namespace === 'string' &&
      typeof d.doc_type === 'string' &&
      typeof d.entity_key === 'string' &&
      typeof d.content === 'string'
    ) {
      return { status: 200, document: { namespace: d.namespace, doc_type: d.doc_type, entity_key: d.entity_key, content: d.content } };
    }
    return { status: 200 };
  } catch {
    return { status: 0 };
  }
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function run(): Promise<number> {
  if (!isRepoRoot()) {
    say('replay: run this from the jarvis-meeting repo root (the pipeline writes to ./.data)');
    return 2;
  }
  loadEnvLocal();

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    say(`replay: config error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const teammate = config.defaultTeammate;
  let backendEndpoint: string;
  try {
    backendEndpoint = loadSoul(teammate, config.soulDir).knowledgeBackend.endpoint;
  } catch (err) {
    say(`replay: SOUL error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (backendEndpoint.trim() === '') {
    say('replay: the SOUL has no knowledge_backend.endpoint, so there is nowhere to read the notes back from');
    return 2;
  }
  const documentUrl = `${backendBaseUrl(backendEndpoint)}/document`;
  const bearer = kbBearerFor(config, documentUrl);

  const today = new Date().toISOString().slice(0, 10);
  const title = process.env['REPLAY_TITLE']?.trim() || `jarvis-meeting replay test ${today}`;
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const meetingId = `replay-${stamp}-${randomBytes(3).toString('hex')}`;
  const botId = `replay-bot-${stamp}-${randomBytes(3).toString('hex')}`;
  const entityKey = `meeting-${meetingId}`;

  const counts = guardFetch();
  const logs = captureLogs();
  const app = createApp(config);

  registerMeeting({ meetingId, botId, teammate, persona: 'first_person', title });
  const token = mintMeetingSessionToken(config, { meetingId, teammate });

  const webhookPath = config.webhookSecret
    ? `/webhooks/recall?s=${encodeURIComponent(config.webhookSecret)}`
    : '/webhooks/recall';
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      ),
    );

  const lines: string[] = [];
  const note = (text: string): void => {
    lines.push(text);
  };

  note(`replay: meeting_id=${meetingId} bot_id=${botId} teammate=${teammate}`);
  note(`replay: title="${title}"`);
  note(`replay: reading back from ${documentUrl} ${bearer ? '(bearer attached)' : '(NO bearer: origin does not match KB_BACKEND_HEALTH_URL)'}`);

  if (config.webhookSecret) {
    const refused = await post('/webhooks/recall', transcriptEvent(botId, 'Nobody', 'no secret'));
    note(`webhook without secret -> ${refused.status} (expected 401)`);
  }

  const first = await post(
    webhookPath,
    transcriptEvent(
      botId,
      'David',
      "Let's use this call to test the meeting companion. The goal is to confirm that the notes document lands in OpenBrain after the meeting ends.",
    ),
  );
  note(`webhook transcript.data #1 -> ${first.status}`);
  const second = await post(
    webhookPath,
    transcriptEvent(
      botId,
      'Alex',
      'Agreed. Decision: we ship the replay script today, and Alex will check the owner panel on a real phone tomorrow.',
    ),
  );
  note(`webhook transcript.data #2 -> ${second.status}`);

  const saved = await post(
    '/api/voice/save',
    { meetingId, content: 'Replay test: Alex to check the owner panel on a phone tomorrow.', tags: ['meeting-note'] },
    { Authorization: `Bearer ${token}` },
  );
  note(`voice/save (note) -> ${saved.status}`);

  const done = await post(webhookPath, botDoneEvent(botId, meetingId, teammate));
  note(`webhook bot.done -> ${done.status}`);

  note(`waiting for ${entityKey} (poll every ${POLL_INTERVAL_MS / 1000}s, up to ${POLL_DEADLINE_MS / 1000}s)`);
  const startedAt = Date.now();
  let result: ReadResult = { status: 0 };
  let pipelineComplete = false;
  while (Date.now() - startedAt < POLL_DEADLINE_MS) {
    result = await readDocument(documentUrl, bearer, entityKey);
    if (result.document !== undefined) break;
    if (result.status === 401 || result.status === 403) break; // bad bearer: waiting will not help
    if (pipelineComplete) break; // pipeline finished and the document is still absent
    pipelineComplete = logs.lines.some((l) => l.msg === 'pipeline: complete');
    await sleep(POLL_INTERVAL_MS);
  }
  const waitedS = Math.round((Date.now() - startedAt) / 1000);

  for (const line of lines) say(line);

  let exit = 1;
  if (result.document === undefined) {
    say(`document NOT found after ${waitedS}s (last /document status ${result.status})`);
  } else {
    const doc = result.document;
    const headings = headingsOf(doc.content);
    const missing = missingHeadings(doc.content);
    say(`document found after ${waitedS}s: namespace=${doc.namespace} doc_type=${doc.doc_type} entity_key=${doc.entity_key} (${doc.content.length} chars)`);
    say('headings:');
    for (const heading of headings) say(`  ${heading}`);
    say(`required sections (${REQUIRED_HEADINGS.join(', ')}): ${missing.length === 0 ? 'all present' : `MISSING ${missing.join(', ')}`}`);
    exit = missing.length === 0 ? 0 : 1;
  }

  say(`requests: anthropic=${counts.anthropic} (cap ${MAX_ANTHROPIC_REQUESTS}), recall blocked=${counts.recallBlocked}`);
  say('pipeline log:');
  for (const l of logs.lines) {
    if (l.msg === 'transcript.data' || l.msg === 'ob-search') continue;
    say(`  [${l.level}] ${l.msg}${l.error ? ` | ${l.error}` : ''}`);
  }
  const summary = summaryStatus(logs.lines);
  say(`summary: ${summary === 'generated' ? 'generated by the model' : 'NOT generated (the BLUF in the document is the failure stub)'}`);
  if (exit === 0) {
    say(summary === 'generated' ? 'replay: PASS' : 'replay: PASS with WARNING (notes document landed, but the summary step failed)');
  } else {
    say('replay: FAIL');
  }
  return exit;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then(
    (code) => process.exit(code),
    (err: unknown) => {
      say(`replay: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
