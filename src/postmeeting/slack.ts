// Post-meeting Slack delivery — minimal chat.postMessage wrapper.
//
// Best-effort: returns a structured { ok, error } and NEVER throws, so a Slack
// outage can never block the pipeline's other delivery lanes. Token comes from
// config.slackBotToken (SLACK_BOT_TOKEN); channel is passed by the caller.
// Shape mirrors the dashboard's slack-post.ts but is node-fetch based and carries
// no DB / file-upload dependencies (summary text only).

const SLACK_API = 'https://slack.com/api';
const TIMEOUT_MS = 5000;

/** Slack chat.postMessage caps text near 40k chars; chunk well under for readable DMs. */
export const SLACK_CHUNK_CHARS = 3500;

/**
 * Split long text (e.g. a full transcript) into <=max-char chunks on line
 * boundaries, hard-splitting only a single line that itself exceeds max. Pure.
 */
export function chunkForSlack(text: string, max = SLACK_CHUNK_CHARS): string[] {
  if (text.length <= max) return text.trim() === '' ? [] : [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface DeliverSlackOptions {
  token?: string;
  channel: string;
  text: string;
}

export interface DeliverSlackResult {
  ok: boolean;
  error?: string;
}

export async function deliverSlack(opts: DeliverSlackOptions): Promise<DeliverSlackResult> {
  const { token, channel, text } = opts;
  if (!token || token.trim() === '') {
    return { ok: false, error: 'no SLACK_BOT_TOKEN configured' };
  }
  if (!channel || channel.trim() === '') {
    return { ok: false, error: 'no Slack channel configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `chat.postMessage HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!data || data.ok !== true) {
      return { ok: false, error: `slack error: ${data?.error ?? 'unknown'}` };
    }
    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'slack request timed out' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
