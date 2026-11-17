import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_RETRIEVAL_TIMEOUT_MS, retrieveForSoul } from './knowledge-client.js';
import type { Soul } from '../soul/schema.js';

function soul(partial: Partial<Soul>): Soul {
  return {
    owner: 'david',
    name: 'Agent',
    wakeWord: 'Jarvis',
    personaMode: 'ai',
    voice: 'marin',
    language: 'en',
    knowledgeBackend: { type: 'openbrain', endpoint: 'http://own.local', route: 'jarvis' },
    delivery: [],
    ingest: false,
    deniedTopics: [],
    aiDisclosure: '',
    prose: '',
    ...partial,
  };
}

function jsonResponse(results: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ results }), { status: 200 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('retrieveForSoul — jarvis route', () => {
  it('queries the team KB ONLY and reports openbrain empty', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(input.toString());
      return jsonResponse([{ text: 'company fact', source: 'kb/doc', score: 1 }]);
    }) as typeof fetch;

    const result = await retrieveForSoul(soul({ personaMode: 'ai', knowledgeBackend: { type: 'openbrain', endpoint: 'http://own.local', route: 'jarvis' } }), 'q', 5, 'http://team-kb.local');

    expect(urls).toEqual(['http://team-kb.local/search']);
    expect(result.lanes.openbrain).toEqual({ status: 'empty', ms: 0 });
    expect(result.lanes.teamKb.status).toBe('ok');
    expect(result.lanes.teamKb.ms).toBeGreaterThanOrEqual(0);
    expect(result.results[0]).toEqual({ text: 'company fact', source: 'kb/doc', score: 1 });
  });

  it('maps {content,path} response shape', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse([{ content: 'body text', path: 'src/x.md', score: 1 }]),
    ) as typeof fetch;
    const result = await retrieveForSoul(soul({}), 'q', 5, 'http://team-kb.local');
    expect(result.results[0]).toEqual({ text: 'body text', source: 'src/x.md', score: 1 });
  });
});

describe('retrieveForSoul — delegate route', () => {
  const delegateSoul = soul({
    personaMode: 'first_person',
    knowledgeBackend: { type: 'openbrain', endpoint: 'http://own.local', route: 'delegate' },
  });

  it('queries own endpoint first; does NOT call the team KB when results are rich', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(input.toString());
      return jsonResponse([
        { text: 'a', source: 's1', score: 1 },
        { text: 'b', source: 's2', score: 1 },
        { text: 'c', source: 's3', score: 1 },
      ]);
    }) as typeof fetch;

    const result = await retrieveForSoul(delegateSoul, 'q', 5, 'http://team-kb.local');
    expect(urls).toEqual(['http://own.local/search']);
    expect(result.lanes.openbrain.status).toBe('ok');
    expect(result.lanes.teamKb).toEqual({ status: 'empty', ms: 0 });
    expect(result.results).toHaveLength(3);
  });

  it('falls back to the team KB when own backend is thin (<3)', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      urls.push(url);
      if (new URL(url).hostname === 'own.local') {
        return jsonResponse([{ text: 'own1', source: 'o1', score: 1 }]);
      }
      return jsonResponse([{ text: 'cx1', source: 'c1', score: 1 }]);
    }) as typeof fetch;

    const result = await retrieveForSoul(delegateSoul, 'q', 5, 'http://team-kb.local');
    expect(urls).toEqual(['http://own.local/search', 'http://team-kb.local/search']);
    expect(result.lanes.openbrain.status).toBe('ok');
    expect(result.lanes.teamKb.status).toBe('ok');
    expect(result.results.map((r) => r.source)).toEqual(['o1', 'c1']);
  });
});

describe('retrieveForSoul — graceful degradation', () => {
  it('reports timeout and empty results when a lane aborts at the default timeout', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_input: string | URL | Request, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }) as typeof fetch;

    const pending = retrieveForSoul(soul({}), 'q', 5, 'http://team-kb.local');
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRIEVAL_TIMEOUT_MS);
    const result = await pending;
    expect(result.lanes.teamKb.status).toBe('timeout');
    expect(result.lanes.teamKb.ms).toBe(DEFAULT_RETRIEVAL_TIMEOUT_MS);
    expect(result.results).toEqual([]);
  });

  it('honors the per-call timeout override', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_input: string | URL | Request, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const pending = retrieveForSoul(soul({}), 'q', 5, 'http://team-kb.local', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.lanes.teamKb.status).toBe('timeout');
    expect(result.lanes.teamKb.ms).toBe(50);
    expect(result.results).toEqual([]);
  });

  it('reports error when a lane returns non-OK', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as typeof fetch;
    const result = await retrieveForSoul(soul({}), 'q', 5, 'http://team-kb.local');
    expect(result.lanes.teamKb.status).toBe('error');
    expect(result.results).toEqual([]);
  });
});

describe('retrieveForSoul — bearer token for the work-scoped kb-server', () => {
  const delegateSoul = soul({
    personaMode: 'first_person',
    knowledgeBackend: { type: 'openbrain', endpoint: 'http://own.local', route: 'delegate' },
  });

  /** Records the Authorization header (or null) per requested URL. */
  function recordAuth(responses: (url: string) => Response): Map<string, string | null> {
    const seen = new Map<string, string | null>();
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const headers = new Headers(init?.headers);
      seen.set(url, headers.get('authorization'));
      return responses(url);
    }) as typeof fetch;
    return seen;
  }

  it('delegate lane sends Authorization: Bearer <ownToken> to /search', async () => {
    const seen = recordAuth(() => jsonResponse([{ text: 'a', source: 's1', score: 1 }]));

    await retrieveForSoul(delegateSoul, 'q', 5, undefined, { ownToken: 'kb-secret' });

    expect(seen.get('http://own.local/search')).toBe('Bearer kb-secret');
  });

  it('delegate lane sends no Authorization header without an ownToken', async () => {
    const seen = recordAuth(() => jsonResponse([{ text: 'a', source: 's1', score: 1 }]));

    await retrieveForSoul(delegateSoul, 'q', 5);
    await retrieveForSoul(delegateSoul, 'q', 5, undefined, { timeoutMs: 500 });

    expect(seen.get('http://own.local/search')).toBeNull();
  });

  it('the team-KB fallback lane never receives the ownToken', async () => {
    const seen = recordAuth((url) =>
      new URL(url).hostname === 'own.local'
        ? jsonResponse([{ text: 'own1', source: 'o1', score: 1 }])
        : jsonResponse([{ text: 'cx1', source: 'c1', score: 1 }]),
    );

    const result = await retrieveForSoul(delegateSoul, 'q', 5, 'http://team-kb.local', { ownToken: 'kb-secret' });

    expect(result.lanes.teamKb.status).toBe('ok');
    expect(seen.get('http://own.local/search')).toBe('Bearer kb-secret');
    expect(seen.get('http://team-kb.local/search')).toBeNull();
  });

  it('the jarvis route (team KB only) never sends the ownToken anywhere', async () => {
    const seen = recordAuth(() => jsonResponse([{ text: 'cx1', source: 'c1', score: 1 }]));

    await retrieveForSoul(soul({}), 'q', 5, 'http://team-kb.local', { ownToken: 'kb-secret' });

    expect([...seen.keys()]).toEqual(['http://team-kb.local/search']);
    expect(seen.get('http://team-kb.local/search')).toBeNull();
  });
});
