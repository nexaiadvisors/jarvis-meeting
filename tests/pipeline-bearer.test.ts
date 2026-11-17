import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The kb-server bearer must reach /store only for David's own delegate SOUL, and
// only on the kb-server origin. Unlike pipeline.test.ts this file does NOT mock
// ingestToBrain: it lets the real ingest run against a stubbed fetch and reads the
// Authorization header each /store request actually carried.
vi.mock('../src/postmeeting/artifacts.js', () => ({ uploadAudioArtifact: vi.fn(async () => null) }));
vi.mock('../src/postmeeting/summary.js', () => ({
  generateSummary: vi.fn(async () => ({ bluf: 'Ship Friday.', decisions: [], actionItems: [] })),
  generateSummaryWithReason: vi.fn(async () => ({
    summary: { bluf: 'Ship Friday.', decisions: [], actionItems: [] },
  })),
}));
vi.mock('../src/postmeeting/email.js', () => ({
  composeEmail: vi.fn(() => ({ subject: 'T', bodyText: 'T', recipients: [] })),
  sendOrDryRunEmail: vi.fn(async () => {}),
}));
vi.mock('../src/postmeeting/slack.js', () => ({
  deliverSlack: vi.fn(async () => ({ ok: true })),
  chunkForSlack: vi.fn(() => [] as string[]),
}));

const { kickoffPipeline } = await import('../src/postmeeting/pipeline.js');

import type { Config } from '../src/config.js';

const DATA_DIR = join(process.cwd(), '.data');
const KB_ORIGIN = 'http://127.0.0.1:7402';

let soulDir: string;
const botIds: string[] = [];

function writeSoul(slug: string, frontMatter: string): void {
  writeFileSync(join(soulDir, `${slug}.md`), `---\n${frontMatter}\n---\nprose\n`, 'utf8');
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    recallApiKey: 'rk',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600000,
    maxDurationMs: 7200000,
    sweepIntervalMs: 60000,
    publicBaseUrl: 'https://ngrok.example.com',
    tokenRegistry: new Map<string, string>(),
    soulDir,
    defaultTeammate: 'tester',
    artifactSasTtlHours: 168,
    anthropicModel: 'claude-sonnet-5-5',
    meetingSummaryMaxTokens: 4096,
    meetingSummaryInputCharCap: 400000,
    meetingIngestTimeoutMs: 5000,
    meetingEmailDefaultRecipients: [],
    kbBackendToken: 'kb-secret',
    kbBackendHealthUrl: `${KB_ORIGIN}/healthz`,
    workScopeNamespaces: [],
    ...overrides,
  } as unknown as Config;
}

/** Runs the pipeline for `teammate` and returns every /store request: URL plus Authorization header. */
async function storeRequests(cfg: Config, teammate = 'tester'): Promise<Array<{ url: string; authorization: string | null }>> {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: input.toString(), authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const botId = `bot-bearer-${Math.random().toString(36).slice(2)}`;
  botIds.push(botId);
  kickoffPipeline(cfg, { botId, meetingId: `mtg-${botId}`, meetingTitle: 'Sync', teammate });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return seen;
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  soulDir = mkdtempSync(join(tmpdir(), 'pipe-bearer-soul-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const id of botIds.splice(0)) {
    try { rmSync(join(DATA_DIR, `${id}.done`)); } catch { /* ok */ }
  }
  try { rmSync(soulDir, { recursive: true, force: true }); } catch { /* ok */ }
});

const DELEGATE = (endpoint: string, owner = 'tester') =>
  `name: Tester\nowner: ${owner}\npersona_mode: first_person\nknowledge_backend:\n  type: openbrain\n  endpoint: ${endpoint}\ndelivery:\n  - ob\ningest: true`;

describe('pipeline /store bearer is bound to the kb-server origin and David\'s delegate SOUL', () => {
  it('sends the bearer to /store when the delegate SOUL endpoint is on the kb-server origin', async () => {
    writeSoul('tester', DELEGATE(KB_ORIGIN));

    const seen = await storeRequests(config());

    expect(seen).toEqual([{ url: `${KB_ORIGIN}/store`, authorization: 'Bearer kb-secret' }]);
  });

  it('a second delegate SOUL on another origin gets its /store call without the bearer', async () => {
    writeSoul('tester', DELEGATE('http://127.0.0.1:7499'));

    const seen = await storeRequests(config());

    expect(seen).toEqual([{ url: 'http://127.0.0.1:7499/store', authorization: null }]);
  });

  it('a jarvis-route (ai) SOUL never sends the bearer to /store, even on the kb-server origin', async () => {
    // Shaped like soul/example.md: persona ai, localhost:3031, delivery includes ob.
    writeSoul(
      'tester',
      'name: Jarvis\nowner: tester\npersona_mode: ai\nknowledge_backend:\n  type: openbrain\n  endpoint: http://localhost:3031\ndelivery:\n  - slack\n  - ob\ningest: true',
    );

    const exampleShaped = await storeRequests(config());
    expect(exampleShaped).toEqual([{ url: 'http://localhost:3031/store', authorization: null }]);

    writeSoul(
      'tester',
      `name: Jarvis\nowner: tester\npersona_mode: ai\nknowledge_backend:\n  type: openbrain\n  endpoint: ${KB_ORIGIN}\ndelivery:\n  - ob\ningest: true`,
    );
    const sameOrigin = await storeRequests(config());
    expect(sameOrigin).toEqual([{ url: `${KB_ORIGIN}/store`, authorization: null }]);
  });

  it('a delegate SOUL whose owner is not the teammate never sends the bearer', async () => {
    writeSoul('tester', DELEGATE(KB_ORIGIN, 'someone-else'));

    const seen = await storeRequests(config());

    expect(seen).toEqual([{ url: `${KB_ORIGIN}/store`, authorization: null }]);
  });

  it('sends no bearer anywhere when KB_BACKEND_HEALTH_URL is unset or unparseable', async () => {
    writeSoul('tester', DELEGATE(KB_ORIGIN));

    const unset = await storeRequests(config({ kbBackendHealthUrl: undefined }));
    const bad = await storeRequests(config({ kbBackendHealthUrl: 'not a url' }));

    expect(unset).toEqual([{ url: `${KB_ORIGIN}/store`, authorization: null }]);
    expect(bad).toEqual([{ url: `${KB_ORIGIN}/store`, authorization: null }]);
  });
});
