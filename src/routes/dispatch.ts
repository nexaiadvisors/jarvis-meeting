// POST /v1/dispatch — single dispatch primitive.
//
// Accepts a meeting URL, generates a meetingId, creates a Recall.ai bot, and
// returns {meetingId, botId}. Three callers will eventually hit this route:
//   1. Calendar watcher (auto-join on invite acceptance)
//   2. Slack slash command (/jarvis join <url>)
//   3. Dashboard "Join now" button
//
// Auth + attribution: the Bearer token IS the teammate identity. A per-teammate
// token registry (config.tokenRegistry, parsed from JARVIS_TOKENS) maps each
// token to a teammate slug. The request body can NOT override the teammate — the
// only body-controlled SOUL selection is `soul` (a slug to load INSTEAD of the
// teammate's own, e.g. the shared 'jarvis' team agent), and persona is derived
// from the loaded SOUL, never trusted from the body (anti-spoof).
//
// Token resolution:
//   - Owner panel: no bearer, a valid `jm_owner` cookie -> defaultTeammate, and the
//     SOUL is always that teammate's own (body.soul is ignored on this path). The
//     cookie path also needs a same-origin Origin header (403 ORIGIN_MISMATCH otherwise).
//   - JARVIS_TOKENS set + token matches a registry entry -> that teammate.
//   - JARVIS_TOKENS set + token unknown -> 401.
//   - Only legacy JARVIS_API_TOKEN set + it matches -> defaultTeammate (folded
//     into the registry at config load).
//   - Neither mechanism configured -> dev-mode warn + defaultTeammate.

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { createBot } from '../recall/create-bot.js';
import { registerMeeting, countLiveForTeammate } from '../meeting/registry.js';
import { loadSoul } from '../soul/loader.js';
import { resolveTeammate, type Config } from '../config.js';
import { mintMeetingSessionToken } from './session-token.js';
import { ownerCredential, rejectCrossOriginCookieWrite } from '../auth/owner.js';

/**
 * Grace added to the meeting's hard max duration when minting its session token.
 * The sweep leaves a meeting at maxDurationMs; the token must outlive that so the
 * bot page keeps working for the WHOLE meeting (the default 30 minute token
 * silently killed the page's polling, logging and retrieval mid-meeting).
 */
const SESSION_TOKEN_GRACE_MS = 15 * 60 * 1000;

export interface DispatchBody {
  meeting_url: string;
  title?: string;
  language_code?: string;
  /**
   * SOUL slug to load INSTEAD of the token-resolved teammate's own SOUL — e.g.
   * the shared 'jarvis' team agent. The teammate (attribution) still comes from
   * the token; only the loaded persona definition changes. Never used to spoof
   * identity: the registry record still records the token-resolved teammate.
   */
  soul?: string;
  /** Join to listen and take notes only: no answers, no chat posts except the join notice. */
  notes_only?: boolean;
  /** Let the bot look at the shared screen when asked. Off unless true (or SCREEN_SHARE_DEFAULT). */
  screen_share?: boolean;
}

export interface DispatchResponse {
  meetingId: string;
  botId: string;
}

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

export interface StartMeetingParams {
  /** Attribution: whose meeting this is. */
  teammate: string;
  meetingUrl: string;
  /** SOUL slug to load. Attribution stays with `teammate`. */
  soulSlug: string;
  title?: string;
  languageCode?: string;
  /** Listen and take notes only (see MeetingRecord.notesOnly). */
  notesOnly?: boolean;
  /** Screen viewing for this meeting. Defaults to config.screenShareDefault (false). */
  screenShare?: boolean;
}

export type StartMeetingResult =
  | { ok: true; meetingId: string; botId: string }
  | { ok: false; status: 400 | 502; error: string; code?: string };

/**
 * Create the Recall bot for a meeting and register it. The one join path: the dispatch
 * route (owner panel, calendar watcher, scripts) and the MCP join_meeting tool both
 * call this. Callers do auth and the concurrency check first. Persona is read from the
 * loaded SOUL, never from the caller.
 */
