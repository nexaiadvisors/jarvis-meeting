import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockSendChat = vi.fn(async (_c: unknown, _b: string, _m: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/send-chat.js', () => ({ sendChat: mockSendChat }));

const { createCommandRoutes } = await import('./commands.js');
const { __clearRegistry, registerMeeting, setStatus } = await import('../meeting/registry.js');
const { __clearAgentUtterances, readMergedTranscript } = await import('../meeting/transcript.js');
const { sessionHeader } = await import('../../tests/helpers/session.js');
const { makeConfig } = await import('../../tests/helpers/mcp.js');
const { rmSync } = await import('node:fs');
const { join } = await import('node:path');

const config = makeConfig();
const ID = `chat-reply-test-${process.pid}`;

function app(): Hono {
  const a = new Hono();
  a.route('/', createCommandRoutes(config));
  return a;
}

function reply(body: unknown, headers: Record<string, string> = sessionHeader(config, ID, 'david')): Promise<Response> {
  return Promise.resolve(
    app().fetch(
      new Request(`http://x/api/meetings/${ID}/chat-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );
}

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  mockSendChat.mockClear();
  mockSendChat.mockResolvedValue({ ok: true });
  registerMeeting({ meetingId: ID, botId: 'b1', teammate: 'david', persona: 'ai', title: 'T' });
});

afterEach(() => {
  rmSync(join(process.cwd(), '.data', `${ID}.agent.jsonl`), { force: true });
  vi.restoreAllMocks();
});

describe('POST /api/meetings/:id/chat-reply', () => {
  it('posts the written answer to the meeting chat and records it as a chat line', async () => {
    const res = await reply({ text: ' Last year the event cost 38k. ' });
    expect(res.status).toBe(200);
    expect(mockSendChat).toHaveBeenCalledWith(expect.anything(), 'b1', 'Last year the event cost 38k.');
    expect(readMergedTranscript({ meetingId: ID, botId: 'b1' }, 'Jarvis')).toEqual([
      expect.objectContaining({ speaker: 'Jarvis', text: 'Last year the event cost 38k.', kind: 'chat' }),
    ]);
  });

  it('needs the meeting session token', async () => {
    expect((await reply({ text: 'x' }, {})).status).toBe(401);
    expect(mockSendChat).not.toHaveBeenCalled();
  });

  it('rejects empty text, a finished meeting, and reports a Recall failure', async () => {
    expect((await reply({ text: '  ' })).status).toBe(400);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSendChat.mockResolvedValue({ ok: false, error: 'recall send_chat_message failed (403)' });
    expect((await reply({ text: 'x' })).status).toBe(502);
    setStatus(ID, 'completed');
    expect((await reply({ text: 'x' })).status).toBe(409);
  });
});
