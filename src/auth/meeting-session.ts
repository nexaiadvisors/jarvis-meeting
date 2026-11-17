// Per-meeting access guard for every route that reads or writes one meeting.
//
// The bot's browser page (and nothing else) holds a meeting session token that
// dispatch minted for exactly one (meetingId, teammate) pair. Every route that
// takes a meeting id calls requireMeetingAccess FIRST, so a guessed or leaked
// meeting id alone never reaches transcripts, retrieval, logs or the SOUL.
//
// Order of checks (the unknown-meeting 404 comes first on purpose: it reveals
// nothing an unauthenticated caller could not already infer, and it keeps arbitrary
// ids from ever reaching the file-writing routes):
//   1. unknown meeting            -> 404 {code:'not_found'}
//   2. owner (only if allowOwner) -> allowed
//   3. valid session token for THIS meeting and its teammate -> allowed
//   4. anything else              -> 401 {code:'SESSION_REQUIRED'}

import type { Context } from 'hono';
import type { Config } from '../config.js';
import { getMeeting } from '../meeting/registry.js';
import { extractBearerToken, verifyMeetingSessionToken } from '../routes/session-token.js';
import { isOwnerRequest } from './owner.js';

export interface MeetingAccessOptions {
  /**
   * Also admit the owner (bearer OWNER_TOKEN or the `jm_owner` cookie). Only the
   * owner-panel reads set this: GET /api/meetings/:id and transcript-search.
   */
  allowOwner?: boolean;
}

/** Returns `null` when the request may proceed, otherwise the error Response to return. */
export function requireMeetingAccess(
  c: Context,
  config: Config,
  meetingId: string,
  opts: MeetingAccessOptions = {},
): Response | null {
  const meeting = getMeeting(meetingId);
  if (!meeting) {
    return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
  }

  if (opts.allowOwner === true && isOwnerRequest(c, config)) return null;

  const token = extractBearerToken(c.req.header('authorization'));
  if (
    token !== undefined &&
    verifyMeetingSessionToken(config, token, { meetingId, teammate: meeting.teammate })
  ) {
    return null;
  }

  return c.json({ error: 'meeting session token required', code: 'SESSION_REQUIRED' }, 401);
}
