/**
 * Pure helpers for the bot page's owner-command poll and its OpenBrain-unreachable
 * handling. main.tsx wires them to the realtime socket; nothing here touches the DOM,
 * the network or React, so all of it is unit-tested in tests/agent-frame-commands.test.ts.
 */

import { COMMAND_TTL_MS, type MeetingCommand, type QueuedCommand } from '../../src/meeting/commands.js'
import { OPENBRAIN_UNREACHABLE_DIRECTIVE } from '../../src/agent/realtime-config.js'

/** How often the page asks GET /api/meetings/:id/commands for new owner commands. */
export const COMMAND_POLL_MS = 1000

/** Instruction for a `say` command; the owner's text follows it directly. */
export const SAY_VERBATIM_PREFIX = 'Say exactly the following words, verbatim, with nothing before or after: '

/** Leads a typed request so the model knows who asked, and that its answer is posted in writing. */
export const CHAT_ASK_PREFIX = (from: string): string =>
  `(${from || 'Someone'} typed this in the meeting chat. Reply in writing, in a few short sentences; your reply is posted to the chat, not spoken.) `

/** How long a written answer may take (tool calls included) before the page stops treating responses as chat replies. */
export const CHAT_REPLY_WINDOW_MS = 60_000

/**
 * Make a `response.create` text-only when its answer goes to the meeting chat. An event
 * that carries its own instructions (an owner `say`) is spoken and is left alone, as is
 * every other event type. `output_modalities` applies to that one response only.
 */
export function withChatReply(event: Record<string, unknown>, chatReply: boolean): Record<string, unknown> {
  if (!chatReply || event['type'] !== 'response.create') return event
  const response = (event['response'] as Record<string, unknown> | undefined) ?? {}
  if (response['instructions'] !== undefined) return event
  return { ...event, response: { ...response, output_modalities: ['text'] } }
}

/** What the bot is doing right now, as far as planCommand needs to know. */
export interface PlanState {
  /** A response is in flight (created, not yet done). */
  activeResponse: boolean
  /** Audio is still playing out. It outlasts the response: the model finishes well before the speech does. */
  isSpeaking: boolean
}

export interface CommandPlan {
  /** Realtime client events to send, in order. */
  events: Record<string, unknown>[]
  /** New mute state, when the command changes it. */
  muted?: boolean
  /** What the bot is about to say, for the transcript. */
  spokenText?: string
  /** True when the answer to this command is written to the meeting chat, not spoken. */
  chatReply?: boolean
}

/**
 * Turn one owner command into realtime events. Anything the bot is saying is cancelled
 * first, so a `say` never talks over, or queues behind, an answer and a `mute` really
 * goes quiet. That means either a response in flight or audio still playing out after
 * the response finished; the caller turns the cancel into stopSpeaking(), which sends
 * the wire cancel only when a response is active and always flushes buffered audio.
 *
 * `response.create` carries `response.instructions` and `response.tool_choice`, which
 * the OpenAI Realtime API applies to that one response only (checked against the
 * current API reference): the model speaks the text and cannot call a tool.
 */
export function planCommand(cmd: MeetingCommand, state: PlanState): CommandPlan {
  const cancel: Record<string, unknown>[] =
    state.activeResponse || state.isSpeaking ? [{ type: 'response.cancel' }] : []
  switch (cmd.type) {
    case 'say':
      return {
        events: [
          ...cancel,
          {
            type: 'response.create',
            response: { instructions: SAY_VERBATIM_PREFIX + cmd.text, tool_choice: 'none' },
          },
        ],
        spokenText: cmd.text,
      }
    case 'ask':
      // A typed request never interrupts speech: the caller holds it until the bot is
      // idle. The session instructions (the persona) stay in force, so the guidance
      // rides in the user message, and the reply is text only.
      return {
        events: [
          {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `${CHAT_ASK_PREFIX(cmd.from)}${cmd.text}` }],
            },
          },
          withChatReply({ type: 'response.create' }, true),
        ],
        chatReply: true,
      }
    case 'wake':
      // Handled by the page itself (it leaves quiet mode and answers); nothing to send.
      return { events: [] }
    case 'mute':
      return { events: cancel, muted: true }
    case 'unmute':
      return { events: [], muted: false }
  }
}

