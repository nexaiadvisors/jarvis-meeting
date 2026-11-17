// The private owner panel: the page, its bundle, and the owner-only API behind it.
//
//   GET  /panel                          public static page (web/panel/index.html)
//   GET  /panel.js                       public static bundle (public/panel.js, built by build-web.mjs)
//   GET  /api/owner/meetings             owner -> {meetings: [...]} newest first
//   POST /api/owner/meetings/:id/leave   owner -> 202 {ok:true} | 202 {ok:true, alreadyGone:true}
//                                                | 404 | 409 NO_BOT | 502 LEAVE_FAILED
//   GET  /api/owner/kb-health            owner -> {ok: boolean}
//
// The page and the bundle carry no data and no secrets, so they are public; the panel
// asks for the owner login before it calls anything else. Every /api/owner route sits
// behind requireOwner (bearer OWNER_TOKEN or the jm_owner cookie; a cookie write must
// also come from our own origin, else 403 ORIGIN_MISMATCH). Errors are JSON with a
// machine-readable `code`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../config.js';
import { requireOwner } from '../auth/owner.js';
import { loadSoul } from '../soul/loader.js';
import { findSupportedUrlInText } from '../calendar/extract-url.js';
import { getMeeting, listMeetings } from '../meeting/registry.js';
import { readNotes } from '../meeting/notes.js';
import { LEAVE_BACKSTOP_DELAY_MS, leaveMeeting } from '../meeting/leave.js';
import { probeBackendHealthy } from '../lifecycle/sweep.js';
import {
  getCalendarWatcherStatus,
  JOIN_MODES,
  saveJoinMode,
  setCalendarEventSkipOverride,
  saveMeetingSetting,
} from '../calendar/watcher.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/routes -> dist/routes at runtime; the repo root (where web/ and public/
// live) is two levels up in both layouts.
const pkgRoot = resolve(here, '..', '..');

/** How long the panel waits for the knowledge backend before calling it down. */
const KB_HEALTH_TIMEOUT_MS = 2_000;

export { LEAVE_BACKSTOP_DELAY_MS } from '../meeting/leave.js';

export interface PanelOptions {
  /** Delay before the Leave backstop starts the pipeline. Injectable for tests. */
  backstopDelayMs?: number;
}

// The page is same-origin only: one module script, one inline <style>, fetches to
// itself. It may not be framed (it holds the Leave and Say buttons).
const PANEL_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function readIndexHtml(): string {
  return readFileSync(resolve(pkgRoot, 'web/panel/index.html'), 'utf8');
}

function readBundle(): string {
  return readFileSync(resolve(pkgRoot, 'public/panel.js'), 'utf8');
}

