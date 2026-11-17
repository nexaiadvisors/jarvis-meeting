// `jarvis-meeting doctor --connector <endpoint>` — conformance verifier for a
// second-brain connector (the contract in docs/CONNECTOR.md).
//
// This is the linchpin that makes a teammate's agent-written adapter trustworthy:
// point it at any connector and it proves the wire contract holds before a SOUL
// ever depends on it. It POSTs known queries + an optional /store round-trip and
// checks: /healthz, the /search response SHAPE, the ~800ms LATENCY budget,
// empty-query handling, and a "no obvious personal markers" safety smoke.
//
// Design mirrors checks.ts: the POLICY is a set of PURE functions
// (validateSearchShape / latencyVerdict / emptyQueryVerdict / scanPersonalMarkers)
// kept separate from the fetch wrappers, so the verdicts are unit-testable
// without a live connector. Each Check never throws (runChecks catches anyway).

import type { Check, CheckStatus } from './checks.js';

/** The agent's per-/search AbortController budget (knowledge-client.ts TIMEOUT_MS). */
export const SEARCH_BUDGET_MS = 800;
/** Within budget but slow enough to warn (target is < 300ms warm). */
export const WARN_LATENCY_MS = 500;
/** Probe timeout: > budget so a slow-but-finite connector is MEASURED (and FAILs latency) rather than hanging. */
const PROBE_TIMEOUT_MS = 5000;

export interface ConnectorCheckOptions {
  /** Run the /store round-trip (default true). Set false for read-only brains. */
  store?: boolean;
  /** Primary benign probe query. */
  query?: string;
  /** Result cap to request. */
  k?: number;
}

// --------------------------------------------------------------------------
// Pure policy functions (independently testable)
// --------------------------------------------------------------------------

export interface ShapeVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Validate a /search response body against the contract:
 * { results: [{ text|content: string, source|path: string, score: number }] }
 * ordered list, length <= k.
 */
export function validateSearchShape(body: unknown, k: number): ShapeVerdict {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'response body is not a JSON object' };
  }
  const results = (body as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) {
    return { ok: false, reason: 'missing results[] array' };
  }
  if (results.length > k) {
    return { ok: false, reason: `returned ${results.length} results > requested k=${k}` };
  }
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (typeof r !== 'object' || r === null) {
      return { ok: false, reason: `results[${i}] is not an object` };
    }
    const rr = r as Record<string, unknown>;
    const text = typeof rr['text'] === 'string' ? rr['text'] : rr['content'];
    const source = typeof rr['source'] === 'string' ? rr['source'] : rr['path'];
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: `results[${i}].text (or .content) missing / not a non-empty string` };
    }
    if (typeof source !== 'string') {
      return { ok: false, reason: `results[${i}].source (or .path) missing / not a string` };
    }
    if (typeof rr['score'] !== 'number') {
      return { ok: false, reason: `results[${i}].score missing / not a number` };
    }
  }
  return { ok: true, reason: `${results.length} result(s), each {text, source, score}` };
}

export function latencyVerdict(ms: number, budget = SEARCH_BUDGET_MS): { status: CheckStatus; message: string } {
  if (ms >= budget) {
    return { status: 'FAIL', message: `${ms}ms >= ${budget}ms budget (agent abandons the lane at ${budget}ms)` };
  }
  if (ms >= WARN_LATENCY_MS) {
    return { status: 'WARN', message: `${ms}ms — within ${budget}ms budget but slow (target < 300ms warm)` };
  }
  return { status: 'PASS', message: `${ms}ms (budget ${budget}ms)` };
}

export function emptyQueryVerdict(status: number, body: unknown): { status: CheckStatus; message: string } {
  if (status === 400) {
    return { status: 'PASS', message: 'empty query -> 400 BAD_REQUEST' };
  }
  if (status === 200) {
    const results =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['results'] : undefined;
    if (Array.isArray(results) && results.length === 0) {
      return { status: 'WARN', message: 'empty query -> 200 with empty results (contract prefers 400)' };
    }
    return { status: 'FAIL', message: 'empty query -> 200 with results (must reject empty input)' };
  }
  return { status: 'WARN', message: `empty query -> ${status} (contract expects 400)` };
}

/** Secrets / hard PII that must NEVER appear in meeting results -> FAIL. */
const HARD_MARKERS: { re: RegExp; label: string }[] = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN-like number' },
  { re: /\b(?:password|passwd|api[_-]?key|secret[_-]?key|private[_-]?key)\s*[:=]/i, label: 'secret/credential' },
];
/** Soft personal-life markers -> WARN (heuristic; avoid false-positive FAILs on legit work text). */
const PERSONAL_MARKERS: { re: RegExp; label: string }[] = [
  { re: /\bcustody\b/i, label: 'custody' },
  { re: /\bdivorce\b/i, label: 'divorce' },
  { re: /\bdiagnosed with\b/i, label: 'medical diagnosis' }, // medical phrasing only — "root-cause diagnosis" is work
  { re: /\bprescription\b/i, label: 'prescription' },
  { re: /\beviction\b/i, label: 'eviction' },
];

/**
 * Smoke-scan combined result text+source for content that should never surface
 * in a work meeting. Hard markers (secrets, SSN) -> FAIL; soft personal-life
 * markers -> WARN; otherwise PASS. A heuristic, not a guarantee — real scoping
 * is the connector's job (see CONNECTOR.md "Safety").
 */
