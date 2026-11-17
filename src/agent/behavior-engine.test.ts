import { describe, it, expect } from 'vitest'
import {
  shouldRespond,
  looksLikeQuestion,
  matchesAgentName,
  matchesInWindow,
} from './behavior-engine.js'
import type { TranscriptEntry } from './behavior-engine.js'
import type { MeetingAgent } from './types.js'

function makeAgent(overrides: Partial<MeetingAgent> = {}): MeetingAgent {
  return {
    id: 'a1',
    name: 'Delegate',
    role: 'Senior AI Engineer',
    behavior_mode: 'delegated',
    speaking_style: 'professional',
    persona_mode: 'first_person',
    voice_id: null,
    confidence_threshold: 0.7,
    allowed_topics: null,
    denied_topics: [],
    escalation_rules: {},
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function entry(speaker: string, text: string, ts = '2026-04-15T12:00:00Z'): TranscriptEntry {
  return { speaker, text, timestamp: ts }
}

describe('looksLikeQuestion', () => {
  it('detects explicit question mark', () => {
    expect(looksLikeQuestion('what is this?')).toBe(true)
  })

  it('detects question words without punctuation', () => {
    expect(looksLikeQuestion('what is the current progress')).toBe(true)
    expect(looksLikeQuestion('how are things going')).toBe(true)
    expect(looksLikeQuestion('where did we land on that')).toBe(true)
    expect(looksLikeQuestion("what's the status")).toBe(true)
  })

  it('detects request patterns', () => {
    expect(looksLikeQuestion('can you give me an update')).toBe(true)
    expect(looksLikeQuestion('tell me about the pipeline')).toBe(true)
    expect(looksLikeQuestion('share your update')).toBe(true)
    expect(looksLikeQuestion('explain the architecture')).toBe(true)
  })

  it('rejects non-questions', () => {
    expect(looksLikeQuestion('okay sounds good')).toBe(false)
    expect(looksLikeQuestion('thanks')).toBe(false)
    expect(looksLikeQuestion('I agree with that')).toBe(false)
  })

  it('handles leading fillers + contracted interrogatives (the silent-follow-up bug)', () => {
    // The exact live miss: started with "okay", used the contraction "where'd".
    expect(looksLikeQuestion("okay where'd it go i'm reporting any status update on that")).toBe(true)
    expect(looksLikeQuestion("where'd it go")).toBe(true)
    expect(looksLikeQuestion('so what is the timeline')).toBe(true)
    expect(looksLikeQuestion('and how about the rollout')).toBe(true)
    expect(looksLikeQuestion('um who owns this')).toBe(true)
    // still not over-firing on filler-only / acknowledgements
    expect(looksLikeQuestion('okay sounds good')).toBe(false)
    expect(looksLikeQuestion('yeah that works for me')).toBe(false)
  })
})

describe('matchesAgentName', () => {
  it('matches literal substring (case-insensitive)', () => {
    expect(matchesAgentName('hey Delegate what time is it', 'Delegate')).toBe(true)
    expect(matchesAgentName('hey delegate', 'Delegate')).toBe(true)
  })

  it('fuzzy-matches single-character STT errors on long enough tokens', () => {
    expect(matchesAgentName('hey Delegete pull up the funnel', 'Delegate')).toBe(true)
    expect(matchesAgentName('hey Dellegate are you there', 'Delegate')).toBe(true)
  })

  it('does NOT fuzzy-match short tokens to avoid false positives', () => {
    expect(matchesAgentName('oh ok', 'of')).toBe(false)
    expect(matchesAgentName('ah ha', 'hi')).toBe(false)
  })

  it('returns false on unrelated text', () => {
    expect(matchesAgentName('the marketing team is here', 'Delegate')).toBe(false)
  })
})

describe('matchesInWindow', () => {
  const agent = makeAgent()

  it('returns false on empty transcript', () => {
    expect(matchesInWindow([], agent.name, 4)).toBe(false)
  })

  it('catches trigger word in an earlier chunk', () => {
    const transcript = [
      entry('Bob', 'hey Delegate'),
      entry('Bob', 'tell me about the funnel'),
    ]
    expect(matchesInWindow(transcript, agent.name, 4)).toBe(true)
  })

  it('ignores entries outside the window', () => {
    const transcript = [
      entry('Bob', 'hey Delegate'),
      entry('Alice', 'so anyway'),
      entry('Carol', 'about marketing'),
      entry('Dan', 'and the pipeline'),
      entry('Eve', 'is interesting'),
    ]
    expect(matchesInWindow(transcript, agent.name, 4)).toBe(false)
  })
})

describe('shouldRespond — respond mode with sliding window', () => {
  const agent = makeAgent({ behavior_mode: 'respond' })

  it('fires when trigger word lands in a previous chunk', () => {
    const transcript = [
      entry('Bob', 'hey Delegate'),
      entry('Bob', 'tell me about the funnel'),
    ]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(true)
  })

  it('does not fire when name is not in window', () => {
    const transcript = [entry('Bob', 'what is the marketing budget')]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(false)
  })
})

describe('shouldRespond — delegated mode', () => {
  const agent = makeAgent({ behavior_mode: 'delegated' })

  it('responds when directly addressed by name', () => {
    const transcript = [entry('Bob', 'hey Delegate what is the current progress')]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(true)
  })

  it('does NOT respond to questions without direct address', () => {
    const transcript = [entry('Bob', 'what is the current progress of the daily pipeline report')]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(false)
  })

  it('does NOT respond to "david" alone when agent is named Delegate', () => {
    const transcript = [entry('Bob', 'hey david share your update')]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(false)
  })

  it('does NOT respond to conversational statements after the wake word leaves the window', () => {
    const transcript = [
      entry('Bob', 'hey Delegate what did you work on'),
      entry('Delegate', 'I worked on the pipeline'),
      entry('Bob', 'thanks for that'),
      entry('Alice', 'so anyway'),
      entry('Carol', 'about marketing'),
      entry('Bob', 'log files i guess the marketing team is going to want to see that'),
    ]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(false)
  })

  it('rejects short non-questions when not engaged', () => {
    const transcript = [entry('Bob', 'ok')]
    const result = shouldRespond(agent, transcript, 0.5)
    expect(result.respond).toBe(false)
  })

  it('rejects when confidence too low', () => {
    const transcript = [entry('Bob', 'what do you think')]
    const result = shouldRespond(agent, transcript, 0.2)
    expect(result.respond).toBe(false)
  })
})

describe('shouldRespond — active mode', () => {
  it('does NOT fire on bare word "david" when agent is named Delegate', () => {
    const agent = makeAgent({ behavior_mode: 'active', confidence_threshold: 0.3 })
    const transcript = [entry('Bob', 'david is on the team')]
    const result = shouldRespond(agent, transcript, 0.9)
    expect(result.respond).toBe(false)
  })
})

describe('shouldRespond — observe mode', () => {
  it('never responds', () => {
    const agent = makeAgent({ behavior_mode: 'observe' })
    const transcript = [entry('Bob', 'hey Delegate what do you think?')]
    expect(shouldRespond(agent, transcript, 1.0).respond).toBe(false)
  })
})