export function createPanelRoutes(config: Config, options: PanelOptions = {}): Hono {
  const app = new Hono();
  const backstopDelayMs = options.backstopDelayMs ?? LEAVE_BACKSTOP_DELAY_MS;
  // Read once at startup (it is a tracked source file); the bundle is a build
  // artifact, read per request so a rebuild is picked up without a restart.
  const indexHtml = readIndexHtml();

  app.get('/panel', (c) => c.html(indexHtml, 200, { ...PANEL_HEADERS, 'Cache-Control': 'no-cache' }));

  app.get('/panel.js', (c) =>
    c.body(readBundle(), 200, {
      ...PANEL_HEADERS,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    }),
  );

  app.get('/api/owner/meetings', requireOwner(config), (c) =>
    c.json({
      meetings: listMeetings().map((m) => ({
        id: m.meetingId,
        title: m.title,
        status: m.status,
        inCall: m.inCall,
        muted: m.mutedAt !== undefined,
        notesCount: readNotes(m.botId ?? m.meetingId).length,
        obEntityKey: `meeting-${m.meetingId}`,
        ...(m.failureCode !== undefined ? { failureCode: m.failureCode } : {}),
      })),
    }),
  );

  app.post('/api/owner/meetings/:id/leave', requireOwner(config), async (c) => {
    const meeting = getMeeting(c.req.param('id'));
    if (!meeting) {
      return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    }
    const result = await leaveMeeting(config, meeting, backstopDelayMs);
    if (!result.ok) {
      return result.code === 'NO_BOT'
        ? c.json({ error: result.error, code: 'NO_BOT' }, 409)
        : c.json({ ok: false, error: result.error, code: 'LEAVE_FAILED' }, 502);
    }
    return c.json(result.alreadyGone ? { ok: true, alreadyGone: true } : { ok: true }, 202);
  });

  app.get('/api/owner/kb-health', requireOwner(config), async (c) => {
    const url = config.kbBackendHealthUrl;
    // probeBackendHealthy never throws; no configured URL means we cannot vouch for the backend.
    const ok = url !== undefined && url.trim() !== '' && (await probeBackendHealthy(url, KB_HEALTH_TIMEOUT_MS));
    return c.json({ ok });
  });

  app.get('/api/owner/upcoming', requireOwner(config), (c) => {
    return c.json(getCalendarWatcherStatus(config));
  });

  // The owner's join rule: which calendar meetings the bot joins without being asked.
  app.post('/api/owner/join-mode', requireOwner(config), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = JOIN_MODES.find((m) => m === body?.mode);
    if (!mode) return c.json({ error: `mode must be one of: ${JOIN_MODES.join(', ')}`, code: 'BAD_REQUEST' }, 400);
    saveJoinMode(mode);
    console.info(JSON.stringify({ level: 'info', msg: 'calendar join mode set', mode }));
    return c.json({ ok: true, ...getCalendarWatcherStatus(config) });
  });

  app.post('/api/owner/upcoming/skip', requireOwner(config), async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      eventKey?: unknown;
      skip?: unknown;
    } | null;
    if (
      !body ||
      typeof body.eventKey !== 'string' ||
      body.eventKey.trim() === '' ||
      typeof body.skip !== 'boolean'
    ) {
      return c.json({ error: 'eventKey (string) and skip (boolean) are required', code: 'BAD_REQUEST' }, 400);
    }
    setCalendarEventSkipOverride(body.eventKey.trim(), body.skip);
    return c.json({ ok: true, ...getCalendarWatcherStatus(config) });
  });

  // One meeting's persona (and, for an invite whose calendar copy has no link, its join
  // link). Keyed by series id, so it holds for every occurrence of a repeating meeting.
  // soul: a SOUL slug, or null for the default notetaker.
  app.post('/api/owner/upcoming/persona', requireOwner(config), async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      seriesId?: unknown;
      soul?: unknown;
      meetingUrl?: unknown;
      title?: unknown;
    } | null;
    const seriesId = typeof body?.seriesId === 'string' ? body.seriesId.trim() : '';
    if (seriesId === '' || seriesId.length > 200) {
      return c.json({ error: 'seriesId (string) is required', code: 'BAD_REQUEST' }, 400);
    }
    if (body!.soul !== undefined && body!.soul !== null && typeof body!.soul !== 'string') {
      return c.json({ error: 'soul must be a SOUL slug or null', code: 'BAD_REQUEST' }, 400);
    }
    const soul = typeof body!.soul === 'string' ? body!.soul.trim() : (body!.soul as null | undefined);
    if (typeof soul === 'string') {
      try {
        loadSoul(soul, config.soulDir);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err), code: 'SOUL_LOAD_FAILED' }, 400);
      }
    }
    let meetingUrl: string | null | undefined;
    if (body!.meetingUrl === null) meetingUrl = null;
    else if (typeof body!.meetingUrl === 'string') {
      const found = findSupportedUrlInText(body!.meetingUrl);
      if (!found) return c.json({ error: 'meetingUrl is not a supported meeting link', code: 'BAD_REQUEST' }, 400);
      meetingUrl = found.meetingUrl;
    }
    saveMeetingSetting(seriesId, {
      ...(soul !== undefined ? { soul } : {}),
      ...(meetingUrl !== undefined ? { meetingUrl } : {}),
      ...(typeof body!.title === 'string' ? { title: body!.title.slice(0, 120) } : {}),
    });
    console.info(JSON.stringify({ level: 'info', msg: 'calendar meeting persona set', seriesId, soul: soul ?? 'default' }));
    return c.json({ ok: true, ...getCalendarWatcherStatus(config) });
  });

  return app;
}
