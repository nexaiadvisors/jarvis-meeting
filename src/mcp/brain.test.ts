import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockSendChat = vi.fn(async (_c: unknown, _b: string, _m: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/send-chat.js', () => ({ sendChat: mockSendChat }));
vi.mock('../postmeeting/pipeline.js', () => ({ kickoffPipeline: vi.fn() }));

const { createMcpRoute } = await import('../routes/mcp.js');
const { createCommandRoutes } = await import('../routes/commands.js');
const { createWebhookRoute } = await import('../routes/webhook.js');
const { __clearRegistry, registerMeeting } = await import('../meeting/registry.js');
const { __clearCommands, commandsAfter } = await import('../meeting/commands.js');
const { __clearRequests } = await import('../meeting/requests.js');
const { queueForExternalBrain, usesExternalBrain } = await import('../meeting/external-brain.js');
const { __clearAgentUtterances } = await import('../meeting/transcript.js');
const { sessionHeader } = await import('../../tests/helpers/session.js');
const { call, connect, makeConfig } = await import('../../tests/helpers/mcp.js');

let soulDir: string;
let app: Hono;
let config: ReturnType<typeof makeConfig>;
let n = 0;
let botId: string;
let id: string;

function soul(brain?: string): void {
  writeFileSync(join(soulDir, 'david.md'), `---\nname: Sidekick\nowner: david\nwake_word: jarvis\npersona_mode: first_person\n${brain ? `brain: ${brain}\n` : ''}---\nprose\n`);
}

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  __clearRequests();
  __clearAgentUtterances();
  mockSendChat.mockClear();
  soulDir = mkdtempSync(join(tmpdir(), 'jm-brain-'));
  soul('external');
  config = makeConfig({ soulDir });
  app = new Hono();
  app.route('/', createMcpRoute(config, { dataDir: soulDir }));
  app.route('/', createCommandRoutes(config));
  app.route('/', createWebhookRoute(config));
  n += 1;
  botId = `brain-test-bot-${process.pid}-${n}`;
  id = `m-${botId}`;
  registerMeeting({ meetingId: id, botId, teammate: 'david', persona: 'first_person', title: 'T' });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  __clearRequests();
  rmSync(soulDir, { recursive: true, force: true });
  rmSync(join(process.cwd(), '.data', `${botId}.jsonl`), { force: true });
  vi.restoreAllMocks();
});

const spoken = (text: string) =>
  app.fetch(new Request(`http://x/api/meetings/${id}/requests`, { method: 'POST', headers: { 'content-type': 'application/json', ...sessionHeader(config, id, 'david') }, body: JSON.stringify({ text, from: 'Nick' }) }));
const typed = (text: string) =>
  app.fetch(new Request('http://x/webhooks/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'participant_events.chat_message', data: { data: { participant: { name: 'Robin' }, timestamp: { absolute: new Date().toISOString() }, data: { text, to: 'everyone' } }, bot: { id: botId } } }) }));

describe('an MCP agent acting as the brain', () => {
  it('usesExternalBrain reads the SOUL, and treats a missing SOUL as builtin', () => {
    expect(usesExternalBrain(config, 'david')).toBe(true);
    soul();
    expect(usesExternalBrain(config, 'david')).toBe(false);
    expect(usesExternalBrain(config, 'nobody')).toBe(false);
  });

  it('a spoken request is collected with wait_for_request and answered aloud with respond', async () => {
    expect((await spoken('what did last year cost?')).status).toBe(202);
    // The built-in agent got nothing.
    expect(commandsAfter(id, 0)).toEqual([]);

    const client = await connect(app);
    const waited = await call(client, 'wait_for_request', { meeting_id: id });
    expect(waited.data['request']).toMatchObject({ text: 'what did last year cost?', from: 'Nick', source: 'voice' });
    expect(Array.isArray(waited.data['recent_transcript'])).toBe(true);

    const answered = await call(client, 'respond', { request_id: waited.data['request'].id, text: 'Thirty-eight thousand.' });
    expect(answered.data).toMatchObject({ answered: true, via: 'voice' });
    expect(commandsAfter(id, 0).map((q) => q.command)).toEqual([{ type: 'say', text: 'Thirty-eight thousand.' }]);

    const again = await call(client, 'respond', { request_id: waited.data['request'].id, text: 'again' });
    expect(again.isError).toBe(true);
  });

  it('a typed request goes to the outside brain and is answered in chat', async () => {
    await typed('Jarvis, summarize the decisions');
    expect(commandsAfter(id, 0)).toEqual([]);

    const client = await connect(app);
    const waited = await call(client, 'wait_for_request', { meeting_id: id, timeout_seconds: 0 });
    expect(waited.data['request']).toMatchObject({ text: 'summarize the decisions', from: 'Robin', source: 'chat' });
    const answered = await call(client, 'respond', { request_id: waited.data['request'].id, text: 'Two decisions so far.' });
    expect(answered.data).toMatchObject({ answered: true, via: 'chat' });
    expect(mockSendChat).toHaveBeenCalledWith(expect.anything(), botId, 'Two decisions so far.');
  });

  it('a failed chat post leaves the request open, so respond can be retried', async () => {
    await typed('Jarvis, summarize the decisions');
    const client = await connect(app);
    const waited = await call(client, 'wait_for_request', { meeting_id: id, timeout_seconds: 0 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSendChat.mockResolvedValueOnce({ ok: false, error: 'recall send_chat_message failed (500)' });
    expect((await call(client, 'respond', { request_id: waited.data['request'].id, text: 'Two decisions.' })).isError).toBe(true);
    mockSendChat.mockResolvedValue({ ok: true });
    expect((await call(client, 'respond', { request_id: waited.data['request'].id, text: 'Two decisions.' })).data).toMatchObject({ answered: true, via: 'chat' });
  });

  it('wait_for_request returns request null when nobody asked, and refuses a meeting that is not live', async () => {
    const client = await connect(app);
    expect((await call(client, 'wait_for_request', { meeting_id: id, timeout_seconds: 0 })).data).toEqual({ request: null });
    expect((await call(client, 'wait_for_request', { meeting_id: 'nope', timeout_seconds: 0 })).isError).toBe(true);
    expect((await call(client, 'respond', { request_id: 'nope', text: 'x' })).isError).toBe(true);
  });

  it('with no answer in time the built-in agent takes it: aloud for a spoken request, in chat for a typed one', async () => {
    vi.useFakeTimers();
    try {
      queueForExternalBrain(id, { text: 'spoken question', from: 'Nick', source: 'voice' }, 1_000);
      queueForExternalBrain(id, { text: 'typed question', from: 'Robin', source: 'chat' }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commandsAfter(id, 0).map((q) => q.command)).toEqual([
        { type: 'ask', text: 'spoken question', from: 'Nick', reply: 'voice' },
        { type: 'ask', text: 'typed question', from: 'Robin' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with brain builtin a typed request goes straight to the built-in agent', async () => {
    soul();
    await typed('Jarvis, summarize the decisions');
    expect(commandsAfter(id, 0).map((q) => q.command)).toEqual([{ type: 'ask', text: 'summarize the decisions', from: 'Robin' }]);
  });
});
