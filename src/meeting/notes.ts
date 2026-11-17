// Durable record of what the realtime agent noted or flagged during a meeting.
//
// One JSONL file per meeting next to the transcript: <dataDir>/<key>.notes.jsonl,
// where key = meeting.botId ?? meeting.meetingId (the same key the transcript file
// uses). Written by POST /api/voice/save, shown by GET /api/meetings/:id, and read
// once more by the post-meeting pipeline for the OpenBrain notes document.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SavedNote {
  kind: 'note' | 'flag';
  text: string;
  /** ISO-8601 time the note was saved. */
  at: string;
  /** 'agent' = the realtime model's tool call; 'owner' = typed by David in the panel. */
  by: 'agent' | 'owner';
}

// The key becomes part of a file name, so it must be a plain name: no separators,
// no '.' / '..', not empty.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function defaultDataDir(): string {
  return join(process.cwd(), '.data');
}

function notesFile(key: string, dataDir: string): string {
  if (!SAFE_KEY.test(key)) throw new Error('invalid notes key');
  return join(dataDir, `${key}.notes.jsonl`);
}

function asSavedNote(value: unknown): SavedNote | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== 'note' && v['kind'] !== 'flag') return undefined;
  if (v['by'] !== 'agent' && v['by'] !== 'owner') return undefined;
  if (typeof v['text'] !== 'string' || typeof v['at'] !== 'string') return undefined;
  return { kind: v['kind'], text: v['text'], at: v['at'], by: v['by'] };
}

/**
 * Append one note. Unlike the best-effort telemetry logs, this THROWS when the note
 * cannot be written: the caller must not tell the model "saved" for a lost note.
 */
export function appendNote(key: string, note: SavedNote, dataDir: string = defaultDataDir()): void {
  const file = notesFile(key, dataDir);
  mkdirSync(dataDir, { recursive: true });
  const line: SavedNote = { kind: note.kind, text: note.text, at: note.at, by: note.by };
  appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
}

/** Read a meeting's notes in the order saved. A missing file is []; bad lines are skipped. Never throws. */
export function readNotes(key: string, dataDir: string = defaultDataDir()): SavedNote[] {
  let raw: string;
  try {
    raw = readFileSync(notesFile(key, dataDir), 'utf8');
  } catch {
    return [];
  }
  const notes: SavedNote[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const note = asSavedNote(JSON.parse(line));
      if (note !== undefined) notes.push(note);
    } catch {
      // skip malformed line
    }
  }
  return notes;
}
