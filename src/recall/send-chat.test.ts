import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { CHAT_CHUNK_CHARS, sendChat, splitChatMessage } from './send-chat.js';

const config = { recallApiBase: 'https://us-east-1.recall.ai/api/v1/', recallApiKey: 'rk' } as unknown as Config;

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(status = 200): { url: string; init: RequestInit }[] {
  const seen: { url: string; init: RequestInit }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status });
  }) as typeof fetch;
  return seen;
}

describe('sendChat', () => {
  it('POSTs to /bot/{id}/send_chat_message/ with Token auth, to everyone', async () => {
    const seen = capture();
    const result = await sendChat(config, 'bot 1', 'Hello team');
    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://us-east-1.recall.ai/api/v1/bot/bot%201/send_chat_message/');
    expect(seen[0]!.init.method).toBe('POST');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Token rk');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ to: 'everyone', message: 'Hello team' });
  });

  it('splits a long message into parts under the Google Meet limit, in order', async () => {
    const seen = capture();
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    await sendChat(config, 'b', long);
    const parts = seen.map((s) => JSON.parse(String(s.init.body)).message as string);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= CHAT_CHUNK_CHARS)).toBe(true);
    expect(parts.join(' ')).toBe(long);
  });

  it('reports a refusal without throwing and stops sending', async () => {
    const seen = capture(403);
    const result = await sendChat(config, 'b', 'x'.repeat(1200));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
    expect(seen).toHaveLength(1);
  });

  it('reports a network failure without throwing, and refuses an empty message', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await sendChat(config, 'b', 'hi')).ok).toBe(false);
    expect(await sendChat(config, 'b', '   ')).toEqual({ ok: false, error: 'empty message' });
  });

  it('splitChatMessage hard-cuts a string with no whitespace', () => {
    expect(splitChatMessage('a'.repeat(1000), 480).map((p) => p.length)).toEqual([480, 480, 40]);
  });
});
