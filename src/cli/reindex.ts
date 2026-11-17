// `jarvis-meeting reindex` — trigger a knowledge-backend reindex for a teammate.
//
// Folder backends index from disk, so they expose a /reindex endpoint we POST to
// (derived from the /search base). OpenBrain backends index live (continuous
// ingest), so there is nothing to trigger — we say so and no-op. Best-effort:
// never throws, short timeout.

import { loadSoul } from '../soul/loader.js';

const REINDEX_TIMEOUT_MS = 5000;

export interface ReindexResult {
  ok: boolean;
  message: string;
}

export async function reindex(teammate: string, soulDir: string): Promise<ReindexResult> {
  let soul;
  try {
    soul = loadSoul(teammate, soulDir);
  } catch (err) {
    return { ok: false, message: `SOUL load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (soul.knowledgeBackend.type !== 'folder') {
    return { ok: true, message: `backend type "${soul.knowledgeBackend.type}" indexes live — nothing to reindex` };
  }

  const endpoint = soul.knowledgeBackend.endpoint.replace(/\/+$/, '');
  if (endpoint === '') {
    return { ok: false, message: 'folder backend has no endpoint to POST /reindex to' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REINDEX_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint}/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    return res.ok
      ? { ok: true, message: `reindex triggered at ${endpoint}/reindex (${res.status})` }
      : { ok: false, message: `${endpoint}/reindex returned ${res.status}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, message: aborted ? 'reindex timed out' : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
