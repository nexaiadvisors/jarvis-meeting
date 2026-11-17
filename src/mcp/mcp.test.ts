import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMcpRoute } from '../routes/mcp.js';
import { ownerCookieValue } from '../auth/owner.js';
import { __clearRegistry, registerMeeting, setStatus } from '../meeting/registry.js';
import { __clearAgentUtterances, appendAgentUtterance } from '../meeting/transcript.js';
import { appendNote } from '../meeting/notes.js';
import { writeSummary } from '../postmeeting/summary-store.js';
import { OWNER, call, connect, makeConfig } from '../../tests/helpers/mcp.js';

let dataDir: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  dataDir = mkdtempSync(join(tmpdir(), 'jm-mcp-'));
  app = createMcpRoute(makeConfig(), { dataDir });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request('http://jarvis.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function meeting(id: string, botId: string, title: string): void {
  registerMeeting({ meetingId: id, botId, teammate: 'david', persona: 'participant' as never, title });
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('POST /mcp auth', () => {
  it('returns 401 and no tool list without a bearer', async () => {
    const res = await post(LIST);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('list_meetings');
  });

  it('returns 401 for a wrong bearer', async () => {
    const res = await post(LIST, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no owner token is configured', async () => {
    app = createMcpRoute(makeConfig({ ownerToken: undefined }), { dataDir });
    const res = await post(LIST, { authorization: 'Bearer undefined' });
    expect(res.status).toBe(401);
  });

  it('does not accept the owner cookie: this endpoint is bearer only', async () => {
    const res = await post(LIST, { cookie: `jm_owner=${ownerCookieValue(makeConfig())}`, origin: 'https://jarvis.example.com' });
    expect(res.status).toBe(401);
  });

  it('answers a single stateless JSON-RPC POST with the owner bearer', async () => {
    const res = await post(LIST, { authorization: `Bearer ${OWNER}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain('list_meetings');
  });

  it('refuses GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.fetch(new Request('http://jarvis.test/mcp', { method }));
      expect(res.status).toBe(405);
    }
  });
});

describe('MCP read tools', () => {
  it('lists the read tools', async () => {
    const client = await connect(app);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['list_meetings', 'get_meeting', 'get_transcript', 'search_transcript', 'get_notes', 'list_upcoming']) {
      expect(names).toContain(name);
    }
  });

  it('list_meetings filters by status and get_meeting returns one', async () => {
    meeting('m1', 'b1', 'Standup');
    meeting('m2', 'b2', 'Old');
    setStatus('m2', 'completed');
    const client = await connect(app);

    const live = await call(client, 'list_meetings', { status: 'live' });
    expect(live.data['meetings'].map((m: { meetingId: string }) => m.meetingId)).toEqual(['m1']);

    const one = await call(client, 'get_meeting', { meeting_id: 'm2' });
    expect(one.data).toMatchObject({ meetingId: 'm2', title: 'Old', status: 'completed', muted: false });

    const missing = await call(client, 'get_meeting', { meeting_id: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('get_transcript merges spoken and bot lines; search_transcript ranks them', async () => {
    meeting('m1', 'b1', 'Standup');
    writeFileSync(
      join(dataDir, 'b1.jsonl'),
      [
        { speaker: 'Nick', text: 'The launch budget is forty thousand', timestamp: '2026-11-13T10:00:00.000Z' },
        { speaker: 'David', text: 'Let us ship on Friday', timestamp: '2026-11-13T10:00:05.000Z' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    appendAgentUtterance('m1', { speaker: 'agent', text: 'Noted the Friday date', timestamp: '2026-11-13T10:00:09.000Z' }, dataDir);
    const client = await connect(app);

    const all = await call(client, 'get_transcript', { meeting_id: 'm1' });
    expect(all.data['total']).toBe(3);
    expect(all.data['entries'][2]).toMatchObject({ speaker: 'Jarvis', text: 'Noted the Friday date' });

    const tail = await call(client, 'get_transcript', { meeting_id: 'm1', tail: 1 });
    expect(tail.data['entries']).toHaveLength(1);

    const found = await call(client, 'search_transcript', { meeting_id: 'm1', query: 'budget' });
    expect(found.data['results'][0]).toMatchObject({ speaker: 'Nick' });
  });

  it('get_notes returns saved notes and list_upcoming returns the calendar status', async () => {
    meeting('m1', 'b1', 'Standup');
    appendNote('b1', { kind: 'note', text: 'Send the deck', at: '2026-11-13T10:01:00.000Z', by: 'agent' }, dataDir);
    const client = await connect(app);

    const notes = await call(client, 'get_notes', { meeting_id: 'm1' });
    expect(notes.data['notes']).toEqual([{ kind: 'note', text: 'Send the deck', at: '2026-11-13T10:01:00.000Z', by: 'agent' }]);

    const upcoming = await call(client, 'list_upcoming');
    expect(upcoming.data).toMatchObject({ enabled: false });
    expect(Array.isArray(upcoming.data['upcoming'])).toBe(true);
  });

  it('get_summary and get_action_items read the stored summary', async () => {
    meeting('m1', 'b1', 'Standup');
    const client = await connect(app);

    const early = await call(client, 'get_summary', { meeting_id: 'm1' });
    expect(early.isError).toBe(true);

    writeSummary(
      'b1',
      { bluf: 'Ship Friday.', decisions: ['Budget stays at 40k'], actionItems: [{ owner: 'Nick', task: 'Send the deck' }] },
      true,
      dataDir,
    );
    const summary = await call(client, 'get_summary', { meeting_id: 'm1' });
    expect(summary.data).toMatchObject({ bluf: 'Ship Friday.', decisions: ['Budget stays at 40k'], generated: true });

    const items = await call(client, 'get_action_items', { meeting_id: 'm1' });
    expect(items.data).toEqual({ actionItems: [{ owner: 'Nick', task: 'Send the deck' }], generated: true });
  });

  it('artifact tools create, read, list and update with the version check', async () => {
    meeting('m1', 'b1', 'Standup');
    const client = await connect(app);

    const created = await call(client, 'create_artifact', { meeting_id: 'm1', kind: 'doc', title: 'Plan', content: '# Plan' });
    expect(created.data).toMatchObject({ kind: 'doc', title: 'Plan', version: 1 });
    expect(created.data['url']).toMatch(new RegExp(`^https://jarvis\\.example\\.com/a/m1/${created.data['id']}\\?t=.{32,}$`));
    const id = created.data['id'] as string;

    const updated = await call(client, 'update_artifact', { meeting_id: 'm1', artifact_id: id, content: '# Plan v2', version: 1 });
    expect(updated.data).toMatchObject({ content: '# Plan v2', version: 2 });

    const stale = await call(client, 'update_artifact', { meeting_id: 'm1', artifact_id: id, content: 'old', version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.data['current']).toMatchObject({ content: '# Plan v2', version: 2 });

    expect((await call(client, 'get_artifact', { meeting_id: 'm1', artifact_id: id })).data).toMatchObject({ content: '# Plan v2' });
    const list = await call(client, 'list_artifacts', { meeting_id: 'm1' });
    expect(list.data['artifacts']).toEqual([expect.objectContaining({ id, kind: 'doc', version: 2 })]);

    expect((await call(client, 'create_artifact', { meeting_id: 'nope', kind: 'doc', title: 'x', content: '' })).isError).toBe(true);
    expect((await call(client, 'get_artifact', { meeting_id: 'm1', artifact_id: 'missing' })).isError).toBe(true);
  });
});
