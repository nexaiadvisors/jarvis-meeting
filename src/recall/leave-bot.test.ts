import { describe, it, expect, vi, afterEach } from 'vitest';
import { leaveBot } from './leave-bot.js';
import type { Config } from '../config.js';

const config = { recallApiBase: 'https://us-east-1.recall.ai/api/v1', recallApiKey: 'rk' } as Config;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('leaveBot', () => {
  it('POSTs to the Recall leave endpoint with Token auth and returns ok on 2xx', async () => {
    let captured: Request | undefined;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const result = await leaveBot(config, 'bot-123');

    expect(result).toEqual({ ok: true });
    expect(captured?.url).toBe('https://us-east-1.recall.ai/api/v1/bot/bot-123/leave_call/');
    expect(captured?.method).toBe('POST');
    expect(captured?.headers.get('authorization')).toBe('Token rk');
  });

  it('returns {ok:false} on a non-2xx response (never throws)', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
    const result = await leaveBot(config, 'bot-x');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it.each([404, 410])('flags HTTP %i as alreadyGone: Recall has already removed the bot', async (status) => {
    global.fetch = vi.fn(async () => new Response('{"detail":"Not found."}', { status })) as typeof fetch;

    const result = await leaveBot(config, 'bot-gone');

    expect(result.ok).toBe(false);
    expect(result.alreadyGone).toBe(true);
    expect(result.error).toContain(String(status));
  });

  it.each([400, 401, 403, 429, 500, 502])('does not flag HTTP %i as alreadyGone', async (status) => {
    global.fetch = vi.fn(async () => new Response('nope', { status })) as typeof fetch;

    const result = await leaveBot(config, 'bot-still-there');

    expect(result.ok).toBe(false);
    expect(result.alreadyGone).toBeUndefined();
  });

  it('returns {ok:false,error:"timeout"} when the request aborts (never throws)', async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as typeof fetch;

      const p = leaveBot(config, 'bot-timeout');
      // leaveBot arms a 5s AbortController timeout; advance fake time past it.
      await vi.advanceTimersByTimeAsync(5001);
      await expect(p).resolves.toEqual({ ok: false, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns {ok:false} on a network error (never throws)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await leaveBot(config, 'bot-net');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});
