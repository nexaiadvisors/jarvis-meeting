// One page per meeting, reached with the meeting's share token.
//
//   GET /m/:meetingId?t=<share>                 -> the page (HTML)
//   GET /api/meeting-page/:meetingId?t=<share>  -> what the page shows, as JSON
//   GET /meeting-page.js                        -> the page's script (build output)
//
// The page shows the meeting's notes, action items, transcript and artifact links: live
// during the call (it polls the JSON), final after it. A wrong or missing token and an
// unknown meeting both answer 404. The JSON never carries the share token, the owner
// token, the audio URL or a bot id.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Config } from '../config.js';
import { getMeeting, shareTokenFor } from '../meeting/registry.js';
import { readMergedTranscript } from '../meeting/transcript.js';
import { readNotes } from '../meeting/notes.js';
import { listArtifacts } from '../meeting/artifacts.js';
import { readSummary } from '../postmeeting/summary-store.js';
import { SHARE_HEADERS, hasShareAccess } from './artifacts.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', '..');

export interface MeetingPageOptions {
  dataDir?: string;
}

/** The link to a meeting's page. Undefined for an unknown meeting. */
export function meetingPageUrl(config: Config, meetingId: string): string | undefined {
  const token = shareTokenFor(meetingId);
  if (token === undefined) return undefined;
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/m/${encodeURIComponent(meetingId)}?t=${token}`;
}

// One same-origin page: its own script, an inline <style>, fetches to itself.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

export function createMeetingPageRoutes(config: Config, options: MeetingPageOptions = {}): Hono {
  const app = new Hono();
  const dir = (): [string] | [] => (options.dataDir !== undefined ? [options.dataDir] : []);
  const pageHtml = readFileSync(resolve(pkgRoot, 'web/meeting-page/index.html'), 'utf8');

  app.get('/m/:meetingId', (c) => {
    if (!hasShareAccess(c, c.req.param('meetingId'))) return c.text('Not found', 404, SHARE_HEADERS);
    return c.html(pageHtml, 200, { ...PAGE_HEADERS, ...SHARE_HEADERS });
  });

  app.get('/meeting-page.js', (c) => {
    let bundle: string;
    try {
      bundle = readFileSync(resolve(pkgRoot, 'public/meeting-page.js'), 'utf8');
    } catch {
      return c.text('Not found', 404);
    }
    return c.body(bundle, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.get('/api/meeting-page/:meetingId', (c) => {
    const meetingId = c.req.param('meetingId');
    const meeting = hasShareAccess(c, meetingId) ? getMeeting(meetingId) : undefined;
    if (!meeting) return c.json({ error: 'Not found', code: 'not_found' }, 404, SHARE_HEADERS);
    const summary = meeting.botId !== undefined ? readSummary(meeting.botId, ...dir()) : undefined;
    return c.json(
      {
        meeting: {
          id: meeting.meetingId,
          title: meeting.title,
          status: meeting.status,
          startedAt: new Date(meeting.createdAt).toISOString(),
        },
        botName: meeting.botName ?? config.jarvisBotName,
        // Flags are private escalations to the owner ("flag for David"). The page link goes to
        // everyone in the meeting chat, so only plain notes are shown here.
        notes: readNotes(meeting.botId ?? meeting.meetingId, ...dir())
          .filter((n) => n.kind === 'note')
          .map((n) => ({ kind: n.kind, text: n.text, at: n.at })),
        // Written by the post-meeting pipeline; null until then.
        summary: summary
          ? { bluf: summary.bluf, decisions: summary.decisions, actionItems: summary.actionItems, generated: summary.generated }
          : null,
        transcript: readMergedTranscript(meeting, meeting.botName ?? config.jarvisBotName, ...dir()),
        artifacts: listArtifacts(meeting.meetingId, ...dir()).map((a) => ({
          id: a.id,
          kind: a.kind,
          title: a.title,
          updatedAt: a.updatedAt,
        })),
      },
      200,
      SHARE_HEADERS,
    );
  });

  return app;
}