export function scanPersonalMarkers(texts: string[]): { status: CheckStatus; message: string } {
  const blob = texts.join('\n');
  const hard = HARD_MARKERS.filter((m) => m.re.test(blob)).map((m) => m.label);
  if (hard.length > 0) {
    return { status: 'FAIL', message: `secret/PII leaked into results: ${hard.join(', ')}` };
  }
  const soft = PERSONAL_MARKERS.filter((m) => m.re.test(blob)).map((m) => m.label);
  if (soft.length > 0) {
    return { status: 'WARN', message: `possible personal-life markers in results: ${soft.join(', ')} (verify scoping)` };
  }
  return { status: 'PASS', message: 'no obvious secret or personal-life markers in sampled results' };
}

// --------------------------------------------------------------------------
// Fetch wrappers
// --------------------------------------------------------------------------

interface Probe {
  res: Response;
  ms: number;
}

async function probe(url: string, init: RequestInit, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, ms: Date.now() - t0 };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function postSearch(base: string, query: string, k: number): Promise<Probe | undefined> {
  return probe(`${base}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, k }),
  });
}

async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Collect result text+source strings from a /search body for the marker smoke. */
function textsFromSearchBody(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const results = (body as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  for (const r of results) {
    if (typeof r !== 'object' || r === null) continue;
    const rr = r as Record<string, unknown>;
    if (typeof rr['text'] === 'string') out.push(rr['text']);
    if (typeof rr['content'] === 'string') out.push(rr['content']);
    if (typeof rr['source'] === 'string') out.push(rr['source']);
    if (typeof rr['path'] === 'string') out.push(rr['path']);
  }
  return out;
}

// --------------------------------------------------------------------------
// Check list
// --------------------------------------------------------------------------

export function buildConnectorChecks(endpoint: string, opts: ConnectorCheckOptions = {}): Check[] {
  const base = endpoint.replace(/\/+$/, '');
  const query = opts.query ?? 'project status and recent decisions';
  const k = opts.k ?? 5;
  const runStore = opts.store !== false;

  return [
    {
      name: 'healthz',
      run: async () => {
        const p = await probe(`${base}/healthz`, { method: 'GET' });
        if (p === undefined) return { status: 'FAIL', message: `unreachable: GET ${base}/healthz` };
        if (!p.res.ok) return { status: 'FAIL', message: `GET /healthz returned ${p.res.status}` };
        const body = await jsonOf(p.res);
        const ok = typeof body === 'object' && body !== null && (body as Record<string, unknown>)['ok'] === true;
        return ok
          ? { status: 'PASS', message: `/healthz ok (${p.ms}ms)` }
          : { status: 'WARN', message: '/healthz 200 but body missing {ok:true}' };
      },
    },
    {
      name: 'search-shape',
      run: async () => {
        const p = await postSearch(base, query, k);
        if (p === undefined) return { status: 'FAIL', message: `no response from POST ${base}/search` };
        if (!p.res.ok) return { status: 'FAIL', message: `/search returned ${p.res.status}` };
        const body = await jsonOf(p.res);
        const v = validateSearchShape(body, k);
        return v.ok ? { status: 'PASS', message: v.reason } : { status: 'FAIL', message: v.reason };
      },
    },
    {
      name: 'search-latency',
      run: async () => {
        // Warm once (untimed) so the verdict reflects warm-path latency, then time it.
        await postSearch(base, query, k);
        const p = await postSearch(base, query, k);
        if (p === undefined) return { status: 'FAIL', message: `no response within ${PROBE_TIMEOUT_MS}ms` };
        if (!p.res.ok) return { status: 'FAIL', message: `/search returned ${p.res.status}` };
        return latencyVerdict(p.ms);
      },
    },
    {
      name: 'empty-query',
      run: async () => {
        const p = await postSearch(base, '', k);
        if (p === undefined) return { status: 'FAIL', message: 'no response to empty-query probe' };
        const body = p.res.status === 200 ? await jsonOf(p.res) : undefined;
        return emptyQueryVerdict(p.res.status, body);
      },
    },
    {
      name: 'personal-markers',
      run: async () => {
        const probes = [query, 'what are the latest priorities and plans'];
        const texts: string[] = [];
        for (const q of probes) {
          const p = await postSearch(base, q, k);
          if (p && p.res.ok) texts.push(...textsFromSearchBody(await jsonOf(p.res)));
        }
        if (texts.length === 0) {
          return { status: 'WARN', message: 'no results to smoke-scan (empty brain or /search down)' };
        }
        return scanPersonalMarkers(texts);
      },
    },
    ...(runStore
      ? [
          {
            name: 'store-roundtrip',
            run: async () => {
              const token = `connector-conformance-${Date.now()}`;
              const p = await probe(`${base}/store`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  namespace: 'second-brain',
                  doc_type: 'meeting-transcript',
                  entity_key: token,
                  content: `# Conformance store probe\nSentinel token ${token} written by jarvis-meeting doctor.`,
                }),
              });
              if (p === undefined) return { status: 'FAIL', message: `no response from POST ${base}/store` };
              const body = await jsonOf(p.res);
              const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
              if (p.res.ok && rec['ok'] === true) {
                return { status: 'PASS', message: `/store accepted (${p.ms}ms)` };
              }
              if (p.res.ok && (rec['skipped'] === true || rec['ok'] === false)) {
                return { status: 'WARN', message: '/store is a no-op (read-only brain) — transcripts will not be ingested' };
              }
              return { status: 'FAIL', message: `/store returned ${p.res.status} ${JSON.stringify(rec).slice(0, 80)}` };
            },
          } satisfies Check,
        ]
      : []),
  ];
}
