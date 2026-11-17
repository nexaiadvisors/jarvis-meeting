import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createVoiceRoutes, LOOKUP_APPROVAL_REFUSAL } from './voice.js';
import { LOOKUP_APPROVAL_WINDOW_MS, __clearRegistry, approveLookup, isLookupApproved, registerMeeting } from '../meeting/registry.js';
import { SoulFrontMatter, toSoul } from '../soul/schema.js';
import { selectToolRoutes } from '../agent/realtime-config.js';
import { sessionHeader } from '../../tests/helpers/session.js';
import { makeConfig } from '../../tests/helpers/mcp.js';

let soulDir: string;
let app: Hono;
let fetched: string[];
let config: ReturnType<typeof makeConfig>;

function soul(lookupApproval?: string): void {
  writeFileSync(
    join(soulDir, 'example.md'),
    `---\nowner: example\nname: Jarvis\npersona_mode: ai\n${lookupApproval ? `lookup_approval: ${lookupApproval}\n` : ''}knowledge_backend:\n  type: openbrain\n  endpoint: http://kb.test\n---\nJarvis.`,
  );
}

beforeEach(() => {
  __clearRegistry();
  soulDir = mkdtempSync(join(tmpdir(), 'jm-approval-'));
  config = makeConfig({ soulDir, teamKbEndpoint: 'http://team-kb.test', teamKbFallbackUrl: 'http://team-kb.test', anthropicApiKey: undefined });
  app = new Hono();
  app.route('/', createVoiceRoutes(config));
  registerMeeting({ meetingId: 'm1', botId: 'b1', teammate: 'example', persona: 'ai', title: 'T' });
  fetched = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify({ results: [{ text: 'Last year cost 38k', source: 'kb/events.md', score: 1 }], document: null }), { status: 200 });
  }) as typeof fetch;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(soulDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const post = (path: string, body: Record<string, unknown>) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeader(config, 'm1', 'example') },
      body: JSON.stringify({ meetingId: 'm1', ...body }),
    }),
  );

const KNOWLEDGE_ROUTES: [string, Record<string, unknown>][] = [
  ['/api/voice/ob-search', { query: 'last year cost' }],
  ['/api/voice/ob-context', { query: 'last year cost' }],
  ['/api/voice/ob-get-document', { namespace: 'work', doc_type: 'plan', entity_key: 'x' }],
  ['/api/voice/team-kb-answer', { question: 'what did last year cost' }],
];

describe('SOUL lookup_approval', () => {
  it('defaults to none and accepts ask', () => {
    expect(toSoul(SoulFrontMatter.parse({ name: 'J' }), '').lookupApproval).toBe('none');
    expect(toSoul(SoulFrontMatter.parse({ name: 'J', lookup_approval: 'ask' }), '').lookupApproval).toBe('ask');
  });

  it('with none, lookups run without any approval (unchanged behavior)', async () => {
    soul();
    const res = await post('/api/voice/ob-search', { query: 'last year cost' });
    expect(res.status).toBe(200);
    expect(fetched.length).toBeGreaterThan(0);
  });

  it('with ask, every knowledge route refuses and fetches nothing until approved', async () => {
    soul('ask');
    for (const [path, body] of KNOWLEDGE_ROUTES) {
      const res = await post(path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: 'LOOKUP_APPROVAL_REQUIRED', approval_required: true, instruction: LOOKUP_APPROVAL_REFUSAL, results: [] });
    }
    expect(fetched).toEqual([]);
  });

  it('approve_lookup opens a short window in which the lookup runs', async () => {
    soul('ask');
    const route = selectToolRoutes({ persona_mode: 'ai' })['approve_lookup']!;
    expect(route.path).toBe('/api/voice/approve-lookup');
    const approved = await post(route.path, route.body({}));
    expect(await approved.json()).toEqual({ ok: true, approved_for_seconds: LOOKUP_APPROVAL_WINDOW_MS / 1000 });

    const res = await post('/api/voice/ob-search', { query: 'last year cost' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
  });

  it('the approval expires, and belongs to one meeting only', () => {
    registerMeeting({ meetingId: 'm2', botId: 'b2', teammate: 'example', persona: 'ai', title: 'Other' });
    approveLookup('m1', 1_000);
    expect(isLookupApproved('m1', 1_000 + LOOKUP_APPROVAL_WINDOW_MS - 1)).toBe(true);
    expect(isLookupApproved('m1', 1_000 + LOOKUP_APPROVAL_WINDOW_MS)).toBe(false);
    expect(isLookupApproved('m2', 1_001)).toBe(false);
    expect(approveLookup('nope')).toBe(false);
  });

  it('approve_lookup needs the meeting session token', async () => {
    soul('ask');
    const res = await app.fetch(new Request('http://x/api/voice/approve-lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meetingId: 'm1' }) }));
    expect(res.status).toBe(401);
    expect(isLookupApproved('m1')).toBe(false);
  });
});
