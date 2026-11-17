import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../recall/create-bot.js', () => ({ createBot: vi.fn(async () => ({ botId: 'bot-n1' })) }));
const mockSendChat = vi.fn(async (_c: unknown, _b: string, _m: string) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../recall/send-chat.js', () => ({ sendChat: mockSendChat }));

const { createDispatchRoute } = await import('./dispatch.js');
const { createRealtimeSessionRoute } = await import('./realtime-session.js');
const { __clearRegistry, getMeeting } = await import('../meeting/registry.js');
const { __clearAgentUtterances } = await import('../meeting/transcript.js');
const { joinNotice, postChat } = await import('../meeting/chat.js');
const { OWNER, makeConfig } = await import('../../tests/helpers/mcp.js');

let soulDir: string;
let app: Hono;

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  mockSendChat.mockClear();
  soulDir = mkdtempSync(join(tmpdir(), 'jm-notes-only-'));
  writeFileSync(join(soulDir, 'david.md'), '---\nname: Sidekick\nowner: david\npersona_mode: first_person\n---\nprose\n');
  const config = makeConfig({ soulDir, sessionTokenSecret: 'test-secret-test-secret-test-secret', maxConcurrentPerTeammate: 5 });
  app = new Hono();
  app.route('/', createDispatchRoute(config));
  app.route('/', createRealtimeSessionRoute(config));
});

afterEach(() => {
  rmSync(soulDir, { recursive: true, force: true });
});

async function dispatch(body: Record<string, unknown>): Promise<string> {
  const res = await app.fetch(
    new Request('http://x/v1/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ meeting_url: 'https://meet.google.com/abc-defg-hij', ...body }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { meetingId: string }).meetingId;
}

describe('notes-only meetings', () => {
  it('POST /v1/dispatch with notes_only marks the meeting record; without it the field is absent', async () => {
    expect(getMeeting(await dispatch({ notes_only: true }))?.notesOnly).toBe(true);
    expect(getMeeting(await dispatch({}))).not.toHaveProperty('notesOnly');
    expect(getMeeting(await dispatch({ notes_only: 'yes' }))).not.toHaveProperty('notesOnly');
  });

  it('postChat refuses everything but the join notice in a notes-only meeting', async () => {
    const meeting = getMeeting(await dispatch({ notes_only: true }))!;
    const refused = await postChat(makeConfig(), meeting, 'Doc: Plan https://x.test');
    expect(refused.ok).toBe(false);
    expect(mockSendChat).not.toHaveBeenCalled();

    const notice = await postChat(makeConfig(), meeting, joinNotice('Jarvis'), soulDir, { joinNotice: true });
    expect(notice.ok).toBe(true);
    expect(mockSendChat).toHaveBeenCalledTimes(1);
  });
});
