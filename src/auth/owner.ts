// Owner credential for the private owner panel and its API.
//
// The owner proves identity with either:
//   - a bearer token equal to OWNER_TOKEN (scripts, curl), or
//   - the `jm_owner` cookie set by POST /panel/login (the phone/browser panel).
// The cookie holds HMAC-SHA256(OWNER_TOKEN, "jm-owner-cookie-v1") base64url, never
// the raw token, so a leaked cookie cannot be replayed as a bearer token.
// With no OWNER_TOKEN configured nothing counts as the owner (fail closed).
//
// A cookie is sent by the browser on its own, so a cookie-authenticated WRITE (POST,
// PUT, PATCH, DELETE) must also come from our own page: its Origin header has to equal
// the origin of PUBLIC_BASE_URL (see rejectCrossOriginCookieWrite). SameSite=Strict
// alone would not stop a same-site, different-origin page. A bearer is never sent
// by the browser unasked, so bearer requests and reads are not subject to the rule.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import { extractBearerToken } from '../routes/session-token.js';

export const OWNER_COOKIE_NAME = 'jm_owner';

/** Cookie lifetime: 30 days. */
export const OWNER_COOKIE_MAX_AGE_SECONDS = 2_592_000;

/** Attributes for the owner cookie; logout reuses them with maxAge 0 so the flags match. */
export const OWNER_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: '/',
  maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
} as const;

const OWNER_COOKIE_LABEL = 'jm-owner-cookie-v1';

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a dummy compare to avoid timing side-channels on length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** The value stored in the `jm_owner` cookie. Throws when OWNER_TOKEN is not configured. */
export function ownerCookieValue(config: Config): string {
  if (config.ownerToken === undefined) {
    throw new Error('OWNER_TOKEN is not configured');
  }
  return createHmac('sha256', config.ownerToken).update(OWNER_COOKIE_LABEL).digest('base64url');
}

/** True when `presented` equals OWNER_TOKEN (constant-time). False when OWNER_TOKEN is unset. */
export function isOwnerToken(config: Config, presented: string): boolean {
  return config.ownerToken !== undefined && constantTimeEqual(presented, config.ownerToken);
}

/** Which owner credential a request carries. */
export type OwnerCredential = 'bearer' | 'cookie';

/**
 * The owner credential the request carries, or undefined. The bearer is checked first, so
 * a request with both reports 'bearer'; a request whose bearer is not the owner token but
 * whose cookie is valid reports 'cookie'.
 */
export function ownerCredential(c: Context, config: Config): OwnerCredential | undefined {
  if (config.ownerToken === undefined) return undefined;

  const bearer = extractBearerToken(c.req.header('authorization'));
  if (bearer !== undefined && isOwnerToken(config, bearer)) return 'bearer';

  const cookie = getCookie(c, OWNER_COOKIE_NAME);
  return cookie !== undefined && constantTimeEqual(cookie, ownerCookieValue(config)) ? 'cookie' : undefined;
}

/** True when the request carries the owner bearer token or a valid `jm_owner` cookie. */
export function isOwnerRequest(c: Context, config: Config): boolean {
  return ownerCredential(c, config) !== undefined;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The origin of PUBLIC_BASE_URL, or undefined when it is unparseable or opaque (so the rule fails closed). */
function ownOrigin(config: Config): string | undefined {
  try {
    const origin = new URL(config.publicBaseUrl).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF guard for the cookie credential, the single place the rule lives. Returns the 403
 * ORIGIN_MISMATCH response when the request is a state-changing write authenticated by the
 * cookie and its Origin header is not exactly the origin of PUBLIC_BASE_URL (a missing
 * Origin counts as a mismatch); otherwise null. Bearer requests and reads always get null.
 * Callers pass the credential they already resolved with ownerCredential.
 */
export function rejectCrossOriginCookieWrite(
  c: Context,
  config: Config,
  credential: OwnerCredential | undefined,
): Response | null {
  if (credential !== 'cookie' || !STATE_CHANGING_METHODS.has(c.req.method)) return null;
  const expected = ownOrigin(config);
  if (expected !== undefined && c.req.header('origin') === expected) return null;
  return c.json({ error: 'cross-origin request refused', code: 'ORIGIN_MISMATCH' }, 403);
}

/**
 * Route guard: 401 OWNER_REQUIRED unless the request is from the owner; 403 ORIGIN_MISMATCH
 * for a cookie-authenticated write from another origin.
 */
export function requireOwner(config: Config): MiddlewareHandler {
  return async (c, next) => {
    const credential = ownerCredential(c, config);
    if (credential === undefined) {
      return c.json({ error: 'owner credential required', code: 'OWNER_REQUIRED' }, 401);
    }
    const refused = rejectCrossOriginCookieWrite(c, config, credential);
    if (refused !== null) return refused;
    await next();
  };
}
