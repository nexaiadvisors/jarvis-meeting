import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { ownerCookieValue } from '../auth/owner.js';

// Mock createBot so dispatch tests never hit Recall.ai.
const mockCreateBot = vi.fn(async () => ({ botId: 'bot-dispatch-1' }));
vi.mock('../recall/create-bot.js', () => ({
  createBot: mockCreateBot,
}));

// Mock the registry so we can assert what was registered without cross-test bleed.
const mockRegisterMeeting = vi.fn(() => ({}));
const mockCountLiveForTeammate = vi.fn(() => 0);
vi.mock('../meeting/registry.js', () => ({
  registerMeeting: mockRegisterMeeting,
  countLiveForTeammate: mockCountLiveForTeammate,
}));

const { createDispatchRoute } = await import('./dispatch.js');

let soulDir: string;

function writeSoul(slug: string, frontMatter: string): void {
  writeFileSync(join(soulDir, `${slug}.md`), `---\n${frontMatter}\n---\nprose\n`, 'utf8');
}

function baseConfig(overrides: Partial<Config>): Config {
  return {
    port: 8787,
    recallApiKey: 'rk',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600000,
    maxDurationMs: 7200000,
    sweepIntervalMs: 60000,
    publicBaseUrl: 'https://ngrok.example.com',
    teamKbAnswerEndpoint: undefined,
    teamKbAnswerApiToken: undefined,
    teamKbFallbackUrl: 'http://localhost:3031',
    jarvisBotName: 'Jarvis',
    jarvisApiToken: undefined,
    webhookSecret: undefined,
    tokenRegistry: new Map<string, string>(),
    soulDir,
    teamKbEndpoint: undefined,
    defaultTeammate: 'example',
    azureStorageAccountName: undefined,
    azureStorageAccountKey: undefined,
    azureStorageBlobContainer: undefined,
    artifactSasTtlHours: 168,
    anthropicApiKey: undefined,
    anthropicModel: 'claude-sonnet-4-6',
    graphTenantId: undefined,
    graphClientId: undefined,
    graphClientSecret: undefined,
    meetingEmailSender: undefined,
    meetingEmailDefaultRecipients: [],
    slackBotToken: undefined,
    meetingSlackChannel: undefined,
    ...overrides,
  };
}

function makeApp(config: Config): Hono {
  const app = new Hono();
  app.route('/', createDispatchRoute(config));
  return app;
}

