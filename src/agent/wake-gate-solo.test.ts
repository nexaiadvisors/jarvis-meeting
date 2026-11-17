import { describe, expect, it } from 'vitest'
import { evaluateWakeGate, isPromptEcho, isSolo, looksLikeRequest, type WakeGateConfig, type WakeGateState } from './wake-gate.js'

const idle: WakeGateState = { engagedUntil: 0 }
const solo: WakeGateConfig = { wakeWord: 'Jarvis', wakeAliases: [], participantCount: 2 }
const gate = (utterance: string, config: WakeGateConfig = solo) => evaluateWakeGate(idle, utterance, config, 'David')

describe('one person in the call', () => {
  it('is solo only when the live count is exactly one person plus the bot', () => {
    expect(isSolo(solo)).toBe(true)
    expect(isSolo({ ...solo, participantCount: 3 })).toBe(false)
    expect(isSolo({ wakeWord: 'Jarvis' })).toBe(false)
  })

  it('answers a question with no wake word and no recent answer', () => {
    const decision = gate('Okay, what projects am I working on?')
    expect(decision.activate).toBe(true)
    expect(decision.reason).toContain('one person in the call')
  })

  it('answers a request with no wake word', () => {
    expect(gate("tell me what's on my calendar for today").activate).toBe(true)
    expect(gate('can you check my email from Pat').activate).toBe(true)
  })

  it('leaves a remark alone', () => {
    expect(gate('Oh, I saw the bar that was open.').activate).toBe(false)
    expect(gate('okay that makes sense to me').activate).toBe(false)
  })

  it('ignores a fragment of one or two words', () => {
    expect(gate('what now').activate).toBe(false)
  })

  it('still needs the wake word when more people are in the call', () => {
    expect(gate('Okay, what projects am I working on?', { ...solo, participantCount: 3 }).activate).toBe(false)
    expect(gate('Jarvis, what projects am I working on?', { ...solo, participantCount: 3 }).activate).toBe(true)
  })

  it('still needs the wake word while the count is unknown', () => {
    expect(gate('what projects am I working on?', { wakeWord: 'Jarvis', wakeAliases: [], participantCount: 3 }).activate).toBe(false)
  })

  it('does not answer over overlapping speech', () => {
    expect(gate('what projects am I working on?', { ...solo, overlappingSpeech: true }).activate).toBe(false)
  })
})

describe('looksLikeRequest', () => {
  it('recognizes requests behind filler words', () => {
    for (const text of ['Tell me about Northwind', 'okay so can you look that up', 'please summarize last week', 'I need you to check my calendar']) {
      expect(looksLikeRequest(text)).toBe(true)
    }
  })

  it('does not treat a statement as a request', () => {
    for (const text of ['I checked the calendar already', 'the list is long', 'we should find a time']) {
      expect(looksLikeRequest(text)).toBe(false)
    }
  })
})

describe('isPromptEcho', () => {
  const prompt = 'Jarvis, OpenBrain, Acme, Beads'

  it('recognises the speech-to-text prompt coming back as a transcript', () => {
    expect(isPromptEcho('Jarvis, OpenBrain, Acme, Beads', prompt)).toBe(true)
    expect(isPromptEcho('Jarvis OpenBrain Acme.', prompt)).toBe(true)
  })

  it('lets real speech through, including the wake word alone', () => {
    expect(isPromptEcho('Jarvis', prompt)).toBe(false)
    expect(isPromptEcho('Hey Jarvis', prompt)).toBe(false)
    expect(isPromptEcho('Jarvis, what is Sideshop?', prompt)).toBe(false)
    expect(isPromptEcho('tell me about OpenBrain', prompt)).toBe(false)
  })

  it('does nothing without a prompt', () => {
    expect(isPromptEcho('Jarvis OpenBrain', '')).toBe(false)
  })
})
