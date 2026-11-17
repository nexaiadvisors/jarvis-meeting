// Paces the on-tile caption to the voice.
//
// The model sends the transcript of an answer much faster than the audio, and the audio
// itself arrives at about the speed it plays. So neither "show text as it arrives" nor
// "show the share of the audio that has played" works: both run ahead (live calls,
// 2026-11-14). The caption is revealed at the speaking rate instead: characters per
// second of speech, learned from finished answers.

/** The text may lead the voice by this much, so a word is on screen as it is spoken. */
export const CAPTION_LEAD_SEC = 0.35

/** Typical speaking rate of the realtime voices, used until an answer has been measured. */
export const DEFAULT_CHARS_PER_SEC = 15

const MIN_CHARS_PER_SEC = 8
const MAX_CHARS_PER_SEC = 26

/** A measured rate, kept inside the range a voice can actually speak at. */
export function speakingRate(chars: number, audioSec: number, fallback: number = DEFAULT_CHARS_PER_SEC): number {
  if (!(audioSec >= 1) || !(chars >= 10)) return fallback
  return Math.min(MAX_CHARS_PER_SEC, Math.max(MIN_CHARS_PER_SEC, chars / audioSec))
}

/**
 * The part of `text` to show after `playedSec` of speech at `charsPerSec`.
 * Cut at a word boundary, and never ahead of the text that has arrived.
 */
export function pacedCaption(text: string, playedSec: number, charsPerSec: number): string {
  if (text === '' || !(playedSec >= 0)) return ''
  const cut = Math.floor((playedSec + CAPTION_LEAD_SEC) * charsPerSec)
  if (cut >= text.length) return text
  if (cut <= 0) return ''
  // Never stop mid-word: back up to the last space at or before the cut.
  if (/\s/.test(text[cut] ?? ' ')) return text.slice(0, cut).trimEnd()
  const space = text.lastIndexOf(' ', cut)
  return space <= 0 ? '' : text.slice(0, space)
}

/**
 * The last sentence of what was said, left on the tile after the agent stops speaking so
 * a glance at the screen still shows how the answer ended.
 */
export function lastSentence(text: string, maxChars = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  const sentences = clean.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [clean]
  const last = (sentences[sentences.length - 1] ?? clean).trim()
  if (last.length <= maxChars) return last
  const cut = last.lastIndexOf(' ', maxChars)
  return `${last.slice(0, cut > 0 ? cut : maxChars)}…`
}
