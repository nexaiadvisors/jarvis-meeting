/**
 * Realtime transport recovery policy.
 *
 * Keep the lifecycle decision outside the browser frame so the backoff and
 * terminal-state contract remain deterministic and testable without React or a
 * WebSocket implementation.
 */

export const RECONNECT_INITIAL_DELAY_MS = 1_000
export const RECONNECT_MAX_DELAY_MS = 30_000
export const WEBSOCKET_OPEN_TIMEOUT_MS = 15_000

export interface ReconnectDecisionInput {
  /** True once the page has been torn down or the meeting is terminal. */
  ended: boolean
  /** True when React is unmounting the frame. */
  cancelled: boolean
  /** The latest lifecycle value returned by the meeting-state endpoint. */
  meetingStatus: string | null | undefined
  /** Number of failed recovery attempts since the most recent successful open. */
  attempt: number
}

export interface ReconnectDecision {
  reconnect: boolean
  /** Null means the caller must not schedule a retry. */
  delayMs: number | null
  /** Persist this value after scheduling; reset it after a successful open. */
  nextAttempt: number
}

const TERMINAL_MEETING_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'ended', 'failed'])

/** Whether the page must stop recovery for the supplied meeting lifecycle state. */
export function isTerminalMeetingStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_MEETING_STATUSES.has(status.trim().toLowerCase())
}

/**
 * Decide whether a closed or failed realtime connection should be retried.
 *
 * Attempts are zero based: 0 -> 1s, 1 -> 2s, 2 -> 4s, capped at 30s. A
 * caller resets the count to `resetReconnectAttempt()` as soon as a socket
 * opens, so every later interruption starts again at one second.
 */
export function getReconnectDecision({ ended, cancelled, meetingStatus, attempt }: ReconnectDecisionInput): ReconnectDecision {
  if (ended || cancelled || isTerminalMeetingStatus(meetingStatus)) {
    return { reconnect: false, delayMs: null, nextAttempt: attempt }
  }

  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  const delayMs = Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** normalizedAttempt, RECONNECT_MAX_DELAY_MS)
  return { reconnect: true, delayMs, nextAttempt: normalizedAttempt + 1 }
}

/** Reset the failure counter after a successfully opened realtime socket. */
export function resetReconnectAttempt(): number {
  return 0
}

interface TimerApi {
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
}

/**
 * Bound the WebSocket CONNECTING phase. The caller owns the actual close/retry
 * policy; this small handle only guarantees a black-holed handshake eventually
 * returns control to that policy and that open/close can cancel the deadline.
 */
export function createConnectionOpenWatchdog(
  onExpired: () => void,
  timeoutMs = WEBSOCKET_OPEN_TIMEOUT_MS,
  timers: TimerApi = globalThis,
): { start: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    start: () => {
      if (timer) return
      timer = timers.setTimeout(() => {
        timer = undefined
        onExpired()
      }, timeoutMs)
    },
    clear: () => {
      if (!timer) return
      timers.clearTimeout(timer)
      timer = undefined
    },
  }
}
