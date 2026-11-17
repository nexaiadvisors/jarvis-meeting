// Routes for the 4-option Live Avatar Switcher:
//   GET  /api/owner/avatar-provider           -> active provider + catalog of all 4 options
//   POST /api/owner/avatar-provider           -> switch active avatar provider live
//   POST /api/meetings/:id/avatar-session     -> mint/fetch avatar session for a live meeting tile

import { Hono } from 'hono';
import type { Config } from '../config.js';
import { requireOwner } from '../auth/owner.js';
import { requireMeetingAccess } from '../auth/meeting-session.js';
import {
  getActiveAvatarProvider,
  getAvatarProviderCatalog,
  isValidAvatarProviderId,
  mintAvatarSession,
  setActiveAvatarProvider,
} from '../avatar/providers.js';

/**
 * The one provider that calls no outside service. Every other provider may spend a server
 * API key, so it is treated as paid: deny by default, not a list of known paid ones.
 */
const FREE_PROVIDER = 'google-live-avatar';
/** A meeting may open a paid face session at most this often, and this many times in all. */
export const PAID_SESSION_MIN_INTERVAL_MS = 30_000;
export const PAID_SESSION_MAX_PER_MEETING = 20;

export function createAvatarRoutes(config: Config): Hono {
  const app = new Hono();
  // Paid sessions opened per meeting. In memory: a restart resets it, and a meeting's
  // page opens a new session only after three idle minutes or at the session limit.
  const paidSessions = new Map<string, { count: number; lastAt: number }>();

  app.get('/api/owner/avatar-provider', requireOwner(config), (c) => {
    return c.json({
      activeProvider: getActiveAvatarProvider(),
      providers: getAvatarProviderCatalog(),
    });
  });

  app.post('/api/owner/avatar-provider', requireOwner(config), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const requested = body?.['provider'];
    if (!isValidAvatarProviderId(requested)) {
      return c.json(
        {
          error:
            'Invalid avatar provider. Expected one of: google-live-avatar, simli, heygen-live-avatar, alibaba-live-avatar',
          code: 'BAD_REQUEST',
        },
        400,
      );
    }
    const activeProvider = setActiveAvatarProvider(requested);
    return c.json({
      activeProvider,
      providers: getAvatarProviderCatalog(),
    });
  });

  app.post('/api/meetings/:id/avatar-session', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id, { allowOwner: true });
    if (denied) return denied;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const requested = isValidAvatarProviderId(body['provider']) ? body['provider'] : undefined;
    const provider = requested ?? getActiveAvatarProvider();
    if (provider !== FREE_PROVIDER) {
      // A paid session costs money each time. It is opened only for the provider the
      // owner has switched on, and only at a bounded rate per meeting, so a holder of
      // one meeting's token cannot run up sessions.
      if (provider !== getActiveAvatarProvider()) {
        return c.json({ error: 'That avatar provider is not switched on.', code: 'PROVIDER_NOT_ACTIVE' }, 403);
      }
      const now = Date.now();
      const used = paidSessions.get(id) ?? { count: 0, lastAt: 0 };
      if (used.count >= PAID_SESSION_MAX_PER_MEETING || now - used.lastAt < PAID_SESSION_MIN_INTERVAL_MS) {
        return c.json({ error: 'Too many avatar sessions for this meeting.', code: 'RATE_LIMITED', fallbackReason: 'avatar_session_rate_limited' }, 429);
      }
      paidSessions.set(id, { count: used.count + 1, lastAt: now });
    }
    const session = await mintAvatarSession(id, requested);
    return c.json(session);
  });

  return app;
}
