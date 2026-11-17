import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Config } from '../src/config.js';
import { isOwnerRequest, ownerCookieValue, ownerCredential, requireOwner } from '../src/auth/owner.js';
import { createPanelAuthRoutes } from '../src/routes/panel-auth.js';

const OWNER = 'owner-token-for-tests';
const PUBLIC_ORIGIN = 'https://panel.example.com';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ownerToken: OWNER,
    publicBaseUrl: `${PUBLIC_ORIGIN}/`,
    defaultTeammate: 'david',
    tokenRegistry: new Map([[OWNER, 'david']]),
    ...overrides,
  } as Config;
}

function mount(config: Config): Hono {
  const app = new Hono();
  app.route('/', createPanelAuthRoutes(config));
  app.get('/whoami', (c) => c.json({ owner: isOwnerRequest(c, config) }));
  app.get('/credential', (c) => c.json({ credential: ownerCredential(c, config) ?? null }));
  app.get('/private', requireOwner(config), (c) => c.json({ ok: true }));
  app.all('/write', requireOwner(config), (c) => c.json({ ok: true, method: c.req.method }));
  return app;
}

function login(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request('http://x/panel/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );
}

describe('ownerCookieValue', () => {
  it('is base64url HMAC-SHA256 of the fixed label keyed by OWNER_TOKEN', () => {
    const expected = createHmac('sha256', OWNER).update('jm-owner-cookie-v1').digest('base64url');
    expect(ownerCookieValue(makeConfig())).toBe(expected);
  });

  it('throws when OWNER_TOKEN is not configured', () => {
    expect(() => ownerCookieValue(makeConfig({ ownerToken: undefined }))).toThrow(/OWNER_TOKEN/);
  });
});

describe('POST /panel/login', () => {
  it('login with right token sets jm_owner cookie with HttpOnly, Secure, SameSite=Strict', async () => {
    const res = await login(mount(makeConfig()), { token: OWNER });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`jm_owner=${ownerCookieValue(makeConfig())}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('never puts the raw owner token in the cookie or the body', async () => {
    const res = await login(mount(makeConfig()), { token: OWNER });

    expect(res.headers.get('set-cookie') ?? '').not.toContain(OWNER);
    expect(await res.text()).not.toContain(OWNER);
  });

  it('wrong token sets no cookie', async () => {
    const res = await login(mount(makeConfig()), { token: 'nope' });

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe('OWNER_TOKEN_INVALID');
  });

  it('the cookie value itself is not accepted as a login token', async () => {
    const res = await login(mount(makeConfig()), { token: ownerCookieValue(makeConfig()) });

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['missing token', {}],
    ['non-string token', { token: 123 }],
    ['empty token', { token: '' }],
  ])('%s is a 400 with no cookie', async (_label, body) => {
    const res = await login(mount(makeConfig()), body);

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('is a 503 with no cookie when OWNER_TOKEN is not configured', async () => {
    const res = await login(mount(makeConfig({ ownerToken: undefined })), { token: 'anything' });

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe('OWNER_NOT_CONFIGURED');
  });
});

describe('POST /panel/logout', () => {
  it('expires the jm_owner cookie', async () => {
    const res = await mount(makeConfig()).fetch(new Request('http://x/panel/logout', { method: 'POST' }));

    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^jm_owner=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
  });
});

describe('isOwnerRequest', () => {
  async function whoami(app: Hono, headers: Record<string, string>): Promise<boolean> {
    const res = await app.fetch(new Request('http://x/whoami', { headers }));
    return ((await res.json()) as { owner: boolean }).owner;
  }

  it('accepts bearer OWNER_TOKEN and the cookie, rejects other values', async () => {
    const app = mount(makeConfig());
    const cookie = ownerCookieValue(makeConfig());

    expect(await whoami(app, { authorization: `Bearer ${OWNER}` })).toBe(true);
    expect(await whoami(app, { cookie: `jm_owner=${cookie}` })).toBe(true);
    expect(await whoami(app, { cookie: `other=1; jm_owner=${cookie}; x=2` })).toBe(true);

    expect(await whoami(app, {})).toBe(false);
    expect(await whoami(app, { authorization: 'Bearer wrong' })).toBe(false);
    expect(await whoami(app, { authorization: OWNER })).toBe(false);
    expect(await whoami(app, { cookie: 'jm_owner=wrong' })).toBe(false);
    expect(await whoami(app, { cookie: `jm_owner=${OWNER}` })).toBe(false);
  });

  it('rejects a teammate dispatch token that is not the owner token', async () => {
    const config = makeConfig({ tokenRegistry: new Map([[OWNER, 'david'], ['tok-alice', 'alice']]) });

    expect(await whoami(mount(config), { authorization: 'Bearer tok-alice' })).toBe(false);
  });

  it('rejects everything when OWNER_TOKEN is not configured', async () => {
    const app = mount(makeConfig({ ownerToken: undefined }));

    expect(await whoami(app, {})).toBe(false);
    expect(await whoami(app, { authorization: 'Bearer undefined' })).toBe(false);
    expect(await whoami(app, { authorization: 'Bearer ' })).toBe(false);
    expect(await whoami(app, { cookie: 'jm_owner=' })).toBe(false);
  });
});

describe('requireOwner', () => {
  it('returns 401 OWNER_REQUIRED without credentials', async () => {
    const res = await mount(makeConfig()).fetch(new Request('http://x/private'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'owner credential required', code: 'OWNER_REQUIRED' });
  });

  it('returns 401 OWNER_REQUIRED for a wrong bearer or cookie', async () => {
    const app = mount(makeConfig());

    const bearer = await app.fetch(new Request('http://x/private', { headers: { authorization: 'Bearer wrong' } }));
    const cookie = await app.fetch(new Request('http://x/private', { headers: { cookie: 'jm_owner=wrong' } }));

    expect(bearer.status).toBe(401);
    expect(cookie.status).toBe(401);
  });

  it('lets the owner bearer and the owner cookie through', async () => {
    const app = mount(makeConfig());
    const cookie = ownerCookieValue(makeConfig());

    const bearer = await app.fetch(new Request('http://x/private', { headers: { authorization: `Bearer ${OWNER}` } }));
    const viaCookie = await app.fetch(new Request('http://x/private', { headers: { cookie: `jm_owner=${cookie}` } }));

    expect(bearer.status).toBe(200);
    expect(viaCookie.status).toBe(200);
  });
});

describe('ownerCredential', () => {
  async function credentialOf(headers: Record<string, string>): Promise<string | null> {
    const res = await mount(makeConfig()).fetch(new Request('http://x/credential', { headers }));
    return ((await res.json()) as { credential: string | null }).credential;
  }

  it('reports which credential matched', async () => {
    const cookie = `jm_owner=${ownerCookieValue(makeConfig())}`;

    expect(await credentialOf({ authorization: `Bearer ${OWNER}` })).toBe('bearer');
    expect(await credentialOf({ cookie })).toBe('cookie');
    expect(await credentialOf({})).toBeNull();
    expect(await credentialOf({ authorization: 'Bearer wrong', cookie: 'jm_owner=wrong' })).toBeNull();
  });

  it('prefers the bearer when both match, and falls back to the cookie when the bearer is not the owner', async () => {
    const cookie = `jm_owner=${ownerCookieValue(makeConfig())}`;

    expect(await credentialOf({ authorization: `Bearer ${OWNER}`, cookie })).toBe('bearer');
    expect(await credentialOf({ authorization: 'Bearer tok-alice', cookie })).toBe('cookie');
  });
});

describe('requireOwner: cookie-authenticated writes must be same-origin', () => {
  const cookie = () => `jm_owner=${ownerCookieValue(makeConfig())}`;

  function write(method: string, headers: Record<string, string>): Promise<Response> {
    return Promise.resolve(mount(makeConfig()).fetch(new Request('http://x/write', { method, headers })));
  }

  it('cookie POST with the matching Origin succeeds (the panel\'s own fetch)', async () => {
    const res = await write('POST', { cookie: cookie(), origin: PUBLIC_ORIGIN });

    expect(res.status).toBe(200);
  });

  it.each([
    ['a different origin', { origin: 'https://evil.example.com' }],
    ['a same-site sibling origin', { origin: 'https://other.example.com' }],
    ['a different scheme', { origin: 'http://panel.example.com' }],
    ['a different port', { origin: 'https://panel.example.com:8443' }],
    ['the opaque origin "null"', { origin: 'null' }],
    ['no Origin header', {}],
  ])('cookie POST with %s gets 403 ORIGIN_MISMATCH', async (_label, extra) => {
    const res = await write('POST', { cookie: cookie(), ...extra });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ORIGIN_MISMATCH');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('cookie %s with no Origin gets 403 ORIGIN_MISMATCH', async (method) => {
    const res = await write(method, { cookie: cookie() });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ORIGIN_MISMATCH');
  });

  it('bearer POST with no Origin still succeeds, and so does one with a foreign Origin', async () => {
    const bare = await write('POST', { authorization: `Bearer ${OWNER}` });
    const foreign = await write('POST', { authorization: `Bearer ${OWNER}`, origin: 'https://evil.example.com' });

    expect(bare.status).toBe(200);
    expect(foreign.status).toBe(200);
  });

  it('cookie GET with no Origin still succeeds', async () => {
    const res = await mount(makeConfig()).fetch(new Request('http://x/private', { headers: { cookie: cookie() } }));

    expect(res.status).toBe(200);
  });

  it('a request with no valid credential is 401 (not 403), whatever its Origin', async () => {
    const anon = await write('POST', { origin: 'https://evil.example.com' });
    const forged = await write('POST', { cookie: 'jm_owner=forged', origin: 'https://evil.example.com' });

    expect(anon.status).toBe(401);
    expect(forged.status).toBe(401);
  });

  it('refuses a cookie write when PUBLIC_BASE_URL cannot be parsed (fails closed)', async () => {
    const config = makeConfig({ publicBaseUrl: 'not a url' });
    const res = await mount(config).fetch(
      new Request('http://x/write', {
        method: 'POST',
        headers: { cookie: `jm_owner=${ownerCookieValue(config)}`, origin: 'not a url' },
      }),
    );

    expect(res.status).toBe(403);
  });
});
