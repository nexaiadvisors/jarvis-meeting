import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMeetingStateRoutes } from './meeting-state.js';
import { registerMeeting, __clearRegistry } from '../meeting/registry.js';
import { ownerCookieValue } from '../auth/owner.js';
import { appendNote } from '../meeting/notes.js';
import { __clearAgentUtterances } from '../meeting/transcript.js';
import { sessionHeader } from '../../tests/helpers/session.js';
import type { Config } from '../config.js';

const DATA_DIR = join(process.cwd(), '.data');
const BOT = 'mstate-test-bot';
const OWNER = 'owner-token-for-tests';
const cleanupFiles: string[] = [];

function makeConfig(): Config {
  return {
    port: 8787,
    recallApiKey: 'k',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600000,
    maxDurationMs: 7200000,
    sweepIntervalMs: 60000,
    publicBaseUrl: 'https://ngrok.example.com',
    teamKbAnswerEndpoint: undefined,
    teamKbAnswerApiToken: undefined,
    teamKbFallbackUrl: 'http://localhost:3031',
    jarvisBotName: 'Jarvis',
    jarvisApiToken: undefined,
    webhookSecret: undefined,
    ownerToken: OWNER,
    tokenRegistry: new Map<string, string>(),
    soulDir: join(process.cwd(), 'soul'),
    teamKbEndpoint: undefined,
    defaultTeammate: 'example',
    azureStorageAccountName: undefined,
    azureStorageAccountKey: undefined,
    azureStorageBlobContainer: undefined,
    artifactSasTtlHours: 168,
    anthropicApiKey: undefined,
    anthropicModel: 'claude-sonnet-4-6',
    graphTenantId: undefined,
    graphClientId: undefined,
    graphClientSecret: undefined,
    meetingEmailSender: undefined,
    meetingEmailDefaultRecipients: [],
  };
}

const config = makeConfig();

function mount(): Hono {
  const app = new Hono();
  app.route('/', createMeetingStateRoutes(config));
  return app;
}

/** Session header for a meeting registered with teammate 'example'. */
function auth(meetingId: string): Record<string, string> {
  return sessionHeader(config, meetingId, 'example');
}

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => {
  for (const f of cleanupFiles) rmSync(f, { force: true });
  cleanupFiles.length = 0;
});

