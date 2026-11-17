// Knowledge lookups through the OpenBrain MCP gateway (KNOWLEDGE_SOURCE=ob-mcp).
//
// The gateway speaks stateless streamable HTTP: one JSON-RPC message per POST, bearer
// auth, and a reply that is either JSON or a one-event SSE stream. This client sends
// `tools/call` for `search_documents` and `get_document` and maps the rows to the shapes
// the voice routes already use. It never throws: a timeout, a refusal or a malformed
// reply degrades to an empty result, like the other lanes.
//
// The bearer is read from OB_MCP_TOKEN_FILE on every call and is never logged. Results
// are NOT filtered here: the voice routes pass every row, with its metadata, through the
// work-scope filter.

import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { LaneStatus, RankedChunk } from './knowledge-client.js';

export const DEFAULT_OB_MCP_URL = 'http://127.0.0.1:7410/mcp';

export interface ObMcpDocument {
  namespace: string;
  doc_type: string;
  entity_key: string;
  content: string;
  /** Document metadata as the gateway returned it; the work-scope filter reads `audience` from it. */
  metadata?: Record<string, unknown>;
}

export interface ObMcpSearchOutcome {
  /** One entry per row, in the gateway's order. `doc` is the whole row, for the work-scope filter. */
  results: (RankedChunk & { doc: ObMcpDocument })[];
  status: LaneStatus;
  ms: number;
}

export type ObMcpDocumentOutcome =
  | { status: 'ok'; document: ObMcpDocument }
  | { status: 'not_found' }
  | { status: 'error' };

type CallOutcome = { status: 'ok'; text: string; isError: boolean } | { status: 'timeout' | 'error' };

function readToken(config: Config): string | undefined {
  if (!config.obMcpTokenFile) return undefined;
  try {
    const token = readFileSync(config.obMcpTokenFile, 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/** The JSON-RPC reply from a JSON body or from the `data:` line of an SSE body. */
function parseRpcBody(contentType: string, body: string): unknown {
  if (!contentType.includes('text/event-stream')) return JSON.parse(body);
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5));
  }
  throw new Error('no data line');
}

/** One `tools/call`. Returns the tool's single text block. */
async function callTool(
  config: Config,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<CallOutcome> {
  const token = readToken(config);
  if (token === undefined) return { status: 'error' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.obMcpUrl ?? DEFAULT_OB_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      // A redirect must never carry the bearer to another host.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'error' };
    const rpc = parseRpcBody(response.headers.get('content-type') ?? '', await response.text()) as {
      result?: { content?: unknown; isError?: unknown };
    };
    const content = rpc.result?.content;
    const block = Array.isArray(content) ? (content[0] as { type?: unknown; text?: unknown } | undefined) : undefined;
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return { status: 'error' };
    return { status: 'ok', text: block.text, isError: rpc.result?.isError === true };
  } catch (err) {
    return { status: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

function asDocument(value: unknown): ObMcpDocument | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v['namespace'] !== 'string' ||
    typeof v['doc_type'] !== 'string' ||
    typeof v['entity_key'] !== 'string' ||
    typeof v['content'] !== 'string'
  ) {
    return undefined;
  }
  const metadata = v['metadata'];
  return {
    namespace: v['namespace'],
    doc_type: v['doc_type'],
    entity_key: v['entity_key'],
    content: v['content'],
    ...(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
  };
}

/** Search OpenBrain through the gateway. Rows without a full natural key are dropped. */
export async function obMcpSearch(
  config: Config,
  query: string,
  k: number,
  timeoutMs: number,
): Promise<ObMcpSearchOutcome> {
  const started = Date.now();
  const done = (results: ObMcpSearchOutcome['results'], status: LaneStatus): ObMcpSearchOutcome => ({
    results,
    status,
    ms: Math.max(0, Date.now() - started),
  });
  const called = await callTool(config, 'search_documents', { query, limit: k }, timeoutMs);
  if (called.status !== 'ok') return done([], called.status);
  if (called.isError) return done([], 'error');
  let rows: unknown;
  try {
    rows = JSON.parse(called.text);
  } catch {
    return done([], 'error');
  }
  if (!Array.isArray(rows)) return done([], 'error');
  const results: ObMcpSearchOutcome['results'] = [];
  for (const row of rows) {
    const doc = asDocument(row);
    if (!doc) continue;
    const similarity = (row as Record<string, unknown>)['similarity'];
    results.push({
      text: doc.content,
      // The work-scope filter classifies a result by this namespace/doc_type/entity_key path.
      source: `${doc.namespace}/${doc.doc_type}/${doc.entity_key}`,
      score: typeof similarity === 'number' && Number.isFinite(similarity) ? similarity : 0,
      doc,
    });
  }
  return done(results, results.length > 0 ? 'ok' : 'empty');
}

/** Read one document by its natural key through the gateway. */
export async function obMcpGetDocument(
  config: Config,
  key: { namespace: string; doc_type: string; entity_key: string },
  timeoutMs: number,
): Promise<ObMcpDocumentOutcome> {
  const called = await callTool(config, 'get_document', key, timeoutMs);
  if (called.status !== 'ok' || called.isError) return { status: 'error' };
  let value: unknown;
  try {
    value = JSON.parse(called.text);
  } catch {
    // The gateway answers a missing document with plain text, not JSON.
    return { status: 'not_found' };
  }
  if (value === null) return { status: 'not_found' };
  const document = asDocument(value);
  return document ? { status: 'ok', document } : { status: 'error' };
}
