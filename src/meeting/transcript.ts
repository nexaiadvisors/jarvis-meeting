// The one transcript reader for a meeting.
//
// Two sources are written during a call:
//   - <dataDir>/<botId or meetingId>.jsonl   what people said (the Recall webhook)
//   - <dataDir>/<meetingId>.agent.jsonl      what the bot said (answers and "Say this" lines),
//                                            also kept in memory so a refetch is current
//                                            before a disk write lands
// readMergedTranscript merges both, deduplicated and sorted by time, so the panel, the
// bot page's reconnect seed and the post-meeting document all show the same conversation.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TranscriptEntry {
  speaker: string;
  text: string;
  timestamp: string;
  /** Set on a line typed in the meeting chat. Absent on a spoken line. */
  kind?: 'chat';
}

// The key becomes part of a file name, so it must be a plain name: no separators,
// no '.' / '..', not empty.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// In-memory agent utterances keyed by meeting id.
const agentUtterances = new Map<string, TranscriptEntry[]>();

function defaultDataDir(): string {
  return join(process.cwd(), '.data');
}

/**
 * Record one line the bot spoke: append it to <dataDir>/<meetingId>.agent.jsonl and keep
 * it in memory. A failed disk write is logged and not thrown; the in-memory copy still
 * shows in this process's reads.
 */
export function appendAgentUtterance(
  meetingId: string,
  entry: TranscriptEntry,
  dataDir: string = defaultDataDir(),
): void {
  const existing = agentUtterances.get(meetingId) ?? [];
  existing.push(entry);
  agentUtterances.set(meetingId, existing);
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, `${meetingId}.agent.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'meeting-state: failed to write jsonl',
        file: `${meetingId}.agent.jsonl`,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Read a JSONL transcript file, tolerating a missing file and bad lines. Never throws. */
function readJsonlEntries(key: string, suffix: string, dataDir: string): TranscriptEntry[] {
  if (!SAFE_KEY.test(key)) return [];
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, `${key}${suffix}`), 'utf8');
  } catch {
    return [];
  }
  const out: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      out.push({
        speaker: typeof obj['speaker'] === 'string' ? obj['speaker'] : '',
        text: typeof obj['text'] === 'string' ? obj['text'] : '',
        timestamp: typeof obj['timestamp'] === 'string' ? obj['timestamp'] : '',
        ...(obj['kind'] === 'chat' ? { kind: 'chat' as const } : {}),
      });
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function entryKey(e: TranscriptEntry): string {
  return JSON.stringify([e.timestamp, e.speaker, e.text]);
}

/**
 * The bot's lines: the agent file plus any in-memory entries not on disk. A line present
 * in both counts once (matched one-for-one, so two genuinely identical lines stay two).
 */
function agentEntries(meetingId: string, dataDir: string): TranscriptEntry[] {
  const fromFile = readJsonlEntries(meetingId, '.agent.jsonl', dataDir);
  const onDisk = new Map<string, number>();
  for (const e of fromFile) onDisk.set(entryKey(e), (onDisk.get(entryKey(e)) ?? 0) + 1);
  const merged = [...fromFile];
  for (const e of agentUtterances.get(meetingId) ?? []) {
    const k = entryKey(e);
    const left = onDisk.get(k) ?? 0;
    if (left > 0) onDisk.set(k, left - 1);
    else merged.push(e);
  }
  return merged;
}

function timeOf(e: TranscriptEntry): number {
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The whole conversation in time order: what people said (webhook file, keyed by botId,
 * else meetingId) interleaved with what the bot said, with the bot's lines labeled
 * `botName`. Equal timestamps keep spoken-before-agent and then source order. A line
 * with no usable timestamp sorts first. Never throws.
 */
export function readMergedTranscript(
  meeting: { meetingId: string; botId?: string | undefined },
  botName: string,
  dataDir: string = defaultDataDir(),
): TranscriptEntry[] {
  const spoken = readJsonlEntries(meeting.botId ?? meeting.meetingId, '.jsonl', dataDir);
  const agent = agentEntries(meeting.meetingId, dataDir).map((e) => ({ ...e, speaker: botName }));
  return [...spoken, ...agent].sort((a, b) => timeOf(a) - timeOf(b));
}

/** One "[timestamp] speaker: text" line per entry, in order (the stored transcript text). A chat line reads "speaker (chat)". */
export function renderTranscriptText(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => `[${e.timestamp}] ${e.speaker || 'Unknown'}${e.kind === 'chat' ? ' (chat)' : ''}: ${e.text}`)
    .join('\n');
}

/** Test-only: forget the in-memory agent utterances between cases. */
export function __clearAgentUtterances(): void {
  agentUtterances.clear();
}
