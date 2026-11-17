import { describe, it, expect } from 'vitest'
import { shouldCommitOnPartial } from './wake-gate.js'

describe('shouldCommitOnPartial', () => {
  const W = 'Jarvis'
  it('commits on an addressed complete question', () => {
    expect(shouldCommitOnPartial('Jarvis what did we decide about the Falcon deadline', W)).toBe(true)
    expect(shouldCommitOnPartial('hey Jarvis can you summarize the morning session', W)).toBe(true)
  })
  it('does NOT commit on a bare wake word or too-short fragment', () => {
    expect(shouldCommitOnPartial('Jarvis', W)).toBe(false)
    expect(shouldCommitOnPartial('Jarvis um', W)).toBe(false)
    expect(shouldCommitOnPartial('Jarvis so', W)).toBe(false)
  })
  it('does NOT commit when the agent is not addressed', () => {
    expect(shouldCommitOnPartial('so I think we should ship the thing this week', W)).toBe(false)
    expect(shouldCommitOnPartial('what did Jarvis say earlier', W)).toBe(false) // mention, not address
  })
  it('commits once enough content accumulates even without a question mark', () => {
    expect(shouldCommitOnPartial('Jarvis pull up the pod operating system proposal for me', W)).toBe(true)
  })
  it('honors aliases', () => {
    expect(shouldCommitOnPartial('Travis what is our Q3 revenue forecast', W, ['travis'])).toBe(true)
  })
})
