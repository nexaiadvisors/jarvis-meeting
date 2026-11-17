import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSoul, listSouls, soulPath, isValidSoulSlug } from './loader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'soul-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FULL_SOUL = `---
owner: david
name: David's Delegate
wake_word: David
persona_mode: first_person
voice: cedar
language: en
knowledge_backend:
  type: openbrain
  endpoint: http://localhost:9000
delivery:
  - slack
  - email
ingest: true
denied_topics:
  - compensation
ai_disclosure: AI representative for David
---

This is the persona prose.
It spans multiple lines.
`;

describe('loadSoul', () => {
  it('parses all fields including knowledge_backend and prose', () => {
    writeFileSync(join(dir, 'david.md'), FULL_SOUL, 'utf8');
    const soul = loadSoul('david', dir);
    expect(soul.owner).toBe('david');
    expect(soul.name).toBe("David's Delegate");
    expect(soul.wakeWord).toBe('David');
    expect(soul.personaMode).toBe('first_person');
    expect(soul.voice).toBe('cedar');
    expect(soul.language).toBe('en');
    expect(soul.knowledgeBackend).toEqual({
      type: 'openbrain',
      endpoint: 'http://localhost:9000',
      route: 'delegate',
    });
    expect(soul.delivery).toEqual(['slack', 'email']);
    expect(soul.ingest).toBe(true);
    expect(soul.deniedTopics).toEqual(['compensation']);
    expect(soul.aiDisclosure).toBe('AI representative for David');
    expect(soul.prose).toContain('This is the persona prose.');
    expect(soul.prose).toContain('multiple lines.');
  });

  it('defaults route from persona_mode when knowledge_backend.route is absent', () => {
    writeFileSync(
      join(dir, 'jarvis.md'),
      `---\nname: Jarvis\npersona_mode: ai\nknowledge_backend:\n  type: openbrain\n  endpoint: http://x\n---\nhi`,
      'utf8',
    );
    expect(loadSoul('jarvis', dir).knowledgeBackend.route).toBe('jarvis');
  });

  it('ignores a contradictory explicit route (route always derives from persona_mode)', () => {
    // Security: persona_mode 'ai' must yield route 'jarvis' even if the
    // front-matter claims route 'delegate', so the owner gate (which keys on
    // route at the retrieval point) cannot be bypassed by a mismatched route.
    writeFileSync(
      join(dir, 'mixed.md'),
      `---\nowner: x\nname: Mixed\npersona_mode: ai\nknowledge_backend:\n  type: openbrain\n  endpoint: http://x\n  route: delegate\n---\nhi`,
      'utf8',
    );
    expect(loadSoul('mixed', dir).knowledgeBackend.route).toBe('jarvis');
  });

  it('throws when the file is missing', () => {
    expect(() => loadSoul('nope', dir)).toThrow(/SOUL not found/);
  });

  it('throws when there is no front-matter', () => {
    writeFileSync(join(dir, 'bad.md'), 'just prose, no front matter', 'utf8');
    expect(() => loadSoul('bad', dir)).toThrow(/no YAML front-matter/);
  });

  it('throws when front-matter fails validation (missing name)', () => {
    writeFileSync(join(dir, 'noname.md'), `---\nowner: x\n---\nprose`, 'utf8');
    expect(() => loadSoul('noname', dir)).toThrow(/failed validation/);
  });

  it('soulPath joins dir + slug.md', () => {
    expect(soulPath('alice', dir)).toBe(join(dir, 'alice.md'));
  });
});

describe('isValidSoulSlug', () => {
  it.each(['../x', 'a/b', 'A', '', 'x'.repeat(41), 'a b', 'a.b', 'a\\b', '..', '.', 'a\0b', 'a\n', 'under_score'])(
    'rejects slug %j',
    (s) => expect(isValidSoulSlug(s)).toBe(false),
  );

  it.each(['david', 'jarvis', 'a', 'team-kb-2', '0', 'x'.repeat(40)])('accepts slug %j', (s) =>
    expect(isValidSoulSlug(s)).toBe(true),
  );

  it('rejects non-string input', () => {
    expect(isValidSoulSlug(undefined as unknown as string)).toBe(false);
    expect(isValidSoulSlug(42 as unknown as string)).toBe(false);
    expect(isValidSoulSlug({} as unknown as string)).toBe(false);
  });
});

describe('loadSoul slug validation', () => {
  it('rejects a traversal slug before touching the filesystem, even when the target file exists', () => {
    // A file that a traversal slug would resolve to: <dir>/../outside.md.
    const outside = join(dir, '..', 'outside-soul-test.md');
    writeFileSync(outside, FULL_SOUL, 'utf8');
    try {
      expect(() => loadSoul('../outside-soul-test', dir)).toThrow(/^INVALID_SOUL_SLUG/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it.each(['../x', 'a/b', 'A', '', 'x'.repeat(41)])('loadSoul(%j) throws INVALID_SOUL_SLUG', (s) => {
    expect(() => loadSoul(s, dir)).toThrow(/^INVALID_SOUL_SLUG/);
  });

  it('a valid slug with no file still reports SOUL not found (not INVALID_SOUL_SLUG)', () => {
    expect(() => loadSoul('ghost', dir)).toThrow(/SOUL not found/);
    expect(() => loadSoul('ghost', dir)).not.toThrow(/INVALID_SOUL_SLUG/);
  });
});

describe('listSouls', () => {
  it('lists slugs, excluding README.md', () => {
    writeFileSync(join(dir, 'a.md'), `---\nname: A\n---\n`, 'utf8');
    writeFileSync(join(dir, 'b.md'), `---\nname: B\n---\n`, 'utf8');
    writeFileSync(join(dir, 'README.md'), 'readme', 'utf8');
    expect(listSouls(dir)).toEqual(['a', 'b']);
  });

  it('returns [] for a missing directory', () => {
    expect(listSouls(join(dir, 'does-not-exist'))).toEqual([]);
  });
});
