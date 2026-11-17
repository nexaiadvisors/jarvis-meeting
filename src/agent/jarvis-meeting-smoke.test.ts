/**
 * Tier-1 SMOKE-AS-REPLAY for the meeting agent.
 *
 * SCOPE CAVEAT (read before extending): this is the deterministic
 * event-reaction smoke gate. It replays a fixed scripted transcript through
 * the pure wake-gate (+ retrieval-injection formatting) and asserts the wake
 * matrix and that the expected-answer substring would be injected ahead of the
 * model's response. It proves the handler reacts correctly to a given sequence
 * of events — it does NOT prove interruption TIMING, that "barge-in works", or
 * answer correctness. Those live in the later audio-path tier (the real
 * barge-in gate), the advisory team-KB grounding eval, and the full-duplex
 * interruptibility fix (bead BZ-0z7y). No audio, no Recall, no network — the
 * clock is injected so the replay is byte-for-byte reproducible.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateWakeGateStitched,
  isPresenceCheck,
  markAgentSpoke,
  type PendingFragment,
  type WakeGateConfig,
  type WakeGateState,
} from './wake-gate.js'
import { formatRetrievalForInjection } from './realtime-config.js'

const NOW = 1_750_000_000_000
const SECOND = 1_000

const config: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'respond',
  wakeAliases: ['travis', 'jervis', 'gervis', 'jarvas'],
  engagementWindowMs: 60_000,
}

// A tiny deterministic "knowledge base" standing in for fanOutSearch results,
// so the smoke test asserts the injected context WITHOUT any network. Keyed by
// a substring of the question.
const CANNED: { match: RegExp; rows: { entity_key: string; content: string }[] }[] = [
  {
    match: /robo ?sdr/i,
    rows: [{ entity_key: 'robosdr_status_2026-06', content: 'RoboSDR is in pilot with two design partners.' }],
  },
  {
    match: /funnel/i,
    rows: [{ entity_key: 'funnel_weekly_2026-06', content: 'Top-of-funnel volume is up 12% week over week.' }],
  },
]

function retrieveAndFormat(question: string): string {
  const hit = CANNED.find((c) => c.match.test(question))
  return formatRetrievalForInjection(question, hit ? hit.rows : [])
}

interface ScriptStep {
  /** Seconds after NOW that this utterance completes. */
  at: number
  speaker?: string
  text: string
  /** Whether the wake gate is expected to open on this utterance. */
  expectActivate: boolean
  /** A substring expected in the injected retrieval context, if it activates. */
  expectInjected?: string
}

// One realistic standup: cold-open wake word, a non-question ack that stays
// silent inside the window, a follow-up question inside the window, a presence
// check, then room chatter (substring trap) that must stay silent after the
// window has closed. State is threaded honestly: each activation opens a fresh
// follow-up window; each silent turn becomes the next stitch candidate.
const SCRIPT: ScriptStep[] = [
  { at: 0, speaker: 'David He', text: 'Hey Jarvis, what is the status of RoboSDR?', expectActivate: true, expectInjected: 'pilot with two design partners' },
  { at: 5, speaker: 'David He', text: 'ok thanks that helps', expectActivate: false },
  // No wake word, but a question within the (still-open) follow-up window.
  { at: 15, speaker: 'David He', text: 'can you tell me the funnel numbers this week', expectActivate: true, expectInjected: 'up 12% week over week' },
  // Wake word again, but a bare presence check — acknowledged, NOT retrieved.
  { at: 20, speaker: 'David He', text: 'Hey Jarvis, are you there?', expectActivate: true },
  // Window has long since closed (last open ended at +80s); substring trap.
  { at: 90, speaker: 'Matt M', text: 'the jar is open on the counter', expectActivate: false },
]

describe('meeting agent smoke replay', () => {
  it('reacts correctly across a scripted standup transcript', () => {
    let state: WakeGateState = { engagedUntil: 0 }
    let prev: PendingFragment | null = null

    for (const step of SCRIPT) {
      const now = NOW + step.at * SECOND
      const decision = evaluateWakeGateStitched(state, step.text, config, prev, step.speaker, now)

      expect(decision.activate, `"${step.text}" @${step.at}s`).toBe(step.expectActivate)

      if (decision.activate) {
        // Presence checks acknowledge without a knowledge retrieval; everything
        // else injects grounded context ahead of the response.
        if (!isPresenceCheck(decision.effectiveUtterance, config.wakeWord, config.wakeAliases)) {
          const injected = retrieveAndFormat(decision.effectiveUtterance)
          if (step.expectInjected) {
            expect(injected, `injected for "${step.text}"`).toContain(step.expectInjected)
          }
        }
        // Activation clears the pending fragment and (modeled here) the agent
        // answers, re-opening the follow-up window from this moment.
        prev = null
        state = markAgentSpoke(config, now)
      } else {
        // A non-activating utterance becomes the stitch candidate for the next.
        prev = { text: step.text, at: now }
      }
    }
  })

  it('injects the no-results guard when a scripted question has no knowledge hit', () => {
    const injected = retrieveAndFormat('hey jarvis what is the airspeed of an unladen swallow')
    expect(injected).toContain('no relevant results')
    expect(injected.toLowerCase()).toContain('let me know if you have any other questions')
  })
})
