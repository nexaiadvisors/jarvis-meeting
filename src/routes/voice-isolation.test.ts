// E2E isolation probe (plan §16):
// prove teammate A's session can NEVER read teammate B's brain through the FULL
// voice route — request -> meeting registry -> SOUL load -> owner gate ->
// knowledge-client -> real HTTP /search.
//
// Unlike voice.test.ts (which mocks global.fetch), this file stands up two REAL
// node:http stub brains with distinct corpora and distinct ports, so the
// assertion "B's endpoint received zero requests" is physical, not mocked:
//   (a) A's delegate retrieval only ever hits A's endpoint;
//   (b) a request whose teammate does not match the SOUL owner is denied
//       fail-closed (403 DELEGATE_OWNER_REQUIRED) BEFORE any backend I/O;
//   (c) a probe query that only matches B's corpus returns nothing for A —
//       and a control query proves B's brain WOULD have answered it.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceRoutes } from './voice.js';
import { registerMeeting, __clearRegistry } from '../meeting/registry.js';
import { sessionHeader } from '../../tests/helpers/session.js';
import type { Config } from '../config.js';

interface StubHit {
  text: string;
  /** kb-server shape: `<namespace>/<doc_type>/<entity_key>` (the delegate route filters on it). */
  source: string;
  score: number;
}

interface StubBrain {
  server: Server;
  endpoint: string;
  /** Every POST the brain received, in order (with the Authorization header it carried, or null). */
  requests: Array<{ path: string; query: string; authorization: string | null }>;
  close: () => Promise<void>;
}

