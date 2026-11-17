import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { leaveBot } from './leave-bot.js';

const config = { recallApiBase: 'https://us-west-2.recall.ai/api/v1', recallApiKey: 'rk' } as unknown as Config;
const REFUSAL = JSON.stringify({ code: 'cannot_command_unstarted_bot', detail: 'Cannot send a command to a bot which has not been started.' });

afterEach(() => {
  vi.restoreAllMocks();
});

function recall(statusCodes: string[] | 'error'): string[] {
  const seen: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url.replace(config.recallApiBase, '')}`);
    if (url.endsWith('/leave_call/')) return new Response(REFUSAL, { status: 400 });
    if (statusCodes === 'error') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ status_changes: statusCodes.map((code) => ({ code })) }), { status: 200 });
  }) as typeof fetch;
  return seen;
}

describe('leaveBot when Recall answers 400', () => {
  it('reports the bot as already gone when its status history shows it finished (kicked from the call)', async () => {
    const seen = recall(['in_waiting_room', 'in_call_recording', 'call_ended', 'recording_done', 'done']);
    const result = await leaveBot(config, 'bot-1');
    expect(result).toMatchObject({ ok: false, alreadyGone: true });
    expect(seen).toEqual(['POST /bot/bot-1/leave_call/', 'GET /bot/bot-1/']);
  });

  it('does NOT report a bot that has not joined yet as gone', async () => {
    recall(['joining_call']);
    const result = await leaveBot(config, 'bot-1');
    expect(result.ok).toBe(false);
    expect(result.alreadyGone).toBeUndefined();
  });

  it('does not report gone when the status lookup fails', async () => {
    recall('error');
    expect((await leaveBot(config, 'bot-1')).alreadyGone).toBeUndefined();
  });
});
