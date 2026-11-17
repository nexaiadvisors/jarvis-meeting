// Hands a wake-word request to an outside brain, with the built-in agent as the fallback.

import type { Config } from '../config.js';
import { loadSoul } from '../soul/loader.js';
import { enqueueCommand } from './commands.js';
import { getMeeting } from './registry.js';
import { addRequest, type MeetingRequest, type RequestSource } from './requests.js';

/** True when the meeting's SOUL sets brain: external. A SOUL that cannot be loaded counts as builtin. */
export function usesExternalBrain(config: Config, teammate: string): boolean {
  try {
    return loadSoul(teammate, config.soulDir).brain === 'external';
  } catch {
    return false;
  }
}

/**
 * Queue a request for the outside brain. If nobody answers in time, the built-in agent
 * gets it through the command queue: a typed request is answered in chat, a spoken one aloud.
 */
export function queueForExternalBrain(
  meetingId: string,
  input: { text: string; from: string; source: RequestSource },
  timeoutMs?: number,
): MeetingRequest {
  return addRequest(
    meetingId,
    input,
    (request) => {
      if (getMeeting(meetingId)?.status !== 'live') return;
      enqueueCommand(meetingId, {
        type: 'ask',
        text: request.text,
        from: request.from,
        ...(request.source === 'voice' ? { reply: 'voice' as const } : {}),
      });
      console.info(JSON.stringify({ level: 'info', msg: 'external brain: no answer, built-in agent takes it', meetingId, source: request.source }));
    },
    timeoutMs,
  );
}
