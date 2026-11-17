// The bot's side of the meeting chat: post a message and keep it in the transcript.
// One path for the join notice, the MCP post_chat tool, written replies and artifact links.

import type { Config } from '../config.js';
import { sendChat, type SendChatResult } from '../recall/send-chat.js';
import { appendAgentUtterance } from './transcript.js';
import type { MeetingRecord } from './registry.js';

/** What the bot says in chat once it is in the call. `link` is the meeting page, when there is one. */
export function joinNotice(botName: string, link?: string, screenShare?: boolean, facilitator?: boolean, standIn?: boolean): string {
  if (standIn === true) {
    return (
      `${botName} is an AI speaking in place of the person who would normally take this call. ` +
      `It answers only from that person's notes for today, never makes new commitments for them, and transcribes the call. ` +
      `Say "${botName}, stop" to pause it.` +
      (link !== undefined ? ` Meeting page: ${link}` : '')
    );
  }
  if (facilitator === true) {
    return (
      `${botName} is an AI that leads this session. It speaks without being asked, transcribes the call and writes notes. ` +
      `Say "${botName}, stop" to pause it and "${botName}" to bring it back.` +
      (screenShare === true ? ' It can look at the shared screen when asked.' : '') +
      (link !== undefined ? ` Meeting page: ${link}` : '')
    );
  }
  return (
    `${botName} is an AI note-taker in this meeting. It transcribes the call and writes notes and action items. ` +
    `Say or type "${botName}" to ask it something.` +
    (screenShare === true ? ' It can look at the shared screen when asked.' : '') +
    (link !== undefined ? ` Meeting page: ${link}` : '')
  );
}

/**
 * The message as it is kept in the transcript: links lose their `?t=<share token>`. The
 * transcript goes on to the summary model, OpenBrain and Slack, and a working edit link
 * must not travel with it. The chat itself gets the full link.
 */
export function withoutShareTokens(message: string): string {
  return message.replace(/\?t=[A-Za-z0-9_-]{16,}/g, '');
}

/** Post `message` to the meeting chat. On success the line is added to the transcript as a chat line. */
export async function postChat(
  config: Config,
  meeting: MeetingRecord,
  message: string,
  dataDir?: string,
  /** The join notice is the one message a notes-only meeting still gets. */
  opts: { joinNotice?: boolean } = {},
): Promise<SendChatResult> {
  if (meeting.botId === undefined) return { ok: false, error: 'meeting has no bot yet' };
  if (meeting.notesOnly === true && opts.joinNotice !== true) {
    return { ok: false, error: 'notes-only meeting: the bot does not post to chat' };
  }
  const result = await sendChat(config, meeting.botId, message);
  if (result.ok) {
    appendAgentUtterance(
      meeting.meetingId,
      { speaker: 'agent', text: withoutShareTokens(message.trim()), timestamp: new Date().toISOString(), kind: 'chat' },
      ...(dataDir !== undefined ? [dataDir] : []),
    );
  } else {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'chat: post failed', meetingId: meeting.meetingId, error: result.error }),
    );
  }
  return result;
}
