// Auto-ingest a finished meeting into the teammate's OWN knowledge brain.
//
// Gated on SOUL.ingest. Mirrors the /search seam used by the retrieval client
// (src/retrieval/knowledge-client.ts): the teammate's OpenBrain is expected to
// expose a /store endpoint alongside /search, derived by swapping the trailing
// `/search` for `/store` on soul.knowledgeBackend.endpoint
// (e.g. http://host:3031/search -> http://host:3031/store).
//
// NOTE: the OB-side /store wrapper is a SEPARATE deliverable. This client only
// POSTs to the derived URL; if the endpoint is absent or errors, ingest fails
// GRACEFULLY ({ ok:false, error }) and the pipeline continues. This function
// NEVER throws.

import type { Soul } from '../soul/schema.js';
import type { SavedNote } from '../meeting/notes.js';

export interface IngestInput {
  meetingId: string;
  title: string;
  summary: { bluf: string; decisions: string[]; actionItems: { owner: string; task: string; due?: string }[] };
  transcriptText: string;
  date: string;
  /** Items the agent saved during the call (save_meeting_note / flag_for_david). */
  notes?: SavedNote[];
}

export interface IngestResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

/**
 * Derive the /store endpoint from a /search endpoint by swapping a trailing
 * `/search` (with optional trailing slashes) for `/store`. If the endpoint does
 * not end in `/search`, `/store` is appended to the trimmed base.
 */
function deriveStoreEndpoint(searchEndpoint: string): string {
  const trimmed = searchEndpoint.trim().replace(/\/+$/, '');
  if (/\/search$/.test(trimmed)) {
    return trimmed.replace(/\/search$/, '/store');
  }
  return `${trimmed}/store`;
}

/**
 * One markdown bullet. Continuation lines are indented so a multi-line item (the
 * flag text always has a blank line before "Reason:") stays inside its bullet, and a
 * line of the item can never start a column-0 heading like "## Transcript".
 */
function bullet(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line, i) => (i === 0 ? `- ${line}` : line === '' ? '' : `  ${line}`))
    .join('\n');
}

/** Render the meeting into a markdown doc: title, date, BLUF, decisions, action items, noted, flagged, transcript. */
function renderContent(input: IngestInput): string {
  const { title, date, summary, transcriptText } = input;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Date: ${date}`);
  lines.push('');
  lines.push('## BLUF');
  lines.push(summary.bluf || 'Meeting completed.');
  lines.push('');

  if (summary.decisions.length > 0) {
    lines.push('## Decisions');
    for (const d of summary.decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  if (summary.actionItems.length > 0) {
    lines.push('## Action items');
    for (const item of summary.actionItems) {
      const due = item.due ? ` (due: ${item.due})` : '';
      lines.push(`- ${item.owner}: ${item.task}${due}`);
    }
    lines.push('');
  }

  const noted = (input.notes ?? []).filter((n) => n.kind === 'note');
  if (noted.length > 0) {
    lines.push('## Noted');
    for (const n of noted) lines.push(bullet(n.text));
    lines.push('');
  }

  const flagged = (input.notes ?? []).filter((n) => n.kind === 'flag');
  if (flagged.length > 0) {
    lines.push('## Flagged for David');
    for (const n of flagged) lines.push(bullet(n.text));
    lines.push('');
  }

  lines.push('## Transcript');
  lines.push(transcriptText);
  return lines.join('\n');
}

/**
 * Best-effort ingest of a meeting into the teammate's own brain. Returns a
 * structured result; never throws. `authToken` (KB_BACKEND_TOKEN), when given, is
 * sent to /store as `Authorization: Bearer <authToken>`.
 */
export async function ingestToBrain(
  soul: Soul,
  input: IngestInput,
  timeoutMs: number,
  authToken?: string,
): Promise<IngestResult> {
  if (!soul.ingest) {
    return { ok: true, skipped: 'ingest disabled in SOUL' };
  }

  const endpoint = soul.knowledgeBackend.endpoint;
  if (!endpoint || endpoint.trim() === '') {
    return { ok: false, error: 'no knowledge backend endpoint configured in SOUL' };
  }

  const storeUrl = deriveStoreEndpoint(endpoint);
  const content = renderContent(input);
  const payload = {
    namespace: 'second-brain',
    doc_type: 'meeting-transcript',
    entity_key: `meeting-${input.meetingId}`,
    content,
    metadata: {
      source: 'jarvis-meeting',
      scope: 'work',
      title: input.title,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(storeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `store HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'store request timed out' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
