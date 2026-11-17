/**
 * Tier-1 adversarial wake matrix for the meeting agent.
 *
 * SCOPE CAVEAT: this suite proves event-reaction LOGIC ONLY — that the pure
 * wake-gate functions activate on the right tokens and stay silent on the
 * wrong ones. It does NOT prove interruption timing or that "barge-in works";
 * those are owned by the later audio-path tier and the full-duplex
 * interruptibility fix (bead BZ-0z7y).
 *
 * Additive to wake-gate.test.ts (does not modify it). The matrix hardens the
 * regression backbone with the homophone aliases that SHOULD activate and the
 * substring / near-homophone name traps that MUST NOT — both directions
 * asserted, because a wake gate is only as good as its false-positive floor.
 */
import { describe, expect, it } from 'vitest'
import {
  containsWakeWord,
  DEFAULT_WAKE_ALIASES,
  evaluateWakeGate,
  isPresenceCheck,
  normalizeTranscript,
  type WakeGateConfig,
} from './wake-gate.js'

const NOW = 1_750_000_000_000

const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  wakeAliases: DEFAULT_WAKE_ALIASES,
  engagementWindowMs: 25_000,
}

const closed = { engagedUntil: 0 }

const activate = (utterance: string, speaker?: string) =>
  evaluateWakeGate(closed, utterance, config, speaker, NOW).activate

describe('normalizeTranscript (adversarial)', () => {
  it('strips repeated punctuation and surrounding noise', () => {
    expect(normalizeTranscript('JARVIS!!!')).toBe('jarvis')
    expect(normalizeTranscript('  the jar, is open.  ')).toBe('the jar is open')
  })

  it('collapses chained spelled-out initials', () => {
    expect(normalizeTranscript('the R.O.B.O. metric')).toBe('the robo metric')
  })
})

describe('adversarial wake matrix — homophone aliases SHOULD activate', () => {
  // DEFAULT_WAKE_ALIASES = ['travis','jervis','gervis','jarvas'] (verified).
  // 'jervis'/'jarvas' are within 1 edit of "jarvis" so they match the fuzzy
  // wake-word path directly; 'travis'/'gervis' match via the alias list.
  it.each(DEFAULT_WAKE_ALIASES)('activates on STT mis-hearing "%s"', (alias) => {
    expect(activate(`hey ${alias} what is the status`)).toBe(true)
  })

  it('reports the alias path for a true alias-only mis-hearing ("travis")', () => {
    const d = evaluateWakeGate(closed, 'Hey Travis, are you there?', config, undefined, NOW)
    expect(d.activate).toBe(true)
    expect(d.reason).toContain('addressed')
  })

  it('does NOT activate on those aliases when none are configured', () => {
    const noAliases: WakeGateConfig = { ...config, wakeAliases: [] }
    for (const alias of ['travis', 'gervis']) {
      expect(evaluateWakeGate(closed, `hey ${alias} hello`, noAliases, undefined, NOW).activate).toBe(false)
    }
  })
})

describe('adversarial wake matrix — substring & name traps MUST NOT activate', () => {
  // Substring traps: the wake word sits inside an unrelated word/phrase.
  it.each(['the jar is open', 'in Paris', 'that color is garish', 'a jarful of marbles'])(
    'stays silent on substring trap %j',
    (utterance) => {
      expect(activate(utterance)).toBe(false)
    },
  )

  // Near-homophone NAMES that are not the wake word or a configured alias.
  // (lev jared/jarvis=3, marvin/jarvis=2, paris/jarvis=2 — all beyond the
  // 1-edit fuzz, verified.)
  it.each(['can jared take the notes', 'marvin is presenting next', 'let us ask marvin about it'])(
    'stays silent on near-homophone name %j',
    (utterance) => {
      expect(activate(utterance)).toBe(false)
    },
  )

  it('does not fuzzy-match short tokens (the jar / a jar)', () => {
    expect(containsWakeWord('the jar is full', 'jarvis')).toBe(false)
    expect(containsWakeWord('grab a jar', 'jarvis')).toBe(false)
  })
})

describe('adversarial wake matrix — presence checks classified correctly', () => {
  it.each([
    'Hey Jarvis, are you there?',
    'are you still there',
    'can you hear me',
    'hey jarvis good morning',
    'Hello?',
  ])('classifies %j as a presence check', (utterance) => {
    expect(isPresenceCheck(utterance, 'Jarvis', DEFAULT_WAKE_ALIASES)).toBe(true)
  })

  it.each([
    'Hey Jarvis, what is the status of RoboSDR?',
    'can you tell me about the last meeting with Morgan',
    'give me an elevator pitch for the funnel',
  ])('does NOT misclassify real question %j as a presence check', (utterance) => {
    expect(isPresenceCheck(utterance, 'Jarvis', DEFAULT_WAKE_ALIASES)).toBe(false)
  })

  it('does not treat a long presence-shaped ramble (>6 tokens) as a presence check', () => {
    // 5 content tokens after stripping the wake word — within the bare-check cap.
    expect(isPresenceCheck('hey jarvis can you hear me', 'Jarvis', DEFAULT_WAKE_ALIASES)).toBe(true)
    // 9 presence-shaped tokens — past the >6 cap, so it is NOT a bare check.
    expect(isPresenceCheck('hey are you there can you hear me okay', 'Jarvis', DEFAULT_WAKE_ALIASES)).toBe(false)
  })
})
