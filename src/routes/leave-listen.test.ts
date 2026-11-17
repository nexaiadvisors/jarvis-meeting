import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockLeaveBot = vi.fn(async (_c: unknown, _b: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/leave-bot.js', () => ({ leaveBot: mockLeaveBot }));
vi.mock('../postmeeting/pipeline.js', () => ({ kickoffPipeline: vi.fn() }));

const { createCommandRoutes } = await import('./commands.js');
const { createWebhookRoute } = await import('./webhook.js');
const { __clearRegistry, getMeeting, registerMeeting } = await import('../meeting/registry.js');
const { __clearCommands, commandsAfter } = await import('../meeting/commands.js');
const { __clearLeaveBackstops } = await import('../meeting/leave.js');
const { readMergedTranscript } = await import('../meeting/transcript.js');
const { sessionHeader } = await import('../../tests/helpers/session.js');
const { makeConfig } = await import('../../tests/helpers/mcp.js');

const config = makeConfig();
let n = 0;
let botId: string;
let id: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  __clearLeaveBackstops();
  mockLeaveBot.mockClear();
  mockLeaveBot.mockResolvedValue({ ok: true });
  n += 1;
  botId = `leave-listen-bot-${process.pid}-${n}`;
  id = `m-${botId}`;
  registerMeeting({ meetingId: id, botId, teammate: 'david', persona: 'ai', title: 'T' });
  app = new Hono();
  app.route('/', createCommandRoutes(config));
  app.route('/', createWebhookRoute(config));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // The join notice goes out on the first event of a meeting; by default the fake Recall refuses it.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  global.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(join(process.cwd(), '.data', `${botId}.jsonl`), { force: true });
  vi.restoreAllMocks();
});

const page = (path: string, body?: unknown, headers = sessionHeader(config, id, 'david')) =>
  app.fetch(new Request(`http://x/api/meetings/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }));
const hook = (event: unknown) =>
  app.fetch(new Request('http://x/webhooks/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) }));
const said = (speaker: string, text: string) => ({ event: 'transcript.data', data: { data: { participant: { name: speaker }, words: text.split(' ').map((t) => ({ text: t })) }, bot: { id: botId } } });
const typed = (speaker: string, text: string) => ({ event: 'participant_events.chat_message', data: { data: { participant: { name: speaker }, timestamp: { absolute: new Date().toISOString() }, data: { text, to: 'everyone' } }, bot: { id: botId } } });
const transcript = () => readMergedTranscript({ meetingId: id, botId }, 'Jarvis').map((l) => l.text);

describe('leave the call', () => {
  it('the bot page’s leave request leaves through Recall and retires the meeting', async () => {
    const res = await page('leave-request');
    expect(res.status).toBe(202);
    expect(mockLeaveBot).toHaveBeenCalledWith(expect.anything(), botId);
    expect(getMeeting(id)).toMatchObject({ status: 'completed', inCall: false });
    expect((await page('leave-request')).status).toBe(409);
  });

  it('needs the meeting session token', async () => {
    expect((await page('leave-request', {}, {})).status).toBe(401);
    expect(mockLeaveBot).not.toHaveBeenCalled();
  });

  it('a typed "Jarvis, leave the call" leaves and is not sent to the model', async () => {
    await hook(typed('Nick', 'Jarvis, leave the call'));
    await vi.waitFor(() => expect(getMeeting(id)?.status).toBe('completed'));
    expect(mockLeaveBot).toHaveBeenCalledWith(expect.anything(), botId);
    expect(commandsAfter(id, 0)).toEqual([]);
  });
});

describe('stop listening', () => {
  it('while paused nothing said or typed is kept; the wake word in chat resumes', async () => {
    await hook(said('Nick', 'before the pause'));
    expect((await page('listening', { paused: true })).status).toBe(200);
    expect(getMeeting(id)?.listeningPausedAt).toBeDefined();

    await hook(said('Nick', 'this is off the record'));
    await hook(typed('Nick', 'also off the record'));
    expect(transcript()).toEqual(['before the pause']);

    await hook(typed('Nick', 'Jarvis, what did we decide?'));
    expect(getMeeting(id)?.listeningPausedAt).toBeUndefined();
    await hook(said('Nick', 'back on the record'));
    expect(transcript()).toEqual(['before the pause', 'Jarvis, what did we decide?', 'back on the record']);
    expect(commandsAfter(id, 0).map((q) => q.command.type)).toEqual(['ask']);
  });

  it('the bot page learns the pause from its command poll, and ordinary typed requests do not leave', async () => {
    const poll = async () =>
      (await (await app.fetch(new Request(`http://x/api/meetings/${id}/commands`, { headers: sessionHeader(config, id, 'david') }))).json()) as { listeningPaused: boolean };
    expect((await poll()).listeningPaused).toBe(false);
    await hook(typed('Nick', 'Jarvis, stop listening'));
    expect((await poll()).listeningPaused).toBe(true);
    await hook(typed('Nick', 'Jarvis, please leave a comment in the doc'));
    expect((await poll()).listeningPaused).toBe(false);
    expect(mockLeaveBot).not.toHaveBeenCalled();
    expect(getMeeting(id)?.status).toBe('live');
  });

  it('a typed "Jarvis, stop listening" pauses without reaching the model or the transcript', async () => {
    await hook(typed('Nick', 'Jarvis, stop listening'));
    expect(getMeeting(id)?.listeningPausedAt).toBeDefined();
    expect(commandsAfter(id, 0)).toEqual([]);
    expect(transcript()).toEqual([]);
  });

  it('the bot page resumes with paused false, and a bad body is rejected', async () => {
    await page('listening', { paused: true });
    expect((await page('listening', { paused: false })).status).toBe(200);
    expect(getMeeting(id)?.listeningPausedAt).toBeUndefined();
    expect((await page('listening', { paused: 'yes' })).status).toBe(400);
    expect((await page('listening', { paused: true }, {})).status).toBe(401);
  });
});
