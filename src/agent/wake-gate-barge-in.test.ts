import { describe, expect, it } from 'vitest'
import {
  isAddressedToAgent,
  isStopCommand,
  shouldHoldFloorOnSpeechStarted,
} from './wake-gate.js'

/**
 * Output-side barge-in policy (noisy-room fix): bare server_vad speech onsets
 * must NOT interrupt an in-flight answer — background noise fires VAD too.
 * Interruption is decided at the transcription level: a stop command or an
 * addressed question are the only speech paths allowed to cut the agent off.
 */
describe('shouldHoldFloorOnSpeechStarted', () => {
  it('holds the floor while a response is in flight (thinking/generating)', () => {
    expect(shouldHoldFloorOnSpeechStarted({ responseActive: true, audioPlaying: false })).toBe(true)
  })
  it('holds the floor while audio is playing (speaking)', () => {
    expect(shouldHoldFloorOnSpeechStarted({ responseActive: false, audioPlaying: true })).toBe(true)
  })
  it('holds the floor through the buffered audio tail (response done, audio draining)', () => {
    expect(shouldHoldFloorOnSpeechStarted({ responseActive: true, audioPlaying: true })).toBe(true)
  })
  it('does NOT hold when the agent is idle — onset may flush stale playout', () => {
    expect(shouldHoldFloorOnSpeechStarted({ responseActive: false, audioPlaying: false })).toBe(false)
  })
})

describe('transcription-level interrupts still work while the floor is held', () => {
  it('"Jarvis stop" is a stop command while the agent is speaking', () => {
    expect(
      isStopCommand('Jarvis stop talking', 'jarvis', [], { agentSpeaking: true, msSinceAgentSpoke: 0 }),
    ).toBe(true)
    expect(
      isStopCommand('jarvis be quiet', 'jarvis', [], { agentSpeaking: true, msSinceAgentSpoke: 0 }),
    ).toBe(true)
  })
  it('an addressed question is an activation (the other allowed interrupt path)', () => {
    expect(isAddressedToAgent('Jarvis, what about the renewal numbers instead?', 'jarvis', [])).toBe(true)
  })
  it('background chatter is neither a stop nor an address — it can never interrupt', () => {
    const chatter = 'yeah I think the vendor call went fine'
    expect(isStopCommand(chatter, 'jarvis', [], { agentSpeaking: true, msSinceAgentSpoke: 0 })).toBe(false)
    expect(isAddressedToAgent(chatter, 'jarvis', [])).toBe(false)
  })
})

describe('greeted by name mid-utterance', () => {
  it('is an address wherever the greeting falls', () => {
    expect(isAddressedToAgent('Okay, it shows waiting. Hey Jarvis, are you still there?', 'jarvis', [])).toBe(true)
    expect(isAddressedToAgent('it shows waiting hey jarvis are you still there', 'jarvis', [])).toBe(true)
    expect(isAddressedToAgent('one second. Jarvis are you with us', 'jarvis', [])).toBe(true)
  })
  it('still treats a passing mention as a mention', () => {
    expect(isAddressedToAgent('let me see if my jarvis is still here', 'jarvis', [])).toBe(false)
    expect(isAddressedToAgent('good luck with jarvis bye david', 'jarvis', [])).toBe(false)
    expect(isAddressedToAgent('we said hey to jarvis earlier and moved on', 'jarvis', [])).toBe(false)
  })
})
