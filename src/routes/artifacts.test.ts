import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createArtifactRoutes, artifactUrl } from './artifacts.js';
import { createArtifact } from '../meeting/artifacts.js';
import { __clearRegistry, registerMeeting, shareTokenFor } from '../meeting/registry.js';
import { OWNER, makeConfig } from '../../tests/helpers/mcp.js';

let dir: string;
let app: Hono;
let token: string;
let id: string;
const config = makeConfig();

beforeEach(() => {
  __clearRegistry();
  dir = mkdtempSync(join(tmpdir(), 'jm-artroute-'));
  app = createArtifactRoutes(config, { dataDir: dir });
  registerMeeting({ meetingId: 'm1', botId: 'b1', teammate: 'david', persona: 'ai', title: 'Launch' });
  registerMeeting({ meetingId: 'm2', botId: 'b2', teammate: 'david', persona: 'ai', title: 'Other' });
  token = shareTokenFor('m1')!;
  id = createArtifact('m1', { kind: 'doc', title: 'Plan', content: '# Plan' }, dir).id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://x${path}`, { headers }));
const put = (path: string, body: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('artifact routes', () => {
  it('reads an artifact and the list with the meeting share token', async () => {
    const one = await get(`/api/artifacts/m1/${id}?t=${token}`);
    expect(one.status).toBe(200);
    expect(one.headers.get('referrer-policy')).toBe('no-referrer');
    expect(((await one.json()) as { artifact: { content: string } }).artifact.content).toBe('# Plan');

    const list = (await (await get(`/api/artifacts/m1?t=${token}`)).json()) as { artifacts: Record<string, unknown>[] };
    expect(list.artifacts).toEqual([expect.objectContaining({ id, kind: 'doc', title: 'Plan', version: 1 })]);
    expect(list.artifacts[0]).not.toHaveProperty('content');
  });

  it('answers 404 without the token, with another meeting’s token, and with the owner token', async () => {
    const other = shareTokenFor('m2')!;
    expect((await get(`/api/artifacts/m1/${id}`)).status).toBe(404);
    expect((await get(`/api/artifacts/m1/${id}?t=${other}`)).status).toBe(404);
    expect((await get(`/api/artifacts/m1/${id}?t=${OWNER}`)).status).toBe(404);
    expect((await get(`/api/artifacts/m1/${id}`, { authorization: `Bearer ${OWNER}` })).status).toBe(404);
    expect((await get(`/api/artifacts/m1?t=wrong`)).status).toBe(404);
    expect((await put(`/api/artifacts/m1/${id}?t=${other}`, { content: 'x', version: 1 })).status).toBe(404);
    expect((await get(`/api/artifacts/unknown/${id}?t=${token}`)).status).toBe(404);
  });

  it('saves with the current version and returns 409 with the stored artifact for a stale one', async () => {
    const saved = await put(`/api/artifacts/m1/${id}?t=${token}`, { content: 'Alice', version: 1 });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { artifact: { version: number } }).artifact.version).toBe(2);

    const stale = await put(`/api/artifacts/m1/${id}?t=${token}`, { content: 'Bob', version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'CONFLICT', current: { content: 'Alice', version: 2 } });
  });

  it('rejects a save without a version or content', async () => {
    expect((await put(`/api/artifacts/m1/${id}?t=${token}`, { content: 'x' })).status).toBe(400);
    expect((await put(`/api/artifacts/m1/${id}?t=${token}`, { version: 1 })).status).toBe(400);
  });

  it('never returns the share token, the owner token or an audio url in a body', async () => {
    const body = await (await get(`/api/artifacts/m1/${id}?t=${token}`)).text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(OWNER);
    expect(body).not.toMatch(/audio|sas/i);
  });

  it('artifactUrl builds the page link with the share token', () => {
    expect(artifactUrl(config, 'm1', id)).toBe(`https://jarvis.example.com/a/m1/${id}?t=${token}`);
    expect(artifactUrl(config, 'nope', id)).toBeUndefined();
  });
});

describe('artifact page', () => {
  it('serves the page to a share-token holder with a locked-down policy and no cache', async () => {
    const res = await get(`/a/m1/${id}?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('/artifact-assets/main.js');
    // The page shell carries no meeting data and no token; it loads them through the API.
    expect(html).not.toContain(token);
    expect(html).not.toContain('# Plan');
  });

  it('answers 404 for a wrong token, a missing token and an unknown artifact', async () => {
    expect((await get(`/a/m1/${id}?t=wrong`)).status).toBe(404);
    expect((await get(`/a/m1/${id}`)).status).toBe(404);
    expect((await get(`/a/m1/doesnotexist?t=${token}`)).status).toBe(404);
    expect((await get(`/a/m2/${id}?t=${token}`)).status).toBe(404);
  });

  it('serves only plainly named built files from the asset route', async () => {
    expect((await get('/artifact-assets/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await get('/artifact-assets/main.js.map')).status).toBe(404);
    expect((await get('/artifact-assets/registry.json')).status).toBe(404);
    expect((await get('/artifact-assets/chunk-NOPE0000.js')).status).toBe(404);
  });
});
