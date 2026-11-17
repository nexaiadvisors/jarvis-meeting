/**
 * Tier-1 tests for stop-command detection and dormant-mode logic.
 *
 * SCOPE CAVEAT: proves the pure isStopCommand function and the dormant-mode
 * routing logic (simulated via the same state machine the component uses).
 * Does NOT test that stopSpeaking() actually cancels audio — that's in the
 * audio-path tier. Barge-in audio timing is tracked in bead BZ-0z7y.
 */
import { describe, expect, it } from 'vitest'
import {
  containsWakeWord,
  DEFAULT_STOP_GRATITUDE_WINDOW_MS,
  DEFAULT_WAKE_ALIASES,
  evaluateWakeGate,
  isStopCommand,
  type WakeGateConfig,
  type WakeGateState,
} from './wake-gate.js'

const config: WakeGateConfig = {
  wakeWord: 'jarvis',
  behaviorMode: 'respond',
  wakeAliases: DEFAULT_WAKE_ALIASES,
  engagementWindowMs: 30_000,
}

const NOW = 1_750_000_000_000

// ---------------------------------------------------------------------------
// isStopCommand — true-positive cases
// ---------------------------------------------------------------------------
describe('isStopCommand — phrases that SHOULD trigger dormant mode', () => {
  const stops = [
    'be quiet',
    'go quiet',
    'stay quiet',
    'be silent',
    'stay silent',
    'shut up',
    'shush',
    'stand down',
    'stop talking',
    'stop speaking',
    'stop answering',
    "that's enough",
    'thats enough',
    // Gratitude/acknowledgment phrases used to be unconditional stops. They are
    // intentionally tested in the context-aware block below now.
    // With wake word prefix — still a stop command
    'jarvis be quiet',
    'hey jarvis stand down',
    'travis shut up',
    // With "hey" filler
    'hey be quiet',
    'hey stand down',
    // Punctuation / casing should not block detection
    'Be Quiet!',
    'STAND DOWN.',
    // F2: the two verbatim logged mid-sentence stop commands (must be true)
    "Okay, just be silent for now, and don't speak until I summon you again.",
    "Hey, hold on, Jarvis, I didn't summon you. I need you to be quiet until I specif",
    // F2: command contiguous-run additions
    'stop responding',
    'everyone please shut up', // contiguous run "shut up"
  ]

  for (const phrase of stops) {
    it(`detects stop: "${phrase}"`, () => {
      expect(isStopCommand(phrase, 'jarvis', DEFAULT_WAKE_ALIASES)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// isStopCommand — false-positive guard (must NOT activate dormant mode)
// ---------------------------------------------------------------------------
describe('isStopCommand — phrases that MUST NOT trigger dormant mode', () => {
  const nonStops = [
    // Questions
    'jarvis what is the status of the deal',
    'can you hear me',
    'are you there',
    // Meeting talk containing stop-adjacent words — must NOT silence the bot
    'we should stop the bleeding in Q3',
    'enough said about that topic',
    'enough time to close this quarter',
    'be quiet when the CEO speaks',
    'that is enough data for now',
    // Empty / unrelated
    '',
    'hello everyone',
    'let me pull up the deck',
    // Single-word ambiguous — intentionally excluded from the phrase sets
    'stop',
    'wait',
    'enough',
    // F2 false-positive guards: room-addressing / wrapped DIRECTED_ONLY phrases
    'we should stop the duplicate creation',
    'we should be silent in the library', // DIRECTED_ONLY phrase, no directed cue
    'be quieter please', // token boundary: must NOT match "be quiet"
    'be quiet everyone the meeting is starting', // room-addressing, no directed cue
    'be silent partners we need an nda', // room-addressing, no directed cue
    // Live 2026-07-08 regression: gratitude/acknowledgment room talk must not
    // fire without turn-ownership context.
    'OK, thanks a million.',
    "Okay thanks everyone, let's move on.",
    'ok thanks',
    'okay thanks',
    'got it thanks',
    'i got it',
  ]

  for (const phrase of nonStops) {
    it(`does NOT detect stop: "${phrase}"`, () => {
      expect(isStopCommand(phrase, 'jarvis', DEFAULT_WAKE_ALIASES)).toBe(false)
    })
  }
})

describe('isStopCommand — context-aware gratitude/acknowledgment phrases', () => {
  const stale = { agentSpeaking: false, msSinceAgentSpoke: 150_000 }

  it('does NOT stop on multi-party gratitude when the agent has been silent for over two minutes', () => {
    expect(isStopCommand('OK, thanks a million.', 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(false)
    expect(isStopCommand("Okay thanks everyone, let's move on.", 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(false)
  })

  it('stops on gratitude while the agent is currently speaking', () => {
    expect(
      isStopCommand('ok thanks jarvis', 'jarvis', DEFAULT_WAKE_ALIASES, {
        agentSpeaking: true,
        msSinceAgentSpoke: null,
      }),
    ).toBe(true)
    expect(
      isStopCommand('ok thanks', 'jarvis', DEFAULT_WAKE_ALIASES, {
        agentSpeaking: true,
        msSinceAgentSpoke: null,
      }),
    ).toBe(true)
  })

  it('stops on gratitude shortly after the agent finished speaking', () => {
    expect(
      isStopCommand('got it thanks', 'jarvis', DEFAULT_WAKE_ALIASES, {
        agentSpeaking: false,
        msSinceAgentSpoke: 3_000,
      }),
    ).toBe(true)
    expect(
      isStopCommand('got it thanks', 'jarvis', DEFAULT_WAKE_ALIASES, {
        agentSpeaking: false,
        msSinceAgentSpoke: DEFAULT_STOP_GRATITUDE_WINDOW_MS + 1,
      }),
    ).toBe(false)
  })

  it('stops on gratitude with a directed cue when context is present', () => {
    expect(isStopCommand('ok thanks jarvis', 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(true)
    expect(isStopCommand('ok thanks, you can stop there', 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(true)
  })

  it('keeps ADDRESSED command stops unconditional regardless of context', () => {
    expect(isStopCommand("Jarvis, that's enough", 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(true)
    // Un-addressed command stops now require turn ownership (2026-07-15 IRG
    // fix): a bare "shut up" when the agent has been silent for minutes is
    // room talk aimed at a human, not a command to the agent.
    expect(isStopCommand('shut up', 'jarvis', DEFAULT_WAKE_ALIASES, stale)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dormant-mode simulation: mirrors the logic in handleUserUtterance
// ---------------------------------------------------------------------------

/**
 * Minimal simulation of the dormant-gate logic that lives in the component.
 * Returns { activated, dormantAfter } so tests can assert the full state.
 */
function simulateUtterance(
  transcript: string,
  dormant: boolean,
  gateState: WakeGateState,
  now: number = NOW,
): { activated: boolean; dormantAfter: boolean; reason: string } {
  if (isStopCommand(transcript, config.wakeWord ?? '', config.wakeAliases ?? [])) {
    return { activated: false, dormantAfter: true, reason: 'stop command' }
  }

  if (dormant) {
    const hasWake =
      containsWakeWord(transcript, config.wakeWord ?? '') ||
      (config.wakeAliases ?? []).some((a) => containsWakeWord(transcript, a))
    if (hasWake) {
      // Clear dormant, fall through to normal gate.
      dormant = false
    } else {
      return { activated: false, dormantAfter: true, reason: 'dormant: no wake word' }
    }
  }

  const decision = evaluateWakeGate(gateState, transcript, config, undefined, now)
  return { activated: decision.activate, dormantAfter: false, reason: decision.reason }
}

const closedState: WakeGateState = { engagedUntil: 0 }

describe('dormant-mode state machine', () => {
  it('stop command => not activated, dormant=true', () => {
    const r = simulateUtterance('be quiet', false, closedState)
    expect(r.activated).toBe(false)
    expect(r.dormantAfter).toBe(true)
  })

  it('while dormant, non-wake utterance => suppressed', () => {
    const r = simulateUtterance('tell me more about the deal', true, closedState)
    expect(r.activated).toBe(false)
    expect(r.dormantAfter).toBe(true)
  })

  it('while dormant, wake word clears dormant and activates', () => {
    const r = simulateUtterance('jarvis what is the quarterly number', true, closedState)
    expect(r.activated).toBe(true)
    expect(r.dormantAfter).toBe(false)
  })

  it('while dormant, wake alias clears dormant and activates', () => {
    // "travis" is a DEFAULT_WAKE_ALIAS for "jarvis"
    const r = simulateUtterance('travis can you summarize', true, closedState)
    expect(r.activated).toBe(true)
    expect(r.dormantAfter).toBe(false)
  })

  it('follow-up question inside engagement window is suppressed while dormant', () => {
    // Even with an open engagement window, dormant must block follow-ups.
    const openWindow: WakeGateState = { engagedUntil: NOW + 30_000 }
    const r = simulateUtterance('what about last month?', true, openWindow)
    expect(r.activated).toBe(false)
    expect(r.dormantAfter).toBe(true)
  })

  it('stop command while dormant stays dormant', () => {
    // Saying "be quiet" again while already dormant is a no-op (already quiet).
    const r = simulateUtterance('be quiet', true, closedState)
    expect(r.activated).toBe(false)
    expect(r.dormantAfter).toBe(true)
  })

  it('non-stop non-dormant utterance with wake word activates normally', () => {
    const r = simulateUtterance('jarvis what is the pipeline this week', false, closedState)
    expect(r.activated).toBe(true)
    expect(r.dormantAfter).toBe(false)
  })

  it('jarvis-prefixed stop command enters dormant, not active', () => {
    const r = simulateUtterance('jarvis be quiet', false, closedState)
    expect(r.activated).toBe(false)
    expect(r.dormantAfter).toBe(true)
  })

  it('sequence: active -> stop -> dormant -> re-wake', () => {
    // Step 1: normal activation
    const s1 = simulateUtterance('jarvis what are our OKRs', false, closedState)
    expect(s1.activated).toBe(true)
    expect(s1.dormantAfter).toBe(false)

    // Step 2: user says "be quiet"
    const s2 = simulateUtterance('be quiet', false, closedState)
    expect(s2.activated).toBe(false)
    expect(s2.dormantAfter).toBe(true)

    // Step 3: random utterance while dormant
    const s3 = simulateUtterance('thanks everyone', true, closedState)
    expect(s3.activated).toBe(false)
    expect(s3.dormantAfter).toBe(true)

    // Step 4: wake word re-arms and activates
    const s4 = simulateUtterance('jarvis give me a summary', true, closedState)
    expect(s4.activated).toBe(true)
    expect(s4.dormantAfter).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isStopCommand — turn-ownership gate for un-addressed stop phrases
// (2026-07-15 IRG live failure: human-to-human "You shut up!" banter sent the
// IDLE agent dormant for the entire meeting.)
// ---------------------------------------------------------------------------
describe('isStopCommand — un-addressed stops require the agent to own the turn', () => {
  const idle = { agentSpeaking: false, msSinceAgentSpoke: null }
  const longIdle = { agentSpeaking: false, msSinceAgentSpoke: DEFAULT_STOP_GRATITUDE_WINDOW_MS + 1 }
  const speaking = { agentSpeaking: true, msSinceAgentSpoke: 0 }
  const justSpoke = { agentSpeaking: false, msSinceAgentSpoke: 3_000 }

  it('human-to-human banter while the agent is idle is NOT a stop (verbatim live utterance)', () => {
    expect(
      isStopCommand("I didn't tell them about your comment. You shut up!", 'jarvis', DEFAULT_WAKE_ALIASES, idle),
    ).toBe(false)
    expect(isStopCommand('you shut up', 'jarvis', DEFAULT_WAKE_ALIASES, longIdle)).toBe(false)
    expect(isStopCommand('be quiet', 'jarvis', DEFAULT_WAKE_ALIASES, idle)).toBe(false)
    expect(isStopCommand('everyone please shut up', 'jarvis', DEFAULT_WAKE_ALIASES, longIdle)).toBe(false)
  })

  it('the same phrases DO stop the agent while it is speaking or just spoke', () => {
    expect(isStopCommand('shut up', 'jarvis', DEFAULT_WAKE_ALIASES, speaking)).toBe(true)
    expect(isStopCommand('you shut up', 'jarvis', DEFAULT_WAKE_ALIASES, speaking)).toBe(true)
    expect(isStopCommand('stop talking', 'jarvis', DEFAULT_WAKE_ALIASES, justSpoke)).toBe(true)
    expect(isStopCommand('be quiet please', 'jarvis', DEFAULT_WAKE_ALIASES, speaking)).toBe(true)
  })

  it('an ADDRESSED stop is always honored, even while idle (pre-emptive silencing)', () => {
    expect(isStopCommand('Jarvis, be quiet', 'jarvis', DEFAULT_WAKE_ALIASES, idle)).toBe(true)
    expect(isStopCommand('Jarvis, shut up', 'jarvis', DEFAULT_WAKE_ALIASES, longIdle)).toBe(true)
    expect(isStopCommand('jarvis stop talking', 'jarvis', DEFAULT_WAKE_ALIASES, idle)).toBe(true)
  })

  it('without context the broad legacy behavior is preserved (fail-safe)', () => {
    expect(isStopCommand('shut up', 'jarvis', DEFAULT_WAKE_ALIASES)).toBe(true)
  })
})
