import { describe, expect, it } from 'vitest'
import { CAPTION_LEAD_SEC, DEFAULT_CHARS_PER_SEC, lastSentence, pacedCaption, speakingRate } from './caption-pace.js'

const text = 'You have one thing on your calendar today and the rest of the day is open for other work'

describe('pacedCaption', () => {
  it('shows nothing before the voice starts', () => {
    expect(pacedCaption(text, -1, 15)).toBe('')
    expect(pacedCaption('', 3, 15)).toBe('')
  })

  it('reveals text at the speaking rate, however much text has already arrived', () => {
    // The whole text is here, but only 2 seconds have been spoken.
    const shown = pacedCaption(text, 2, 15)
    expect(shown.length).toBeLessThanOrEqual(Math.floor((2 + CAPTION_LEAD_SEC) * 15))
    expect(shown.length).toBeGreaterThan(20)
    expect(text.startsWith(shown)).toBe(true)
  })

  it('never cuts a word in half', () => {
    for (let played = 0; played <= 6; played += 0.23) {
      const shown = pacedCaption(text, played, 15)
      if (shown === '' || shown === text) continue
      expect(text[shown.length]).toBe(' ')
    }
  })

  it('shows everything once enough has been spoken, and never more than has arrived', () => {
    expect(pacedCaption(text, 60, 15)).toBe(text)
    expect(pacedCaption('Short.', 60, 15)).toBe('Short.')
  })

  it('only moves forward', () => {
    let last = 0
    for (let played = 0; played <= 8; played += 0.25) {
      const length = pacedCaption(text, played, 15).length
      expect(length).toBeGreaterThanOrEqual(last)
      last = length
    }
  })
})

describe('speakingRate', () => {
  it('measures characters per second of audio', () => {
    expect(speakingRate(150, 10)).toBe(15)
  })

  it('keeps the fallback when there is too little to measure', () => {
    expect(speakingRate(4, 0.3)).toBe(DEFAULT_CHARS_PER_SEC)
    expect(speakingRate(200, 0.5, 14)).toBe(14)
  })

  it('stays inside what a voice can speak', () => {
    expect(speakingRate(1000, 10)).toBe(26)
    expect(speakingRate(20, 10)).toBe(8)
  })
})

describe('lastSentence', () => {
  it('returns the final sentence of an answer', () => {
    expect(lastSentence('You have one thing today. It is payroll at nine. The rest of the day is open.')).toBe('The rest of the day is open.')
  })

  it('keeps a question mark and a single sentence whole', () => {
    expect(lastSentence('First part. Which topic would you like to work on?')).toBe('Which topic would you like to work on?')
    expect(lastSentence('Yes, I can hear you clearly.')).toBe('Yes, I can hear you clearly.')
  })

  it('handles text that was cut off mid-sentence, and empty text', () => {
    expect(lastSentence('Done. Sure, I am here to assist with')).toBe('Sure, I am here to assist with')
    expect(lastSentence('   ')).toBe('')
  })

  it('shortens a very long sentence at a word', () => {
    const long = `${'word '.repeat(80)}end.`
    const shown = lastSentence(long, 60)
    expect(shown.length).toBeLessThanOrEqual(61)
    expect(shown.endsWith('…')).toBe(true)
  })
})
