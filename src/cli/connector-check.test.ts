import { describe, it, expect, vi, afterEach } from 'vitest';
import { runChecks, exitCodeFor } from './checks.js';
import {
  buildConnectorChecks,
  validateSearchShape,
  latencyVerdict,
  emptyQueryVerdict,
  scanPersonalMarkers,
  SEARCH_BUDGET_MS,
} from './connector-check.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// Pure policy functions
// --------------------------------------------------------------------------

describe('validateSearchShape', () => {
  it('accepts the canonical shape and the content/path aliases', () => {
    expect(validateSearchShape({ results: [{ text: 'a', source: 's', score: 0.1 }] }, 5).ok).toBe(true);
    expect(validateSearchShape({ results: [{ content: 'a', path: 'p', score: 0 }] }, 5).ok).toBe(true);
    expect(validateSearchShape({ results: [] }, 5).ok).toBe(true); // empty is valid
  });

  it('rejects non-object, missing array, over-k, and per-field violations', () => {
    expect(validateSearchShape(null, 5)).toMatchObject({ ok: false });
    expect(validateSearchShape({ results: 'nope' }, 5).reason).toMatch(/results\[\] array/);
    expect(validateSearchShape({ results: [{ text: 'a', source: 's', score: 0 }, { text: 'b', source: 's', score: 0 }] }, 1).reason).toMatch(/> requested k=1/);
    expect(validateSearchShape({ results: [{ source: 's', score: 0 }] }, 5).reason).toMatch(/text/);
    expect(validateSearchShape({ results: [{ text: 'a', score: 0 }] }, 5).reason).toMatch(/source/);
    expect(validateSearchShape({ results: [{ text: 'a', source: 's' }] }, 5).reason).toMatch(/score/);
    expect(validateSearchShape({ results: [{ text: '', source: 's', score: 0 }] }, 5).reason).toMatch(/text/);
  });
});

describe('latencyVerdict', () => {
  it('PASS under WARN threshold, WARN near budget, FAIL at/over budget', () => {
    expect(latencyVerdict(120).status).toBe('PASS');
    expect(latencyVerdict(600).status).toBe('WARN');
    expect(latencyVerdict(SEARCH_BUDGET_MS).status).toBe('FAIL');
    expect(latencyVerdict(2000).status).toBe('FAIL');
  });
});

describe('emptyQueryVerdict', () => {
  it('400 -> PASS, 200+empty -> WARN, 200+results -> FAIL, other -> WARN', () => {
    expect(emptyQueryVerdict(400, undefined).status).toBe('PASS');
    expect(emptyQueryVerdict(200, { results: [] }).status).toBe('WARN');
    expect(emptyQueryVerdict(200, { results: [{ text: 'x' }] }).status).toBe('FAIL');
    expect(emptyQueryVerdict(503, undefined).status).toBe('WARN');
  });
});

describe('scanPersonalMarkers', () => {
  it('PASS on clean work text (incl. engineering "diagnosis")', () => {
    expect(scanPersonalMarkers(['Q3 roadmap and engineering plan', 'plan_BZ-123']).status).toBe('PASS');
    expect(scanPersonalMarkers(['root cause diagnosis of the outage']).status).toBe('PASS');
  });
  it('WARN on soft personal-life markers', () => {
    expect(scanPersonalMarkers(['notes about the eviction hearing']).status).toBe('WARN');
  });
  it('FAIL on secrets / hard PII', () => {
    expect(scanPersonalMarkers(['ssn 123-45-6789 on file']).status).toBe('FAIL');
    expect(scanPersonalMarkers(['api_key: sk-abc123']).status).toBe('FAIL');
  });
});

// --------------------------------------------------------------------------
// Integration: buildConnectorChecks with a mocked fetch
// --------------------------------------------------------------------------

