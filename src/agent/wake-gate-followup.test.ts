/**
 * Tier-1 follow-up engagement-window tests for the meeting agent.
 *
 * SCOPE CAVEAT: proves event-reaction LOGIC ONLY — that a wake-word-free
 * follow-up question activates while the engagement window is open and goes
 * silent once it expires, with the clock injected so the test is fully
 * deterministic (no real timers, no audio). It does NOT prove interruption
 * timing or barge-in (later audio-path tier + full-duplex fix, bead BZ-0z7y).
 *
 * Additive to wake-gate.test.ts. Covers both the plain follow-up path
 * (markAgentSpoke -> evaluateWakeGate with `now` advanced) and the stitched
 * fragment path (evaluateWakeGateStitched) inside vs outside the window.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateWakeGate,
  evaluateWakeGateStitched,
  markAgentSpoke,
  type WakeGateConfig,
} from './wake-gate.js'

const NOW = 1_750_000_000_000
const WINDOW = 25_000

const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  engagementWindowMs: WINDOW,
}

const closed = { engagedUntil: 0 }

describe('follow-up window — plain path', () => {
  it('opens the window exactly engagementWindowMs after the agent speaks', () => {
    const state = markAgentSpoke(config, NOW)
    expect(state.engagedUntil).toBe(NOW + WINDOW)
  })

  it('activates a no-wake-word follow-up question INSIDE the window', () => {
    const state = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(state, 'and what about the timeline', config, undefined, NOW + 10_000)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('follow-up')
  })

  it('still activates right up to the window boundary (now < engagedUntil)', () => {
    const state = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(state, 'can you expand on that', config, undefined, NOW + WINDOW - 1)
    expect(d.activate).toBe(true)
  })

  it('does NOT activate a no-wake-word follow-up AT or AFTER expiry', () => {
    const state = markAgentSpoke(config, NOW)
    // Boundary is exclusive: engagedUntil > now is required, so == expiry closes.
    expect(evaluateWakeGate(state, 'can you expand on that', config, undefined, NOW + WINDOW).activate).toBe(false)
    expect(evaluateWakeGate(state, 'can you expand on that', config, undefined, NOW + WINDOW + 5_000).activate).toBe(
      false,
    )
  })

  it('requires the follow-up to look like a question (bare statement stays silent)', () => {
    const state = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(state, 'ok thanks that helps', config, undefined, NOW + 5_000)
    expect(d.activate).toBe(false)
  })

  it('a fresh agent turn re-opens the window from the new now', () => {
    let state = markAgentSpoke(config, NOW)
    // Just expired...
    expect(evaluateWakeGate(state, 'what about next quarter', config, undefined, NOW + WINDOW + 1_000).activate).toBe(
      false,
    )
    // ...agent speaks again, window re-opens relative to that later moment.
    state = markAgentSpoke(config, NOW + WINDOW + 1_000)
    expect(evaluateWakeGate(state, 'what about next quarter', config, undefined, NOW + WINDOW + 5_000).activate).toBe(
      true,
    )
  })
})

describe('follow-up window — stitched fragment path', () => {
  it('activates a stitched follow-up question INSIDE the window', () => {
    const state = markAgentSpoke(config, NOW)
    const prev = { text: 'actually can you tell me', at: NOW + 8_000 }
    const d = evaluateWakeGateStitched(state, 'the latest on robo sdr', config, prev, undefined, NOW + 10_000)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('stitched')
    expect(d.effectiveUtterance).toBe('actually can you tell me the latest on robo sdr')
  })

  it('does NOT activate a stitched follow-up once the window has expired', () => {
    const state = markAgentSpoke(config, NOW)
    const prev = { text: 'actually can you tell me', at: NOW + WINDOW + 2_000 }
    const d = evaluateWakeGateStitched(state, 'the latest on robo sdr', config, prev, undefined, NOW + WINDOW + 3_000)
    expect(d.activate).toBe(false)
  })

  it('passes through unchanged when the gate is closed and no fragment is pending', () => {
    const d = evaluateWakeGateStitched(closed, 'random side chatter', config, null, undefined, NOW)
    expect(d.activate).toBe(false)
    expect(d.effectiveUtterance).toBe('random side chatter')
  })
})
