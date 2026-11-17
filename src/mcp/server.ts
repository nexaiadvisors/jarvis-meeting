// Builds one MCP server holding every Jarvis meeting tool. The HTTP route makes a
// fresh server per request (stateless mode), so nothing here keeps session state.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { registerTools, type McpToolOptions } from './tools.js';

export function createMcpServer(config: Config, options: McpToolOptions = {}): McpServer {
  const server = new McpServer({ name: 'jarvis-meeting', version: '0.0.1' });
  registerTools(server, config, options);
  return server;
}
