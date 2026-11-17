import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { __clearRegistry, getMeeting, registerMeeting, setStatus } from '../src/meeting/registry.js';
import { ownerCookieValue } from '../src/auth/owner.js';
import {
  __clearCommands,
  commandsAfter,
  enqueueCommand,
  type QueuedCommand,
} from '../src/meeting/commands.js';
import { sessionHeader } from './helpers/session.js';

const OWNER = 'owner-token-for-tests';

function makeConfig(): Config {
  return {
    port: 8790,
    publicBaseUrl: 'https://ngrok.example.com',
    jarvisBotName: 'Jarvis',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: 7_200_000,
    maxConcurrentPerTeammate: 2,
    tokenRegistry: new Map([[OWNER, 'david']]),
    workScopeNamespaces: [],
  } as unknown as Config;
}

const config = makeConfig();
const ownerBearer = { Authorization: `Bearer ${OWNER}` };

function post(
  app: ReturnType<typeof createApp>,
  id: string,
  body: unknown,
  headers: Record<string, string> = ownerBearer,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/api/meetings/${id}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );
}

function get(
  app: ReturnType<typeof createApp>,
  id: string,
  query = '',
  headers: Record<string, string> = sessionHeader(config, id, 'david'),
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://x/api/meetings/${id}/commands${query}`, { headers })));
}

async function poll(
  app: ReturnType<typeof createApp>,
  id: string,
  query = '',
): Promise<{ commands: QueuedCommand[]; muted: boolean }> {
  const res = await get(app, id, query);
  expect(res.status).toBe(200);
  return (await res.json()) as { commands: QueuedCommand[]; muted: boolean };
}

beforeEach(() => {
  __clearRegistry();
  __clearCommands();
  registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'david', persona: 'first_person', title: 'M1' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __clearRegistry();
  __clearCommands();
});

describe('command queue', () => {
  it('commandsAfter returns each command once', () => {
    enqueueCommand('m1', { type: 'say', text: 'one' }, 1_000);
    enqueueCommand('m1', { type: 'say', text: 'two' }, 1_000);
    enqueueCommand('m1', { type: 'mute' }, 1_000);

    const all = commandsAfter('m1', 0, 1_000);
    expect(all.map((q) => q.seq)).toEqual([1, 2, 3]);
    expect(all.map((q) => q.command)).toEqual([
      { type: 'say', text: 'one' },
      { type: 'say', text: 'two' },
      { type: 'mute' },
    ]);

    expect(commandsAfter('m1', 1, 1_000).map((q) => q.seq)).toEqual([2, 3]);
    expect(commandsAfter('m1', 3, 1_000)).toEqual([]);
  });

  it('seq starts at 1 for each meeting independently', () => {
    expect(enqueueCommand('m1', { type: 'mute' }, 0).seq).toBe(1);
    expect(enqueueCommand('m1', { type: 'unmute' }, 0).seq).toBe(2);
    expect(enqueueCommand('other', { type: 'mute' }, 0).seq).toBe(1);
    expect(commandsAfter('other', 0, 0).map((q) => q.seq)).toEqual([1]);
  });

  it('returns nothing for a meeting that never had a command', () => {
    expect(commandsAfter('never-seen', 0, 0)).toEqual([]);
  });

  it('expired commands are not returned after 30_000 ms', () => {
    const queued = enqueueCommand('m1', { type: 'say', text: 'stale' }, 10_000);
    expect(queued.expiresAt).toBe(40_000);

    expect(commandsAfter('m1', 0, 10_000 + 29_999).map((q) => q.seq)).toEqual([1]);
    expect(commandsAfter('m1', 0, 10_000 + 30_000)).toEqual([]);
  });

  it('only the expired commands are dropped', () => {
    enqueueCommand('m1', { type: 'say', text: 'old' }, 0);
    enqueueCommand('m1', { type: 'say', text: 'new' }, 20_000);

    const got = commandsAfter('m1', 0, 35_000);
    expect(got.map((q) => q.seq)).toEqual([2]);
  });

  it('seq keeps counting after earlier commands expired, so a poller cursor never rewinds', () => {
    enqueueCommand('m1', { type: 'say', text: 'a' }, 0);
    enqueueCommand('m1', { type: 'say', text: 'b' }, 0);
    expect(commandsAfter('m1', 0, 31_000)).toEqual([]);

    const next = enqueueCommand('m1', { type: 'say', text: 'c' }, 31_000);
    expect(next.seq).toBe(3);
    expect(commandsAfter('m1', 2, 31_000).map((q) => q.seq)).toEqual([3]);
  });

  it('__clearCommands resets every meeting', () => {
    enqueueCommand('m1', { type: 'mute' }, 0);
    __clearCommands();
    expect(commandsAfter('m1', 0, 0)).toEqual([]);
    expect(enqueueCommand('m1', { type: 'mute' }, 0).seq).toBe(1);
  });
});

