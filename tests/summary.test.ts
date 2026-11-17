import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config.js';

// ------------------------------------------------------------------
// Mock @anthropic-ai/sdk before importing the module under test.
// ------------------------------------------------------------------
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

const { generateSummary, generateSummaryWithReason } = await import('../src/postmeeting/summary.js');

const DATA_DIR = join(process.cwd(), '.data');

const BASE_CONFIG: Config = {
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
  azureStorageAccountName: undefined,
  azureStorageAccountKey: undefined,
  azureStorageBlobContainer: undefined,
  artifactSasTtlHours: 168,
  anthropicApiKey: 'sk-test',
  anthropicModel: 'claude-sonnet-5-5',
  anthropicFallbackModel: 'claude-opus-5-5',
  meetingSummaryMaxTokens: 4096,
  meetingSummaryInputCharCap: 400000,
  meetingIngestTimeoutMs: 120000,
  graphTenantId: undefined,
  graphClientId: undefined,
  graphClientSecret: undefined,
  meetingEmailSender: undefined,
  meetingEmailDefaultRecipients: [],
};

const NO_ANTHROPIC_CONFIG: Config = { ...BASE_CONFIG, anthropicApiKey: undefined };

const TEST_BOT_ID = 'bot-summary-test';
const TEST_JSONL = [
  JSON.stringify({ speaker: 'Alice', text: 'We should ship this Friday.', timestamp: '2026-06-17T10:00:00Z' }),
  JSON.stringify({ speaker: 'Bob', text: 'Agreed. I will handle the deploy.', timestamp: '2026-06-17T10:01:00Z' }),
].join('\n') + '\n';

const VALID_SUMMARY_JSON = JSON.stringify({
  bluf: 'Team agreed to ship on Friday with Bob handling the deploy.',
  decisions: ['Ship on Friday'],
  actionItems: [{ owner: 'Bob', task: 'Handle the deploy', due: '2026-06-20' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, `${TEST_BOT_ID}.jsonl`), TEST_JSONL, 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(join(DATA_DIR, `${TEST_BOT_ID}.jsonl`)); } catch { /* ok */ }
});

describe('generateSummary', () => {
  it('returns null and logs warn when ANTHROPIC_API_KEY is not configured', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await generateSummary(NO_ANTHROPIC_CONFIG, TEST_BOT_ID);
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('NOT_CONFIGURED'));
  });

  it('parses well-formed Anthropic JSON response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: VALID_SUMMARY_JSON }],
    });

    const result = await generateSummary(BASE_CONFIG, TEST_BOT_ID);
    expect(result).not.toBeNull();
    expect(result?.bluf).toBe('Team agreed to ship on Friday with Bob handling the deploy.');
    expect(result?.decisions).toEqual(['Ship on Friday']);
    expect(result?.actionItems).toHaveLength(1);
    expect(result?.actionItems[0]?.owner).toBe('Bob');
    expect(result?.actionItems[0]?.due).toBe('2026-06-20');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 4096 }));
  });

  it('uses configured max tokens and preserves the latest capped transcript tail', async () => {
    const latest = 'LATEST-MEETING-DECISION'
    writeFileSync(
      join(DATA_DIR, `${TEST_BOT_ID}.jsonl`),
      JSON.stringify({ speaker: 'Alice', text: `${'old context '.repeat(30)}${latest}`, timestamp: 't' }) + '\n',
      'utf8',
    );
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: VALID_SUMMARY_JSON }] });

    await generateSummary({ ...BASE_CONFIG, meetingSummaryMaxTokens: 777, meetingSummaryInputCharCap: 80 }, TEST_BOT_ID);

    const request = mockCreate.mock.calls[0]?.[0] as {
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    expect(request.max_tokens).toBe(777);
    const sentTranscript = request.messages[0]?.content.replace('Meeting transcript:\n\n', '') ?? '';
    const [notice, tail] = sentTranscript.split('\n\n');
    expect(notice).toContain('Transcript truncated');
    expect(tail).toHaveLength(80);
    expect(tail).toContain(latest);
    expect(tail).toMatch(new RegExp(`${latest}$`));
  });

  it('strips markdown fences if model wraps JSON in ```json', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + VALID_SUMMARY_JSON + '\n```' }],
    });

    const result = await generateSummary(BASE_CONFIG, TEST_BOT_ID);
    expect(result).not.toBeNull();
    expect(result?.bluf).toBeTruthy();
  });

  it('returns null on malformed JSON response (defensive parse)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'This is not JSON at all.' }],
    });

    const result = await generateSummary(BASE_CONFIG, TEST_BOT_ID);
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse'));
  });

  it('returns null when Anthropic call throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreate.mockRejectedValue(new Error('rate limit'));

    const result = await generateSummary(BASE_CONFIG, TEST_BOT_ID);
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Anthropic call failed'));
  });

  it('returns null when transcript file is absent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await generateSummary(BASE_CONFIG, 'nonexistent-bot');
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('transcript empty'));
  });

  it('includes agent utterances from readMergedTranscript when meetingId is passed', async () => {
    const meetingId = 'mtg-summary-merged';
    const agentFile = join(DATA_DIR, `${meetingId}.agent.jsonl`);
    writeFileSync(
      agentFile,
      JSON.stringify({ speaker: 'Agent', text: 'I confirmed the Q4 budget is $50k.', timestamp: '2026-06-17T10:00:30Z' }) + '\n',
      'utf8',
    );
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: VALID_SUMMARY_JSON }],
    });

    try {
      await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID, meetingId);
      const sentContent = (mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> }).messages[0]?.content ?? '';
      expect(sentContent).toContain('Jarvis: I confirmed the Q4 budget is $50k.');
    } finally {
      try { rmSync(agentFile); } catch { /* ok */ }
    }
  });
});

