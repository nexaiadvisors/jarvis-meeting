import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deliverSlack, chunkForSlack, SLACK_CHUNK_CHARS } from '../src/postmeeting/slack.js';

describe('chunkForSlack', () => {
  it('returns [] for empty/whitespace and a single chunk under the cap', () => {
    expect(chunkForSlack('')).toEqual([]);
    expect(chunkForSlack('   ')).toEqual([]);
    expect(chunkForSlack('short transcript')).toEqual(['short transcript']);
  });

  it('splits long text on line boundaries, each chunk within the cap', () => {
    const line = 'David He: ' + 'x'.repeat(200);
    const text = Array.from({ length: 100 }, () => line).join('\n'); // ~21k chars
    const chunks = chunkForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SLACK_CHUNK_CHARS);
    // No content lost (modulo the join newlines).
    expect(chunks.join('\n').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
  });

  it('hard-splits a single line longer than the cap', () => {
    const chunks = chunkForSlack('a'.repeat(SLACK_CHUNK_CHARS * 2 + 10));
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SLACK_CHUNK_CHARS);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deliverSlack', () => {
  it('returns { ok:false } when no token is configured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await deliverSlack({ channel: 'C123', text: 'hi' });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns { ok:false } when no channel is configured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await deliverSlack({ token: 'xoxb-x', channel: '', text: 'hi' });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to chat.postMessage and returns ok on success', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, ts: '1.2' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await deliverSlack({ token: 'xoxb-x', channel: 'C123', text: 'notes' });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('https://slack.com/api/chat.postMessage');
    expect(capturedBody['channel']).toBe('C123');
    expect(capturedBody['text']).toBe('notes');
  });

  it('returns { ok:false } on slack API error payload without throwing', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await deliverSlack({ token: 'xoxb-x', channel: 'C123', text: 'notes' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
  });

  it('returns { ok:false } on network error without throwing', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ENET');
    }) as unknown as typeof fetch;

    const result = await deliverSlack({ token: 'xoxb-x', channel: 'C123', text: 'notes' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENET');
  });
});
