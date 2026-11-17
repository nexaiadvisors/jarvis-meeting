// Zero-infra folder connector — the turnkey default brain for a teammate.
//
// Implements the second-brain connector contract (docs/CONNECTOR.md) over a
// plain folder of .md/.markdown/.txt files, with NO external dependencies:
// no Postgres, no pgvector, no embedding API key. It builds an in-memory BM25
// index from the folder and serves /search + /store + /healthz over node:http.
//
// This is what makes onboarding self-contained: a colleague who has only this
// repo runs `npm run connector` against a folder and immediately has a
// conforming brain — no infra to install.
//
// Trade-off vs the pgvector connectors (openbrain ob-retrieval / kb-retrieval):
// keyword BM25 only, no semantic recall. Fine for a folder of curated work docs;
// upgrade to a vector connector when you outgrow it. The FOLDER is the scope
// boundary — only put work-safe content in it.
//
// The POLICY (tokenize / chunkContent / buildIndex / search) is pure + exported
// for unit tests; the server + filesystem walk are thin wrappers.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const CHUNK_CHARS = 2800;
const MIN_CONTENT_LENGTH = 30;
const INDEXABLE = /\.(md|markdown|txt)$/i;
const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
]);

// --------------------------------------------------------------------------
// Pure indexing + ranking
// --------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Paragraph-boundary chunking; hard-splits a paragraph that alone exceeds the cap. */
export function chunkContent(content: string, cap = CHUNK_CHARS): string[] {
  if (content.length <= cap) return content.trim() === '' ? [] : [content];
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > cap) {
      chunks.push(current);
      current = '';
    }
    if (p.length > cap) {
      for (let i = 0; i < p.length; i += cap) chunks.push(p.slice(i, i + cap));
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface IndexedChunk {
  source: string;
  text: string;
  tf: Map<string, number>;
  len: number;
}

export interface Bm25Index {
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgdl: number;
  docCount: number;
}

export interface SourceDoc {
  source: string;
  content: string;
}

export function buildIndex(docs: SourceDoc[]): Bm25Index {
  const chunks: IndexedChunk[] = [];
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const text of chunkContent(doc.content)) {
      const tokens = tokenize(text);
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      chunks.push({ source: doc.source, text, tf, len: tokens.length });
    }
  }
  const totalLen = chunks.reduce((s, c) => s + c.len, 0);
  return { chunks, df, avgdl: chunks.length > 0 ? totalLen / chunks.length : 0, docCount: chunks.length };
}

export interface RankedChunk {
  text: string;
  source: string;
  score: number;
}

/** BM25 ranking over the in-memory index. Returns up to k best chunks, best-first. */
export function search(index: Bm25Index, query: string, k: number): RankedChunk[] {
  const terms = tokenize(query);
  if (terms.length === 0 || index.chunks.length === 0) return [];
  const N = index.chunks.length;
  const idf = new Map<string, number>();
  for (const t of terms) {
    const dfT = index.df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5)));
  }
  const scored = index.chunks.map((c) => {
    let score = 0;
    for (const t of terms) {
      const f = c.tf.get(t);
      if (!f) continue;
      const denom = f + K1 * (1 - B + (B * c.len) / (index.avgdl || 1));
      score += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / denom);
    }
    return { text: c.text, source: c.source, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// --------------------------------------------------------------------------
// Folder walk + filesystem
// --------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else if (INDEXABLE.test(entry)) out.push(full);
  }
  return out;
}

export async function loadFolder(root: string): Promise<SourceDoc[]> {
  const files = (await walk(root)).sort();
  const docs: SourceDoc[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (content.trim().length < MIN_CONTENT_LENGTH) continue;
    docs.push({ source: relative(root, file), content });
  }
  return docs;
}

/** Filesystem-safe slug for an entity_key used as a filename. */
export function safeSlug(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200) || 'doc';
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

export interface FolderConnectorOptions {
  root: string;
  port?: number;
  host?: string;
}

export async function startFolderConnector(opts: FolderConnectorOptions): Promise<{ close: () => void }> {
  const root = opts.root;
  const port = opts.port ?? 7412;
  const host = opts.host ?? '127.0.0.1';
  await mkdir(root, { recursive: true });
  let index = buildIndex(await loadFolder(root));

  const server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0];
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && url === '/healthz') {
          send(res, 200, { ok: true, indexed_chunks: index.docCount, kb_root: root });
          return;
        }
        if (method === 'POST' && url === '/search') {
          const body = (await readJson(req)) as Record<string, unknown>;
          const queryRaw = body['query'];
          const query = typeof queryRaw === 'string' ? queryRaw : '';
          if (query.trim() === '') {
            send(res, 400, { error: 'query is required', code: 'BAD_REQUEST' });
            return;
          }
          const kRaw = body['k'];
          const k = typeof kRaw === 'number' && kRaw > 0 ? Math.min(50, Math.floor(kRaw)) : 8;
          send(res, 200, { results: search(index, query, k), mode: 'bm25' });
          return;
        }
        if (method === 'POST' && url === '/store') {
          const body = (await readJson(req)) as Record<string, unknown>;
          const docTypeRaw = body['doc_type'];
          const entityKeyRaw = body['entity_key'];
          const contentRaw = body['content'];
          const docType = typeof docTypeRaw === 'string' ? docTypeRaw : '';
          const entityKey = typeof entityKeyRaw === 'string' ? entityKeyRaw : '';
          const content = typeof contentRaw === 'string' ? contentRaw : '';
          if (entityKey.trim() === '' || content.trim() === '') {
            send(res, 400, { ok: false, error: 'entity_key and content are required', code: 'BAD_REQUEST' });
            return;
          }
          const dir = join(root, safeSlug(docType || 'doc'));
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${safeSlug(entityKey)}.md`), content, 'utf8');
          index = buildIndex(await loadFolder(root)); // small folders: full rebuild is fine
          send(res, 200, { ok: true });
          return;
        }
        if (method === 'POST' && url === '/reindex') {
          index = buildIndex(await loadFolder(root));
          send(res, 200, { ok: true, indexed_chunks: index.docCount });
          return;
        }
        send(res, 404, { error: 'not found', code: 'NOT_FOUND' });
      } catch (err) {
        // Log the detail server-side; do NOT return it in the response body
        // (avoids leaking internal error/stack detail to callers).
        console.error('[folder-connector] request failed:', err instanceof Error ? err.message : String(err));
        send(res, 503, { results: [], ok: false, error: 'connector error', code: 'UNAVAILABLE' });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // eslint-disable-next-line no-console
  console.error(`[folder-connector] listening on http://${host}:${port} (KB_ROOT: ${root}, ${index.docCount} chunks)`);
  return { close: () => server.close() };
}

// CLI entry: `KB_ROOT=/path tsx src/connector/folder-connector.ts`  (or --folder <path>)
const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('folder-connector.ts');
if (isMain) {
  const folderFlag = process.argv.indexOf('--folder');
  const root = folderFlag >= 0 ? process.argv[folderFlag + 1]! : process.env['KB_ROOT'] ?? '';
  if (!root || root.trim() === '') {
    console.error('folder-connector: set KB_ROOT or pass --folder <path>');
    process.exit(1);
  }
  startFolderConnector({ root, port: Number(process.env['KB_RETRIEVAL_PORT'] ?? 7412) }).catch((err) => {
    console.error('folder-connector failed:', err);
    process.exit(1);
  });
}
