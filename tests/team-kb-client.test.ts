import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTeamKbClient } from '../src/retrieval/team-kb-client.js';
import type { Config } from '../src/config.js';

const BASE_CONFIG: Config = {
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
  jarvisApiToken: 'tok',
  webhookSecret: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('team-kb-client lane selection', () => {
  it('uses local fallback when endpoint+token are not set', async () => {
    let calledUrl = '';
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calledUrl = input.toString();
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    const client = createTeamKbClient(BASE_CONFIG);
    await client.retrieve('test query');
    expect(calledUrl).toBe('http://localhost:3031/search');
  });

  it('uses hosted endpoint when both endpoint and token are set', async () => {
    let calledUrl = '';
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calledUrl = input.toString();
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });

    const config: Config = {
      ...BASE_CONFIG,
      teamKbAnswerEndpoint: 'https://kb.example.com',
      teamKbAnswerApiToken: 'secret',
    };
    const client = createTeamKbClient(config);
    await client.retrieve('test query');
    expect(calledUrl).toBe('https://kb.example.com/v1/kb/retrieve');
  });

  it('returns empty results on fetch error (graceful degrade)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network error');
    });

    const client = createTeamKbClient(BASE_CONFIG);
    const response = await client.retrieve('test query');
    expect(response.results).toEqual([]);
  });

  it('normalizes hosted hits into results shape', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          hits: [{ snippet: 'hello world', path: 'docs/foo.md', score: 0.9 }],
        }),
        { status: 200 },
      ),
    );

    const config: Config = {
      ...BASE_CONFIG,
      teamKbAnswerEndpoint: 'https://kb.example.com',
      teamKbAnswerApiToken: 'secret',
    };
    const client = createTeamKbClient(config);
    const response = await client.retrieve('foo');
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toEqual({ text: 'hello world', source: 'docs/foo.md', score: 0.9 });
  });
});
