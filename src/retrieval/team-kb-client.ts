// Company-knowledge retrieval client.
//
// Two lanes, selected at startup based on config:
//   1. Hosted team-KB answer path (TEAM_KB_ANSWER_ENDPOINT + token set)
//      POST {endpoint}/v1/kb/retrieve  with Bearer auth
//   2. Local team-kb-retrieval fallback  (TEAM_KB_FALLBACK_URL, default :3031)
//      POST {fallbackUrl}/search
//
// Either lane degrades gracefully to an empty result on timeout or error so
// the realtime agent can still respond (just without company knowledge).

import type { Config } from '../config.js';

export interface RetrievalResult {
  text: string;
  source: string;
  score: number;
}

export interface RetrievalResponse {
  results: RetrievalResult[];
}

const TIMEOUT_MS = 800;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`retrieval timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export function createTeamKbClient(config: Config) {
  const useHosted =
    config.teamKbAnswerEndpoint !== undefined &&
    config.teamKbAnswerApiToken !== undefined;

  if (useHosted) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'team-kb-client: using hosted team-KB endpoint',
        endpoint: config.teamKbAnswerEndpoint,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'team-kb-client: using local team-kb-retrieval fallback',
        fallback: config.teamKbFallbackUrl,
      }),
    );
  }

  return {
    async retrieve(query: string): Promise<RetrievalResponse> {
      try {
        if (useHosted) {
          return await withTimeout(hostedRetrieve(query, config), TIMEOUT_MS);
        } else {
          return await withTimeout(fallbackRetrieve(query, config), TIMEOUT_MS);
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'team-kb-client: retrieval failed, returning empty',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return { results: [] };
      }
    },
  };
}

async function hostedRetrieve(query: string, config: Config): Promise<RetrievalResponse> {
  const response = await fetch(`${config.teamKbAnswerEndpoint!}/v1/kb/retrieve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.teamKbAnswerApiToken!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question: query }),
  });

  if (!response.ok) {
    throw new Error(`hosted team KB returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const hits = Array.isArray(data['hits']) ? data['hits'] : [];

  return {
    results: (hits as Array<Record<string, unknown>>).map((h) => ({
      text: typeof h['snippet'] === 'string' ? h['snippet'] : '',
      source: typeof h['path'] === 'string' ? h['path'] : '',
      score: typeof h['score'] === 'number' ? h['score'] : 0,
    })),
  };
}

async function fallbackRetrieve(query: string, config: Config): Promise<RetrievalResponse> {
  const response = await fetch(`${config.teamKbFallbackUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`local team-KB fallback returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const results = Array.isArray(data['results']) ? data['results'] : [];

  return {
    results: (results as Array<Record<string, unknown>>).map((r) => ({
      text: typeof r['text'] === 'string' ? r['text'] : '',
      source: typeof r['source'] === 'string' ? r['source'] : '',
      score: typeof r['score'] === 'number' ? r['score'] : 0,
    })),
  };
}
