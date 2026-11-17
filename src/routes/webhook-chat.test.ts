import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Config } from '../config.js';

const mockKickoffPipeline = vi.fn();
vi.mock('../postmeeting/pipeline.js', () => ({ kickoffPipeline: mockKickoffPipeline }));

const { createWebhookRoute } = await import('./webhook.js');
const { registerMeeting, getMeeting, __clearRegistry } = await import('../meeting/registry.js');
const { __clearAgentUtterances } = await import('../meeting/transcript.js');
const { __clearCommands, commandsAfter } = await import('../meeting/commands.js');
const { setStatus, shareTokenFor } = await import('../meeting/registry.js');
const { readMergedTranscript, renderTranscriptText } = await import('../meeting/transcript.js');

const config = { jarvisBotName: 'Jarvis', webhookSecret: undefined, recallApiBase: 'https://r.example/api/v1', recallApiKey: 'rk', publicBaseUrl: 'https://jarvis.example.com' } as unknown as Config;
const DATA_DIR = join(process.cwd(), '.data');
let botId: string;
let n = 0;

function app(): Hono {
  const a = new Hono();
  a.route('/', createWebhookRoute(config));
  return a;
}

function chatEvent(name: string | null, text: string, absolute = '2026-11-13T10:00:00.000Z'): unknown {
  return {
    event: 'participant_events.chat_message',
    data: {
      data: { participant: { id: 1, name }, timestamp: { absolute, relative: 12.5 }, data: { text, to: 'everyone' } },
      bot: { id: botId, metadata: {} },
    },
  };
}

async function send(body: unknown): Promise<Response> {
  return app().fetch(
    new Request('http://x/webhooks/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  n += 1;
  botId = `chat-test-bot-${process.pid}-${n}`;
  registerMeeting({ meetingId: `m-${botId}`, botId, teammate: 'david', persona: 'ai', title: 'Chat' });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // The join notice goes out on the first event of a meeting; by default the fake Recall refuses it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  global.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
});

afterEach(() => {
  rmSync(join(DATA_DIR, `${botId}.jsonl`), { force: true });
  rmSync(join(DATA_DIR, `m-${botId}.agent.jsonl`), { force: true });
  __clearAgentUtterances();
  vi.restoreAllMocks();
});

const transcript = () => readMergedTranscript({ meetingId: `m-${botId}`, botId }, 'Jarvis');

describe('webhook participant_events.chat_message', () => {
  it("appends the typed line to the meeting transcript with kind 'chat' and the event time", async () => {
    const res = await send(chatEvent('Nick', '  Jarvis, what was last year’s budget?  '));
    expect(res.status).toBe(200);
    expect(transcript()).toEqual([
      { speaker: 'Nick', text: 'Jarvis, what was last year’s budget?', timestamp: '2026-11-13T10:00:00.000Z', kind: 'chat' },
    ]);
    expect(renderTranscriptText(transcript())).toBe('[2026-11-13T10:00:00.000Z] Nick (chat): Jarvis, what was last year’s budget?');
  });

  it('stores a pasted meeting link without its share token', async () => {
    await send(chatEvent('Nick', 'here it is https://jarvis.example.com/a/m1/abc123?t=AbCdEfGhIjKlMnOpQrStUvWxYz012345 thanks'));
    expect(transcript()[0]!.text).toBe('here it is https://jarvis.example.com/a/m1/abc123 thanks');
  });

  it('keeps chat and speech in one time-ordered transcript', async () => {
    await send(chatEvent('Nick', 'typed first', '2020-01-01T00:00:00.000Z'));
    await send({
      event: 'transcript.data',
      data: { data: { participant: { name: 'David' }, words: [{ text: 'spoken' }, { text: 'later' }] }, bot: { id: botId } },
    });
    const lines = transcript();
    expect(lines.map((l) => [l.speaker, l.kind])).toEqual([['Nick', 'chat'], ['David', undefined]]);
  });

  it('ignores an empty message, the bot’s own echo and an unknown bot', async () => {
    await send(chatEvent('Nick', '   '));
    await send(chatEvent('Jarvis', 'I am an AI note-taker.'));
    expect(transcript()).toEqual([]);

    const known = botId;
    botId = `foreign-${known}`;
    const res = await send(chatEvent('Nick', 'hello'));
    expect(res.status).toBe(200);
    expect(readMergedTranscript({ meetingId: 'none', botId }, 'Jarvis')).toEqual([]);
    botId = known;
  });

  it('never logs the chat text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await send(chatEvent('Nick', 'secret-chat-phrase'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-chat-phrase');
  });
});

