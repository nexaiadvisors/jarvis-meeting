import { describe, expect, it } from 'vitest'
import {
  containsWakeWord,
  DEFAULT_ENGAGEMENT_WINDOW_MS,
  DEFAULT_WAKE_ALIASES,
  evaluateWakeGate,
  evaluateWakeGateStitched,
  FRAGMENT_STITCH_WINDOW_MS,
  isPresenceCheck,
  markAgentSpoke,
  normalizeTranscript,
  stripWakeWords,
  type WakeGateConfig,
} from './wake-gate.js'

const NOW = 1_750_000_000_000

const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  engagementWindowMs: 25_000,
}

const closed = { engagedUntil: 0 }

describe('normalizeTranscript', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTranscript('Hey, Jarvis!')).toBe('hey jarvis')
  })

  it('collapses spelled-out initials like "A.I."', () => {
    expect(normalizeTranscript('Hey A.I. David, you there?')).toBe('hey ai david you there')
  })
})

describe('containsWakeWord', () => {
  it('matches exact wake word', () => {
    expect(containsWakeWord('hey jarvis what is the status', 'jarvis')).toBe(true)
  })

  it('matches despite punctuation and case', () => {
    expect(containsWakeWord('Jarvis, can you summarize?', 'jarvis')).toBe(true)
  })

  it('tolerates one STT character error on single-token wake words', () => {
    expect(containsWakeWord('hey jarvus what do you think', 'jarvis')).toBe(true)
  })

  it('does NOT match an unrelated name', () => {
    expect(containsWakeWord('david can you take this one', 'jarvis')).toBe(false)
  })

  it('does not fuzzy-match short tokens', () => {
    expect(containsWakeWord('the jar is full', 'jarvis')).toBe(false)
  })

  it('tolerates one STT edit on a >=4-char token (re-wake contract, F6)', () => {
    // The dormant re-wake path relies on this fuzzy contract so a mis-heard
    // wake word ("Jervis") still re-arms the agent.
    expect(containsWakeWord('Hey Jervis can you summarize', 'jarvis')).toBe(true) // jervis: 1 edit
    expect(containsWakeWord('Hey Jarvis can you summarize', 'jarvis')).toBe(true) // exact
  })
})

describe('stripWakeWords (clean retrieval query)', () => {
  it('removes the wake word and leading hey so the query is the bare question', () => {
    expect(stripWakeWords('Hey Jarvis, can you tell me the status of AI receptionist', 'jarvis', DEFAULT_WAKE_ALIASES))
      .toBe('can you tell me the status of ai receptionist')
  })

  it('removes alias mishearings too', () => {
    expect(stripWakeWords('travis what is the robo sdr status', 'jarvis', DEFAULT_WAKE_ALIASES))
      .toBe('what is the robo sdr status')
  })

  it('falls back to the original text when stripping would empty it', () => {
    // Bare wake word -> nothing left -> return original (query never blank).
    expect(stripWakeWords('Jarvis', 'jarvis', DEFAULT_WAKE_ALIASES)).toBe('Jarvis')
    expect(stripWakeWords('jarvis', 'jarvis', DEFAULT_WAKE_ALIASES)).toBe('jarvis')
    // "hey jarvis" -> "hey" remains (non-empty); only presence checks hit this,
    // and they bypass retrieval, so a thin query here is harmless.
    expect(stripWakeWords('hey jarvis', 'jarvis', DEFAULT_WAKE_ALIASES)).toBe('hey')
  })

  it('leaves a wake-word-free query unchanged (normalized)', () => {
    expect(stripWakeWords('what is the status of AI receptionist', 'jarvis', DEFAULT_WAKE_ALIASES))
      .toBe('what is the status of ai receptionist')
  })
})

describe('evaluateWakeGate', () => {
  it('never activates in observe mode', () => {
    const d = evaluateWakeGate(closed, 'hey jarvis hello', { ...config, behaviorMode: 'observe' }, undefined, NOW)
    expect(d.activate).toBe(false)
  })

  it('activates on wake word in the current utterance', () => {
    const d = evaluateWakeGate(closed, 'hey jarvis what shipped this week', config, undefined, NOW)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('addressed')
  })

  it('does NOT activate on a question without wake word when gate is closed', () => {
    const d = evaluateWakeGate(closed, 'what do we think about the rollout', config, undefined, NOW)
    expect(d.activate).toBe(false)
  })

  it('does NOT activate when the wake word appeared only in an earlier utterance (no sliding window)', () => {
    // Legacy engine matched a 4-entry window; the new gate is current-utterance only.
    const d = evaluateWakeGate(closed, 'and the deadline is friday', config, undefined, NOW)
    expect(d.activate).toBe(false)
  })

  it('activates on a follow-up question within the engagement window', () => {
    const engaged = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(engaged, 'can you give more details', config, undefined, NOW + 10_000)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('follow-up')
  })

  it('does NOT activate on a follow-up after the window expires', () => {
    const engaged = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(engaged, 'can you give more details', config, undefined, NOW + 26_000)
    expect(d.activate).toBe(false)
  })

  it('does NOT activate on a non-question statement within the engagement window', () => {
    const engaged = markAgentSpoke(config, NOW)
    const d = evaluateWakeGate(engaged, 'ok thanks that helps', config, undefined, NOW + 5_000)
    expect(d.activate).toBe(false)
  })

  it('enforces owner-priority when allowedSpeakers is set and speaker is known', () => {
    const cfg = { ...config, allowedSpeakers: ['David He'] }
    const denied = evaluateWakeGate(closed, 'hey jarvis status update', cfg, 'Matt M', NOW)
    expect(denied.activate).toBe(false)
    const allowed = evaluateWakeGate(closed, 'hey jarvis status update', cfg, 'david he', NOW)
    expect(allowed.activate).toBe(true)
  })

  it('skips owner-priority when speaker is unknown (mixed-audio transcription)', () => {
    const cfg = { ...config, allowedSpeakers: ['David He'] }
    const d = evaluateWakeGate(closed, 'hey jarvis status update', cfg, undefined, NOW)
    expect(d.activate).toBe(true)
  })
})

