import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSummary, writeSummary } from './summary-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-summary-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SUMMARY = {
  bluf: 'Ship Friday.',
  decisions: ['Budget stays at 40k'],
  actionItems: [{ owner: 'Nick', task: 'Send the deck', due: '2026-11-20' }],
};

describe('summary store', () => {
  it('round-trips a summary under <botId>.summary.json', () => {
    writeSummary('bot-1', SUMMARY, true, dir);
    expect(readSummary('bot-1', dir)).toMatchObject({ ...SUMMARY, generated: true });
  });

  it('returns undefined for a missing file, a bad key and a malformed file', () => {
    expect(readSummary('nope', dir)).toBeUndefined();
    expect(readSummary('../etc', dir)).toBeUndefined();
    writeFileSync(join(dir, 'bad.summary.json'), '{"bluf": 3}');
    expect(readSummary('bad', dir)).toBeUndefined();
  });

  it('refuses to write under a key that is not a plain name', () => {
    expect(() => writeSummary('../x', SUMMARY, true, dir)).toThrow();
  });
});