async function dispatch(app: Hono, opts: { token?: string; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`;
  return app.fetch(
    new Request('http://localhost/v1/dispatch', {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body ?? { meeting_url: 'https://meet.google.com/abc' }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  soulDir = mkdtempSync(join(tmpdir(), 'dispatch-soul-'));
  // SOULs available to all tests.
  writeSoul('david', 'name: David Delegate\nowner: david\npersona_mode: first_person');
  writeSoul('alice', 'name: Alice Delegate\nowner: alice\npersona_mode: first_person');
  writeSoul('jarvis', 'name: Jarvis\nowner: example\npersona_mode: ai');
  writeSoul('example', 'name: Jarvis\nowner: example\npersona_mode: ai');
  mockCreateBot.mockResolvedValue({ botId: 'bot-dispatch-1' });
  mockCountLiveForTeammate.mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  try { rmSync(soulDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('dispatch token -> teammate mapping', () => {
  it('resolves the teammate from the bearer token registry', async () => {
    const config = baseConfig({
      tokenRegistry: new Map([['tok-david', 'david'], ['tok-alice', 'alice']]),
    });
    const resp = await dispatch(makeApp(config), { token: 'tok-david' });

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({
        teammate: 'david',
        soulSlug: 'david',
        persona: 'first_person',
        sessionToken: expect.stringMatching(/^[^.]+\.[^.]+$/),
      }),
    );
    expect(mockRegisterMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', persona: 'first_person' }),
    );
  });

  it('maps a different token to a different teammate', async () => {
    const config = baseConfig({
      tokenRegistry: new Map([['tok-david', 'david'], ['tok-alice', 'alice']]),
    });
    await dispatch(makeApp(config), { token: 'tok-alice' });
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'alice' }));
  });
});

describe('dispatch unknown token', () => {
  it('returns 401 when the token is not in the registry', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });
    const resp = await dispatch(makeApp(config), { token: 'nope' });

    expect(resp.status).toBe(401);
    expect(mockCreateBot).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is presented but a registry is configured', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });
    const resp = await dispatch(makeApp(config), {});
    expect(resp.status).toBe(401);
  });
});

describe('dispatch legacy token', () => {
  it('maps the legacy JARVIS_API_TOKEN to defaultTeammate', async () => {
    // config load folds JARVIS_API_TOKEN into the registry mapping to defaultTeammate.
    const config = baseConfig({
      defaultTeammate: 'example',
      jarvisApiToken: 'legacy-tok',
      tokenRegistry: new Map([['legacy-tok', 'example']]),
    });
    const resp = await dispatch(makeApp(config), { token: 'legacy-tok' });

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'example' }));
  });
});

describe('dispatch dev mode (no tokens configured)', () => {
  it('allows the request and uses defaultTeammate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = baseConfig({ defaultTeammate: 'example', tokenRegistry: new Map() });
    const resp = await dispatch(makeApp(config), {});

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'example' }));
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('dispatch body cannot override teammate (anti-spoof)', () => {
  it('ignores any teammate field in the body; teammate stays token-derived', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });
    await dispatch(makeApp(config), {
      token: 'tok-david',
      body: { meeting_url: 'https://meet.google.com/abc', teammate: 'alice', persona: 'jarvis' },
    });

    // teammate comes from the token (david), NOT the body (alice).
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'david' }));
    expect(mockRegisterMeeting).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'david' }));
  });

  it('honors body.soul as the loaded SOUL slug while attribution stays with the token teammate', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });
    await dispatch(makeApp(config), {
      token: 'tok-david',
      body: { meeting_url: 'https://meet.google.com/abc', soul: 'jarvis' },
    });

    // soulSlug = jarvis (the shared team agent), persona derived from that SOUL ('ai'),
    // but the registered teammate is still david (token-resolved).
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', soulSlug: 'jarvis', persona: 'ai' }),
    );
    expect(mockRegisterMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', persona: 'ai' }),
    );
  });
});

describe('dispatch per-teammate concurrency cap', () => {
  it('returns 429 CONCURRENCY_LIMIT when the teammate is already at the cap', async () => {
    mockCountLiveForTeammate.mockReturnValue(2);
    const config = baseConfig({
      tokenRegistry: new Map([['tok-david', 'david']]),
      maxConcurrentPerTeammate: 2,
    });
    const resp = await dispatch(makeApp(config), { token: 'tok-david' });
    const json = (await resp.json()) as { code?: string };

    expect(resp.status).toBe(429);
    expect(json.code).toBe('CONCURRENCY_LIMIT');
    expect(mockCreateBot).not.toHaveBeenCalled();
    expect(mockCountLiveForTeammate).toHaveBeenCalledWith('david');
  });

  it('allows the dispatch when under the cap', async () => {
    mockCountLiveForTeammate.mockReturnValue(1);
    const config = baseConfig({
      tokenRegistry: new Map([['tok-david', 'david']]),
      maxConcurrentPerTeammate: 2,
    });
    const resp = await dispatch(makeApp(config), { token: 'tok-david' });

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch validation', () => {
  it('returns 400 when meeting_url is missing', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });
    const resp = await dispatch(makeApp(config), { token: 'tok-david', body: {} });
    expect(resp.status).toBe(400);
  });

  it('returns 400 when the resolved SOUL is missing on disk', async () => {
    const config = baseConfig({ tokenRegistry: new Map([['tok-ghost', 'ghost']]) });
    const resp = await dispatch(makeApp(config), { token: 'tok-ghost' });
    const json = (await resp.json()) as { code?: string };
    expect(resp.status).toBe(400);
    expect(json.code).toBe('SOUL_LOAD_FAILED');
  });
});

describe('dispatch SOUL slug validation', () => {
  const tokenConfig = () => baseConfig({ tokenRegistry: new Map([['tok-david', 'david']]) });

  it('dispatch with soul "../../etc/passwd" returns 400 INVALID_SOUL_SLUG and creates no bot', async () => {
    const resp = await dispatch(makeApp(tokenConfig()), {
      token: 'tok-david',
      body: { meeting_url: 'https://meet.google.com/abc', soul: '../../etc/passwd' },
    });
    const json = (await resp.json()) as { code?: string; error?: string };

    expect(resp.status).toBe(400);
    expect(json.code).toBe('INVALID_SOUL_SLUG');
    expect(mockCreateBot).not.toHaveBeenCalled();
    expect(mockRegisterMeeting).not.toHaveBeenCalled();
  });

  it.each([
    ['uppercase', 'David'],
    ['slash', 'a/b'],
    ['empty', ''],
    ['too long', 'x'.repeat(41)],
    ['non-string', { evil: true }],
  ])('rejects a %s soul slug with 400 INVALID_SOUL_SLUG', async (_label, soul) => {
    const resp = await dispatch(makeApp(tokenConfig()), {
      token: 'tok-david',
      body: { meeting_url: 'https://meet.google.com/abc', soul },
    });
    const json = (await resp.json()) as { code?: string };

    expect(resp.status).toBe(400);
    expect(json.code).toBe('INVALID_SOUL_SLUG');
    expect(mockCreateBot).not.toHaveBeenCalled();
  });

  it('keeps SOUL_LOAD_FAILED for a valid slug whose file does not exist', async () => {
    const resp = await dispatch(makeApp(tokenConfig()), {
      token: 'tok-david',
      body: { meeting_url: 'https://meet.google.com/abc', soul: 'no-such-soul' },
    });
    const json = (await resp.json()) as { code?: string };

    expect(resp.status).toBe(400);
    expect(json.code).toBe('SOUL_LOAD_FAILED');
    expect(mockCreateBot).not.toHaveBeenCalled();
  });
});

describe('dispatch with the owner token', () => {
  it('accepts the OWNER_TOKEN bearer and resolves defaultTeammate', async () => {
    // Build the config the way production does so the OWNER_TOKEN -> defaultTeammate
    // registry entry comes from loadConfig itself, not from the test.
    vi.stubEnv('RECALL_API_KEY', 'rk-test');
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('OWNER_TOKEN', 'owner-test-token');
    vi.stubEnv('DEFAULT_TEAMMATE', 'david');
    vi.stubEnv('JARVIS_TOKENS', '');
    vi.stubEnv('JARVIS_API_TOKEN', '');
    const config = { ...loadConfig(), soulDir };

    const resp = await dispatch(makeApp(config), { token: 'owner-test-token' });

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', soulSlug: 'david', persona: 'first_person' }),
    );
    expect(mockRegisterMeeting).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'david' }));
  });

  it('still rejects a token that is neither the owner token nor a registered one', async () => {
    vi.stubEnv('RECALL_API_KEY', 'rk-test');
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('OWNER_TOKEN', 'owner-test-token');
    vi.stubEnv('DEFAULT_TEAMMATE', 'david');
    vi.stubEnv('JARVIS_TOKENS', '');
    vi.stubEnv('JARVIS_API_TOKEN', '');
    const config = { ...loadConfig(), soulDir };

    const resp = await dispatch(makeApp(config), { token: 'not-the-owner-token' });

    expect(resp.status).toBe(401);
    expect(mockCreateBot).not.toHaveBeenCalled();
  });
});

describe('dispatch with the owner cookie (the owner panel)', () => {
  const OWNER = 'owner-test-token';

  function ownerConfig(overrides: Partial<Config> = {}): Config {
    return baseConfig({
      ownerToken: OWNER,
      defaultTeammate: 'david',
      tokenRegistry: new Map([[OWNER, 'david'], ['tok-alice', 'alice']]),
      ...overrides,
    });
  }

  // The panel's own fetch: browsers send Origin on a POST, and it is the public base URL's origin.
  const PANEL_ORIGIN = 'https://ngrok.example.com';

  async function dispatchWithCookie(
    config: Config,
    cookie: string,
    body?: unknown,
    headers: Record<string, string> = { Origin: PANEL_ORIGIN },
  ): Promise<Response> {
    return makeApp(config).fetch(
      new Request('http://localhost/v1/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
        body: JSON.stringify(body ?? { meeting_url: 'https://meet.google.com/abc', title: 'Standup' }),
      }),
    );
  }

  it('dispatch with the owner cookie resolves the default teammate', async () => {
    const config = ownerConfig();
    const resp = await dispatchWithCookie(config, `jm_owner=${ownerCookieValue(config)}`);

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', soulSlug: 'david', persona: 'first_person' }),
    );
    expect(mockRegisterMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', title: 'Standup' }),
    );
  });

  it('works when the dispatch registry is empty (the cookie alone authenticates the owner)', async () => {
    const config = ownerConfig({ tokenRegistry: new Map() });
    const resp = await dispatchWithCookie(config, `jm_owner=${ownerCookieValue(config)}`);

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'david' }));
  });

  it('ignores body.soul: an owner-cookie dispatch always loads the default teammate\'s own SOUL', async () => {
    const config = ownerConfig();
    const resp = await dispatchWithCookie(config, `jm_owner=${ownerCookieValue(config)}`, {
      meeting_url: 'https://meet.google.com/abc',
      soul: 'jarvis',
    });

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.objectContaining({ teammate: 'david', soulSlug: 'david', persona: 'first_person' }),
    );
  });

  it.each([
    ['another origin', { Origin: 'https://evil.example.com' }],
    ['a same-site sibling origin', { Origin: 'https://other.example.com' }],
    ['no Origin header', {}],
  ])('dispatch with the owner cookie and %s gets 403 ORIGIN_MISMATCH and creates no bot', async (_label, headers) => {
    const config = ownerConfig();
    const resp = await dispatchWithCookie(config, `jm_owner=${ownerCookieValue(config)}`, undefined, headers);
    const json = (await resp.json()) as { code?: string };

    expect(resp.status).toBe(403);
    expect(json.code).toBe('ORIGIN_MISMATCH');
    expect(mockCountLiveForTeammate).not.toHaveBeenCalled();
    expect(mockCreateBot).not.toHaveBeenCalled();
    expect(mockRegisterMeeting).not.toHaveBeenCalled();
  });

  it('a bearer dispatch ignores Origin: the owner token without Origin, and with a foreign one, still works', async () => {
    const config = ownerConfig();
    for (const origin of [undefined, 'https://evil.example.com']) {
      const resp = await makeApp(config).fetch(
        new Request('http://localhost/v1/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OWNER}`,
            ...(origin !== undefined ? { Origin: origin } : {}),
          },
          body: JSON.stringify({ meeting_url: 'https://meet.google.com/abc' }),
        }),
      );
      expect(resp.status).toBe(201);
    }
  });

  it('rejects a cookie with a wrong value (401, no bot)', async () => {
    const resp = await dispatchWithCookie(ownerConfig(), 'jm_owner=not-the-hmac');

    expect(resp.status).toBe(401);
    expect(mockCreateBot).not.toHaveBeenCalled();
  });

  it('a teammate bearer still wins over the cookie, so a teammate token keeps its own identity', async () => {
    const config = ownerConfig();
    const resp = await makeApp(config).fetch(
      new Request('http://localhost/v1/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-alice',
          Cookie: `jm_owner=${ownerCookieValue(config)}`,
        },
        body: JSON.stringify({ meeting_url: 'https://meet.google.com/abc' }),
      }),
    );

    expect(resp.status).toBe(201);
    expect(mockCreateBot).toHaveBeenCalledWith(expect.objectContaining({ teammate: 'alice' }));
  });

  it('still applies the concurrency cap to an owner-cookie dispatch', async () => {
    mockCountLiveForTeammate.mockReturnValue(2);
    const config = ownerConfig();
    const resp = await dispatchWithCookie(config, `jm_owner=${ownerCookieValue(config)}`);

    expect(resp.status).toBe(429);
    expect(mockCountLiveForTeammate).toHaveBeenCalledWith('david');
    expect(mockCreateBot).not.toHaveBeenCalled();
  });
});
