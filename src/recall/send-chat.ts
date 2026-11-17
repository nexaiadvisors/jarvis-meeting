// Post a message into the meeting chat as the bot.
//
// POST <recall>/bot/{id}/send_chat_message/ with Token auth. Best-effort by contract,
// like leave-bot: it never throws and never hangs (5 s timeout per request). Google Meet
// caps a chat message at 500 characters, so a longer message is sent as several, split
// at whitespace. The message is meeting content and is never logged here.

import type { Config } from '../config.js';

const SEND_TIMEOUT_MS = 5000;
/** Under Google Meet's 500-character cap (Zoom and Teams allow 4096). */
export const CHAT_CHUNK_CHARS = 480;

export interface SendChatResult {
  ok: boolean;
  error?: string;
}

/** Split a message into parts of at most `max` characters, breaking at whitespace when possible. */
export function splitChatMessage(message: string, max: number = CHAT_CHUNK_CHARS): string[] {
  const parts: string[] = [];
  let rest = message.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

async function sendOne(config: Config, botId: string, message: string): Promise<SendChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.recallApiBase.replace(/\/+$/, '')}/bot/${encodeURIComponent(botId)}/send_chat_message/`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${config.recallApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'everyone', message }),
        signal: controller.signal,
      },
    );
    return response.ok ? { ok: true } : { ok: false, error: `recall send_chat_message failed (${response.status})` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : err instanceof Error ? err.name : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Send `message` to everyone in the call. Stops at the first part Recall refuses. */
export async function sendChat(config: Config, botId: string, message: string): Promise<SendChatResult> {
  const parts = splitChatMessage(message);
  if (parts.length === 0) return { ok: false, error: 'empty message' };
  for (const part of parts) {
    const result = await sendOne(config, botId, part);
    if (!result.ok) return result;
  }
  return { ok: true };
}
