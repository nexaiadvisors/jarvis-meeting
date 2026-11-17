// SOUL-driven knowledge retrieval client.
//
// Replaces the dashboard's in-process pgvector + fanout with a file-/HTTP-based
// `/search` seam. Two routes, derived from the SOUL:
//
//   - 'jarvis'   (persona_mode 'ai'): query the team-KB /search ONLY.
//                openbrain lane is reported 'empty' (never queried).
//   - 'delegate' (persona_mode 'first_person'): query the SOUL's own knowledge
//                backend first; if it returns < 3 useful results AND a team-KB
//                endpoint is configured, also query the team KB and append (deduped).
//
// Each lane has a per-call AbortController timeout (800ms default) and degrades
// gracefully to an empty result on timeout/error (mirrors team-kb-client.ts), so
// the realtime agent can still answer (just without that lane's knowledge).

import type { Soul } from '../soul/schema.js';

export interface RankedChunk {
  text: string;
  source: string;
  score: number;
  /** Source date (YYYY-MM-DD) when the backend supplies it — used for grounding. */
  date?: string;
  /**
   * Set by the kb-server when the query named a period of time: true when the
   * document is dated inside that period, false when it only mentions it.
   */
  inWindow?: boolean;
}

/** The period of time a query named, as the kb-server resolved it. */
export interface SearchWindow {
  label: string;
  start: string;
  end: string;
}

export type LaneStatus = 'ok' | 'empty' | 'timeout' | 'error';

export interface LaneTiming {
  status: LaneStatus;
  ms: number;
}

export interface RetrieveResult {
  results: RankedChunk[];
  lanes: { openbrain: LaneTiming; teamKb: LaneTiming };
  /** Present when the delegate's own backend resolved a period of time from the query. */
  window?: SearchWindow;
}

export interface RetrieveOptions {
  timeoutMs?: number;
  /**
   * Bearer token for the delegate's OWN knowledge backend (the work-scoped
   * kb-server). Sent only to that lane; the team-KB lane never receives it.
   */
  ownToken?: string;
}

export const DEFAULT_RETRIEVAL_TIMEOUT_MS = 800;
export const FORCED_RETRIEVAL_TIMEOUT_MS = 2500;

/** Minimum useful results from the delegate's own backend before we add teamKb. */
const DELEGATE_THIN_THRESHOLD = 3;

interface LaneOutcome extends LaneTiming {
  results: RankedChunk[];
  window?: SearchWindow;
}

/**
 * POST {query, k} to a /search endpoint and normalize the response. Accepts both
 * {text,...}/{content,...} and {source,...}/{path,...} shapes. Per-call abort.
 * `authToken`, when given, is sent as `Authorization: Bearer <authToken>`.
 * Never throws — returns a status + (possibly empty) results.
 */
