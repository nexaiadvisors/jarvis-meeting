import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../postmeeting/pipeline.js', () => ({ kickoffPipeline: vi.fn() }));

const { createWebhookRoute } = await import('./webhook.js');
const { __clearRegistry, registerMeeting } = await import('../meeting/registry.js');
const { __clearCommands, commandsAfter } = await import('../meeting/commands.js');
const { makeConfig } = await import('../../tests/helpers/mcp.js');

const config = { ...makeConfig(), ownerParticipantNames: ['David'] };
let n = 0;
let botId: string;
let id: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  n += 1;
  botId = `wake-bot-${process.pid}-${n}`;
  id = `m-${botId}`;
  registerMeeting({ meetingId: id, botId, teammate: 'david', persona: 'ai', title: 'T' });
  app = new Hono();
  app.route('/', createWebhookRoute(config));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  global.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
});

afterEach(() => {
  rmSync(join(process.cwd(), '.data', `${botId}.jsonl`), { force: true });
  vi.restoreAllMocks();
});

const said = (participant: Record<string, unknown>, text: string) =>
  app.fetch(
    new Request('http://x/webhooks/recall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'transcript.data', data: { data: { participant, words: text.split(' ').map((t) => ({ text: t })) }, bot: { id: botId } } }),
    }),
  );
const OWNER = { id: 1, name: 'David', is_host: true };
const GUEST = { id: 2, name: 'Thy' };
const wakes = () => commandsAfter(id, 0).map((q) => q.command).filter((c) => c.type === 'wake');

describe('wake from the per-speaker transcript', () => {
  it('queues a wake when the owner calls the agent by name, even mid-sentence', async () => {
    await said(OWNER, 'it shows waiting hey jarvis are you still there');
    expect(wakes()).toHaveLength(1);
  });

  it('does not wake for a guest, a passing mention, or the request to be quiet', async () => {
    await said(OWNER, 'hello there');
    await said(GUEST, 'hey jarvis are you still there');
    await said(OWNER, 'let me see if my jarvis is still here');
    await said(OWNER, 'jarvis can you be quiet until we call on you');
    expect(wakes()).toHaveLength(0);
  });
});
