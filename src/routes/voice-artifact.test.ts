import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockSendChat = vi.fn(async (_c: unknown, _b: string, _m: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/send-chat.js', () => ({ sendChat: mockSendChat }));

const { createVoiceRoutes } = await import('./voice.js');
const { __clearRegistry, registerMeeting, shareTokenFor } = await import('../meeting/registry.js');
const { __clearAgentUtterances } = await import('../meeting/transcript.js');
const { getArtifact, listArtifacts } = await import('../meeting/artifacts.js');
const { selectToolRoutes } = await import('../agent/realtime-config.js');
const REALTIME_TOOL_ROUTES = selectToolRoutes({ persona_mode: 'first_person' });
const { sessionHeader } = await import('../../tests/helpers/session.js');
const { makeConfig } = await import('../../tests/helpers/mcp.js');

const config = makeConfig();
let dir: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  mockSendChat.mockClear();
  mockSendChat.mockResolvedValue({ ok: true });
  dir = mkdtempSync(join(tmpdir(), 'jm-voice-art-'));
  app = new Hono();
  app.route('/', createVoiceRoutes(config, { dataDir: dir }));
  registerMeeting({ meetingId: 'm1', botId: 'b1', teammate: 'david', persona: 'ai', title: 'Launch' });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Call the route exactly as the bot page does for a tool: route.body(args) plus meetingId. */
function tool(name: string, args: Record<string, unknown>, headers = sessionHeader(config, 'm1', 'david')): Promise<Response> {
  const route = REALTIME_TOOL_ROUTES[name]!;
  return Promise.resolve(
    app.fetch(
      new Request(`http://x${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ ...route.body(args), meetingId: 'm1', personaMode: 'ai' }),
      }),
    ),
  );
}

describe('realtime artifact tools -> POST /api/voice/artifact', () => {
  it('all three tools dispatch to /api/voice/artifact', () => {
    for (const name of ['create_doc', 'create_whiteboard', 'update_artifact']) {
      expect(REALTIME_TOOL_ROUTES[name]?.path).toBe('/api/voice/artifact');
    }
  });

  it('create_doc stores a doc and posts its link to the meeting chat', async () => {
    const res = await tool('create_doc', { title: 'Launch plan', markdown: '# Plan\n\n- Ship Friday' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string; link_posted_in_chat: boolean };
    expect(body.link_posted_in_chat).toBe(true);
    expect(getArtifact('m1', body.artifact_id, dir)).toMatchObject({ kind: 'doc', title: 'Launch plan', content: '# Plan\n\n- Ship Friday', version: 1 });
    expect(mockSendChat).toHaveBeenCalledWith(
      expect.anything(),
      'b1',
      `Doc: Launch plan https://jarvis.example.com/a/m1/${body.artifact_id}?t=${shareTokenFor('m1')}`,
    );
    // The model gets no link to read aloud.
    expect(JSON.stringify(body)).not.toContain('https://');
  });

  it('create_whiteboard stores the Mermaid text as a whiteboard', async () => {
    const res = await tool('create_whiteboard', { title: 'Timeline', mermaid: 'flowchart LR\n A-->B' });
    const body = (await res.json()) as { artifact_id: string };
    expect(getArtifact('m1', body.artifact_id, dir)).toMatchObject({ kind: 'whiteboard', content: 'flowchart LR\n A-->B' });
    expect(mockSendChat.mock.calls[0]![2]).toMatch(/^Whiteboard: Timeline https:/);
  });

  it('update_artifact replaces the content without posting again', async () => {
    const created = (await (await tool('create_doc', { title: 'Plan', markdown: 'v1' })).json()) as { artifact_id: string };
    mockSendChat.mockClear();
    const res = await tool('update_artifact', { artifact_id: created.artifact_id, content: 'v2', version: 1 });
    expect(await res.json()).toMatchObject({ ok: true, version: 2 });
    expect(getArtifact('m1', created.artifact_id, dir)).toMatchObject({ content: 'v2', title: 'Plan' });
    expect(mockSendChat).not.toHaveBeenCalled();
    expect((await tool('update_artifact', { artifact_id: 'missing', content: 'x', version: 1 })).status).toBe(404);
    // No version, or a malformed one, never overwrites: the model gets the current content back.
    for (const version of [undefined, '2']) {
      const blind = await tool('update_artifact', { artifact_id: created.artifact_id, content: 'blind overwrite', version });
      expect(await blind.json()).toMatchObject({ ok: false, conflict: true, current_content: 'v2', version: 2 });
    }
    expect(getArtifact('m1', created.artifact_id, dir)?.content).toBe('v2');
  });

  it('update_artifact with a stale version changes nothing and returns the current content to merge', async () => {
    const created = (await (await tool('create_doc', { title: 'Plan', markdown: 'bot v1' })).json()) as { artifact_id: string; version: number };
    expect(created.version).toBe(1);
    // A person edits the doc on its page.
    const { updateArtifact } = await import('../meeting/artifacts.js');
    updateArtifact('m1', created.artifact_id, { content: 'bot v1 + a person’s paragraph', baseVersion: 1 }, dir);

    const res = await tool('update_artifact', { artifact_id: created.artifact_id, content: 'bot v2', version: 1 });
    expect(await res.json()).toMatchObject({ ok: false, conflict: true, version: 2, current_content: 'bot v1 + a person’s paragraph' });
    expect(getArtifact('m1', created.artifact_id, dir)?.content).toBe('bot v1 + a person’s paragraph');

    const merged = await tool('update_artifact', { artifact_id: created.artifact_id, content: 'merged', version: 2 });
    expect(await merged.json()).toMatchObject({ ok: true, version: 3 });
  });

  it('records the chat line in the transcript without the share token', async () => {
    const { readMergedTranscript } = await import('../meeting/transcript.js');
    await tool('create_doc', { title: 'Plan', markdown: 'x' });
    const lines = readMergedTranscript({ meetingId: 'm1', botId: 'b1' }, 'Jarvis', dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/^Doc: Plan https:\/\/jarvis\.example\.com\/a\/m1\/[0-9a-f]+$/);
    expect(lines[0]!.text).not.toContain(shareTokenFor('m1')!);
  });

  it('keeps the artifact when the chat post fails, and tells the model', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSendChat.mockResolvedValue({ ok: false, error: 'recall send_chat_message failed (403)' });
    const res = await tool('create_doc', { title: 'Plan', markdown: 'x' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { link_posted_in_chat: boolean }).link_posted_in_chat).toBe(false);
    expect(listArtifacts('m1', dir)).toHaveLength(1);
  });

  it('needs the meeting session token and real content', async () => {
    expect((await tool('create_doc', { title: 'Plan', markdown: 'x' }, {})).status).toBe(401);
    expect((await tool('create_doc', { title: 'Plan', markdown: '   ' })).status).toBe(400);
    expect((await tool('create_doc', { title: '', markdown: 'x' })).status).toBe(400);
    expect(listArtifacts('m1', dir)).toEqual([]);
  });

  it('never logs the artifact content', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await tool('create_doc', { title: 'Plan', markdown: 'confidential-artifact-text' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('confidential-artifact-text');
  });
});