async function queryLane(
  endpoint: string,
  query: string,
  k: number,
  timeoutMs: number,
  authToken?: string,
): Promise<LaneOutcome> {
  if (!endpoint || endpoint.trim() === '') {
    return { results: [], status: 'empty', ms: 0 };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ query, k }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { results: [], status: 'error', ms: elapsedMs(started) };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const raw = Array.isArray(data['results']) ? (data['results'] as Array<Record<string, unknown>>) : [];
    const results = raw.map(normalizeChunk);
    const window = parseWindow(data['window']);
    return { results, status: results.length > 0 ? 'ok' : 'empty', ms: elapsedMs(started), ...(window ? { window } : {}) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { results: [], status: aborted ? 'timeout' : 'error', ms: elapsedMs(started) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Base URL of a knowledge backend: the SOUL endpoint with trailing slashes and a
 * trailing `/search` removed, so `<base>/document` and `<base>/store` resolve.
 */
export function backendBaseUrl(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/search$/, '');
}

function elapsedMs(started: number): number {
  return Math.max(0, Date.now() - started);
}

function resolveTimeoutMs(opts?: RetrieveOptions): number {
  const candidate = opts?.timeoutMs;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : DEFAULT_RETRIEVAL_TIMEOUT_MS;
}

function laneTiming(outcome: LaneOutcome): LaneTiming {
  return { status: outcome.status, ms: outcome.ms };
}

function parseWindow(value: unknown): SearchWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { label, start, end } = value as Record<string, unknown>;
  return typeof label === 'string' && typeof start === 'string' && typeof end === 'string'
    ? { label, start, end }
    : undefined;
}

function normalizeChunk(r: Record<string, unknown>): RankedChunk {
  const text = typeof r['text'] === 'string' ? r['text'] : typeof r['content'] === 'string' ? r['content'] : '';
  const source =
    typeof r['source'] === 'string' ? r['source'] : typeof r['path'] === 'string' ? r['path'] : '';
  const score = typeof r['score'] === 'number' ? r['score'] : 0;
  // Accept date | created_at | updated_at; normalize to YYYY-MM-DD for grounding.
  const rawDate = r['date'] ?? r['created_at'] ?? r['updated_at'];
  const date = typeof rawDate === 'string' && rawDate.length >= 10 ? rawDate.slice(0, 10) : undefined;
  const inWindow = typeof r['in_window'] === 'boolean' ? r['in_window'] : undefined;
  return { text, source, score, ...(date ? { date } : {}), ...(inWindow !== undefined ? { inWindow } : {}) };
}

/** De-dupe by (source + text) preserving the first occurrence. */
function dedupe(chunks: RankedChunk[]): RankedChunk[] {
  const seen = new Set<string>();
  const out: RankedChunk[] = [];
  for (const c of chunks) {
    const key = `${c.source}::${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Normalize a lane's scores so its top result is 1.0. Downstream relevance
 * gating (MIN_RELEVANCE_SCORE in realtime-config.ts) is backend-agnostic this
 * way: BM25 folder-connector scores (~0.3-8), kb-server RRF scores (~0.01),
 * and the kb-server temporal lane (=1) all reach the page on one 0..1 scale.
 * No-op when the lane has no positive score.
 */
function normalizeLaneScores(results: RankedChunk[]): RankedChunk[] {
  const max = results.reduce((m, r) => (r.score > m ? r.score : m), 0);
  if (max <= 0) return results;
  return results.map((r) => ({ ...r, score: r.score / max }));
}

/**
 * Retrieve knowledge for a SOUL. Route is taken from soul.knowledgeBackend.route.
 */
export async function retrieveForSoul(
  soul: Soul,
  query: string,
  k: number,
  teamKbEndpoint?: string,
  opts?: RetrieveOptions,
): Promise<RetrieveResult> {
  const route = soul.knowledgeBackend.route;
  const timeoutMs = resolveTimeoutMs(opts);

  if (route === 'jarvis') {
    // Team KB only. OpenBrain lane is never queried.
    const teamKb = await queryLane(teamKbEndpoint ?? '', query, k, timeoutMs);
    return {
      results: normalizeLaneScores(teamKb.results).slice(0, k),
      lanes: { openbrain: { status: 'empty', ms: 0 }, teamKb: laneTiming(teamKb) },
    };
  }

  // Delegate: own backend first, with the bearer. The team-KB lane below is a
  // different service and is never given it.
  const own = await queryLane(soul.knowledgeBackend.endpoint, query, k, timeoutMs, opts?.ownToken);
  const ownNormalized = normalizeLaneScores(own.results);
  let merged = ownNormalized;
  let teamKb: LaneOutcome = { results: [], status: 'empty', ms: 0 };

  if (own.results.length < DELEGATE_THIN_THRESHOLD && teamKbEndpoint && teamKbEndpoint.trim() !== '') {
    teamKb = await queryLane(teamKbEndpoint, query, k, timeoutMs);
    merged = dedupe([...ownNormalized, ...normalizeLaneScores(teamKb.results)]);
  }

  return {
    results: merged.slice(0, k),
    lanes: { openbrain: laneTiming(own), teamKb: laneTiming(teamKb) },
    ...(own.window ? { window: own.window } : {}),
  };
}
