// Owner panel session endpoints.
//
//   POST /panel/login   body {token}  -> sets the `jm_owner` cookie when token === OWNER_TOKEN
//   POST /panel/logout                -> expires the cookie
//
// A wrong token never sets a cookie. Errors are JSON with a machine-readable `code`.

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import {
  OWNER_COOKIE_NAME,
  OWNER_COOKIE_OPTIONS,
  isOwnerToken,
  ownerCookieValue,
} from '../auth/owner.js';

export function createPanelAuthRoutes(config: Config): Hono {
  const app = new Hono();

  app.post('/panel/login', async (c) => {
    if (config.ownerToken === undefined) {
      return c.json({ error: 'owner login is not configured', code: 'OWNER_NOT_CONFIGURED' }, 503);
    }

    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = body !== null && typeof body === 'object' ? body.token : undefined;
    if (typeof token !== 'string' || token === '') {
      return c.json({ error: 'token is required', code: 'BAD_REQUEST' }, 400);
    }

    if (!isOwnerToken(config, token)) {
      return c.json({ error: 'invalid owner token', code: 'OWNER_TOKEN_INVALID' }, 401);
    }

    setCookie(c, OWNER_COOKIE_NAME, ownerCookieValue(config), OWNER_COOKIE_OPTIONS);
    return c.json({ ok: true });
  });

  app.post('/panel/logout', (c) => {
    setCookie(c, OWNER_COOKIE_NAME, '', { ...OWNER_COOKIE_OPTIONS, maxAge: 0 });
    return c.json({ ok: true });
  });

  return app;
}
