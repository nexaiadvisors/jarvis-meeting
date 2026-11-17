/**
 * Coworker-grade triggering: the agent participates only when ADDRESSED, not
 * whenever its name is mentioned, and does not butt in on the room's own
 * conversation during the follow-up window.
 *
 * Regression for a live meeting where Jarvis spoke out of turn: Morgan said
 * "...we chatted we talked to jarvis we got a quick update..." (a REFERENCE to
 * the agent, not an address) and the gate — which fired on any containsWakeWord
 * — activated. The real invocation that turn was "jarvis do you know about the
 * five goals..." (a vocative), which must still fire.
 */
import { describe, expect, it } from 'vitest'
import {
  isAddressedToAgent,
  isRoomManagement,
  evaluateWakeGate,
  markAgentSpoke,
  DEFAULT_WAKE_ALIASES,
  type WakeGateConfig,
} from './wake-gate.js'

const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  wakeAliases: DEFAULT_WAKE_ALIASES,
}
const NOW = 1_750_000_000_000
const closed = { engagedUntil: 0 }

describe('isAddressedToAgent — vocative (address) vs mention', () => {
  it('TRUE when the name is used to address the agent', () => {
    for (const u of [
      'jarvis what shipped this week',
      'hey jarvis can you summarize',
      'jarvis do you know about the five goals of the executive team', // real transcript invocation
      'so jarvis pull up the numbers',
      'okay jarvis, what is the status',
      'what do you think jarvis', // tail vocative
      'and jarvis can you help with this',
      'hey travis what is the status', // STT-misheard alias, still an address
    ]) {
      expect(isAddressedToAgent(u, config.wakeWord, config.wakeAliases)).toBe(true)
    }
  })

  it('FALSE when the name is only MENTIONED (a reference), not addressed', () => {
    for (const u of [
      'we chatted we talked to jarvis we got a quick update on the business', // the live out-of-turn trigger
      'we should ask jarvis about that later',
      'i will loop in jarvis on this',
      'what did jarvis say earlier',
      'maybe jarvis has the answer',
      'tell jarvis to join next time',
    ]) {
      expect(isAddressedToAgent(u, config.wakeWord, config.wakeAliases)).toBe(false)
    }
  })

  it('FALSE on substring / near-homophone traps (no real wake token)', () => {
    expect(isAddressedToAgent('the jar is full', 'Jarvis', [])).toBe(false)
    expect(isAddressedToAgent('marvin is presenting next', 'Jarvis', [])).toBe(false)
  })
})

describe('evaluateWakeGate — activation requires address, not mention', () => {
  it('activates on the real transcript invocation', () => {
    expect(evaluateWakeGate(closed, 'jarvis do you know about the five goals', config, undefined, NOW).activate).toBe(
      true,
    )
  })

  it('does NOT activate on the real transcript REFERENCE that caused the out-of-turn reply', () => {
    const u =
      'maybe our first 20 minute block here is we chatted we talked to jarvis we got a quick update on the business'
    expect(evaluateWakeGate(closed, u, config, undefined, NOW).activate).toBe(false)
  })
})

describe('isRoomManagement', () => {
  it('flags meeting-flow / room-management speech', () => {
    for (const u of [
      "let's burn down the top three topics",
      'should we move to the next item',
      'before we do that jonathan you want to talk about anything',
      'we talked to jarvis and got an update',
      'moving on to the next topic',
    ]) {
      expect(isRoomManagement(u)).toBe(true)
    }
  })

  it('does NOT flag a direct follow-up question to the agent', () => {
    for (const u of ['and what about the timeline', 'can you expand on that', 'what is the status of robo sdr']) {
      expect(isRoomManagement(u)).toBe(false)
    }
  })
})

describe('follow-up window — the room talking among themselves must NOT re-trigger', () => {
  const engaged = markAgentSpoke(config, NOW) // window open until NOW + 30s

  it('vetoes meeting-flow / other-human talk inside the window', () => {
    for (const u of [
      "before we do that though i don't know jonathan you want to talk about anything should we",
      'okay so let us burn down the top three topics and spend twenty minutes on each before we wrap',
    ]) {
      expect(evaluateWakeGate(engaged, u, config, undefined, NOW + 5_000).activate).toBe(false)
    }
  })

  it('still activates a genuine direct follow-up question inside the window', () => {
    expect(evaluateWakeGate(engaged, 'and what about the timeline', config, undefined, NOW + 5_000).activate).toBe(true)
  })

  it('vetoes a long monologue even when it contains a question fragment', () => {
    const monologue =
      'so the way i see it we have a bunch of stuff to get through today and i was wondering what everyone thinks we should prioritize first because there is a lot on the plate and not much time'
    expect(evaluateWakeGate(engaged, monologue, config, undefined, NOW + 5_000).activate).toBe(false)
  })
})