describe('generateSummary refusal handling (mocked client, no real calls)', () => {
  const REFUSAL = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] };
  const OK = { stop_reason: 'end_turn', content: [{ type: 'text', text: VALID_SUMMARY_JSON }] };

  /** Every console line the module wrote, joined, to assert nothing sensitive was logged. */
  function captureConsole(): () => string {
    const lines: string[] = [];
    const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(take);
    vi.spyOn(console, 'warn').mockImplementation(take);
    vi.spyOn(console, 'error').mockImplementation(take);
    return () => lines.join('\n');
  }

  it('retries ONCE on the fallback model after a refusal and returns that summary', async () => {
    const output = captureConsole();
    mockCreate.mockResolvedValueOnce(REFUSAL).mockResolvedValueOnce(OK);

    const outcome = await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID);

    expect(outcome.summary?.bluf).toBe('Team agreed to ship on Friday with Bob handling the deploy.');
    expect(outcome.failure).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({ model: 'claude-opus-5-5' });
    // The retry sends the same prompt, not a changed one.
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({
      system: (mockCreate.mock.calls[0]?.[0] as { system: string }).system,
      max_tokens: 4096,
    });
    expect(output()).toContain('"stop_reason":"refusal"');
    expect(output()).toContain('"model":"claude-sonnet-5-5"');
  });

  it('a second refusal returns null with failure "refused" and makes no third request', async () => {
    captureConsole();
    mockCreate.mockResolvedValue(REFUSAL);

    const outcome = await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID);

    expect(outcome).toEqual({ summary: null, failure: 'refused' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(await generateSummary(BASE_CONFIG, TEST_BOT_ID)).toBeNull();
  });

  it.each([
    ['no text block (max_tokens)', { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }],
    ['text that is not JSON', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, no JSON here.' }] }],
  ])('retries once when the first answer has no structured output: %s', async (_label, first) => {
    captureConsole();
    mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(OK);

    const outcome = await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID);

    expect(outcome.summary).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it('reports "failed" (not "refused") when the retry also has no structured output', async () => {
    captureConsole();
    mockCreate.mockResolvedValueOnce(REFUSAL).mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });

    expect(await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID)).toEqual({ summary: null, failure: 'failed' });
  });

  it('does not retry when the request itself throws (the SDK already retries transient errors)', async () => {
    captureConsole();
    mockCreate.mockRejectedValue(new Error('rate limit'));

    expect(await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID)).toEqual({ summary: null, failure: 'failed' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a throw on the retry is contained and reported as "failed"', async () => {
    captureConsole();
    mockCreate.mockResolvedValueOnce(REFUSAL).mockRejectedValueOnce(new Error('overloaded'));

    expect(await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID)).toEqual({ summary: null, failure: 'failed' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('never logs transcript text or any fragment of the model output', async () => {
    const output = captureConsole();
    mockCreate
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'LEAKY-MODEL-OUTPUT not json' }] })
      .mockResolvedValueOnce(REFUSAL);

    await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID);

    expect(output()).not.toContain('We should ship this Friday');
    expect(output()).not.toContain('Agreed. I will handle the deploy');
    // JSON.parse quotes the start of the text it rejects, so a leak shows up as the first
    // few characters, not the whole string. Assert on a short distinctive prefix.
    expect(output()).not.toContain('LEAKY-');
    expect(output()).not.toContain('LEAKY');
    // What is logged instead: the error class name, a character count, the stop_reason.
    expect(output()).toContain('summary: failed to parse Anthropic response');
    expect(output()).toContain('SyntaxError');
  });

  it('a thrown API error is logged by class name and status only, never its message', async () => {
    const output = captureConsole();
    mockCreate.mockRejectedValue(Object.assign(new Error('429 {"error":"QUOTED-BODY-FRAGMENT"}'), { name: 'RateLimitError', status: 429 }));

    await generateSummaryWithReason(BASE_CONFIG, TEST_BOT_ID);

    expect(output()).not.toContain('QUOTED-');
    expect(output()).toContain('RateLimitError');
    expect(output()).toContain('"status":429');
  });

  it('reports not_configured and no_transcript without any request', async () => {
    captureConsole();
    expect(await generateSummaryWithReason(NO_ANTHROPIC_CONFIG, TEST_BOT_ID)).toEqual({ summary: null, failure: 'not_configured' });
    expect(await generateSummaryWithReason(BASE_CONFIG, 'nonexistent-bot')).toEqual({ summary: null, failure: 'no_transcript' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
