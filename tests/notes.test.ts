import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendNote, readNotes } from '../src/meeting/notes.js';
import type { SavedNote } from '../src/meeting/notes.js';

let dir: string;

const NOTE: SavedNote = { kind: 'note', text: 'Ship on Friday', at: '2026-10-16T10:00:00.000Z', by: 'agent' };
const FLAG: SavedNote = { kind: 'flag', text: '[FLAG FOR DAVID] budget\n\nReason: needs sign-off', at: '2026-10-16T10:01:00.000Z', by: 'agent' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notes-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendNote / readNotes', () => {
  it('appendNote then readNotes round-trips and skips malformed lines', () => {
    appendNote('bot-1', NOTE, dir);
    appendFileSync(join(dir, 'bot-1.notes.jsonl'), 'this is not json\n', 'utf8');
    appendNote('bot-1', FLAG, dir);

    expect(readNotes('bot-1', dir)).toEqual([NOTE, FLAG]);
  });

  it('stores one JSON object per line at <dataDir>/<key>.notes.jsonl, newlines in text included', () => {
    appendNote('bot-1', FLAG, dir);

    const lines = readFileSync(join(dir, 'bot-1.notes.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(FLAG);
  });

  it('creates the data directory when it does not exist yet', () => {
    const nested = join(dir, 'nested', '.data');
    appendNote('bot-1', NOTE, nested);

    expect(readNotes('bot-1', nested)).toEqual([NOTE]);
  });

  it('returns [] when the notes file does not exist', () => {
    expect(readNotes('never-written', dir)).toEqual([]);
  });

  it('skips lines that parse as JSON but are not a SavedNote', () => {
    const file = join(dir, 'bot-1.notes.jsonl');
    const bad = [
      JSON.stringify({ kind: 'other', text: 'x', at: 't', by: 'agent' }),
      JSON.stringify({ kind: 'note', text: 42, at: 't', by: 'agent' }),
      JSON.stringify({ kind: 'note', text: 'x', at: 't', by: 'stranger' }),
      JSON.stringify(['array']),
      'null',
    ];
    appendFileSync(file, bad.join('\n') + '\n', 'utf8');
    appendNote('bot-1', NOTE, dir);

    expect(readNotes('bot-1', dir)).toEqual([NOTE]);
  });

  it('keeps each key in its own file', () => {
    appendNote('bot-1', NOTE, dir);
    appendNote('bot-2', FLAG, dir);

    expect(readNotes('bot-1', dir)).toEqual([NOTE]);
    expect(readNotes('bot-2', dir)).toEqual([FLAG]);
  });

  it('refuses a key that could escape the data directory', () => {
    for (const key of ['../escape', 'a/b', 'a\\b', '..', '.', '']) {
      expect(() => appendNote(key, NOTE, dir)).toThrow();
      expect(readNotes(key, dir)).toEqual([]);
    }
    expect(existsSync(join(dir, '..', 'escape.notes.jsonl'))).toBe(false);
  });
});
