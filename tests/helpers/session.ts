// Test helper: the Authorization header a meeting's bot page would send, i.e. a
// real meeting session token minted with the same signing key the routes verify.

import type { Config } from '../../src/config.js';
import { mintMeetingSessionToken } from '../../src/routes/session-token.js';

export function sessionHeader(
  config: Config,
  meetingId: string,
  teammate: string,
): Record<string, string> {
  return { Authorization: `Bearer ${mintMeetingSessionToken(config, { meetingId, teammate })}` };
}
