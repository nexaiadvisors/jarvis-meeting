import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMcpRoute } from '../routes/mcp.js';
import { connect, makeConfig } from '../../tests/helpers/mcp.js';

describe('docs/MCP.md', () => {
  it('documents exactly the tools the server lists, and no token value', async () => {
    const client = await connect(createMcpRoute(makeConfig()));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const doc = readFileSync(join(process.cwd(), 'docs', 'MCP.md'), 'utf8');
    const documented = [...doc.matchAll(/^### (\S+)$/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(tools);
    // Tokens appear only as env-var names.
    expect(doc).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });
});
