import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenize,
  chunkContent,
  buildIndex,
  search,
  safeSlug,
  startFolderConnector,
} from './folder-connector.js';

describe('tokenize', () => {
  it('lowercases, drops short tokens + stopwords', () => {
    expect(tokenize('The Quick brown FOX a 1')).toEqual(['quick', 'brown', 'fox']);
    expect(tokenize('roadmap, planning! decisions.')).toEqual(['roadmap', 'planning', 'decisions']);
  });
});

describe('chunkContent', () => {
  it('keeps short content as one chunk; [] for empty', () => {
    expect(chunkContent('short')).toEqual(['short']);
    expect(chunkContent('   ')).toEqual([]);
  });
  it('splits long content on paragraph boundaries under the cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} ` + 'x'.repeat(100)).join('\n\n');
    const chunks = chunkContent(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });
});

describe('buildIndex + search (BM25)', () => {
  const docs = [
    { source: 'plans/q3.md', content: 'The Q3 roadmap covers the data platform migration and sprint planning cadence.' },
    { source: 'notes/standup.md', content: 'Standup notes: the connector work shipped, no blockers on retrieval.' },
    { source: 'misc/lunch.md', content: 'Team lunch is on Friday at the taco place downtown.' },
  ];
  const index = buildIndex(docs);

  it('ranks the most relevant chunk first', () => {
    const r = search(index, 'Q3 roadmap data platform', 3);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]?.source).toBe('plans/q3.md');
    expect(r[0]?.score).toBeGreaterThan(0);
  });

  it('returns [] for a no-match query and respects k', () => {
    expect(search(index, 'quantum xylophone', 3)).toEqual([]);
    expect(search(index, 'the', 3)).toEqual([]); // stopword-only -> no terms
    expect(search(index, 'team', 5).length).toBeLessThanOrEqual(5);
  });
});

describe('safeSlug', () => {
  it('sanitizes to a filesystem-safe name', () => {
    expect(safeSlug('meeting 2026/06/24:standup')).toBe('meeting-2026-06-24-standup');
    expect(safeSlug('')).toBe('doc');
  });
});

describe('folder connector HTTP (live round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-conn-'));
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'roadmap.md'), 'The meeting agent connector contract and conformance verifier ship in Q3.', 'utf8');
  const port = 7531;
  let close: (() => void) | undefined;

  afterAll(() => {
    close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves /healthz, /search, empty-query 400, and a /store round-trip', async () => {
    ({ close } = await startFolderConnector({ root: dir, port }));
    const base = `http://127.0.0.1:${port}`;

    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health.ok).toBe(true);
    expect(health.indexed_chunks).toBeGreaterThan(0);

    const searchRes = await fetch(`${base}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'connector conformance verifier', k: 3 }),
    });
    const searchBody = await searchRes.json();
    expect(searchRes.status).toBe(200);
    expect(Array.isArray(searchBody.results)).toBe(true);
    expect(searchBody.results[0]?.source).toBe('plans/roadmap.md');
    expect(typeof searchBody.results[0]?.text).toBe('string');
    expect(typeof searchBody.results[0]?.score).toBe('number');

    const empty = await fetch(`${base}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }),
    });
    expect(empty.status).toBe(400);

    const uniq = `zephyrquux${port}`;
    const store = await fetch(`${base}/store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'second-brain', doc_type: 'meeting-transcript', entity_key: `mt-${uniq}`, content: `Decision: adopt ${uniq} for the pilot.` }),
    });
    expect((await store.json()).ok).toBe(true);
    // wrote a file under the doc_type subdir
    expect(readdirSync(join(dir, 'meeting-transcript')).length).toBeGreaterThan(0);

    const after = await fetch(`${base}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: uniq, k: 3 }),
    });
    const afterBody = await after.json();
    expect(afterBody.results[0]?.text).toContain(uniq); // stored doc is now retrievable
  });
});