type Handlers = {
  healthz: () => Response;
  search: (body: Record<string, unknown>) => Response;
  store?: (body: Record<string, unknown>) => Response;
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockConnector(h: Handlers): void {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    let body: Record<string, unknown> = {};
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    if (u.endsWith('/healthz')) return h.healthz();
    if (u.endsWith('/search')) return h.search(body);
    if (u.endsWith('/store')) return (h.store ?? (() => json({ ok: true })))(body);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('buildConnectorChecks against a CONFORMING connector', () => {
  it('all checks pass -> exit 0', async () => {
    mockConnector({
      healthz: () => json({ ok: true, indexed_docs: 10 }),
      search: (body) =>
        body['query'] === ''
          ? json({ error: 'empty', code: 'BAD_REQUEST' }, 400)
          : json({ results: [{ text: 'the work plan for Q3', source: 'plan_x', score: 0.42 }] }),
      store: () => json({ ok: true }),
    });

    const results = await runChecks(buildConnectorChecks('http://conn.local:7411'));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));

    expect(byName['healthz']).toBe('PASS');
    expect(byName['search-shape']).toBe('PASS');
    expect(byName['search-latency']).toBe('PASS'); // mock resolves ~instantly
    expect(byName['empty-query']).toBe('PASS');
    expect(byName['personal-markers']).toBe('PASS');
    expect(byName['store-roundtrip']).toBe('PASS');
    expect(exitCodeFor(results)).toBe(0);
  });

  it('read-only /store (ok:false, skipped) -> WARN, still exit 0', async () => {
    mockConnector({
      healthz: () => json({ ok: true }),
      search: (body) =>
        body['query'] === ''
          ? json({ code: 'BAD_REQUEST' }, 400)
          : json({ results: [{ text: 'roadmap', source: 's', score: 1 }] }),
      store: () => json({ ok: false, skipped: true }),
    });
    const results = await runChecks(buildConnectorChecks('http://conn.local:7411'));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName['store-roundtrip']).toBe('WARN');
    expect(exitCodeFor(results)).toBe(0);
  });

  it('--no-store omits the store check entirely', async () => {
    mockConnector({
      healthz: () => json({ ok: true }),
      search: (body) => (body['query'] === '' ? json({}, 400) : json({ results: [] })),
    });
    const results = await runChecks(buildConnectorChecks('http://conn.local:7411', { store: false }));
    expect(results.find((r) => r.name === 'store-roundtrip')).toBeUndefined();
  });
});

describe('buildConnectorChecks against a DELIBERATELY-WRONG stub', () => {
  it('fails with clear reasons -> exit 1', async () => {
    mockConnector({
      healthz: () => new Response('nope', { status: 404 }),
      search: () => json({ hits: ['wrong shape'] }), // no results[] array
      store: () => new Response('err', { status: 500 }),
    });

    const results = await runChecks(buildConnectorChecks('http://bad.local:9999'));
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName['healthz']?.status).toBe('FAIL');
    expect(byName['healthz']?.message).toMatch(/404/);
    expect(byName['search-shape']?.status).toBe('FAIL');
    expect(byName['search-shape']?.message).toMatch(/results\[\] array/);
    expect(byName['store-roundtrip']?.status).toBe('FAIL');
    expect(exitCodeFor(results)).toBe(1);
  });

  it('FAILs latency when /search returns a non-2xx status', async () => {
    mockConnector({
      healthz: () => json({ ok: true }),
      search: () => new Response('unavailable', { status: 503 }),
    });
    const results = await runChecks(buildConnectorChecks('http://bad.local:9999', { store: false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName['search-shape']).toBe('FAIL');
    expect(byName['search-latency']).toBe('FAIL');
    expect(exitCodeFor(results)).toBe(1);
  });
});

describe('buildConnectorChecks against an UNREACHABLE connector', () => {
  it('marks healthz + search FAIL when fetch throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const results = await runChecks(buildConnectorChecks('http://nothing.local:1', { store: false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName['healthz']).toBe('FAIL');
    expect(byName['search-shape']).toBe('FAIL');
    expect(exitCodeFor(results)).toBe(1);
  });
});
