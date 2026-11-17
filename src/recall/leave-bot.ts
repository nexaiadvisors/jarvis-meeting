// Tell a Recall.ai bot to leave its call — the cost-control "stop spending" lever.
//
// POSTs to Recall's leave endpoint with Token auth. Best-effort by contract:
// it NEVER throws and NEVER hangs (5s AbortController timeout), so the
// cost-control sweep can fire it for many meetings without one bad request
// stalling the loop. Returns a small {ok, error?, alreadyGone?} result for logging.
//
// HTTP 400 for a bot whose own status history shows it finished is treated the same way.
// HTTP 404/410 means Recall no longer has that bot in a call it can leave (it already
// left, was removed, or was force-terminated). That is not a retryable failure: callers
// treat `alreadyGone` as "the bot is out" so they stop retrying and free the meeting.

import type { Config } from '../config.js';

const LEAVE_TIMEOUT_MS = 5000;

export interface LeaveBotResult {
  ok: boolean;
  error?: string;
  /** True when Recall answered 404 or 410: the bot is already gone. Never set with ok: true. */
  alreadyGone?: boolean;
}

/** Status codes after which a bot is out of the call for good. */
const FINISHED_STATUS_CODES = new Set(['call_ended', 'recording_done', 'done', 'fatal', 'analysis_done']);

/** True when Recall's status history for the bot ends in a finished state. False on any doubt. */
async function botHasFinished(config: Config, botId: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${config.recallApiBase.replace(/\/+$/, '')}/bot/${encodeURIComponent(botId)}/`, {
      headers: { Authorization: `Token ${config.recallApiKey}`, Accept: 'application/json' },
      signal,
    });
    if (!response.ok) return false;
    const bot = (await response.json()) as { status_changes?: { code?: unknown }[] };
    const last = bot.status_changes?.at(-1)?.code;
    return typeof last === 'string' && FINISHED_STATUS_CODES.has(last);
  } catch {
    return false;
  }
}

export async function leaveBot(config: Config, botId: string): Promise<LeaveBotResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEAVE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.recallApiBase.replace(/\/+$/, '')}/bot/${encodeURIComponent(botId)}/leave_call/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.recallApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read body)');
      const error = `recall leave failed (${response.status}): ${body}`;
      if (response.status === 404 || response.status === 410) return { ok: false, error, alreadyGone: true };
      // Recall answers 400 "cannot command" for a bot that has already finished (kicked,
      // call ended). Only its own status history proves that, so ask before treating the
      // bot as gone: a bot that has not joined yet gets the same 400 and is NOT gone.
      if (response.status === 400 && (await botHasFinished(config, botId, controller.signal))) {
        return { ok: false, error, alreadyGone: true };
      }
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
