// Live artifacts: the docs and whiteboards the bot builds during a meeting.
//
// One JSON file per artifact at <dataDir>/artifacts/<meetingId>/<artifactId>.json.
// Every save carries the version it was based on; a save based on an old version is
// refused (conflict), so two people editing the same artifact cannot silently overwrite
// each other. Files only, no database.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ArtifactKind = 'doc' | 'whiteboard';

export interface Artifact {
  id: string;
  meetingId: string;
  kind: ArtifactKind;
  title: string;
  /**
   * A doc holds markdown. A whiteboard holds Mermaid text until it is first opened,
   * then the Excalidraw scene as JSON ({"type":"excalidraw", "elements":[...]}).
   */
  content: string;
  /** Starts at 1 and goes up by one on every save. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const ARTIFACT_TITLE_MAX_CHARS = 200;
export const ARTIFACT_CONTENT_MAX_CHARS = 500_000;

// Both ids become path segments, so each must be a plain name.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

function defaultDataDir(): string {
  return join(process.cwd(), '.data');
}

function meetingDir(meetingId: string, dataDir: string): string | undefined {
  return SAFE_ID.test(meetingId) ? join(dataDir, 'artifacts', meetingId) : undefined;
}

function artifactFile(meetingId: string, artifactId: string, dataDir: string): string | undefined {
  const dir = meetingDir(meetingId, dataDir);
  return dir !== undefined && SAFE_ID.test(artifactId) ? join(dir, `${artifactId}.json`) : undefined;
}

function asArtifact(value: unknown): Artifact | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v['id'] !== 'string' ||
    typeof v['meetingId'] !== 'string' ||
    (v['kind'] !== 'doc' && v['kind'] !== 'whiteboard') ||
    typeof v['title'] !== 'string' ||
    typeof v['content'] !== 'string' ||
    typeof v['version'] !== 'number' ||
    typeof v['createdAt'] !== 'string' ||
    typeof v['updatedAt'] !== 'string'
  ) {
    return undefined;
  }
  return {
    id: v['id'],
    meetingId: v['meetingId'],
    kind: v['kind'],
    title: v['title'],
    content: v['content'],
    version: v['version'],
    createdAt: v['createdAt'],
    updatedAt: v['updatedAt'],
  };
}

function write(file: string, artifact: Artifact): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(artifact), 'utf8');
  renameSync(tmp, file);
}

/** Create an artifact at version 1. Throws on an invalid meeting id or a failed write. */
export function createArtifact(
  meetingId: string,
  input: { kind: ArtifactKind; title: string; content: string },
  dataDir: string = defaultDataDir(),
): Artifact {
  const dir = meetingDir(meetingId, dataDir);
  if (dir === undefined) throw new Error('invalid meeting id');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const artifact: Artifact = {
    id: randomBytes(8).toString('hex'),
    meetingId,
    kind: input.kind,
    title: input.title.trim().slice(0, ARTIFACT_TITLE_MAX_CHARS) || 'Untitled',
    content: input.content,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  write(join(dir, `${artifact.id}.json`), artifact);
  return artifact;
}

/** Read one artifact. Undefined when it does not exist or the file is not an artifact. Never throws. */
export function getArtifact(
  meetingId: string,
  artifactId: string,
  dataDir: string = defaultDataDir(),
): Artifact | undefined {
  const file = artifactFile(meetingId, artifactId, dataDir);
  if (file === undefined) return undefined;
  try {
    return asArtifact(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** A meeting's artifacts, oldest first. Never throws. */
export function listArtifacts(meetingId: string, dataDir: string = defaultDataDir()): Artifact[] {
  const dir = meetingDir(meetingId, dataDir);
  if (dir === undefined) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Artifact[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const artifact = getArtifact(meetingId, name.slice(0, -'.json'.length), dataDir);
    if (artifact) out.push(artifact);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export type UpdateArtifactResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; code: 'not_found' }
  /** The save was based on an old version. `current` is what is stored now. */
  | { ok: false; code: 'conflict'; current: Artifact };

/**
 * Save new content (and optionally a new title). `baseVersion` is the version the
 * editor loaded; when it is not the stored version the save is refused. Leaving it
 * undefined overwrites whatever is stored (the bot's own updates).
 */
export function updateArtifact(
  meetingId: string,
  artifactId: string,
  change: { content: string; title?: string; baseVersion?: number },
  dataDir: string = defaultDataDir(),
): UpdateArtifactResult {
  const file = artifactFile(meetingId, artifactId, dataDir);
  const current = getArtifact(meetingId, artifactId, dataDir);
  if (file === undefined || current === undefined) return { ok: false, code: 'not_found' };
  if (change.baseVersion !== undefined && change.baseVersion !== current.version) {
    return { ok: false, code: 'conflict', current };
  }
  const artifact: Artifact = {
    ...current,
    content: change.content,
    title:
      change.title !== undefined ? change.title.trim().slice(0, ARTIFACT_TITLE_MAX_CHARS) || current.title : current.title,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  write(file, artifact);
  return { ok: true, artifact };
}
