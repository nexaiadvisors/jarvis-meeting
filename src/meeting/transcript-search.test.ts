import { describe, expect, it } from 'vitest'
import {
  MAX_TRANSCRIPT_RESULT_CHARS,
  rankTranscriptEntries,
  type TranscriptEntry,
} from './transcript-search.js'

const entry = (speaker: string, text: string, timestamp: string): TranscriptEntry => ({ speaker, text, timestamp })

describe('rankTranscriptEntries', () => {
  it('returns keyword-overlap hits and omits misses', () => {
    const results = rankTranscriptEntries(
      [
        entry('Alice', 'The launch date is Monday.', '2026-07-14T09:00:00.000Z'),
        entry('Bob', 'We should discuss catering.', '2026-07-14T09:01:00.000Z'),
      ],
      'what did Alice say about launch',
    )

    expect(results).toEqual([entry('Alice', 'The launch date is Monday.', '2026-07-14T09:00:00.000Z')])
    expect(rankTranscriptEntries(results, 'unrelated topic')).toEqual([])
  })

  it('uses recency to break equal-overlap ties', () => {
    const older = entry('Alice', 'The budget is approved.', '2026-07-14T09:00:00.000Z')
    const newer = entry('Bob', 'The budget is approved.', '2026-07-14T10:00:00.000Z')

    expect(rankTranscriptEntries([older, newer], 'budget')).toEqual([newer, older])
  })

  it('caps returned transcript text at 500 characters', () => {
    const [result] = rankTranscriptEntries(
      [entry('Alice', `budget ${'x'.repeat(600)}`, '2026-07-14T09:00:00.000Z')],
      'budget',
    )

    expect(result?.text).toHaveLength(MAX_TRANSCRIPT_RESULT_CHARS)
  })
})
