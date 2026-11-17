import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_BRAIN_TIMEOUT_MS, WAIT_MAX_MS, __clearRequests, addRequest, answerRequest, waitForRequest } from './requests.js';
import { SoulFrontMatter, toSoul } from '../soul/schema.js';

beforeEach(() => {
  vi.useFakeTimers();
  __clearRequests();
});
afterEach(() => {
  __clearRequests();
  vi.useRealTimers();
});

const ask = (text = 'what is the budget?') => ({ text, from: 'Nick', source: 'voice' as const });

describe('outside-brain request queue', () => {
  it('SOUL brain defaults to builtin and accepts external', () => {
    expect(toSoul(SoulFrontMatter.parse({ name: 'J' }), '').brain).toBe('builtin');
    expect(toSoul(SoulFrontMatter.parse({ name: 'J', brain: 'external' }), '').brain).toBe('external');
  });

  it('a waiting request is returned at once and marked claimed, oldest first, per meeting', async () => {
    const first = addRequest('m1', ask('first'), vi.fn());
    addRequest('m1', ask('second'), vi.fn());
    addRequest('m2', ask('other meeting'), vi.fn());
    expect(await waitForRequest('m1')).toMatchObject({ id: first.id, text: 'first', status: 'claimed' });
    expect(await waitForRequest('m1')).toMatchObject({ text: 'second' });
    expect(await waitForRequest('m1', 0)).toBeUndefined();
  });

  it('a long poll resolves the moment a request arrives', async () => {
    const waiting = waitForRequest('m1');
    await vi.advanceTimersByTimeAsync(5_000);
    const added = addRequest('m1', ask(), vi.fn());
    expect(await waiting).toMatchObject({ id: added.id, status: 'claimed' });
  });

  it('a long poll gives up after at most 25 seconds', async () => {
    const waiting = waitForRequest('m1', 999_999);
    await vi.advanceTimersByTimeAsync(WAIT_MAX_MS);
    expect(await waiting).toBeUndefined();
  });

  it('an answer inside 20 seconds cancels the fallback', async () => {
    const onFallback = vi.fn();
    const request = addRequest('m1', ask(), onFallback);
    await vi.advanceTimersByTimeAsync(EXTERNAL_BRAIN_TIMEOUT_MS - 1);
    expect(answerRequest(request.id)).toMatchObject({ ok: true, request: { status: 'answered' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFallback).not.toHaveBeenCalled();
    expect(answerRequest(request.id)).toEqual({ ok: false, reason: 'already_answered' });
  });

  it('unanswered for 20 seconds, it falls back exactly once, even if an agent claimed it, and a late answer is refused', async () => {
    const onFallback = vi.fn();
    const request = addRequest('m1', ask(), onFallback);
    await waitForRequest('m1');
    await vi.advanceTimersByTimeAsync(EXTERNAL_BRAIN_TIMEOUT_MS);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0]![0]).toMatchObject({ id: request.id, status: 'fallback' });
    expect(answerRequest(request.id)).toEqual({ ok: false, reason: 'timed_out' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('an unknown request id is not found', () => {
    expect(answerRequest('nope')).toEqual({ ok: false, reason: 'not_found' });
  });
});
