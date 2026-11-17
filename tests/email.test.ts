import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { SummaryResult } from '../src/postmeeting/summary.js';

// ------------------------------------------------------------------
// Mock @azure/identity before importing the module under test.
// ------------------------------------------------------------------
const mockGetToken = vi.fn(async () => ({ token: 'fake-access-token' }));
vi.mock('@azure/identity', () => {
  function MockClientSecretCredential() { return { getToken: mockGetToken }; }
  return { ClientSecretCredential: MockClientSecretCredential };
});

const { composeEmail, sendOrDryRunEmail } = await import('../src/postmeeting/email.js');

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
  anthropicApiKey: undefined,
  anthropicModel: 'claude-sonnet-4-6',
  graphTenantId: undefined,
  graphClientId: undefined,
  graphClientSecret: undefined,
  meetingEmailSender: undefined,
  meetingEmailDefaultRecipients: [],
};

const GRAPH_CONFIG: Config = {
  ...BASE_CONFIG,
  graphTenantId: 'tenant-id',
  graphClientId: 'client-id',
  graphClientSecret: 'client-secret',
  meetingEmailSender: 'jarvis@example.com',
};

const SAMPLE_SUMMARY: SummaryResult = {
  bluf: 'Team agreed to ship on Friday.',
  decisions: ['Ship on Friday', 'Bob owns the deploy'],
  actionItems: [
    { owner: 'Bob', task: 'Handle the deploy', due: '2026-06-20' },
    { owner: 'Alice', task: 'Update the changelog' },
  ],
};

const RECIPIENTS = [{ address: 'alice@example.com', name: 'Alice' }];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up any dry-run files.
  try { rmSync(join(DATA_DIR, 'bot-email-test.email.json')); } catch { /* ok */ }
});

describe('composeEmail', () => {
  it('sets subject to "Meeting notes: <title>"', () => {
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    expect(payload.subject).toBe('Meeting notes: Q2 Planning');
  });

  it('body begins with BLUF', () => {
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    expect(payload.bodyText.trimStart()).toMatch(/^Team agreed to ship on Friday\./);
  });

  it('includes a link when sasUrl is provided', () => {
    const sas = 'https://account.blob.core.windows.net/c/audio.mp4?sig=x';
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, sas, RECIPIENTS);
    expect(payload.bodyText).toContain(sas);
  });

  it('does NOT contain an attachment — only a link in body text', () => {
    const sas = 'https://blob.example.com/audio.mp4?sig=x';
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, sas, RECIPIENTS);
    // Attachment would show as a separate field; email payload has only bodyText.
    expect(Object.keys(payload)).not.toContain('attachment');
    expect(Object.keys(payload)).not.toContain('attachments');
    expect(payload.bodyText).toContain(sas);
  });

  it('includes the consent/recording disclosure footer', () => {
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    expect(payload.bodyText).toContain('recorded and transcribed');
    expect(payload.bodyText).toContain('request deletion');
  });

  it('uses ASCII-only characters in the composed body', () => {
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    // eslint-disable-next-line no-control-regex
    expect(payload.bodyText).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });
});

describe('sendOrDryRunEmail - dry-run (Graph not configured)', () => {
  it('writes .email.json to disk and logs NOT_CONFIGURED', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    await sendOrDryRunEmail(BASE_CONFIG, 'bot-email-test', payload);

    const outFile = join(DATA_DIR, 'bot-email-test.email.json');
    expect(existsSync(outFile)).toBe(true);
    const saved = JSON.parse(readFileSync(outFile, 'utf8')) as typeof payload;
    expect(saved.subject).toBe('Meeting notes: Q2 Planning');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('NOT_CONFIGURED'));
  });
});

describe('sendOrDryRunEmail - Graph send', () => {
  it('calls Graph sendMail endpoint with Bearer token', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries(),
      );
      return new Response(null, { status: 202 });
    });

    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    await sendOrDryRunEmail(GRAPH_CONFIG, 'bot-graph-test', payload);

    expect(capturedUrl).toContain('graph.microsoft.com/v1.0/users/');
    expect(capturedUrl).toContain('sendMail');
    expect(capturedHeaders['authorization']).toBe('Bearer fake-access-token');
  });

  it('skips send and logs warn when recipients list is empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, []);
    payload.recipients = [];
    await sendOrDryRunEmail(GRAPH_CONFIG, 'bot-no-rcpt', payload);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no recipients'));
  });

  it('throws on non-2xx Graph response', async () => {
    global.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    const payload = composeEmail('Q2 Planning', SAMPLE_SUMMARY, null, RECIPIENTS);
    await expect(sendOrDryRunEmail(GRAPH_CONFIG, 'bot-graph-err', payload)).rejects.toThrow('403');
  });
});
