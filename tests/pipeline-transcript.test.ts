// The stored OpenBrain document carries the whole conversation: what people said AND what
// the bot said, in time order. Real ingest, real transcript reader; only the model summary,
// the audio upload and the HTTP /store call are stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/postmeeting/artifacts.js', () => ({ uploadAudioArtifact: vi.fn(async () => null) }));
vi.mock('../src/postmeeting/summary.js', () => ({
  generateSummaryWithReason: async () => ({
    summary: { bluf: 'Panel shipped.', decisions: [], actionItems: [] },
  }),
}));

const { kickoffPipeline } = await import('../src/postmeeting/pipeline.js');
const { appendAgentUtterance, __clearAgentUtterances } = await import('../src/meeting/transcript.js');

import type { Config } from '../src/config.js';

const DATA_DIR = join(process.cwd(), '.data');
let soulDir: string;
const created: string[] = [];

function makeConfig(): Config {
  return {
    port: 8787,
    recallApiKey: 'rk',
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
    tokenRegistry: new Map<string, string>(),
    soulDir,
    teamKbEndpoint: undefined,
    defaultTeammate: 'tester',
    azureStorageAccountName: undefined,
    azureStorageAccountKey: undefined,
    azureStorageBlobContainer: undefined,
    artifactSasTtlHours: 168,
    anthropicApiKey: undefined,
    anthropicModel: 'claude-sonnet-4-6',
    meetingSummaryMaxTokens: 4096,
    meetingSummaryInputCharCap: 400000,
    meetingIngestTimeoutMs: 120000,
    graphTenantId: undefined,
    graphClientId: undefined,
    graphClientSecret: undefined,
    meetingEmailSender: undefined,
    meetingEmailDefaultRecipients: [],
    meetingSlackChannel: undefined,
  } as Config;
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  __clearAgentUtterances();
  soulDir = mkdtempSync(join(tmpdir(), 'pipe-tr-soul-'));
  writeFileSync(
    join(soulDir, 'tester.md'),
    '---\nname: Tester\nowner: tester\nknowledge_backend:\n  type: openbrain\n  endpoint: http://127.0.0.1:7402\ndelivery:\n  - ob\ningest: true\n---\nprose\n',
    'utf8',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(soulDir, { recursive: true, force: true });
  for (const f of created) rmSync(f, { force: true });
  created.length = 0;
});

describe('post-meeting ingest transcript', () => {
  it('stores the bot lines (answers and "Say this") interleaved with what people said', async () => {
    const botId = `bot-tr-${Math.random().toString(36).slice(2)}`;
    const meetingId = `mtg-tr-${Math.random().toString(36).slice(2)}`;
    created.push(
      join(DATA_DIR, `${botId}.jsonl`),
      join(DATA_DIR, `${botId}.done`),
      join(DATA_DIR, `${meetingId}.agent.jsonl`),
    );
    writeFileSync(
      join(DATA_DIR, `${botId}.jsonl`),
      [
        { speaker: 'David', text: 'Jarvis, what shipped this week?', timestamp: '2026-10-16T10:00:00.000Z' },
        { speaker: 'David', text: 'Great, thanks.', timestamp: '2026-10-16T10:00:30.000Z' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
    // The page posts these as the bot speaks; the speaker it sends is not what is stored.
    appendAgentUtterance(meetingId, { speaker: 'Agent', text: 'The owner panel shipped.', timestamp: '2026-10-16T10:00:10.000Z' });
    appendAgentUtterance(meetingId, { speaker: 'Agent', text: 'Say this: we ship Friday.', timestamp: '2026-10-16T10:00:20.000Z' });

    let stored = '';
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      stored = (JSON.parse(String(init?.body)) as { content: string }).content;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    kickoffPipeline(makeConfig(), { botId, meetingId, meetingTitle: 'Order check', teammate: 'tester' });
    await vi.waitFor(() => expect(stored).not.toBe(''), { timeout: 2000 });

    const transcript = stored.slice(stored.indexOf('## Transcript'));
    expect(transcript).toContain('Jarvis: The owner panel shipped.');
    expect(transcript).toContain('Jarvis: Say this: we ship Friday.');
    const order = [
      'David: Jarvis, what shipped this week?',
      'Jarvis: The owner panel shipped.',
      'Jarvis: Say this: we ship Friday.',
      'David: Great, thanks.',
    ].map((line) => transcript.indexOf(line));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