describe('wake-word aliases', () => {
  const cfg: WakeGateConfig = { ...config, wakeAliases: DEFAULT_WAKE_ALIASES }

  it('activates on a known STT mis-hearing (round-15: "Hey Travis")', () => {
    const d = evaluateWakeGate(closed, 'Hey Travis, are you there?', cfg, undefined, NOW)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('addressed')
  })

  it('does not activate on aliases when none are configured', () => {
    const d = evaluateWakeGate(closed, 'Hey Travis, are you there?', config, undefined, NOW)
    expect(d.activate).toBe(false)
  })
})

describe('default engagement window', () => {
  it('is 30s — covers a genuine immediate follow-up, then stops assuming it is addressed', () => {
    expect(DEFAULT_ENGAGEMENT_WINDOW_MS).toBe(30_000)
  })
})

describe('isPresenceCheck', () => {
  it('detects bare presence checks with and without the wake word', () => {
    expect(isPresenceCheck('Hey Jarvis, are you there?', 'Jarvis')).toBe(true)
    expect(isPresenceCheck('are you still there', 'Jarvis')).toBe(true)
    expect(isPresenceCheck('can you hear me', 'Jarvis')).toBe(true)
    expect(isPresenceCheck('Hello?', 'Jarvis')).toBe(true)
    expect(isPresenceCheck('Hey Travis, are you there?', 'Jarvis', ['travis'])).toBe(true)
  })

  it('does NOT flag real questions as presence checks', () => {
    expect(isPresenceCheck('Hey Jarvis, what is the status of RoboSDR?', 'Jarvis')).toBe(false)
    expect(isPresenceCheck('can you tell me about the last meeting with Morgan', 'Jarvis')).toBe(false)
    expect(isPresenceCheck('give me an elevator pitch', 'Jarvis')).toBe(false)
  })
})

describe('evaluateWakeGateStitched', () => {
  it('activates when the stitched sentence is a question but the fragment alone is not', () => {
    // Round-15: "you actually can tell me" (activated, answered) then
    // "the latest status on robo sdr" judged alone -> dropped.
    const engaged = markAgentSpoke(config, NOW)
    const prev = { text: 'actually can you tell me', at: NOW + 1_000 }
    const d = evaluateWakeGateStitched(engaged, 'the latest status on robo sdr', config, prev, undefined, NOW + 3_000)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('stitched')
    expect(d.effectiveUtterance).toBe('actually can you tell me the latest status on robo sdr')
  })

  it('ignores fragments older than the stitch window', () => {
    const engaged = markAgentSpoke(config, NOW)
    const prev = { text: 'actually can you tell me', at: NOW }
    const d = evaluateWakeGateStitched(
      engaged,
      'the latest status on robo sdr',
      config,
      prev,
      undefined,
      NOW + FRAGMENT_STITCH_WINDOW_MS + 1_000,
    )
    expect(d.activate).toBe(false)
  })

  it('uses the CURRENT utterance only when it activates via wake word (does NOT prepend the prior fragment)', () => {
    // Behavior change (David 2026-06-23): a wake-word utterance starts a fresh
    // turn addressed to the agent. The prior fragment — often directed at
    // another person — must NOT be merged in (issue 1), and must not poison the
    // retrieval query.
    const prev = { text: 'i want to know about acme', at: NOW - 2_000 }
    const d = evaluateWakeGateStitched(closed, 'hey jarvis can you check', config, prev, undefined, NOW)
    expect(d.activate).toBe(true)
    expect(d.effectiveUtterance).toBe('hey jarvis can you check')
  })

  it('answers a wake-word presence check as presence-only, ignoring a prior to-other-human utterance (issue 1)', () => {
    // "Hey John, how was your week?" (to John) then "Hey Jarvis, can you hear
    // me?" (to the agent) must be a presence check, not an answer to John.
    const prev = { text: 'hey john so how was your week last time', at: NOW - 1_500 }
    const d = evaluateWakeGateStitched(closed, 'hey jarvis can you hear me', config, prev, undefined, NOW)
    expect(d.activate).toBe(true)
    expect(d.effectiveUtterance).toBe('hey jarvis can you hear me')
    expect(isPresenceCheck(d.effectiveUtterance, config.wakeWord, config.wakeAliases ?? [])).toBe(true)
  })

  it('behaves like evaluateWakeGate when there is no pending fragment', () => {
    const d = evaluateWakeGateStitched(closed, 'random chatter in the room', config, null, undefined, NOW)
    expect(d.activate).toBe(false)
    expect(d.effectiveUtterance).toBe('random chatter in the room')
  })
})
