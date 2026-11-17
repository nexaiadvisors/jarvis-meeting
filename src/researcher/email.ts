// Read-only search of the owner's work mailbox through gws-sa, for the researcher.
// Returns headers and Gmail's short snippet only; message bodies are never read.

import { runGwsJson } from '../calendar/watcher.js';

export interface EmailHit {
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

export type GwsJson = (args: string[]) => Promise<Record<string, unknown>>;

function header(headers: Array<{ name?: string; value?: string }>, name: string): string {
  return headers.find((h) => (h.name ?? '').toLowerCase() === name)?.value ?? '';
}

export async function searchEmail(run: GwsJson, query: string, max: number): Promise<{ messages: EmailHit[]; count: number }> {
  const list = await run(['gmail', 'users', 'messages', 'list', '--params', JSON.stringify({ userId: 'me', q: query, maxResults: max })]);
  const ids = (Array.isArray(list['messages']) ? (list['messages'] as Array<{ id?: string }>) : [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, max);
  const messages = await Promise.all(
    ids.map(async (id): Promise<EmailHit> => {
      const got = await run([
        'gmail', 'users', 'messages', 'get', '--params',
        JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }),
      ]);
      const payload = (got['payload'] ?? {}) as { headers?: Array<{ name?: string; value?: string }> };
      const headers = Array.isArray(payload.headers) ? payload.headers : [];
      return {
        from: header(headers, 'from'),
        to: header(headers, 'to'),
        subject: header(headers, 'subject'),
        date: header(headers, 'date'),
        snippet: typeof got['snippet'] === 'string' ? got['snippet'].slice(0, 300) : '',
      };
    }),
  );
  return { messages, count: messages.length };
}

/** The gws-sa runner bound to one binary path. */
export function gwsRunner(gwsBin: string): GwsJson {
  return (args) => runGwsJson(gwsBin, args);
}
