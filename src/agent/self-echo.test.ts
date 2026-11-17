/**
 * Tier-1 tests for the self-echo rejection gate (L1).
 *
 * SCOPE CAVEAT: pure-function only. Proves the agent's own delayed echo is
 * dropped while a genuine human barge-in (different words) passes through. Does
 * NOT prove the acoustic loop exists or its timing — that is measured live and,
 * if it survives, addressed by L2/L3 (bead BZ-0z7y).
 */
import { describe, expect, it } from 'vitest'
import {
  isSelfEcho,
  tokenSetRatio,
  SELF_ECHO_WINDOW_MS,
  type SpokenWindow,
} from './wake-gate.js'

const NOW = 1_750_000_000_000

// The kind of thing the agent says (its greeting / an answer).
const AGENT_SAID =
  "Hello, I'm Jarvis, an AI meeting assistant for the team. I can answer questions from the company knowledge base, take meeting notes, flag follow-ups, and draft messages for review."

describe('tokenSetRatio', () => {
  it('is 1.0 when every inbound token appears in the reference', () => {
    expect(tokenSetRatio('take meeting notes', AGENT_SAID)).toBeCloseTo(1, 5)
  })

  it('is low when the inbound shares few tokens with the reference', () => {
    expect(tokenSetRatio('what is the pipeline this quarter', AGENT_SAID)).toBeLessThan(0.4)
  })

  it('is 0 for an empty inbound', () => {
    expect(tokenSetRatio('', AGENT_SAID)).toBe(0)
  })

  it('normalizes punctuation/case before comparing', () => {
    expect(tokenSetRatio('JARVIS, an AI assistant!', "i'm jarvis an ai assistant")).toBeCloseTo(1, 5)
  })
})

describe('isSelfEcho', () => {
  const spoken: SpokenWindow = { text: AGENT_SAID, endedAt: NOW }

  it('drops a near-verbatim echo of the agent inside the window', () => {
    const echo = 'I can answer questions from the company knowledge base take meeting notes and flag follow ups'
    expect(isSelfEcho(echo, spoken, NOW + 800)).toBe(true)
  })

  it('passes a genuine human barge-in (different words) inside the window', () => {
    expect(isSelfEcho('Jarvis what is the status of the Acme deal', spoken, NOW + 800)).toBe(false)
  })

  it('passes once the echo window has elapsed', () => {
    const echo = 'I can answer questions from the company knowledge base and take meeting notes'
    expect(isSelfEcho(echo, spoken, NOW + SELF_ECHO_WINDOW_MS + 1)).toBe(false)
  })

  it('does not drop short utterances (below the min-token floor)', () => {
    // "take meeting notes" overlaps 100% but is too short to be treated as echo
    // (and could never open the wake gate on its own anyway).
    expect(isSelfEcho('take meeting notes', spoken, NOW + 500)).toBe(false)
  })

  it('returns false when there is no spoken window yet', () => {
    expect(isSelfEcho('I can answer questions from the company knowledge base', { text: '', endedAt: 0 }, NOW)).toBe(false)
  })

  it('passes a question that merely shares a couple of common words', () => {
    // shares "meeting" / "the" only — below threshold
    expect(isSelfEcho('how did the budget meeting go yesterday afternoon', spoken, NOW + 500)).toBe(false)
  })
})