/**
 * The commands this page should run from one poll response. Commands that were queued
 * before this page loaded are still unexpired after a reload but were meant for the
 * previous page, so they are skipped rather than replayed. A command's enqueue time is
 * `expiresAt` minus the queue's TTL.
 */
export function selectCommandsToRun(commands: QueuedCommand[], pageLoadedAt: number): MeetingCommand[] {
  return commands.filter((item) => item.expiresAt - COMMAND_TTL_MS >= pageLoadedAt).map((item) => item.command)
}

/**
 * The cursor to send as `after` next time: past every command returned, including the
 * ones selectCommandsToRun skipped, and never backwards.
 */
export function nextSeq(commands: QueuedCommand[], lastSeq: number): number {
  return commands.reduce((max, item) => Math.max(max, item.seq), lastSeq)
}

/**
 * Whether an answer that was waiting on retrieval or a tool call may still send its
 * `response.create`. Not if a `mute` or `say` command arrived while it waited (the
 * generation moved on: the owner took over), and not while muted. The `say` command's
 * own response.create does not come through here, so "say this" still works muted.
 */
export function shouldSendDeferredResponse(args: {
  capturedGeneration: number
  currentGeneration: number
  muted: boolean
}): boolean {
  return args.capturedGeneration === args.currentGeneration && !args.muted
}

/**
 * The rows of a speculative ob-search worth caching. None when OpenBrain was
 * unreachable: a cached hit would be served without the directive, so the live path
 * must run (and inject OPENBRAIN_UNREACHABLE_DIRECTIVE) instead.
 */
export function prefetchResultsToStore(
  data: { results?: unknown; unreachable?: unknown } | null,
): Record<string, unknown>[] {
  if (!data || data.unreachable === true || !Array.isArray(data.results)) return []
  return data.results as Record<string, unknown>[]
}

/**
 * What to inject as the retrieval system message: the unreachable directive when the
 * route reported OpenBrain down (so the model says so instead of answering from
 * memory), otherwise the formatted results.
 */
export function injectionFor(response: { unreachable?: boolean }, formatted: string): string {
  return response.unreachable === true ? OPENBRAIN_UNREACHABLE_DIRECTIVE : formatted
}

const DOCUMENT_ROUTE = '/api/voice/ob-get-document'

/**
 * True when a tool route's response means OpenBrain could not be reached: ob-search
 * and ob-context set `unreachable: true` in a normal 200 body, and ob-get-document
 * answers HTTP 502.
 */
export function isOpenBrainUnreachable(path: string, status: number, body: unknown): boolean {
  if (path === DOCUMENT_ROUTE && status === 502) return true
  return typeof body === 'object' && body !== null && (body as { unreachable?: unknown }).unreachable === true
}

/**
 * The tool result handed back to the model for a tool-route response. When OpenBrain
 * is unreachable the model gets the directive instead of results (or of a bare
 * "HTTP 502" it could not interpret).
 */
export function toolOutputFor(path: string, status: number, body: unknown): Record<string, unknown> {
  if (isOpenBrainUnreachable(path, status, body)) {
    return { unreachable: true, instruction: OPENBRAIN_UNREACHABLE_DIRECTIVE }
  }
  if (
    status === 403 &&
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'LOOKUP_APPROVAL_REQUIRED'
  ) {
    // The route refused for want of approval: the model needs the instruction, not "HTTP 403".
    return { approval_required: true, instruction: String((body as { instruction?: unknown }).instruction ?? '') }
  }
  if (status < 200 || status >= 300) return { error: `HTTP ${status}` }
  if (typeof body !== 'object' || body === null) return { error: `HTTP ${status}: unreadable response` }
  return body as Record<string, unknown>
}
