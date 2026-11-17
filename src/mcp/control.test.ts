import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';

// Fake Recall: no test here creates or removes a real bot.
const mockCreateBot = vi.fn(async (_params: Record<string, unknown>) => ({ botId: 'bot-new' }));
vi.mock('../recall/create-bot.js', () => ({ createBot: mockCreateBot }));
const mockLeaveBot = vi.fn(async (_config: unknown, _botId: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/leave-bot.js', () => ({ leaveBot: mockLeaveBot }));
const mockSendChat = vi.fn(async (_c: unknown, _b: string, _m: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/send-chat.js', () => ({ sendChat: mockSendChat }));

const { createMcpRoute } = await import('../routes/mcp.js');
const { __clearRegistry, getMeeting, registerMeeting, setStatus } = await import('../meeting/registry.js');
const { __clearCommands, commandsAfter } = await import('../meeting/commands.js');
const { __clearLeaveBackstops } = await import('../meeting/leave.js');
const { __clearAgentUtterances, readMergedTranscript } = await import('../meeting/transcript.js');
const { call, connect, makeConfig } = await import('../../tests/helpers/mcp.js');

let soulDir: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  __clearLeaveBackstops();
  mockCreateBot.mockClear();
  mockLeaveBot.mockClear();
  mockSendChat.mockClear();
  mockSendChat.mockResolvedValue({ ok: true });
  __clearAgentUtterances();
  mockLeaveBot.mockResolvedValue({ ok: true });
  soulDir = mkdtempSync(join(tmpdir(), 'jm-soul-'));
  writeFileSync(join(soulDir, 'david.md'), '---\nname: David Delegate\nowner: david\npersona_mode: first_person\n---\nprose\n');
  app = createMcpRoute(makeConfig({ soulDir, sessionTokenSecret: 'test-secret-test-secret-test-secret' }), { dataDir: soulDir });
});

afterEach(() => {
  rmSync(soulDir, { recursive: true, force: true });
});

function live(id = 'm1', botId = 'b1'): void {
  registerMeeting({ meetingId: id, botId, teammate: 'david', persona: 'first_person', title: 'Standup' });
}

describe('join_meeting', () => {
  it('creates a bot for the default teammate with its own SOUL and registers the meeting', async () => {
    const client = await connect(app);
    const res = await call(client, 'join_meeting', { meeting_url: 'https://meet.google.com/abc-defg-hij', title: 'Launch sync' });

    expect(res.isError).toBe(false);
    expect(res.data['botId']).toBe('bot-new');
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        teammate: 'david',
        soulSlug: 'david',
        persona: 'first_person',
        botName: 'Jarvis',
      }),
    );
    expect(getMeeting(res.data['meetingId'])).toMatchObject({ botId: 'bot-new', title: 'Launch sync', status: 'live' });
  });

  it('refuses at the concurrency cap without creating a bot', async () => {
    live('a', 'ba');
    live('b', 'bb');
    const client = await connect(app);
    const res = await call(client, 'join_meeting', { meeting_url: 'https://meet.google.com/abc-defg-hij' });
    expect(res.isError).toBe(true);
    expect(mockCreateBot).not.toHaveBeenCalled();
  });

  it('reports a Recall failure as a tool error and registers nothing', async () => {
    mockCreateBot.mockRejectedValueOnce(new Error('recall create failed (402): insufficient_credit_balance'));
    const client = await connect(app);
    const res = await call(client, 'join_meeting', { meeting_url: 'https://meet.google.com/abc-defg-hij' });
    expect(res.isError).toBe(true);
    expect(res.data['error']).toContain('402');
    expect((await call(client, 'list_meetings')).data['meetings']).toEqual([]);
  });
});

