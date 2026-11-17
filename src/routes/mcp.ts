// POST /mcp: the MCP endpoint (streamable HTTP, stateless, JSON responses).
//
// Any MCP client can call the meeting tools here. Every call needs the owner bearer
// token; without it the reply is 401 and no tool list. The cookie credential is not
// accepted: this endpoint is for agents, not the browser panel.
// Stateless means one JSON-RPC exchange per POST and no session id, so GET (the
// server-to-client stream) and DELETE (end session) are 405.

import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Config } from '../config.js';
import { isOwnerToken } from '../auth/owner.js';
import { extractBearerToken } from './session-token.js';
import { createMcpServer } from '../mcp/server.js';
import type { McpToolOptions } from '../mcp/tools.js';

export function createMcpRoute(config: Config, options: McpToolOptions = {}): Hono {
  const app = new Hono();

  app.post('/mcp', async (c) => {
    const bearer = extractBearerToken(c.req.header('authorization'));
    if (bearer === undefined || !isOwnerToken(config, bearer)) {
      return c.json({ error: 'owner bearer token required', code: 'OWNER_REQUIRED' }, 401);
    }
    const server = createMcpServer(config, options);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.on(['GET', 'DELETE'], '/mcp', (c) => {
    c.header('Allow', 'POST');
    return c.json({ error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
  });

  return app;
}
