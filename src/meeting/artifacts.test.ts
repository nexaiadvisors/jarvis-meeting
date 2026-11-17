import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifact, getArtifact, listArtifacts, updateArtifact } from './artifacts.js';
import { __clearRegistry, isShareToken, registerMeeting, shareTokenFor } from './registry.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jm-art-'));
  __clearRegistry();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('artifact store', () => {
  it('stores an artifact as .data/artifacts/<meetingId>/<artifactId>.json at version 1', () => {
    const a = createArtifact('m1', { kind: 'doc', title: ' Launch plan ', content: '# Plan' }, dir);
    expect(a).toMatchObject({ meetingId: 'm1', kind: 'doc', title: 'Launch plan', content: '# Plan', version: 1 });
    expect(existsSync(join(dir, 'artifacts', 'm1', `${a.id}.json`))).toBe(true);
    expect(getArtifact('m1', a.id, dir)).toEqual(a);
  });

  it('a save based on the stored version bumps it; a stale one is a conflict that changes nothing', () => {
    const a = createArtifact('m1', { kind: 'doc', title: 'T', content: 'v1' }, dir);
    const first = updateArtifact('m1', a.id, { content: 'from Alice', baseVersion: 1 }, dir);
    expect(first).toMatchObject({ ok: true, artifact: { content: 'from Alice', version: 2 } });

    const stale = updateArtifact('m1', a.id, { content: 'from Bob', baseVersion: 1 }, dir);
    expect(stale).toMatchObject({ ok: false, code: 'conflict', current: { content: 'from Alice', version: 2 } });
    expect(getArtifact('m1', a.id, dir)).toMatchObject({ content: 'from Alice', version: 2 });
  });

  it('an update without a base version overwrites, and can rename', () => {
    const a = createArtifact('m1', { kind: 'whiteboard', title: 'T', content: 'flowchart TD\n A-->B' }, dir);
    const r = updateArtifact('m1', a.id, { content: 'x', title: 'Timeline' }, dir);
    expect(r).toMatchObject({ ok: true, artifact: { title: 'Timeline', version: 2, kind: 'whiteboard' } });
  });

  it('lists a meeting’s artifacts oldest first and keeps meetings apart', () => {
    const a = createArtifact('m1', { kind: 'doc', title: 'A', content: '' }, dir);
    const b = createArtifact('m1', { kind: 'whiteboard', title: 'B', content: '' }, dir);
    createArtifact('m2', { kind: 'doc', title: 'Other', content: '' }, dir);
    expect(listArtifacts('m1', dir).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(listArtifacts('none', dir)).toEqual([]);
  });

  it('rejects ids that are not plain names', () => {
    expect(() => createArtifact('../x', { kind: 'doc', title: 'T', content: '' }, dir)).toThrow();
    expect(getArtifact('m1', '../../registry', dir)).toBeUndefined();
    expect(updateArtifact('m1', '..', { content: 'x' }, dir)).toEqual({ ok: false, code: 'not_found' });
    expect(listArtifacts('..', dir)).toEqual([]);
  });
});

describe('meeting share token', () => {
  it('each meeting gets its own random token, checked exactly', () => {
    registerMeeting({ meetingId: 'm1', teammate: 'd', persona: 'ai', title: 'A' });
    registerMeeting({ meetingId: 'm2', teammate: 'd', persona: 'ai', title: 'B' });
    const t1 = shareTokenFor('m1')!;
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect(shareTokenFor('m2')).not.toBe(t1);
    expect(isShareToken('m1', t1)).toBe(true);
    expect(isShareToken('m2', t1)).toBe(false);
    expect(isShareToken('m1', undefined)).toBe(false);
    expect(isShareToken('m1', '')).toBe(false);
    expect(isShareToken('nope', t1)).toBe(false);
    expect(shareTokenFor('nope')).toBeUndefined();
  });
});