/** Start a real HTTP /search stub whose corpus is defined by `answer(query)`. */
async function startStubBrain(answer: (query: string) => StubHit[]): Promise<StubBrain> {
  const requests: Array<{ path: string; query: string; authorization: string | null }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let query = '';
      try {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        if (typeof parsed['query'] === 'string') query = parsed['query'];
      } catch {
        // keep query = ''
      }
      requests.push({ path: req.url ?? '', query, authorization: req.headers['authorization'] ?? null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: answer(query) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    server,
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeConfig(soulDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    recallApiKey: 'k',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600000,
    maxDurationMs: 7200000,
    sweepIntervalMs: 60000,
    publicBaseUrl: 'https://ngrok.example.com',
    teamKbAnswerEndpoint: undefined,
    teamKbAnswerApiToken: undefined,
    teamKbFallbackUrl: 'http://localhost:3031',
    jarvisBotName: 'Jarvis',
    jarvisApiToken: undefined,
    webhookSecret: undefined,
    ownerToken: undefined,
    tokenRegistry: new Map<string, string>(),
    soulDir,
    teamKbEndpoint: undefined,
    defaultTeammate: 'example',
    azureStorageAccountName: undefined,
    azureStorageAccountKey: undefined,
    azureStorageBlobContainer: undefined,
    artifactSasTtlHours: 168,
    anthropicApiKey: undefined,
    anthropicModel: 'claude-sonnet-4-6',
    graphTenantId: undefined,
    graphClientId: undefined,
    graphClientSecret: undefined,
    meetingEmailSender: undefined,
    meetingEmailDefaultRecipients: [],
    kbBackendToken: undefined,
    kbBackendHealthUrl: undefined,
    workScopeNamespaces: [],
    ...overrides,
  };
}

function delegateSoul(owner: string, endpoint: string): string {
  return `---
owner: ${owner}
name: Delegate
persona_mode: first_person
knowledge_backend:
  type: openbrain
  endpoint: ${endpoint}
---
Delegate for ${owner}.`;
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Session header for one of the meetings registered in beforeEach. */
function auth(meetingId: string, teammate: string): Record<string, string> {
  return sessionHeader(makeConfig(dir), meetingId, teammate);
}

let dir: string;
let aliceBrain: StubBrain;
let bobBrain: StubBrain;
let app: Hono;

const BOB_ONLY_PROBE = 'bob-secret-probe q3 numbers';

beforeAll(async () => {
  // Alice's brain answers only her own topics.
  aliceBrain = await startStubBrain((query) =>
    query.includes('alpha')
      ? [{ text: 'alpha roadmap: ship in Q3', source: 'second-brain/work-output/alice-doc-1', score: 0.9 }]
      : [],
  );
  // Bob's brain holds the secret the probe query targets.
  bobBrain = await startStubBrain((query) =>
    query.includes('bob-secret-probe')
      ? [{ text: 'bob secret: q3 numbers are 42', source: 'second-brain/work-output/bob-secret-1', score: 0.95 }]
      : [],
  );

  dir = mkdtempSync(join(tmpdir(), 'voice-isolation-soul-'));
  writeFileSync(join(dir, 'alice.md'), delegateSoul('alice', aliceBrain.endpoint), 'utf8');
  writeFileSync(join(dir, 'bob.md'), delegateSoul('bob', bobBrain.endpoint), 'utf8');
  // Mis-provisioned SOUL: mallory carries a copy of ALICE's SOUL (owner: alice,
  // alice's endpoint). The owner gate must refuse it for teammate mallory.
  writeFileSync(join(dir, 'mallory.md'), delegateSoul('alice', aliceBrain.endpoint), 'utf8');
  // Ownerless first_person SOUL (no `owner` key at all -> schema default ''):
  // must fail closed at the gate, not at load.
  writeFileSync(
    join(dir, 'noowner.md'),
    `---
name: Delegate
persona_mode: first_person
knowledge_backend:
  type: openbrain
  endpoint: ${bobBrain.endpoint}
---
Ownerless delegate.`,
    'utf8',
  );

  app = new Hono();
  app.route('/', createVoiceRoutes(makeConfig(dir)));
});

afterAll(async () => {
  await aliceBrain.close();
  await bobBrain.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __clearRegistry();
  aliceBrain.requests.length = 0;
  bobBrain.requests.length = 0;
  registerMeeting({ meetingId: 'm-alice', teammate: 'alice', persona: 'first_person', title: 'A' });
  registerMeeting({ meetingId: 'm-bob', teammate: 'bob', persona: 'first_person', title: 'B' });
  registerMeeting({ meetingId: 'm-mallory', teammate: 'mallory', persona: 'first_person', title: 'M' });
  registerMeeting({ meetingId: 'm-noowner', teammate: 'noowner', persona: 'first_person', title: 'N' });
});

describe('voice route isolation probe (plan §16)', () => {
  it("(a) alice's delegate retrieval hits ONLY alice's endpoint", async () => {
    const res = await post(app, '/api/voice/ob-search', {
      meetingId: 'm-alice',
      query: 'alpha roadmap status',
    }, auth('m-alice', 'alice'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['count']).toBe(1);
    const results = body['results'] as Array<Record<string, unknown>>;
    expect(results[0]?.['source']).toBe('second-brain/work-output/alice-doc-1');

    expect(aliceBrain.requests.length).toBe(1);
    expect(aliceBrain.requests[0]?.path).toBe('/search');
    // The physical isolation guarantee: bob's brain saw NO traffic.
    expect(bobBrain.requests.length).toBe(0);
  });

  it("(c) a probe that only matches bob's corpus returns nothing for alice — bob's brain untouched", async () => {
    const res = await post(app, '/api/voice/ob-search', {
      meetingId: 'm-alice',
      query: BOB_ONLY_PROBE,
    }, auth('m-alice', 'alice'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['count']).toBe(0);
    expect(body['results']).toEqual([]);
    const lanes = body['lanes'] as Record<string, { status: string; ms: number }>;
    expect(lanes['openbrain']?.status).toBe('empty'); // alice's own brain: no match
    expect(lanes['teamKb']).toEqual({ status: 'empty', ms: 0 }); // no team KB configured, never queried
    expect(body['lane_statuses']).toEqual({ openbrain: 'empty', teamKb: 'empty' });

    // Bob's brain was never consulted, even though it holds the answer.
    expect(bobBrain.requests.length).toBe(0);

    // Control: prove the emptiness above is ISOLATION, not a vacuous stub —
    // the same probe posted directly to bob's own brain DOES match.
    const control = await fetch(`${bobBrain.endpoint}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: BOB_ONLY_PROBE, k: 6 }),
    });
    const controlBody = (await control.json()) as { results: StubHit[] };
    expect(controlBody.results).toHaveLength(1);
    expect(controlBody.results[0]?.source).toBe('second-brain/work-output/bob-secret-1');
  });

  it('(b) teammate != SOUL owner is denied fail-closed before any backend I/O', async () => {
    const res = await post(app, '/api/voice/ob-search', {
      meetingId: 'm-mallory',
      query: 'alpha roadmap status',
    }, auth('m-mallory', 'mallory'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('DELEGATE_OWNER_REQUIRED');
    expect(body['results']).toEqual([]);

    // Denied BEFORE retrieval: neither brain saw a single request.
    expect(aliceBrain.requests.length).toBe(0);
    expect(bobBrain.requests.length).toBe(0);
  });

  it('(b) an ownerless first_person SOUL is denied fail-closed', async () => {
    const res = await post(app, '/api/voice/ob-search', {
      meetingId: 'm-noowner',
      query: 'anything at all',
    }, auth('m-noowner', 'noowner'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('DELEGATE_OWNER_REQUIRED');
    expect(bobBrain.requests.length).toBe(0);
  });

  it('(b) ob-context enforces the same owner gate', async () => {
    const res = await post(app, '/api/voice/ob-context', {
      meetingId: 'm-mallory',
      query: 'alpha roadmap status',
    }, auth('m-mallory', 'mallory'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('DELEGATE_OWNER_REQUIRED');
    expect(aliceBrain.requests.length).toBe(0);
    expect(bobBrain.requests.length).toBe(0);
  });

  it("sanity: bob's own session retrieves from bob's brain (isolation is per-teammate, not a dead lane)", async () => {
    const res = await post(app, '/api/voice/ob-search', {
      meetingId: 'm-bob',
      query: BOB_ONLY_PROBE,
    }, auth('m-bob', 'bob'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['count']).toBe(1);
    const results = body['results'] as Array<Record<string, unknown>>;
    expect(results[0]?.['source']).toBe('second-brain/work-output/bob-secret-1');
    expect(bobBrain.requests.length).toBe(1);
    expect(aliceBrain.requests.length).toBe(0);
  });
});

describe('kb-server bearer isolation (real HTTP stubs)', () => {
  it("the bearer reaches only the kb-server origin: alice's brain gets it, bob's never does", async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // Alice's brain stands in for the work-scoped kb-server; its /healthz origin is the allowed origin.
    const bearerApp = new Hono();
    bearerApp.route(
      '/',
      createVoiceRoutes(
        makeConfig(dir, { kbBackendToken: 'kb-secret', kbBackendHealthUrl: `${aliceBrain.endpoint}/healthz` }),
      ),
    );

    const aliceRes = await post(bearerApp, '/api/voice/ob-search', {
      meetingId: 'm-alice',
      query: 'alpha roadmap status',
    }, auth('m-alice', 'alice'));
    const bobRes = await post(bearerApp, '/api/voice/ob-search', {
      meetingId: 'm-bob',
      query: BOB_ONLY_PROBE,
    }, auth('m-bob', 'bob'));

    log.mockRestore();
    expect(aliceRes.status).toBe(200);
    expect(bobRes.status).toBe(200);
    expect(aliceBrain.requests.map((r) => r.authorization)).toEqual(['Bearer kb-secret']);
    expect(bobBrain.requests.length).toBe(1); // bob's own session did reach bob's brain...
    expect(bobBrain.requests[0]?.authorization).toBeNull(); // ...without David's token
  });
});

describe('voice route session guard (cross-meeting access)', () => {
  it("bob's session token cannot query alice's meeting: 401, and neither brain sees a request", async () => {
    const res = await post(
      app,
      '/api/voice/ob-search',
      { meetingId: 'm-alice', query: BOB_ONLY_PROBE },
      auth('m-bob', 'bob'),
    );
    expect(res.status).toBe(401);
    expect(aliceBrain.requests.length).toBe(0);
    expect(bobBrain.requests.length).toBe(0);
  });

  it('an unauthenticated ob-search and ob-context both 401 before any backend I/O', async () => {
    for (const path of ['/api/voice/ob-search', '/api/voice/ob-context']) {
      const res = await post(app, path, { meetingId: 'm-alice', query: 'alpha roadmap status' });
      expect(res.status).toBe(401);
    }
    expect(aliceBrain.requests.length).toBe(0);
    expect(bobBrain.requests.length).toBe(0);
  });
});
