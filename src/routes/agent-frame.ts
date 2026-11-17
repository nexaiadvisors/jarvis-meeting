// Serves the realtime meeting agent-frame BROWSER page. Recall.ai renders
// GET /meetings/agent-frame/:id as the speaking bot's camera tile; the page
// (bundled from web/agent-frame/main.tsx into public/agent-frame.js by
// scripts/build-web.mjs) opens the realtime WS and drives the wake gate.
//
// This is why the service is self-contained: the page is no longer borrowed
// from the OpenBrain dashboard.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/routes -> dist/routes at runtime; the repo root (where web/ and public/
// live) is two levels up in both layouts.
const pkgRoot = resolve(here, '..', '..');

function readIndexHtml(): string {
  return readFileSync(resolve(pkgRoot, 'web/agent-frame/index.html'), 'utf8');
}

function readBundle(): string {
  return readFileSync(resolve(pkgRoot, 'public/agent-frame.js'), 'utf8');
}

export function createAgentFrameRoute(_config: Config): Hono {
  const app = new Hono();

  // Read once at startup; the bundle is a build artifact and does not change at
  // runtime. If either file is missing the build step was skipped.
  const indexHtml = readIndexHtml();

  app.get('/meetings/agent-frame/:id', (c) => c.html(indexHtml));

  app.get('/agent-frame.js', (c) => {
    const bundle = readBundle();
    return c.body(bundle, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}
