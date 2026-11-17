import type { MeetingAgent } from './types.js'

export interface TranscriptEntry {
  speaker: string
  text: string
  timestamp: string
}

const QUESTION_STARTERS = [
  'what', 'where', 'when', 'who', 'why', 'how', 'which', 'whose',
  'can you', 'could you', 'do you', 'did you', 'are you', 'is there', 'will you', 'would you',
  'tell me', 'give me', 'show me', 'walk me', 'remind me', 'share', 'explain', 'describe', 'list', 'summarize',
  'what about', 'how about', 'more on', 'go on', 'any update',
  "what's", "where's", "who's", "how's", "what're",
]

// Leading fillers/backchannels that precede a real question in speech
// ("okay where'd it go", "so what's the status", "and how about X").
const LEADING_FILLERS_RE = /^(?:(?:okay|ok|so|and|well|um+|uh+|yeah|yep|alright|hey|now|but|also|hmm+)[,\s]+)+/i
// Single-word interrogatives — matched as the first token so contractions
// ("where'd", "what's", "how's") count even though the bare list can't list them all.
const INTERROGATIVE_STEMS = ['what', 'where', 'when', 'who', 'why', 'how', 'which', 'whose']

/**
 * Detect questions even without '?' — transcription drops punctuation, and live
 * follow-ups arrive with leading fillers + contracted interrogatives that the
 * naive starter-list missed (the silent-follow-up bug: "okay where'd it go ..."
 * started with "okay" and used "where'd", so it read as a non-question and the
 * agent stayed dormant inside its engagement window).
 */
export function looksLikeQuestion(text: string): boolean {
  if (text.includes('?')) return true
  const lower = text.toLowerCase().trim()
  const stripped = lower.replace(LEADING_FILLERS_RE, '').trim()
  if (!stripped) return false
  const firstTok = stripped.split(/\s+/)[0] ?? ''
  if (INTERROGATIVE_STEMS.some(w => firstTok === w || firstTok.startsWith(`${w}'`))) return true
  return QUESTION_STARTERS.some(p => stripped.startsWith(p) || stripped.includes(` ${p} `))
}

function levenshtein(a: string, b: string): number {
  if (a.length > 64 || b.length > 64) return Infinity
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

export function matchesAgentName(text: string, agentName: string): boolean {
  const t = text.toLowerCase()
  const name = agentName.toLowerCase()
  if (!name) return false
  if (t.includes(name)) return true
  const tokens = t.split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    if (tok.length < 4) continue
    if (levenshtein(tok, name) <= 1) return true
  }
  return false
}

export function matchesInWindow(
  transcript: TranscriptEntry[],
  agentName: string,
  windowSize = 4,
): boolean {
  if (transcript.length === 0) return false
  const recent = transcript.slice(-windowSize)
  const joined = recent.map(e => e.text).join(' ')
  return matchesAgentName(joined, agentName)
}

function recentlyEngaged(agent: MeetingAgent, transcript: TranscriptEntry[], windowSize = 5): boolean {
  const recent = transcript.slice(-windowSize)
  return recent.some(entry => {
    return entry.speaker === agent.name || matchesAgentName(entry.text, agent.name)
  })
}

export function shouldRespond(
  agent: MeetingAgent,
  recentTranscript: TranscriptEntry[],
  confidence: number,
): { respond: boolean; reason: string } {
  const last = recentTranscript[recentTranscript.length - 1]

  switch (agent.behavior_mode) {
    case 'observe':
      return { respond: false, reason: 'observe mode' }

    case 'respond': {
      if (!last) return { respond: false, reason: 'no transcript entries' }
      if (matchesInWindow(recentTranscript, agent.name, 4)) {
        return { respond: true, reason: 'direct address or name mentioned' }
      }
      return { respond: false, reason: 'not directly addressed' }
    }

    case 'active': {
      if (!last) return { respond: false, reason: 'no transcript entries' }
      if (confidence <= agent.confidence_threshold) {
        return { respond: false, reason: 'confidence below threshold' }
      }
      if (recentTranscript.length >= 2) {
        const prev = recentTranscript[recentTranscript.length - 2]!
        const bothOthers =
          prev.speaker !== agent.name && last.speaker !== agent.name
        if (bothOthers && prev.speaker !== last.speaker) {
          return { respond: false, reason: 'rapid back-and-forth between other speakers' }
        }
      }
      const hasQuestion = looksLikeQuestion(last.text)
      const isDirectAddress = matchesInWindow(recentTranscript, agent.name, 4)
      if (hasQuestion || isDirectAddress) {
        return { respond: true, reason: 'question or direct address with sufficient confidence' }
      }
      return { respond: false, reason: 'no question or direct address' }
    }

    case 'delegated': {
      if (!last) return { respond: false, reason: 'no transcript entries' }
      if (confidence < 0.3) {
        return { respond: false, reason: 'confidence too low' }
      }
      const isDirectAddress = matchesInWindow(recentTranscript, agent.name, 4)

      if (isDirectAddress) {
        return { respond: true, reason: 'direct address' }
      }
      const engaged = recentlyEngaged(agent, recentTranscript)
      if (engaged && looksLikeQuestion(last.text) && isDirectAddress) {
        return { respond: true, reason: 'follow-up question while recently engaged' }
      }
      return { respond: false, reason: 'not directly addressed' }
    }

    default:
      return { respond: false, reason: `unknown behavior_mode: ${agent.behavior_mode}` }
  }
}