export async function startMeeting(config: Config, params: StartMeetingParams): Promise<StartMeetingResult> {
  const { teammate, soulSlug } = params;
  const meetingId = crypto.randomUUID();
  const screenShare = params.screenShare ?? config.screenShareDefault === true;

  let soul;
  try {
    soul = loadSoul(soulSlug, config.soulDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // loadSoul rejects a slug outside ^[a-z0-9-]{1,40}$ before it builds any
    // path (the slug can be caller-controlled). Surface that as its own code; a
    // valid slug with no file on disk stays SOUL_LOAD_FAILED.
    const code = message.startsWith('INVALID_SOUL_SLUG') ? 'INVALID_SOUL_SLUG' : 'SOUL_LOAD_FAILED';
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'dispatch: SOUL load failed',
        // Truncate: the slug can come from a request body.
        soulSlug: typeof soulSlug === 'string' ? soulSlug.slice(0, 80) : typeof soulSlug,
        code,
        error: message,
      }),
    );
    return { ok: false, status: 400, error: message, code };
  }

  // A facilitator or a stand-in joins under its own name; an assistant joins as the service's bot.
  const leadsOrStandsIn = soul.mode === 'facilitator' || soul.mode === 'stand_in';
  const botName = leadsOrStandsIn && soul.name.trim() !== '' ? soul.name.trim() : config.jarvisBotName;

  try {
    const sessionToken = mintMeetingSessionToken(config, {
      meetingId,
      teammate,
      ttlMs: config.maxDurationMs + SESSION_TOKEN_GRACE_MS,
    });
    const { botId } = await createBot({
      meetingUrl: params.meetingUrl.trim(),
      botName,
      meetingId,
      languageCode: params.languageCode ?? 'en',
      teammate,
      persona: soul.personaMode,
      soulSlug,
      sessionToken,
      ...(screenShare ? { screenShare: true } : {}),
    });

    registerMeeting({
      meetingId,
      botId,
      teammate,
      persona: soul.personaMode,
      title: params.title ?? 'Meeting',
      ...(params.notesOnly === true ? { notesOnly: true } : {}),
      ...(botName !== config.jarvisBotName ? { botName } : {}),
      ...(soulSlug !== teammate ? { soulSlug } : {}),
      ...(soul.mode === 'facilitator' ? { facilitator: true } : {}),
      ...(soul.mode === 'stand_in' ? { standIn: true } : {}),
      ...(screenShare ? { screenShare: true } : {}),
    });
    return { ok: true, meetingId, botId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', msg: 'dispatch: createBot failed', error: message }));
    return { ok: false, status: 502, error: message };
  }
}

export function createDispatchRoute(config: Config): Hono {
  const app = new Hono();

  app.post('/v1/dispatch', async (c) => {
    // Auth + teammate resolution. The token identifies the teammate.
    let teammate: string;
    // The owner panel authenticates with the HttpOnly `jm_owner` cookie, never a
    // bearer. A request that carries any Authorization header takes the bearer path
    // below, so a teammate token keeps its own identity and a bad bearer is a 401
    // even when a valid cookie rides along.
    const credential = c.req.header('authorization') === undefined ? ownerCredential(c, config) : undefined;
    const ownerPanel = credential === 'cookie';
    if (ownerPanel) {
      // The cookie rides along on any request the browser makes, so only our own page may spend Recall minutes with it.
      const refused = rejectCrossOriginCookieWrite(c, config, credential);
      if (refused !== null) return refused;
      teammate = config.defaultTeammate;
    } else if (config.tokenRegistry.size > 0) {
      const header = c.req.header('authorization') ?? '';
      const match = /^bearer\s+(.+)$/i.exec(header.trim());
      const presented = match?.[1] ?? '';
      // Constant-time scan over known tokens, then registry lookup. The scan
      // avoids leaking which token matched via early-exit timing.
      let matchedToken: string | undefined;
      for (const known of config.tokenRegistry.keys()) {
        if (constantTimeEqual(presented, known)) matchedToken = known;
      }
      const resolved =
        matchedToken !== undefined ? resolveTeammate(config.tokenRegistry, matchedToken) : undefined;
      if (resolved === undefined) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      teammate = resolved;
    } else {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'no dispatch tokens configured (JARVIS_TOKENS / JARVIS_API_TOKEN unset) — endpoint is unauthenticated (dev mode)',
        }),
      );
      teammate = config.defaultTeammate;
    }

    // Per-teammate concurrency cap (cost control: each live bot runs the
    // expensive web_4_core variant). Checked AFTER teammate resolution and
    // BEFORE createBot, so an over-cap teammate never spins up a paid bot.
    // NOTE: count-then-register is not atomic — two simultaneous dispatches for
    // the same teammate can both pass before either registers, briefly exceeding
    // the cap by one. Acceptable at the pilot's single-digit concurrency; revisit
    // with a reserve-slot-before-createBot pattern if strict cost ceilings matter.
    if (countLiveForTeammate(teammate) >= config.maxConcurrentPerTeammate) {
      return c.json(
        {
          error: `teammate "${teammate}" already has ${config.maxConcurrentPerTeammate} live meeting(s)`,
          code: 'CONCURRENCY_LIMIT',
        },
        429,
      );
    }

    const body = (await c.req.json().catch(() => null)) as DispatchBody | null;
    if (!body || typeof body.meeting_url !== 'string' || body.meeting_url.trim() === '') {
      return c.json({ error: 'meeting_url is required', code: 'BAD_REQUEST' }, 400);
    }

    const started = await startMeeting(config, {
      teammate,
      meetingUrl: body.meeting_url,
      // The owner panel cannot choose a SOUL: it always runs the default teammate's own.
      soulSlug: ownerPanel ? teammate : (body.soul ?? teammate),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.language_code !== undefined ? { languageCode: body.language_code } : {}),
      ...(body.notes_only === true ? { notesOnly: true } : {}),
      ...(typeof body.screen_share === 'boolean' ? { screenShare: body.screen_share } : {}),
    });
    if (!started.ok) {
      return c.json(
        { error: started.error, ...(started.code !== undefined ? { code: started.code } : {}) },
        started.status,
      );
    }
    const response: DispatchResponse = { meetingId: started.meetingId, botId: started.botId };
    return c.json(response, 201);
  });

  return app;
}