describe('leave_meeting', () => {
  it('leaves through Recall and retires the meeting', async () => {
    live();
    const client = await connect(app);
    const res = await call(client, 'leave_meeting', { meeting_id: 'm1' });
    expect(res.data).toEqual({ left: true, alreadyGone: false });
    expect(mockLeaveBot).toHaveBeenCalledWith(expect.anything(), 'b1');
    expect(getMeeting('m1')).toMatchObject({ status: 'completed', inCall: false });
  });

  it('keeps the meeting live when Recall refuses', async () => {
    live();
    mockLeaveBot.mockResolvedValue({ ok: false, error: 'recall leave failed (500): boom' });
    const client = await connect(app);
    const res = await call(client, 'leave_meeting', { meeting_id: 'm1' });
    expect(res.isError).toBe(true);
    expect(getMeeting('m1')?.status).toBe('live');
  });
});

describe('leave_meeting on a meeting that is not live', () => {
  it('refuses and does not call Recall', async () => {
    live();
    setStatus('m1', 'failed');
    const client = await connect(app);
    const res = await call(client, 'leave_meeting', { meeting_id: 'm1' });
    expect(res.isError).toBe(true);
    expect(mockLeaveBot).not.toHaveBeenCalled();
    expect((await call(client, 'leave_meeting', { meeting_id: 'nope' })).isError).toBe(true);
  });
});

describe('say / mute / unmute', () => {
  it('queues a say command the bot page will pick up', async () => {
    live();
    const client = await connect(app);
    const res = await call(client, 'say', { meeting_id: 'm1', text: 'The budget is forty thousand.' });
    expect(res.data).toEqual({ queued: true, seq: 1 });
    expect(commandsAfter('m1', 0).map((q) => q.command)).toEqual([{ type: 'say', text: 'The budget is forty thousand.' }]);
  });

  it('never logs the say text', async () => {
    live();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const client = await connect(app);
    await call(client, 'say', { meeting_id: 'm1', text: 'confidential-phrase-xyz' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('confidential-phrase-xyz');
    info.mockRestore();
  });

  it('mute and unmute set the registry state and queue the command', async () => {
    live();
    const client = await connect(app);
    await call(client, 'mute', { meeting_id: 'm1' });
    expect(getMeeting('m1')?.mutedAt).toBeDefined();
    await call(client, 'unmute', { meeting_id: 'm1' });
    expect(getMeeting('m1')?.mutedAt).toBeUndefined();
    expect(commandsAfter('m1', 0).map((q) => q.command.type)).toEqual(['mute', 'unmute']);
  });

  it('refuses a meeting that is not live', async () => {
    live();
    setStatus('m1', 'completed');
    const client = await connect(app);
    const res = await call(client, 'say', { meeting_id: 'm1', text: 'hello' });
    expect(res.isError).toBe(true);
    expect(commandsAfter('m1', 0)).toEqual([]);
  });
});

describe('post_chat', () => {
  it('sends the message to the meeting chat and records it as a chat line', async () => {
    live();
    const client = await connect(app);
    const res = await call(client, 'post_chat', { meeting_id: 'm1', text: 'Last year the event cost 38k.' });
    expect(res.data).toEqual({ posted: true });
    expect(mockSendChat).toHaveBeenCalledWith(expect.anything(), 'b1', 'Last year the event cost 38k.');
    expect(readMergedTranscript({ meetingId: 'm1', botId: 'b1' }, 'Jarvis', soulDir)).toEqual([
      expect.objectContaining({ speaker: 'Jarvis', text: 'Last year the event cost 38k.', kind: 'chat' }),
    ]);
  });

  it('reports a Recall refusal and refuses a meeting that is not live', async () => {
    live();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSendChat.mockResolvedValue({ ok: false, error: 'recall send_chat_message failed (403)' });
    const client = await connect(app);
    expect((await call(client, 'post_chat', { meeting_id: 'm1', text: 'hi' })).isError).toBe(true);
    setStatus('m1', 'completed');
    mockSendChat.mockClear();
    expect((await call(client, 'post_chat', { meeting_id: 'm1', text: 'hi' })).isError).toBe(true);
    expect(mockSendChat).not.toHaveBeenCalled();
  });
});