describe('POST /api/meetings/:id/commands', () => {
  it('requires the owner: no credential and the meeting session token both get 401 OWNER_REQUIRED', async () => {
    const app = createApp(config);

    const anon = await post(app, 'm1', { type: 'say', text: 'hi' }, {});
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('OWNER_REQUIRED');

    // The bot page holds this token. It must not be able to queue commands for itself.
    const botPage = await post(app, 'm1', { type: 'say', text: 'hi' }, sessionHeader(config, 'm1', 'david'));
    expect(botPage.status).toBe(401);
    expect(((await botPage.json()) as { code: string }).code).toBe('OWNER_REQUIRED');

    expect((await poll(app, 'm1')).commands).toEqual([]);
  });

  it('admits the owner bearer token and the jm_owner cookie, returning 201 {seq}', async () => {
    const app = createApp(config);

    const viaBearer = await post(app, 'm1', { type: 'say', text: 'first' });
    expect(viaBearer.status).toBe(201);
    expect(await viaBearer.json()).toEqual({ seq: 1 });

    const viaCookie = await post(app, 'm1', { type: 'say', text: 'second' }, {
      Cookie: `jm_owner=${ownerCookieValue(config)}`,
      Origin: config.publicBaseUrl,
    });
    expect(viaCookie.status).toBe(201);
    expect(await viaCookie.json()).toEqual({ seq: 2 });
  });

  it('refuses a cookie-authenticated command from another origin or with no Origin (403 ORIGIN_MISMATCH), queuing nothing', async () => {
    const app = createApp(config);
    const cookie = `jm_owner=${ownerCookieValue(config)}`;

    const noOrigin = await post(app, 'm1', { type: 'say', text: 'nope' }, { Cookie: cookie });
    const foreign = await post(app, 'm1', { type: 'mute' }, { Cookie: cookie, Origin: 'https://evil.example.com' });

    for (const res of [noOrigin, foreign]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('ORIGIN_MISMATCH');
    }
    expect((await poll(app, 'm1')).commands).toEqual([]);
    expect(getMeeting('m1')?.mutedAt).toBeUndefined();
  });

  it('returns 404 not_found for an unknown meeting', async () => {
    const res = await post(createApp(config), 'nope', { type: 'say', text: 'hi' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('say text of 501 chars returns 400; 500 chars is accepted', async () => {
    const app = createApp(config);

    const tooLong = await post(app, 'm1', { type: 'say', text: 'a'.repeat(501) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { code: string }).code).toBe('BAD_REQUEST');

    const atLimit = await post(app, 'm1', { type: 'say', text: 'a'.repeat(500) });
    expect(atLimit.status).toBe(201);
  });

  it.each([
    ['empty text', { type: 'say', text: '' }],
    ['whitespace-only text', { type: 'say', text: '   \n\t ' }],
    ['missing text', { type: 'say' }],
    ['non-string text', { type: 'say', text: 42 }],
    ['unknown type', { type: 'shout', text: 'hi' }],
    ['missing type', { text: 'hi' }],
    ['array body', ['say']],
    ['null body', null],
    ['malformed JSON', '{not json'],
  ])('%s returns 400 BAD_REQUEST and queues nothing', async (_label, body) => {
    const app = createApp(config);
    const res = await post(app, 'm1', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    expect((await poll(app, 'm1')).commands).toEqual([]);
  });

  it('queues only the validated command fields', async () => {
    const app = createApp(config);
    await post(app, 'm1', { type: 'mute', text: 'ignored', extra: true });

    const { commands } = await poll(app, 'm1');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toEqual({ type: 'mute' });
  });

  it('mute calls setMuted(id, true) and GET reports muted true; unmute reverses it', async () => {
    const app = createApp(config);
    expect((await poll(app, 'm1')).muted).toBe(false);

    const muteRes = await post(app, 'm1', { type: 'mute' });
    expect(muteRes.status).toBe(201);
    expect(getMeeting('m1')?.mutedAt).toBeTypeOf('number');
    const afterMute = await poll(app, 'm1');
    expect(afterMute.muted).toBe(true);
    // The bot page still has to be told, so the command is queued too.
    expect(afterMute.commands.map((q) => q.command)).toEqual([{ type: 'mute' }]);

    const unmuteRes = await post(app, 'm1', { type: 'unmute' });
    expect(unmuteRes.status).toBe(201);
    expect(getMeeting('m1')?.mutedAt).toBeUndefined();
    const afterUnmute = await poll(app, 'm1');
    expect(afterUnmute.muted).toBe(false);
    expect(afterUnmute.commands.map((q) => q.command)).toEqual([{ type: 'mute' }, { type: 'unmute' }]);
  });

  it('say does not change the muted flag', async () => {
    const app = createApp(config);
    await post(app, 'm1', { type: 'say', text: 'hello' });
    expect(getMeeting('m1')?.mutedAt).toBeUndefined();
    expect((await poll(app, 'm1')).muted).toBe(false);
  });

  it.each(['completed', 'failed'] as const)(
    'POST to a %s meeting returns 409 NOT_LIVE, queues nothing and does not change mute',
    async (status) => {
      const app = createApp(config);
      setStatus('m1', status);

      for (const body of [{ type: 'say', text: 'hi' }, { type: 'mute' }]) {
        const res = await post(app, 'm1', body);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe('NOT_LIVE');
      }

      expect(getMeeting('m1')?.mutedAt).toBeUndefined();
      expect(commandsAfter('m1', 0)).toEqual([]);
    },
  );

  it('never writes the say text to the logs, only type and seq', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const app = createApp(config);
    const secret = 'quarterly-numbers-are-confidential';
    const res = await post(app, 'm1', { type: 'say', text: secret });
    expect(res.status).toBe(201);

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(' '));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(secret);
    expect(logged.some((line) => line.includes('"type":"say"') && line.includes('"seq":1'))).toBe(true);
  });
});

describe('GET /api/meetings/:id/commands', () => {
  it('requires the meeting session token: anonymous, the owner and another meeting\'s token all get 401', async () => {
    registerMeeting({ meetingId: 'm2', teammate: 'david', persona: 'first_person', title: 'M2' });
    const app = createApp(config);

    const anon = await get(app, 'm1', '', {});
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('SESSION_REQUIRED');

    // The poll route is for the bot page only; the owner panel does not read it.
    const owner = await get(app, 'm1', '', ownerBearer);
    expect(owner.status).toBe(401);
    expect(((await owner.json()) as { code: string }).code).toBe('SESSION_REQUIRED');

    const otherMeeting = await get(app, 'm1', '', sessionHeader(config, 'm2', 'david'));
    expect(otherMeeting.status).toBe(401);

    const ok = await get(app, 'm1');
    expect(ok.status).toBe(200);
  });

  it('returns 404 not_found for an unknown meeting', async () => {
    const res = await get(createApp(config), 'nope', '', sessionHeader(config, 'nope', 'david'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('returns {commands: [], muted: false} before anything is queued', async () => {
    expect(await poll(createApp(config), 'm1')).toEqual({ commands: [], muted: false, listeningPaused: false });
  });

  it('delivers each command once as the poller advances ?after, in order', async () => {
    const app = createApp(config);
    await post(app, 'm1', { type: 'say', text: 'one' });
    await post(app, 'm1', { type: 'say', text: 'two' });

    const first = await poll(app, 'm1', '?after=0');
    expect(first.commands.map((q) => [q.seq, q.command])).toEqual([
      [1, { type: 'say', text: 'one' }],
      [2, { type: 'say', text: 'two' }],
    ]);
    for (const q of first.commands) expect(q.expiresAt).toBeTypeOf('number');

    expect((await poll(app, 'm1', '?after=2')).commands).toEqual([]);
    expect((await poll(app, 'm1', '?after=1')).commands.map((q) => q.seq)).toEqual([2]);

    await post(app, 'm1', { type: 'say', text: 'three' });
    expect((await poll(app, 'm1', '?after=2')).commands.map((q) => q.seq)).toEqual([3]);
  });

  it('treats a missing ?after as 0', async () => {
    const app = createApp(config);
    await post(app, 'm1', { type: 'say', text: 'one' });
    expect((await poll(app, 'm1')).commands.map((q) => q.seq)).toEqual([1]);
  });

  it.each(['abc', '-1', '1.5', '', '1e3'])('rejects ?after=%s with 400 BAD_REQUEST', async (after) => {
    const res = await get(createApp(config), 'm1', `?after=${after}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('does not return a command 30 seconds after it was queued', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const app = createApp(config);
    await post(app, 'm1', { type: 'say', text: 'too late' });

    vi.setSystemTime(1_700_000_000_000 + 29_999);
    expect((await poll(app, 'm1')).commands.map((q) => q.seq)).toEqual([1]);

    vi.setSystemTime(1_700_000_000_000 + 30_000);
    expect((await poll(app, 'm1')).commands).toEqual([]);
  });

  it('keeps reporting muted after the mute command itself has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const app = createApp(config);
    await post(app, 'm1', { type: 'mute' });

    vi.setSystemTime(1_700_000_000_000 + 60_000);
    expect(await poll(app, 'm1')).toEqual({ commands: [], muted: true, listeningPaused: false });
  });
});
