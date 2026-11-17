// Requests waiting for an outside brain (SOUL brain: external).
//
// When a meeting's SOUL sets brain: external, a wake-word request (spoken or typed) is
// not answered by the built-in realtime agent. It is queued here. An MCP agent collects
// it with wait_for_request (a long poll) and answers with respond. A request nobody
// answered within EXTERNAL_BRAIN_TIMEOUT_MS falls back to the built-in agent, so a
// disconnected outside agent never leaves a person without an answer.
//
// In memory and per process, like the command queue.

import { randomBytes } from 'node:crypto';

export type RequestSource = 'voice' | 'chat';

export interface MeetingRequest {
  id: string;
  meetingId: string;
  /** What was asked, wake word removed. */
  text: string;
  /** Who asked, when known. */
  from: string;
  source: RequestSource;
  /** ISO-8601 time it was asked. */
  askedAt: string;
  /** waiting: nobody collected it. claimed: an agent has it. answered / fallback: closed. */
  status: 'waiting' | 'claimed' | 'answered' | 'fallback';
}

/** An unanswered request goes back to the built-in agent after this long. */
export const EXTERNAL_BRAIN_TIMEOUT_MS = 20_000;
/** The longest a wait_for_request call is held open. */
export const WAIT_MAX_MS = 25_000;

interface Waiter {
  meetingId: string;
  resolve: (request: MeetingRequest | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

const requests = new Map<string, MeetingRequest>();
const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
let waiters: Waiter[] = [];

function claim(request: MeetingRequest): MeetingRequest {
  request.status = 'claimed';
  return request;
}

/**
 * Queue a request for an outside brain. `onFallback` runs once if it is still unanswered
 * after `timeoutMs`. A waiting wait_for_request call receives it at once.
 */
export function addRequest(
  meetingId: string,
  input: { text: string; from: string; source: RequestSource },
  onFallback: (request: MeetingRequest) => void,
  timeoutMs: number = EXTERNAL_BRAIN_TIMEOUT_MS,
): MeetingRequest {
  const request: MeetingRequest = {
    id: randomBytes(9).toString('base64url'),
    meetingId,
    text: input.text,
    from: input.from,
    source: input.source,
    askedAt: new Date().toISOString(),
    status: 'waiting',
  };
  requests.set(request.id, request);
  const timer = setTimeout(() => {
    fallbackTimers.delete(request.id);
    if (request.status === 'answered') return;
    request.status = 'fallback';
    onFallback(request);
  }, timeoutMs);
  timer.unref?.();
  fallbackTimers.set(request.id, timer);

  const waiter = waiters.find((w) => w.meetingId === meetingId);
  if (waiter) {
    waiters = waiters.filter((w) => w !== waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(claim(request));
  }
  return request;
}

/**
 * The oldest request of a meeting that nobody has collected, marked claimed. When there
 * is none, waits up to `timeoutMs` for one; resolves undefined when the time runs out.
 */
export function waitForRequest(meetingId: string, timeoutMs: number = WAIT_MAX_MS): Promise<MeetingRequest | undefined> {
  for (const request of requests.values()) {
    if (request.meetingId === meetingId && request.status === 'waiting') return Promise.resolve(claim(request));
  }
  const wait = Math.max(0, Math.min(timeoutMs, WAIT_MAX_MS));
  if (wait === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      meetingId,
      resolve,
      timer: setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, wait),
    };
    waiter.timer.unref?.();
    waiters.push(waiter);
  });
}

/** A request by id, in whatever state it is. */
export function getRequest(id: string): MeetingRequest | undefined {
  return requests.get(id);
}

export type AnswerResult =
  | { ok: true; request: MeetingRequest }
  | { ok: false; reason: 'not_found' | 'already_answered' | 'timed_out' };

/**
 * Close a request as answered by the outside brain and cancel its fallback. Refused when
 * it already fell back to the built-in agent, so a late answer is never spoken twice.
 */
export function answerRequest(id: string): AnswerResult {
  const request = requests.get(id);
  if (!request) return { ok: false, reason: 'not_found' };
  if (request.status === 'answered') return { ok: false, reason: 'already_answered' };
  if (request.status === 'fallback') return { ok: false, reason: 'timed_out' };
  request.status = 'answered';
  const timer = fallbackTimers.get(id);
  if (timer) clearTimeout(timer);
  fallbackTimers.delete(id);
  return { ok: true, request };
}

/** Test-only: forget every request, waiter and timer. */
export function __clearRequests(): void {
  for (const timer of fallbackTimers.values()) clearTimeout(timer);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(undefined);
  }
  fallbackTimers.clear();
  waiters = [];
  requests.clear();
}
