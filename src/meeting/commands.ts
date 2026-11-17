// In-memory owner-to-bot command queue, one per meeting.
//
// The owner panel POSTs a command (speak this line, mute, unmute) and the Recall webhook
// queues an `ask` for a request typed in the meeting chat; the bot's browser
// page polls GET with the last `seq` it handled and receives only newer commands, so
// each command is delivered once and in order. A command that nobody picked up within
// COMMAND_TTL_MS is dropped: a "say" that arrives 30 seconds late is worse than none.
//
// Process-local and ephemeral by design, like the meeting registry. Seq numbers keep
// counting after items expire, so a poller's cursor never goes backwards.

export type MeetingCommand =
  | { type: 'say'; text: string }
  | { type: 'mute' }
  | { type: 'unmute' }
  /**
   * The owner addressed the agent by name, as heard in the per-speaker transcript. The
   * page uses it only to leave quiet mode when its own transcript missed the name.
   */
  | { type: 'wake'; text: string }
  /** A request typed in the meeting chat (wake word already removed); the bot answers in chat. */
  | {
      type: 'ask';
      text: string;
      from: string;
      /** 'voice': answer aloud (a spoken request that an outside brain did not answer). Default: in chat. */
      reply?: 'voice';
    };

export interface QueuedCommand {
  /** 1-based, strictly increasing per meeting. */
  seq: number;
  command: MeetingCommand;
  /** Epoch ms from which the command is no longer delivered. */
  expiresAt: number;
}

/** A command expires this long after it was enqueued. */
export const COMMAND_TTL_MS = 30_000;

interface MeetingQueue {
  nextSeq: number;
  items: QueuedCommand[];
}

const queues = new Map<string, MeetingQueue>();

/** Drop expired items in place. A command is expired from exactly `expiresAt` onward. */
function prune(queue: MeetingQueue, nowMs: number): void {
  queue.items = queue.items.filter((item) => item.expiresAt > nowMs);
}

/** Queue a command for a meeting and return it with its assigned seq and expiry. */
export function enqueueCommand(
  meetingId: string,
  command: MeetingCommand,
  nowMs: number = Date.now(),
): QueuedCommand {
  let queue = queues.get(meetingId);
  if (!queue) {
    queue = { nextSeq: 1, items: [] };
    queues.set(meetingId, queue);
  }
  // Prune on write too, so a meeting whose bot page stopped polling cannot accumulate items.
  prune(queue, nowMs);

  const queued: QueuedCommand = { seq: queue.nextSeq, command, expiresAt: nowMs + COMMAND_TTL_MS };
  queue.nextSeq += 1;
  queue.items.push(queued);
  return queued;
}

/** Unexpired commands with `seq` greater than `afterSeq`, in order. */
export function commandsAfter(
  meetingId: string,
  afterSeq: number,
  nowMs: number = Date.now(),
): QueuedCommand[] {
  const queue = queues.get(meetingId);
  if (!queue) return [];
  prune(queue, nowMs);
  return queue.items.filter((item) => item.seq > afterSeq);
}

/** Test-only: clear every meeting's queue and seq counter between cases. */
export function __clearCommands(): void {
  queues.clear();
}
