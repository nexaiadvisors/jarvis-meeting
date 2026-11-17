import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendNote } from '../src/meeting/notes.js';

// ------------------------------------------------------------------
// Mock all phase modules before importing the pipeline. Email, ingest,
// and slack lanes are mocked so we can assert which lanes the SOUL drives.
// ------------------------------------------------------------------
const mockUploadAudioArtifact = vi.fn(async () => null);
const mockGenerateSummary = vi.fn(async () => null);
const mockComposeEmail = vi.fn(() => ({ subject: 'Test', bodyText: 'Test body', recipients: [] }));
const mockSendOrDryRunEmail = vi.fn(async () => {});
const mockIngestToBrain = vi.fn(async () => ({ ok: true }));
const mockDeliverSlack = vi.fn(async () => ({ ok: true }));
const mockChunkForSlack = vi.fn(() => [] as string[]);

vi.mock('../src/postmeeting/artifacts.js', () => ({
  uploadAudioArtifact: mockUploadAudioArtifact,
}));
// The pipeline asks for the failure reason too: delegate to mockGenerateSummary, and let a
// test set `summaryFailure` to say why a null summary was null.
let summaryFailure: string | undefined;
vi.mock('../src/postmeeting/summary.js', () => ({
  generateSummary: mockGenerateSummary,
  generateSummaryWithReason: async (...args: unknown[]) => {
    const summary = await (mockGenerateSummary as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    return summary === null ? { summary, failure: summaryFailure ?? 'failed' } : { summary };
  },
}));
vi.mock('../src/postmeeting/email.js', async (importOriginal) => ({
  composeEmail: mockComposeEmail,
  sendOrDryRunEmail: mockSendOrDryRunEmail,
  // The real recipient rule: the pipeline tests assert who would be emailed.
  recapRecipients: (await importOriginal<typeof import('../src/postmeeting/email.js')>()).recapRecipients,
}));
vi.mock('../src/postmeeting/ingest.js', () => ({
  ingestToBrain: mockIngestToBrain,
}));
vi.mock('../src/postmeeting/slack.js', () => ({
  deliverSlack: mockDeliverSlack,
  chunkForSlack: mockChunkForSlack,
}));

const { kickoffPipeline } = await import('../src/postmeeting/pipeline.js');

import type { Config } from '../src/config.js';

const DATA_DIR = join(process.cwd(), '.data');

// Per-test temp SOUL directory so each case controls delivery / ingest.
let soulDir: string;

function writeSoul(slug: string, frontMatter: string): void {
  writeFileSync(join(soulDir, `${slug}.md`), `---\n${frontMatter}\n---\nprose\n`, 'utf8');
}

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    slackBotToken: 'xoxb-test',
    meetingSlackChannel: 'C123',
    ...overrides,
  };
}

const SAMPLE_SUMMARY = {
  bluf: 'Ship Friday.',
  decisions: ['Ship on Friday'],
  actionItems: [],
};

function uniqueBotId(): string {
  return `bot-pipe-${Math.random().toString(36).slice(2)}`;
}

