import { describe, expect, it, vi } from 'vitest'
import {
  createConnectionOpenWatchdog,
  getReconnectDecision,
  isTerminalMeetingStatus,
  RECONNECT_MAX_DELAY_MS,
  resetReconnectAttempt,
} from './reconnect-policy.js'

describe('realtime reconnect policy', () => {
  it('reconnects a normal mid-meeting close after one second', () => {
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: 0 })).toEqual({
      reconnect: true,
      delayMs: 1_000,
      nextAttempt: 1,
    })
  })

  it.each([
    { ended: true, cancelled: false, meetingStatus: 'live' },
    { ended: false, cancelled: true, meetingStatus: 'live' },
    { ended: false, cancelled: false, meetingStatus: 'completed' },
    { ended: false, cancelled: false, meetingStatus: 'cancelled' },
    { ended: false, cancelled: false, meetingStatus: 'failed' },
  ])('does not reconnect after a terminal lifecycle transition: %o', ({ ended, cancelled, meetingStatus }) => {
    expect(getReconnectDecision({ ended, cancelled, meetingStatus, attempt: 3 })).toEqual({
      reconnect: false,
      delayMs: null,
      nextAttempt: 3,
    })
  })

  it('uses capped exponential backoff', () => {
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: 1 }).delayMs).toBe(2_000)
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: 2 }).delayMs).toBe(4_000)
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: 5 }).delayMs).toBe(
      RECONNECT_MAX_DELAY_MS,
    )
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: 30 }).delayMs).toBe(
      RECONNECT_MAX_DELAY_MS,
    )
  })

  it('starts the backoff over after a successful open', () => {
    expect(resetReconnectAttempt()).toBe(0)
    expect(getReconnectDecision({ ended: false, cancelled: false, meetingStatus: 'live', attempt: resetReconnectAttempt() })).toMatchObject({
      delayMs: 1_000,
      nextAttempt: 1,
    })
  })

  it('treats lifecycle status casing defensively', () => {
    expect(isTerminalMeetingStatus('COMPLETED')).toBe(true)
    expect(isTerminalMeetingStatus('live')).toBe(false)
  })

  it('closes a black-holed connection once and clears the deadline after open', () => {
    vi.useFakeTimers()
    try {
      const expire = vi.fn()
      const watchdog = createConnectionOpenWatchdog(expire, 15_000)

      watchdog.start()
      watchdog.start()
      vi.advanceTimersByTime(14_999)
      expect(expire).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(expire).toHaveBeenCalledTimes(1)

      watchdog.start()
      watchdog.clear()
      vi.advanceTimersByTime(15_000)
      expect(expire).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