describe('webhook bot.in_call_recording join notice', () => {
  const admitted = () => ({ event: 'bot.in_call_recording', data: { bot: { id: botId, metadata: {} } } });

  it('posts one notice naming the bot as an AI note-taker, and records it as a chat line', async () => {
    const sent: { url: string; message: string }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), message: JSON.parse(String(init?.body)).message });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await send(admitted());
    await send(admitted());
    await vi.waitFor(() => expect(transcript()).toHaveLength(1));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://r.example/api/v1/bot/${botId}/send_chat_message/`);
    expect(sent[0]!.message).toContain('Jarvis is an AI note-taker');
    // The notice carries the link to this meeting's page.
    expect(sent[0]!.message).toContain(`Meeting page: https://jarvis.example.com/m/m-${botId}?t=${shareTokenFor(`m-${botId}`)}`);
    expect(transcript()[0]).toMatchObject({ speaker: 'Jarvis', kind: 'chat' });
    // The transcript keeps the notice without the share token; only the chat gets the working link.
    expect(transcript()[0]!.text).toContain(`Meeting page: https://jarvis.example.com/m/m-${botId}`);
    expect(transcript()[0]!.text).not.toContain(shareTokenFor(`m-${botId}`)!);
    expect(getMeeting(`m-${botId}`)?.noticeSentAt).toBeDefined();
  });

  it('posts the notice on the first transcript event when the status webhook never arrives', async () => {
    const sent: string[] = [];
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).message);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const spoken = { event: 'transcript.data', data: { data: { participant: { name: 'David' }, words: [{ text: 'hello' }] }, bot: { id: botId } } };
    await send(spoken);
    await send(spoken);
    await send(admitted());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('Jarvis is an AI note-taker');
  });

  it('a failed notice does not fail the webhook and adds no transcript line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    global.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
    const res = await send(admitted());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(transcript()).toEqual([]);
    expect(getMeeting(`m-${botId}`)?.inCall).toBe(true);
  });
});

describe('a chat message that starts with the wake word', () => {
  const asks = () => commandsAfter(`m-${botId}`, 0).map((q) => q.command);

  it('queues an ask command with the wake word removed and the sender named', async () => {
    await send(chatEvent('Nick', 'Jarvis, what did last year’s event cost?'));
    expect(asks()).toEqual([{ type: 'ask', text: 'what did last year’s event cost?', from: 'Nick' }]);
    // The typed line itself is still in the transcript.
    expect(transcript()).toHaveLength(1);
  });

  it('does not queue ordinary chat, a mid-sentence mention, or a bare wake word', async () => {
    await send(chatEvent('Nick', 'running five minutes late'));
    await send(chatEvent('Nick', 'I asked Jarvis about this earlier'));
    await send(chatEvent('Nick', 'Jarvis'));
    expect(asks()).toEqual([]);
  });

  it('does not queue in a notes-only meeting, but still records the line', async () => {
    __clearRegistry();
    registerMeeting({ meetingId: `m-${botId}`, botId, teammate: 'david', persona: 'ai', title: 'Chat', notesOnly: true });
    await send(chatEvent('Guest', 'Jarvis, what is the budget?'));
    expect(asks()).toEqual([]);
    expect(transcript()).toHaveLength(1);
  });

  it('does not queue for a meeting that is no longer live', async () => {
    setStatus(`m-${botId}`, 'completed');
    await send(chatEvent('Nick', 'Jarvis, are you still there?'));
    expect(asks()).toEqual([]);
  });
});
