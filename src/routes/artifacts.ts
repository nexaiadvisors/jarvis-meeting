// Artifact API, reached with the meeting's share token (?t=<token>), not the owner token:
// the people in the meeting open these links from the chat.
//
//   GET /a/:meetingId/:artifactId?t=               -> the editable page (HTML)
//   GET /artifact-assets/:file                     -> the page's built scripts and styles
//   GET /api/artifacts/:meetingId?t=               -> 200 {artifacts:[{id,kind,title,version,updatedAt}]}
//   GET /api/artifacts/:meetingId/:artifactId?t=   -> 200 {artifact}
//   PUT /api/artifacts/:meetingId/:artifactId?t=   body {content, title?, version}
//        -> 200 {artifact} | 409 {code:'CONFLICT', current} | 400 BAD_REQUEST
//
// A wrong or missing token, an unknown meeting and an unknown artifact all answer 404,
// so a guessed link confirms nothing. Responses never carry the share token, the owner
// token or the audio URL.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Config } from '../config.js';
import { isShareToken, shareTokenFor } from '../meeting/registry.js';
import {
  ARTIFACT_CONTENT_MAX_CHARS,
  getArtifact,
  listArtifacts,
  updateArtifact,
} from '../meeting/artifacts.js';

export interface ArtifactRouteOptions {
  dataDir?: string;
}

/** The link people open: the editable page for one artifact. Undefined for an unknown meeting. */
export function artifactUrl(config: Config, meetingId: string, artifactId: string): string | undefined {
  const token = shareTokenFor(meetingId);
  if (token === undefined) return undefined;
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/a/${encodeURIComponent(meetingId)}/${encodeURIComponent(artifactId)}?t=${token}`;
}

const here = dirname(fileURLToPath(import.meta.url));
// src/routes -> dist/routes at runtime; the repo root (web/ and public/) is two levels up in both.
const pkgRoot = resolve(here, '..', '..');

// One same-origin page: its own scripts and styles, fetches to itself. Excalidraw sets
// inline styles and draws through blob: and data: images; its fonts may come over https.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data: https:; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

// Built files are named main.js, main.css, chunk-<hash>.js, asset-<hash>.<ext>: plain names only.
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|css|woff2|woff|ttf)$/;
const ASSET_TYPES: Record<string, string> = {
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
};

const NOT_FOUND = { error: 'Not found', code: 'not_found' } as const;

/** Headers for every share-token response: the token rides in the URL, so it must not leak by Referer or cache. */
export const SHARE_HEADERS = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } as const;

/** True when the request carries the meeting's share token. */
export function hasShareAccess(c: Context, meetingId: string): boolean {
  return isShareToken(meetingId, c.req.query('t'));
}

export function createArtifactRoutes(_config: Config, options: ArtifactRouteOptions = {}): Hono {
  const app = new Hono();
  const dataDir = options.dataDir;
  const dir = (): [string] | [] => (dataDir !== undefined ? [dataDir] : []);

  // The page. It is served only to a holder of the meeting's share token and only for an
  // artifact that exists; the page then loads and saves through the API below.
  const pageHtml = readFileSync(resolve(pkgRoot, 'web/artifact/index.html'), 'utf8');
  app.get('/a/:meetingId/:artifactId', (c) => {
    const meetingId = c.req.param('meetingId');
    if (!hasShareAccess(c, meetingId) || !getArtifact(meetingId, c.req.param('artifactId'), ...dir())) {
      return c.text('Not found', 404, SHARE_HEADERS);
    }
    return c.html(pageHtml, 200, { ...PAGE_HEADERS, ...SHARE_HEADERS });
  });

  // The page's built files (public/artifact/, a build output). They hold no meeting data.
  app.get('/artifact-assets/:file', (c) => {
    const file = c.req.param('file');
    const ext = ASSET_NAME.exec(file)?.[1];
    if (ext === undefined) return c.text('Not found', 404);
    let body: Buffer;
    try {
      body = readFileSync(resolve(pkgRoot, 'public/artifact', file));
    } catch {
      return c.text('Not found', 404);
    }
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': ASSET_TYPES[ext] ?? 'application/octet-stream',
      // Chunk and asset names carry a content hash; main.js and main.css do not.
      'Cache-Control': /^(chunk|asset)-/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.get('/api/artifacts/:meetingId', (c) => {
    const meetingId = c.req.param('meetingId');
    if (!hasShareAccess(c, meetingId)) return c.json(NOT_FOUND, 404, SHARE_HEADERS);
    return c.json(
      {
        artifacts: listArtifacts(meetingId, ...dir()).map((a) => ({
          id: a.id,
          kind: a.kind,
          title: a.title,
          version: a.version,
          updatedAt: a.updatedAt,
        })),
      },
      200,
      SHARE_HEADERS,
    );
  });

  app.get('/api/artifacts/:meetingId/:artifactId', (c) => {
    const meetingId = c.req.param('meetingId');
    if (!hasShareAccess(c, meetingId)) return c.json(NOT_FOUND, 404, SHARE_HEADERS);
    const artifact = getArtifact(meetingId, c.req.param('artifactId'), ...dir());
    return artifact ? c.json({ artifact }, 200, SHARE_HEADERS) : c.json(NOT_FOUND, 404, SHARE_HEADERS);
  });

  app.put('/api/artifacts/:meetingId/:artifactId', async (c) => {
    const meetingId = c.req.param('meetingId');
    if (!hasShareAccess(c, meetingId)) return c.json(NOT_FOUND, 404, SHARE_HEADERS);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const content = body?.['content'];
    const version = body?.['version'];
    const title = body?.['title'];
    if (
      typeof content !== 'string' ||
      content.length > ARTIFACT_CONTENT_MAX_CHARS ||
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      (title !== undefined && typeof title !== 'string')
    ) {
      return c.json({ error: 'content (string), version (integer) and optional title are required', code: 'BAD_REQUEST' }, 400, SHARE_HEADERS);
    }
    const result = updateArtifact(
      meetingId,
      c.req.param('artifactId'),
      { content, baseVersion: version, ...(title !== undefined ? { title } : {}) },
      ...dir(),
    );
    if (result.ok) return c.json({ artifact: result.artifact }, 200, SHARE_HEADERS);
    if (result.code === 'conflict') {
      return c.json({ error: 'artifact changed since it was loaded', code: 'CONFLICT', current: result.current }, 409, SHARE_HEADERS);
    }
    return c.json(NOT_FOUND, 404, SHARE_HEADERS);
  });

  return app;
}
