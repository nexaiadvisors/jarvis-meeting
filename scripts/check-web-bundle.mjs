#!/usr/bin/env node
// Single source of truth for detecting a stale public/agent-frame.js or
// public/panel.js bundle.
//
// public/agent-frame.js is bundled from web/agent-frame/main.tsx (which also
// pulls in src/agent/**, per web/tsconfig.json's `include`) and public/panel.js
// from web/panel/main.tsx, both by `npm run build:web` (scripts/build-web.mjs).
// They are gitignored, and neither scripts/up.sh nor scripts/join-meeting.sh
// rebuilds them on their own — nothing keeps them in sync with source. This
// check exists so callers can detect a stale/missing bundle and rebuild it
// before serving or dispatching against it.
//
// Usage:
//   node scripts/check-web-bundle.mjs          # exit 0 FRESH / 1 STALE; prints the reason to stderr when stale
//   node scripts/check-web-bundle.mjs --print  # also prints STALE / FRESH to stdout

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.data', 'public']);

/**
 * Recursively find the newest mtimeMs under `dir`, skipping IGNORED_DIRS.
 * Returns -Infinity if the directory has no files (or does not exist).
 */
function newestMtimeMs(dir) {
  let newest = -Infinity;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(full);
      if (sub > newest) newest = sub;
    } else if (entry.isFile()) {
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  }
  return newest;
}

const BUNDLES = ['public/agent-frame.js', 'public/panel.js', 'public/artifact/main.js', 'public/meeting-page.js'];
const SOURCE_DIRS = ['web/agent-frame', 'web/panel', 'web/artifact', 'web/meeting-page', 'src'];

/**
 * Decide whether any bundle under public/ is stale relative to the newest file
 * under web/agent-frame/, web/panel/ and src/.
 *
 * @param {string} root - the jarvis-meeting package root (contains web/, src/, public/).
 * @returns {{ stale: boolean, reason: string }}
 */
export function isBundleStale(root) {
  let newestSource = -Infinity;
  for (const dir of SOURCE_DIRS) {
    const m = newestMtimeMs(resolve(root, dir));
    if (m > newestSource) newestSource = m;
  }

  for (const bundle of BUNDLES) {
    const bundlePath = resolve(root, bundle);
    let bundleStat;
    try {
      bundleStat = statSync(bundlePath);
    } catch {
      return { stale: true, reason: `${bundlePath} is missing — run npm run build:web` };
    }

    if (bundleStat.mtimeMs < newestSource) {
      return {
        stale: true,
        reason:
          `${bundlePath} (mtime ${new Date(bundleStat.mtimeMs).toISOString()}) is older than a ` +
          `source file under web/agent-frame/, web/panel/ or src/ (newest ${new Date(newestSource).toISOString()}) ` +
          '— run npm run build:web',
      };
    }
  }

  return { stale: false, reason: 'public/agent-frame.js and public/panel.js are up to date' };
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');
  const printFlag = process.argv.includes('--print');

  const { stale, reason } = isBundleStale(root);
  if (stale) {
    console.error(reason);
    if (printFlag) console.log('STALE');
    process.exit(1);
  } else {
    if (printFlag) console.log('FRESH');
    process.exit(0);
  }
}