/** Wait for the fire-and-forget pipeline to settle. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  summaryFailure = undefined;
  mkdirSync(DATA_DIR, { recursive: true });
  soulDir = mkdtempSync(join(tmpdir(), 'pipe-soul-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(soulDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('kickoffPipeline', () => {
  it('calls artifacts -> summary -> email when SOUL delivery is email', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email\ningest: false');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg1', meetingTitle: 'Q2 Planning', teammate: 'tester' });
    await drain();

    expect(mockUploadAudioArtifact).toHaveBeenCalledOnce();
    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    expect(mockComposeEmail).toHaveBeenCalledOnce();
    expect(mockSendOrDryRunEmail).toHaveBeenCalledOnce();
    expect(mockIngestToBrain).not.toHaveBeenCalled();
    expect(mockDeliverSlack).not.toHaveBeenCalled();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('stores the summary at .data/<botId>.summary.json', async () => {
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg1', meetingTitle: 'Q2 Planning', teammate: 'tester' });
    await drain();

    const { readSummary } = await import('../src/postmeeting/summary-store.js');
    expect(readSummary(botId, DATA_DIR)).toMatchObject({ ...SAMPLE_SUMMARY, generated: true });

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
    try { rmSync(join(DATA_DIR, `${botId}.summary.json`)); } catch { /* ok */ }
  });

  it('stores the failure text with generated=false when no summary was produced', async () => {
    mockGenerateSummary.mockResolvedValue(null);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg1', meetingTitle: 'Q2 Planning', teammate: 'tester' });
    await drain();

    const { readSummary } = await import('../src/postmeeting/summary-store.js');
    expect(readSummary(botId, DATA_DIR)).toMatchObject({ generated: false, decisions: [], actionItems: [] });

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
    try { rmSync(join(DATA_DIR, `${botId}.summary.json`)); } catch { /* ok */ }
  });

  describe('recap recipients and the meeting page link', () => {
    async function runFor(meetingId: string, overrides: Partial<Config>): Promise<unknown[]> {
      const { registerMeeting, setAttendees, shareTokenFor } = await import('../src/meeting/registry.js');
      mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
      const botId = uniqueBotId();
      registerMeeting({ meetingId, botId, teammate: 'tester', persona: 'first_person', title: 'Q2 Planning' });
      setAttendees(meetingId, ['nick@nexai.test', 'client@outside.test', 'owner@nexai.test']);
      kickoffPipeline(makeConfig({ publicBaseUrl: 'https://jarvis.example.com', ...overrides }), { botId, meetingId, meetingTitle: 'Q2 Planning', teammate: 'tester' });
      await drain();
      try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
      try { rmSync(join(DATA_DIR, `${botId}.summary.json`)); } catch { /* ok */ }
      const call = mockComposeEmail.mock.calls.at(-1) as unknown[];
      expect(call[4]).toBe(`https://jarvis.example.com/m/${meetingId}?t=${shareTokenFor(meetingId)}`);
      return (call[3] as { address: string }[]).map((r) => r.address);
    }
    const base = { meetingEmailDefaultRecipients: ['owner@nexai.test'] };

    it('by default emails only the configured recipients, never the invitees', async () => {
      expect(await runFor('recap-default', base)).toEqual(['owner@nexai.test']);
      // Internal domains alone do not turn it on.
      expect(await runFor('recap-domains-only', { ...base, internalDomains: ['nexai.test'] })).toEqual(['owner@nexai.test']);
    });

    it('with RECAP_TO_INVITEES adds only invitees on an internal domain', async () => {
      expect(await runFor('recap-on', { ...base, recapToInvitees: true, internalDomains: ['nexai.test'] })).toEqual([
        'owner@nexai.test',
        'nick@nexai.test',
      ]);
      // On, but no internal domain configured: nobody is added.
      expect(await runFor('recap-on-no-domains', { ...base, recapToInvitees: true })).toEqual(['owner@nexai.test']);
    });
  });

  it('calls ingest when SOUL delivery is ob', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - ob\ningest: false');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-ob', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockIngestToBrain).toHaveBeenCalledOnce();
    expect(mockComposeEmail).not.toHaveBeenCalled();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('passes config.kbBackendToken to ingestToBrain when the SOUL endpoint is on the kb-server origin', async () => {
    writeSoul(
      'tester',
      'name: Tester\nowner: tester\nknowledge_backend:\n  type: openbrain\n  endpoint: http://127.0.0.1:7402\ndelivery:\n  - ob\ningest: true',
    );
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig({ kbBackendToken: 'kb-secret', kbBackendHealthUrl: 'http://127.0.0.1:7402/healthz' }), {
      botId,
      meetingId: 'mtg-bearer',
      meetingTitle: 'Sync',
      teammate: 'tester',
    });
    await drain();

    expect(mockIngestToBrain).toHaveBeenCalledOnce();
    expect(mockIngestToBrain).toHaveBeenCalledWith(expect.anything(), expect.anything(), 120000, 'kb-secret');

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('pipeline passes notes and the bearer token to ingestToBrain', async () => {
    writeSoul(
      'tester',
      'name: Tester\nowner: tester\nknowledge_backend:\n  type: openbrain\n  endpoint: http://127.0.0.1:7402\ndelivery:\n  - ob\ningest: true',
    );
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();
    const note = { kind: 'note', text: 'Ship on Friday', at: '2026-10-16T10:00:00.000Z', by: 'agent' } as const;
    const flag = { kind: 'flag', text: '[FLAG FOR DAVID] budget', at: '2026-10-16T10:01:00.000Z', by: 'agent' } as const;
    appendNote(botId, note);
    appendNote(botId, flag);

    kickoffPipeline(makeConfig({ kbBackendToken: 'kb-secret', kbBackendHealthUrl: 'http://127.0.0.1:7402/healthz' }), {
      botId,
      meetingId: 'mtg-notes',
      meetingTitle: 'Sync',
      teammate: 'tester',
    });
    await drain();

    expect(mockIngestToBrain).toHaveBeenCalledOnce();
    expect(mockIngestToBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ meetingId: 'mtg-notes', notes: [note, flag] }),
      120000,
      'kb-secret',
    );

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
    try { rmSync(join(DATA_DIR, `${botId}.notes.jsonl`)); } catch { /* ok */ }
  });

  it('passes an empty notes list when nothing was noted', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - ob\ningest: false');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-nonotes', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockIngestToBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notes: [] }),
      120000,
      undefined,
    );

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('calls ingest when SOUL ingest:true even without ob in delivery', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery: []\ningest: true');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-ing', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockIngestToBrain).toHaveBeenCalledOnce();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('calls slack when SOUL delivery is slack', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - slack\ningest: false');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-sl', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockDeliverSlack).toHaveBeenCalledOnce();
    expect(mockComposeEmail).not.toHaveBeenCalled();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('drives all three lanes independently when delivery lists all + ingest', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email\n  - ob\n  - slack\ningest: true');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-all', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockSendOrDryRunEmail).toHaveBeenCalledOnce();
    expect(mockIngestToBrain).toHaveBeenCalledOnce();
    expect(mockDeliverSlack).toHaveBeenCalledOnce();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('completes (email-only default) when the SOUL is not found', async () => {
    // No SOUL file written for 'tester' -> loadSoul throws -> default delivery email.
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg-no-soul', meetingTitle: 'Sync', teammate: 'tester' });
    await drain();

    expect(mockSendOrDryRunEmail).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('SOUL load failed'));

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('skips email but preserves a failed summary for OpenBrain and Slack', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email\n  - ob\n  - slack\ningest: true');
    mockGenerateSummary.mockResolvedValue(null);
    const botId = uniqueBotId();
    writeFileSync(
      join(DATA_DIR, `${botId}.jsonl`),
      JSON.stringify({ speaker: 'David', text: 'Keep the full transcript.', timestamp: '2026-07-14T10:00:00Z' }) + '\n',
      'utf8',
    );

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg2', meetingTitle: 'Weekly Sync', teammate: 'tester' });
    await drain();

    expect(mockComposeEmail).not.toHaveBeenCalled();
    expect(mockSendOrDryRunEmail).not.toHaveBeenCalled();
    expect(mockIngestToBrain).toHaveBeenCalledOnce();
    expect(mockIngestToBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: {
          bluf: 'summary generation failed - full transcript preserved',
          decisions: [],
          actionItems: [],
        },
        transcriptText: expect.stringContaining('Keep the full transcript.'),
      }),
      120000,
      undefined,
    );
    expect(mockDeliverSlack).toHaveBeenCalled();
    expect(mockDeliverSlack.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining('summary generation failed - full transcript preserved') }),
    );

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
    try { rmSync(join(DATA_DIR, `${botId}.jsonl`)); } catch { /* ok */ }
  });

  it('stores "summary unavailable (model refused)" when the summary model refused twice', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email\n  - ob\n  - slack\ningest: true');
    mockGenerateSummary.mockResolvedValue(null);
    summaryFailure = 'refused';
    const botId = uniqueBotId();
    writeFileSync(
      join(DATA_DIR, `${botId}.jsonl`),
      JSON.stringify({ speaker: 'David', text: 'Keep the full transcript.', timestamp: '2026-07-14T10:00:00Z' }) + '\n',
      'utf8',
    );

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg3', meetingTitle: 'Weekly Sync', teammate: 'tester' });
    await drain();

    expect(mockComposeEmail).not.toHaveBeenCalled();
    expect(mockIngestToBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: { bluf: 'summary unavailable (model refused)', decisions: [], actionItems: [] },
        transcriptText: expect.stringContaining('Keep the full transcript.'),
      }),
      120000,
      undefined,
    );
    expect(mockDeliverSlack.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining('summary unavailable (model refused)') }),
    );

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
    try { rmSync(join(DATA_DIR, `${botId}.jsonl`)); } catch { /* ok */ }
  });

  it('is idempotent — second call for same botId is a no-op', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();
    const input = { botId, meetingId: 'mtg3', meetingTitle: 'Design Review', teammate: 'tester' };

    kickoffPipeline(makeConfig(), input);
    await drain();
    kickoffPipeline(makeConfig(), input); // second event — should be no-op
    await drain();

    expect(mockUploadAudioArtifact).toHaveBeenCalledOnce(); // not twice

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it.each([
    ['bot.done first, then the Leave backstop', true],
    ['the Leave backstop first, then a late bot.done', false],
  ])('runs once for one bot whichever of the two kickoffs arrives first: %s', async (_label, webhookFirst) => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();
    // The webhook knows the soul slug from Recall's metadata; the panel backstop does not.
    const fromWebhook = { botId, meetingId: 'mtg-bs', meetingTitle: 'Backstop', teammate: 'tester', soulSlug: 'tester' };
    const fromBackstop = { botId, meetingId: 'mtg-bs', meetingTitle: 'Backstop', teammate: 'tester' };

    kickoffPipeline(makeConfig(), webhookFirst ? fromWebhook : fromBackstop);
    await drain();
    kickoffPipeline(makeConfig(), webhookFirst ? fromBackstop : fromWebhook);
    await drain();

    expect(mockUploadAudioArtifact).toHaveBeenCalledOnce();
    expect(mockSendOrDryRunEmail).toHaveBeenCalledOnce();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('is idempotent via .done marker on disk', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email');
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const botId = uniqueBotId();
    writeFileSync(join(DATA_DIR, `${botId}.done`), new Date().toISOString(), 'utf8');

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg4', meetingTitle: 'Retro', teammate: 'tester' });
    await drain();

    expect(mockUploadAudioArtifact).not.toHaveBeenCalled();

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });

  it('continues to delivery even when artifacts phase throws', async () => {
    writeSoul('tester', 'name: Tester\nowner: tester\ndelivery:\n  - email');
    mockUploadAudioArtifact.mockRejectedValue(new Error('blob put failed'));
    mockGenerateSummary.mockResolvedValue(SAMPLE_SUMMARY);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const botId = uniqueBotId();

    kickoffPipeline(makeConfig(), { botId, meetingId: 'mtg5', meetingTitle: 'Incident Retro', teammate: 'tester' });
    await drain();

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    expect(mockSendOrDryRunEmail).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('artifacts phase failed'));

    try { rmSync(join(DATA_DIR, `${botId}.done`)); } catch { /* ok */ }
  });
});
