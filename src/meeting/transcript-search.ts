// In-meeting transcript search over the unbounded durable JSONL record.
// Realtime context and the in-memory buffer retain only recent turns, so this
// module deliberately reads .data/<botId>.jsonl rather than either of them.

import { readFileSync } from 'node:fs'

export interface TranscriptEntry {
  speaker: string
  text: string
  timestamp: string
}

/** Keep a single long utterance from consuming the model's context budget. */
export const MAX_TRANSCRIPT_RESULT_CHARS = 500

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function timestampValue(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Rank transcript entries by keyword overlap, then by recency. Speaker names
 * are part of the searchable content so "what did Alice say" is useful even
 * when the utterance itself does not repeat Alice's name.
 */
export function rankTranscriptEntries(
  entries: TranscriptEntry[],
  query: string,
  k: number = 6,
): TranscriptEntry[] {
  const queryTokens = tokens(query)
  if (queryTokens.size === 0) return []

  return entries
    .map((entry, index) => {
      const entryTokens = tokens(`${entry.speaker} ${entry.text}`)
      let overlap = 0
      for (const token of queryTokens) {
        if (entryTokens.has(token)) overlap += 1
      }
      return { entry, index, overlap, timestamp: timestampValue(entry.timestamp) }
    })
    .filter((candidate) => candidate.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.timestamp - a.timestamp || b.index - a.index)
    .slice(0, Math.max(1, Math.floor(k)))
    .map(({ entry }) => ({
      ...entry,
      text: entry.text.slice(0, MAX_TRANSCRIPT_RESULT_CHARS),
    }))
}

/** Read the durable JSONL transcript, treating a missing or malformed line as absent. */
export function searchTranscriptFile(file: string, query: string, k: number = 6): TranscriptEntry[] {
  let contents: string
  try {
    contents = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const entries: TranscriptEntry[] = []
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Partial<TranscriptEntry>
      if (
        typeof parsed.speaker === 'string' &&
        typeof parsed.text === 'string' &&
        typeof parsed.timestamp === 'string'
      ) {
        entries.push({ speaker: parsed.speaker, text: parsed.text, timestamp: parsed.timestamp })
      }
    } catch {
      // A partial append must not make prior transcript turns unreachable.
    }
  }
  return rankTranscriptEntries(entries, query, k)
}
