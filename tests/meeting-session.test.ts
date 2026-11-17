import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { __clearRegistry, registerMeeting } from '../src/meeting/registry.js';
import { ownerCookieValue } from '../src/auth/owner.js';
import { mintMeetingSessionToken, verifyMeetingSessionToken } from '../src/routes/session-token.js';
import { requireMeetingAccess } from '../src/auth/meeting-session.js';
import { sessionHeader } from './helpers/session.js';

// Dispatch must never reach Recall.ai. The registry stays REAL so the TTL test
// exercises the token that dispatch actually hands to createBot.
const { mockCreateBot } = vi.hoisted(() => ({
  mockCreateBot: vi.fn(async (_params: { sessionToken?: string }) => ({ botId: 'bot-ttl-1' })),
}));
vi.mock('../src/recall/create-bot.js', () => ({ createBot: mockCreateBot }));

const { createDispatchRoute } = await import('../src/routes/dispatch.js');

const OWNER = 'owner-token-for-tests';
const TWO_HOURS_MS = 7_200_000;
let soulDir: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: TWO_HOURS_MS,
    maxConcurrentPerTeammate: 2,
    jarvisBotName: 'Jarvis',
    soulDir,
    tokenRegistry: new Map([[OWNER, 'david']]),
    ...overrides,
  } as Config;
}

/** Tiny app exposing the guard exactly as a route would call it. */
function mount(config: Config, opts?: { allowOwner?: boolean }): Hono {
  const app = new Hono();
  app.get('/guarded/:id', (c) => {
    const denied = requireMeetingAccess(c, config, c.req.param('id'), opts);
    if (denied) return denied;
    return c.json({ ok: true });
  });
  return app;
}

async function get(app: Hono, id: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://x/guarded/${id}`, { headers }));
}

beforeEach(() => {
  __clearRegistry();
  mockCreateBot.mockClear();
  soulDir = mkdtempSync(join(tmpdir(), 'meeting-session-soul-'));
  writeFileSync(join(soulDir, 'david.md'), '---\nname: David Delegate\nowner: david\npersona_mode: first_person\n---\nprose\n');
  registerMeeting({ meetingId: 'm1', teammate: 'david', persona: 'first_person', title: 'M1' });
  registerMeeting({ meetingId: 'm2', teammate: 'david', persona: 'first_person', title: 'M2' });
});

afterEach(() => {
  rmSync(soulDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('requireMeetingAccess', () => {
  it('returns 404 for an unknown meeting before checking the token', async () => {
    const config = makeConfig();
    const app = mount(config);

    // No credentials at all: still 404, never 401.
    const bare = await get(app, 'nope');
    expect(bare.status).toBe(404);
    expect(await bare.json()).toMatchObject({ code: 'not_found' });

    // A well-formed token minted for the unknown id: still 404.
    const withToken = await get(app, 'nope', sessionHeader(config, 'nope', 'david'));
    expect(withToken.status).toBe(404);
    expect(await withToken.json()).toMatchObject({ code: 'not_found' });
  });

  it('returns 401 SESSION_REQUIRED with no bearer', async () => {
    const res = await get(mount(makeConfig()), 'm1');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
  });

  it('returns 401 with a token minted for another meeting', async () => {
    const config = makeConfig();
    const res = await get(mount(config), 'm1', sessionHeader(config, 'm2', 'david'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
  });

  it('returns 401 with a token for this meeting but another teammate', async () => {
    const config = makeConfig();
    const res = await get(mount(config), 'm1', sessionHeader(config, 'm1', 'alice'));
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const config = makeConfig();
    const expired = mintMeetingSessionToken(config, {
      meetingId: 'm1',
      teammate: 'david',
      nowMs: Date.now() - 10_000,
      ttlMs: 1_000,
    });
    const res = await get(mount(config), 'm1', { Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a tampered or garbage bearer', async () => {
    const config = makeConfig();
    const good = mintMeetingSessionToken(config, { meetingId: 'm1', teammate: 'david' });
    const tampered = `${good.slice(0, -2)}xx`;
    expect((await get(mount(config), 'm1', { Authorization: `Bearer ${tampered}` })).status).toBe(401);
    expect((await get(mount(config), 'm1', { Authorization: 'Bearer not-a-token' })).status).toBe(401);
  });

  it('allows a valid token for the same meeting', async () => {
    const config = makeConfig();
    const res = await get(mount(config), 'm1', sessionHeader(config, 'm1', 'david'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('allows the owner cookie only when allowOwner is true', async () => {
    const config = makeConfig();
    const cookie = { Cookie: `jm_owner=${ownerCookieValue(config)}` };

    expect((await get(mount(config), 'm1', cookie)).status).toBe(401);
    expect((await get(mount(config, { allowOwner: false }), 'm1', cookie)).status).toBe(401);
    expect((await get(mount(config, { allowOwner: true }), 'm1', cookie)).status).toBe(200);
  });

  it('allows the owner bearer only when allowOwner is true', async () => {
    const config = makeConfig();
    const bearer = { Authorization: `Bearer ${OWNER}` };

    expect((await get(mount(config), 'm1', bearer)).status).toBe(401);
    expect((await get(mount(config, { allowOwner: true }), 'm1', bearer)).status).toBe(200);
  });

  it('allowOwner does not admit a wrong owner cookie, nor any owner when OWNER_TOKEN is unset', async () => {
    const config = makeConfig();
    expect((await get(mount(config, { allowOwner: true }), 'm1', { Cookie: 'jm_owner=forged' })).status).toBe(401);

    const noOwner = makeConfig({ ownerToken: undefined, tokenRegistry: new Map() });
    expect((await get(mount(noOwner, { allowOwner: true }), 'm1', { Authorization: `Bearer ${OWNER}` })).status).toBe(401);
  });

  it('still lets a valid session token through when allowOwner is true', async () => {
    const config = makeConfig();
    const res = await get(mount(config, { allowOwner: true }), 'm1', sessionHeader(config, 'm1', 'david'));
    expect(res.status).toBe(200);
  });
});

describe('dispatch session token lifetime', () => {
  it('token minted at dispatch still verifies at +2h', async () => {
    // Start empty: the shared beforeEach meetings would put david at his concurrency cap.
    __clearRegistry();
    const config = makeConfig();
    const app = new Hono();
    app.route('/', createDispatchRoute(config));

    const before = Date.now();
    const res = await app.fetch(
      new Request('http://x/v1/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OWNER}` },
        body: JSON.stringify({ meeting_url: 'https://meet.google.com/abc-defg-hij' }),
      }),
    );
    const after = Date.now();
    expect(res.status).toBe(201);
    const { meetingId } = (await res.json()) as { meetingId: string };

    expect(mockCreateBot).toHaveBeenCalledTimes(1);
    const sessionToken = mockCreateBot.mock.calls[0]![0].sessionToken;
    expect(typeof sessionToken).toBe('string');

    const params = { meetingId, teammate: 'david' };
    // A meeting that runs the full +2h (maxDurationMs) plus a minute is still authorised.
    expect(verifyMeetingSessionToken(config, sessionToken!, { ...params, nowMs: before + TWO_HOURS_MS + 60_000 })).toBe(true);
    // The TTL is maxDurationMs + 15 minutes: valid just inside it, dead just past it.
    const ttlMs = TWO_HOURS_MS + 15 * 60 * 1000;
    expect(verifyMeetingSessionToken(config, sessionToken!, { ...params, nowMs: before + ttlMs - 1 })).toBe(true);
    expect(verifyMeetingSessionToken(config, sessionToken!, { ...params, nowMs: after + ttlMs + 1 })).toBe(false);
  });
});
