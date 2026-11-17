/**
 * Tier-1 tests for the follow-up engagement-window directed-at-other-human veto
 * (F5) and the exported isDirectedAtOtherHuman helper.
 *
 * SCOPE CAVEAT: pure-function only. Proves the gate does not butt in on a
 * question addressed to a named human in the room while the engagement window
 * is open, without suppressing genuine agent-directed follow-ups. No audio.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateWakeGate,
  isDirectedAtOtherHuman,
  markAgentSpoke,
  DEFAULT_WAKE_ALIASES,
  type WakeGateConfig,
} from './wake-gate.js'

const NOW = 1_750_000_000_000
const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  wakeAliases: DEFAULT_WAKE_ALIASES,
  engagementWindowMs: 60_000,
}

describe('evaluateWakeGate follow-up veto (F5)', () => {
  const inside = NOW + 10_000
  const open = () => markAgentSpoke(config, NOW)

  it('vetoes a question addressed to human "Kai" inside the window', () => {
    expect(
      evaluateWakeGate(open(), 'So Kai, what do you think about last weeks meeting', config, undefined, inside).activate,
    ).toBe(false)
    expect(
      evaluateWakeGate(open(), 'So Kai, how was last weeks meeting', config, undefined, inside).activate,
    ).toBe(false)
  })

  it('vetoes a question addressed to a lowercase-filler + named human', () => {
    expect(
      evaluateWakeGate(open(), 'So Tom, what do you think', config, undefined, inside).activate,
    ).toBe(false)
  })

  it('does NOT veto a wake-word vocative (So Jarvis, what...)', () => {
    expect(
      evaluateWakeGate(open(), 'So Jarvis, what do you think', config, undefined, inside).activate,
    ).toBe(true)
  })

  // Defect-2 regression guard (the case the original spec omitted): a genuine
  // agent-directed follow-up that STARTS with a capitalized question word.
  it('does NOT veto a follow-up starting with a capitalized question word', () => {
    expect(
      evaluateWakeGate(open(), 'What do you know about robo SDR', config, undefined, inside).activate,
    ).toBe(true)
    expect(
      evaluateWakeGate(open(), 'What did we decide', config, undefined, inside).activate,
    ).toBe(true)
  })

  it('does NOT veto a mid-sentence follow-up with no leading vocative', () => {
    expect(
      evaluateWakeGate(open(), 'and what about the timeline', config, undefined, inside).activate,
    ).toBe(true)
  })
})

describe('isDirectedAtOtherHuman helper (F5)', () => {
  const aliases = DEFAULT_WAKE_ALIASES
  it('Kai => true', () => {
    expect(isDirectedAtOtherHuman('So Kai, what do you think', 'Jarvis', aliases)).toBe(true)
  })
  it('Jarvis => false (wake word)', () => {
    expect(isDirectedAtOtherHuman('So Jarvis, what do you think', 'Jarvis', aliases)).toBe(false)
  })
  it('"and what about X" => false (no leading capital vocative)', () => {
    expect(isDirectedAtOtherHuman('and what about the timeline', 'Jarvis', aliases)).toBe(false)
  })
  it('"The numbers, what are they" => false (stopword "The")', () => {
    expect(isDirectedAtOtherHuman('The numbers, what are they', 'Jarvis', aliases)).toBe(false)
  })
  it('"What do you know about X" => false (no comma after question word)', () => {
    expect(isDirectedAtOtherHuman('What do you know about robo SDR', 'Jarvis', aliases)).toBe(false)
  })
})
