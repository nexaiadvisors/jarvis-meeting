// Test helpers for the MCP surface: a config, a real MCP client wired straight to a
// Hono app (so tests speak the actual protocol), and a call wrapper.

import type { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from '../../src/config.js';

export const OWNER = 'owner-token-for-tests';

export function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    port: 8790,
    publicBaseUrl: 'https://jarvis.example.com',
    jarvisBotName: 'Jarvis',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: 7_200_000,
    maxConcurrentPerTeammate: 2,
    tokenRegistry: new Map([[OWNER, 'david']]),
    workScopeNamespaces: [],
    ...overrides,
  } as unknown as Config;
}

export async function connect(app: Hono, token: string = OWNER): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://jarvis.test/mcp'), {
    fetch: async (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** Call a tool and parse the JSON in its text block. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: Record<string, any>; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0]!.text), isError: res.isError === true };
}
