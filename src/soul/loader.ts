// SOUL loader — reads a teammate's SOUL.md from disk, splits YAML front-matter
// from the prose body, validates the front-matter with zod, and maps it to the
// camelCase `Soul` consumed by the routes. No database: the file IS the persona.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { SoulFrontMatter, toSoul, type Soul } from './schema.js';

function resolveDir(soulDir?: string): string {
  if (soulDir && soulDir.trim() !== '') return soulDir;
  const env = process.env['SOUL_DIR'];
  if (env && env.trim() !== '') return env;
  // Portable fallback: <cwd>/soul (matches config.ts's SOUL_DIR default). No
  // machine-absolute path baked in.
  return join(process.cwd(), 'soul');
}

/** SOUL slugs are lowercase letters, digits and hyphens, 1-40 characters. */
const SOUL_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * True when `slug` is safe to use as a SOUL file name. The slug reaches
 * `loadSoul` from request bodies, so it must never carry a path separator, a
 * dot segment or anything outside the pattern.
 */
export function isValidSoulSlug(slug: string): boolean {
  return typeof slug === 'string' && SOUL_SLUG_PATTERN.test(slug);
}

/** Absolute path to a teammate's SOUL.md. */
export function soulPath(teammate: string, soulDir?: string): string {
  return join(resolveDir(soulDir), `${teammate}.md`);
}

/**
 * Split a SOUL.md into [frontMatterYaml, proseBody]. The front-matter is the
 * block between a leading `---` line and the next `---` line. If the file does
 * not start with a `---` fence, there is no front-matter (returns ['', whole]).
 */
function splitFrontMatter(raw: string): [string, string] {
  const normalized = raw.replace(/^﻿/, '');
  const fence = /^---\r?\n/;
  if (!fence.test(normalized)) {
    return ['', normalized];
  }
  const afterOpen = normalized.replace(fence, '');
  const closeMatch = /\r?\n---\r?\n?/.exec(afterOpen);
  if (!closeMatch) {
    // Open fence but no close — treat the whole thing as front-matter.
    return [afterOpen, ''];
  }
  const fm = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return [fm, body];
}

/**
 * Load + validate a teammate SOUL. Throws a clear Error if the slug is invalid
 * (message starts `INVALID_SOUL_SLUG`, thrown before any path is built), the
 * file is missing, or the front-matter fails validation.
 */
export function loadSoul(teammate: string, soulDir?: string): Soul {
  if (!isValidSoulSlug(teammate)) {
    throw new Error(`INVALID_SOUL_SLUG: SOUL slug must match ${SOUL_SLUG_PATTERN.source}`);
  }
  const path = soulPath(teammate, soulDir);
  if (!existsSync(path)) {
    throw new Error(`SOUL not found for teammate "${teammate}" at ${path}`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`failed to read SOUL at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [fmRaw, prose] = splitFrontMatter(raw);
  if (fmRaw.trim() === '') {
    throw new Error(`SOUL at ${path} has no YAML front-matter (expected a leading --- fenced block)`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(fmRaw);
  } catch (err) {
    throw new Error(`SOUL at ${path} has invalid YAML front-matter: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = SoulFrontMatter.safeParse(parsedYaml);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`SOUL at ${path} failed validation: ${issues}`);
  }

  return toSoul(result.data, prose);
}

/** List teammate slugs that have a SOUL.md in the directory (without `.md`). */
export function listSouls(soulDir?: string): string[] {
  const dir = resolveDir(soulDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.slice(0, -'.md'.length))
    .sort();
}