describe('GET /api/meetings/:id', () => {
  it('returns registry data + transcript from the bot jsonl', async () => {
    const file = join(DATA_DIR, `${BOT}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ speaker: 'Alice', text: 'hi', timestamp: '2026-06-24T00:00:00Z' })}\n`, 'utf8');
    cleanupFiles.push(file);

    registerMeeting({ meetingId: 'g1', botId: BOT, teammate: 'example', persona: 'ai', title: 'Standup' });

    const res = await mount().fetch(new Request('http://x/api/meetings/g1', { headers: auth('g1') }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meeting: Record<string, unknown> };
    expect(body.meeting['id']).toBe('g1');
    expect(body.meeting['title']).toBe('Standup');
    expect(body.meeting['status']).toBe('live');
    expect(body.meeting['metadata']).toEqual({ muted: false });
    const transcript = body.meeting['transcript'] as Array<Record<string, unknown>>;
    expect(transcript[0]).toEqual({ speaker: 'Alice', text: 'hi', timestamp: '2026-06-24T00:00:00Z' });
  });

  it('interleaves the bot lines with what was said, by time, labeled with the bot display name', async () => {
    const bot = 'mstate-order-bot';
    const file = join(DATA_DIR, `${bot}.jsonl`);
    writeFileSync(
      file,
      [
        { speaker: 'Alice', text: 'what shipped?', timestamp: '2020-01-01T00:00:00.000Z' },
        { speaker: 'Alice', text: 'thanks', timestamp: '2099-01-01T00:00:00.000Z' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
    cleanupFiles.push(file, join(DATA_DIR, 'gi1.agent.jsonl'));
    registerMeeting({ meetingId: 'gi1', botId: bot, teammate: 'example', persona: 'ai', title: 'Order' });
    const app = mount();

    // The bot answers "now": after Alice's first line, before her last.
    const post = await app.fetch(
      new Request('http://x/api/meetings/gi1/agent-utterance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth('gi1') },
        body: JSON.stringify({ speaker: 'Agent', text: 'the panel shipped' }),
      }),
    );
    expect(post.status).toBe(200);

    const res = await app.fetch(new Request('http://x/api/meetings/gi1', { headers: auth('gi1') }));
    const body = (await res.json()) as { meeting: { transcript: Array<{ speaker: string; text: string }> } };
    expect(body.meeting.transcript.map((e) => `${e.speaker}: ${e.text}`)).toEqual([
      'Alice: what shipped?',
      'Jarvis: the panel shipped',
      'Alice: thanks',
    ]);
  });

  it('returns [] transcript when no jsonl exists', async () => {
    registerMeeting({ meetingId: 'g2', teammate: 'example', persona: 'ai', title: 'M' });
    const res = await mount().fetch(new Request('http://x/api/meetings/g2', { headers: auth('g2') }));
    const body = (await res.json()) as { meeting: Record<string, unknown> };
    expect(body.meeting['transcript']).toEqual([]);
  });

  it('GET /api/meetings/:id returns notes', async () => {
    const file = join(DATA_DIR, `${BOT}.notes.jsonl`);
    cleanupFiles.push(file);
    const note = { kind: 'note', text: 'Ship on Friday', at: '2026-10-16T10:00:00.000Z', by: 'agent' } as const;
    const flag = { kind: 'flag', text: '[FLAG FOR DAVID] budget', at: '2026-10-16T10:01:00.000Z', by: 'agent' } as const;
    appendNote(BOT, note);
    appendNote(BOT, flag);
    registerMeeting({ meetingId: 'gn1', botId: BOT, teammate: 'example', persona: 'ai', title: 'Standup' });

    const res = await mount().fetch(new Request('http://x/api/meetings/gn1', { headers: auth('gn1') }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meeting: Record<string, unknown> };
    expect(body.meeting['notes']).toEqual([note, flag]);

    // The owner panel reads the same meeting and sees the same notes.
    const owner = await mount().fetch(
      new Request('http://x/api/meetings/gn1', { headers: { Authorization: `Bearer ${OWNER}` } }),
    );
    expect(((await owner.json()) as { meeting: Record<string, unknown> }).meeting['notes']).toEqual([note, flag]);
  });

  it('returns [] notes when none were saved, keyed by meetingId when the meeting has no botId', async () => {
    registerMeeting({ meetingId: 'gn2', teammate: 'example', persona: 'ai', title: 'M' });
    const res = await mount().fetch(new Request('http://x/api/meetings/gn2', { headers: auth('gn2') }));
    expect(((await res.json()) as { meeting: Record<string, unknown> }).meeting['notes']).toEqual([]);

    const file = join(DATA_DIR, 'gn2.notes.jsonl');
    cleanupFiles.push(file);
    appendNote('gn2', { kind: 'note', text: 'by meeting id', at: '2026-10-16T10:00:00.000Z', by: 'agent' });
    const again = await mount().fetch(new Request('http://x/api/meetings/gn2', { headers: auth('gn2') }));
    const notes = ((await again.json()) as { meeting: { notes: Array<{ text: string }> } }).meeting.notes;
    expect(notes.map((n) => n.text)).toEqual(['by meeting id']);
  });

  it('returns 404 for an unknown meeting', async () => {
    const res = await mount().fetch(new Request('http://x/api/meetings/unknown', { headers: auth('unknown') }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });
});

describe('POST /api/meetings/:id/agent-utterance', () => {
  it('appends an utterance and surfaces it in the GET transcript', async () => {
    cleanupFiles.push(join(DATA_DIR, 'u1.agent.jsonl'));
    registerMeeting({ meetingId: 'u1', teammate: 'example', persona: 'ai', title: 'M' });
    const app = mount();

    const post = await app.fetch(
      new Request('http://x/api/meetings/u1/agent-utterance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth('u1') },
        body: JSON.stringify({ speaker: 'Jarvis', text: 'hello there' }),
      }),
    );
    expect(post.status).toBe(200);
    expect((await post.json()) as Record<string, unknown>).toEqual({ ok: true });

    const get = await app.fetch(new Request('http://x/api/meetings/u1', { headers: auth('u1') }));
    const body = (await get.json()) as { meeting: Record<string, unknown> };
    const transcript = body.meeting['transcript'] as Array<Record<string, unknown>>;
    expect(transcript.some((e) => e['text'] === 'hello there' && e['speaker'] === 'Jarvis')).toBe(true);
  });
});

describe('POST /api/meetings/:id/context-refresh', () => {
  it('is a V1 no-op returning contextText null', async () => {
    registerMeeting({ meetingId: 'c1', teammate: 'example', persona: 'ai', title: 'M' });
    const res = await mount().fetch(
      new Request('http://x/api/meetings/c1/context-refresh', { method: 'POST', headers: auth('c1') }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ contextText: null });
  });
});

describe('POST /api/meetings/:id/retrieval-log', () => {
  it('persists structured retrieval telemetry fields', async () => {
    const file = join(DATA_DIR, 'r1.retrieval-log.jsonl');
    cleanupFiles.push(file);
    registerMeeting({ meetingId: 'r1', teammate: 'example', persona: 'ai', title: 'M' });
    const res = await mount().fetch(
      new Request('http://x/api/meetings/r1/retrieval-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth('r1') },
        body: JSON.stringify({
          tool: 'ob-search',
          query: 'raw query',
          searched_query: 'expanded query',
          doc_keys: ['doc-1'],
          sources: ['openbrain'],
          top_score: 0.82,
          lanes: { openbrain: { status: 'ok', ms: 123 }, teamKb: { status: 'empty', ms: 0 } },
          elapsed_ms: 124,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });

    const line = readFileSync(file, 'utf8').trim();
    const saved = JSON.parse(line) as Record<string, unknown>;
    expect(saved).toMatchObject({
      tool: 'ob-search',
      query: 'raw query',
      searched_query: 'expanded query',
      doc_keys: ['doc-1'],
      sources: ['openbrain'],
      top_score: 0.82,
      lanes: { openbrain: { status: 'ok', ms: 123 }, teamKb: { status: 'empty', ms: 0 } },
      elapsed_ms: 124,
    });
    expect(typeof saved['timestamp']).toBe('string');
  });
});

// Every route here needs the meeting's session token (or, for GET only, the owner).
const ROUTES: Array<{ method: 'GET' | 'POST'; suffix: string; file?: string; ownerOk: boolean }> = [
  { method: 'GET', suffix: '', ownerOk: true },
  { method: 'POST', suffix: '/agent-utterance', file: 'agent.jsonl', ownerOk: false },
  { method: 'POST', suffix: '/client-log', file: 'client-log.jsonl', ownerOk: false },
  { method: 'POST', suffix: '/retrieval-log', file: 'retrieval-log.jsonl', ownerOk: false },
  { method: 'POST', suffix: '/context-refresh', ownerOk: false },
];

function call(
  route: (typeof ROUTES)[number],
  id: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    mount().fetch(
      new Request(`http://x/api/meetings/${id}${route.suffix}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(route.method === 'POST' ? { body: JSON.stringify({ speaker: 'x', text: 'leak', message: 'leak' }) } : {}),
      }),
    ),
  );
}

describe.each(ROUTES)('$method /api/meetings/:id$suffix session guard', (route) => {
  const written = (id: string): string[] =>
    route.file ? [join(DATA_DIR, `${id}.${route.file}`)] : [];

  it('401s without a session token and writes nothing', async () => {
    registerMeeting({ meetingId: 'sg1', teammate: 'example', persona: 'ai', title: 'M' });
    cleanupFiles.push(...written('sg1'));

    const res = await call(route, 'sg1');

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('SESSION_REQUIRED');
    for (const f of written('sg1')) expect(existsSync(f)).toBe(false);
  });

  it('401s with a session token minted for a different meeting', async () => {
    registerMeeting({ meetingId: 'sg1', teammate: 'example', persona: 'ai', title: 'M' });
    registerMeeting({ meetingId: 'sg2', teammate: 'example', persona: 'ai', title: 'M' });
    cleanupFiles.push(...written('sg1'));

    const res = await call(route, 'sg1', auth('sg2'));

    expect(res.status).toBe(401);
    for (const f of written('sg1')) expect(existsSync(f)).toBe(false);
  });

  it('404s an unregistered meeting id and writes nothing (no files for arbitrary ids)', async () => {
    cleanupFiles.push(...written('ghost'));

    const res = await call(route, 'ghost', auth('ghost'));

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
    for (const f of written('ghost')) expect(existsSync(f)).toBe(false);
  });

  it(route.ownerOk ? 'admits the owner cookie' : 'rejects the owner cookie', async () => {
    registerMeeting({ meetingId: 'sg3', teammate: 'example', persona: 'ai', title: 'M' });
    cleanupFiles.push(...written('sg3'));

    const res = await call(route, 'sg3', { Cookie: `jm_owner=${ownerCookieValue(config)}` });

    expect(res.status).toBe(route.ownerOk ? 200 : 401);
    if (!route.ownerOk) for (const f of written('sg3')) expect(existsSync(f)).toBe(false);
  });
});
