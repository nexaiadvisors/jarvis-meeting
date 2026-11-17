/**
 * Deterministic wake gate for the realtime meeting agent.
 *
 * The realtime session is configured with create_response: false, so the model
 * NEVER speaks on its own — the agent page calls evaluateWakeGate() on every
 * completed user utterance and only triggers a response when the gate opens.
 * Silence is enforced in code; the system prompt is a second layer, not the gate.
 *
 * Design (2026 best practice, Otter/Fireflies pattern):
 * - Activation requires the wake word in the CURRENT utterance (not a sliding
 *   window — that caused sticky/late false triggers in the legacy engine).
 * - After the agent speaks, a short engagement window allows wake-word-free
 *   follow-up questions.
 * - Optional allowedSpeakers list (owner-priority); when provided and a speaker
 *   label is known, only those speakers can open the gate.
 */

import { looksLikeQuestion } from './behavior-engine.js'

export interface WakeGateConfig {
  /** Activation phrase, e.g. "jarvis". Matched case/punctuation-insensitively. */
  wakeWord: string
  /**
   * Common STT mis-hearings of the wake word, matched with the same logic
   * (round-15 transcript: "hey jarvis" -> "Hey Travis" — levenshtein 3, beyond
   * the 1-edit fuzz). Keep the list tight; every alias widens false-positives.
   */
  wakeAliases?: string[]
  /** observe | respond | active | delegated — observe never activates. */
  behaviorMode: string
  /** How long after the agent last spoke that follow-up questions activate (ms). */
  engagementWindowMs?: number
  /** Narrow window after the agent finishes speaking for correction follow-ups. */
  correctionFollowupWindowMs?: number
  /** When non-empty, only these speakers can open the gate (owner-priority). */
  allowedSpeakers?: string[]
  /**
   * Total participants in the meeting (as tracked by the registry — includes the
   * bot). Plumbed in by the realtime session so the gate can tell a 1:1 from a
   * multi-party room. ABSENT => behave as a 1:1 (today's behavior preserved).
   *
   * In multi-party rooms the normal follow-up gate REQUIRES positive addressing
   * (vocative) before it activates. The only wake-word-free exception is a narrow
   * post-answer correction window. Passive engagement-window carry-over and
   * stitched-fragment activation stay disabled, because in a busy room
   * un-addressed ambient speech ("...and 2") and meta-talk that names the bot
   * ("do the david show and tell") must NOT be treated as turns aimed at the agent.
   */
  participantCount?: number
  /**
   * True when Recall reports 2+ human participants speaking simultaneously.
   * Suppresses wake-word-free follow-up carry-over during cross-talk.
   */
  overlappingSpeech?: boolean
  /**
   * Facilitator mode (SOUL `mode: facilitator`): the agent leads the call, so every
   * turn reaches the model, which then speaks or stays silent itself. The only turn
   * held back is one that names another person in the room.
   */
  facilitator?: boolean
}

/**
 * A room is "multi-party" when there are 2+ humans besides the bot. The registry
 * count includes the bot, so participantCount > 2 (i.e. >= 3 total) is the gate.
 * Absent count defaults to 1 (the lone bot) => NOT multi-party => 1:1 behavior.
 */
/**
 * The speech-to-text model is given a vocabulary prompt ("Jarvis, OpenBrain, ...").
 * On noise or on an echo of the agent's own voice it sometimes returns that prompt as the
 * transcript. The prompt contains the wake word, so the gate opened on nothing and the
 * agent answered itself (live call, 2026-11-14). True when a transcript of two or more
 * words is made only of prompt words.
 */
export function isPromptEcho(transcript: string, prompt: string): boolean {
  const words = normalizeTranscript(transcript).split(' ').filter(Boolean)
  const vocabulary = new Set(normalizeTranscript(prompt).split(' ').filter(Boolean))
  if (words.length < 2 || vocabulary.size === 0) return false
  return words.every((word) => vocabulary.has(word))
}

/**
 * Exactly one person and the bot are in the call (the LIVE count is known and is 2).
 * An unknown count is never solo: the page assumes a full room until the count arrives.
 */
export function isSolo(config: WakeGateConfig): boolean {
  return config.participantCount === 2
}

const REQUEST_LEADING_FILLERS_RE = /^(?:(?:okay|ok|so|um+|uh+|hey|alright|all right|well|and|now|then|please|yeah|right)[\s,]+)+/
const REQUEST_OPENER_RE =
  /^(?:(?:can|could|would|will) you|tell me|show me|give me|let me know|remind me|walk me through|find|check|look up|look at|search|pull up|summari[sz]e|list|read|explain|describe|go ahead and|i (?:need|want) (?:you )?to|i'd like (?:you )?to)\b/

/** "Tell me what's on my calendar", "can you check my email": a request, not a remark. */
export function looksLikeRequest(utterance: string): boolean {
  const stripped = utterance.toLowerCase().trim().replace(REQUEST_LEADING_FILLERS_RE, '')
  return REQUEST_OPENER_RE.test(stripped)
}

/** How long the one person in a call must keep talking over an answer before it stops. */
export const SOLO_BARGE_IN_MS = 700

export function isMultiParty(config: WakeGateConfig): boolean {
  return (config.participantCount ?? 1) > 2
}

export interface WakeGateState {
  /** Epoch ms until which wake-word-free follow-ups are accepted. 0 = closed. */
  engagedUntil: number
  /** Epoch ms when the agent last finished speaking. Optional for legacy callers. */
  agentSpokeAt?: number
  /**
   * Name of the participant who last addressed the agent. In multi-party rooms,
   * allows natural wake-word-free follow-ups from THAT SAME speaker when no
   * overlapping speech is occurring.
   */
  engagedSpeaker?: string
}

export interface WakeGateDecision {
  activate: boolean
  reason: string
  state: WakeGateState
}

// 30s: the window is refreshed at response.done, so it covers the whole answer
// PLUS 30s after it ends — enough for a genuine immediate follow-up, but short
// enough that the agent stops assuming it's being addressed once the room moves
// on. A real coworker doesn't think a question 90s later is still aimed at them.
// (Was 90s, which let a long stretch of room conversation re-trigger the agent;
// the follow-up content gate below — directed + not room-management + not a
// monologue — is the primary protection, this just bounds the tail.)
export const DEFAULT_ENGAGEMENT_WINDOW_MS = 30_000

/** Fresh post-answer correction window. Narrower than the normal 1:1 follow-up window. */
export const DEFAULT_CORRECTION_FOLLOWUP_WINDOW_MS = 15_000

/** Gratitude/ack stop phrases only silence the agent when it plausibly owns the turn. */
export const DEFAULT_STOP_GRATITUDE_WINDOW_MS = 8_000

/** Default mis-hearing aliases for the "Jarvis" wake word (observed in STT). */
export const DEFAULT_WAKE_ALIASES = ['travis', 'jervis', 'gervis', 'jarvas']

/**
 * Normalize STT output for matching: lowercase, collapse spelled-out
 * abbreviations ("a.i." -> "ai"), strip punctuation, collapse whitespace.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1') // a.i. -> ai. (chained initials)
    .replace(/\b([a-z])\.\s/g, '$1 ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(a: string, b: string): number {
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
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

/** True when the normalized utterance contains the wake word (fuzzy on single tokens). */
export function containsWakeWord(text: string, wakeWord: string): boolean {
  const normalized = normalizeTranscript(text)
  const wake = normalizeTranscript(wakeWord)
  if (!wake) return false
  if (normalized.includes(wake)) return true
  // Single-token wake words tolerate one STT character error (>=4 chars only).
  if (!wake.includes(' ') && wake.length >= 4) {
    return normalized.split(' ').some((tok) => tok.length >= 4 && levenshtein(tok, wake) <= 1)
  }
  return false
}

/**
 * Direct-address detection: is the wake word ADDRESSING the agent (a vocative —
 * "Jarvis, what's the status?") or merely MENTIONED in passing ("we talked to
 * jarvis", "ask jarvis later", "what jarvis said")? A real coworker only chimes
 * in when addressed, not whenever their name is uttered. The live failure:
 * Morgan said "...we chatted we talked to jarvis we got a quick update..." as a
 * reference, and the agent — which activated on ANY containsWakeWord — butted in.
 *
 * Text-only (no diarization). Addressing signals (any one): the wake word is the
 * first non-filler token ("[hey] jarvis ..."), the last token (tail vocative,
 * "what do you think jarvis"), or immediately followed by a second-person /
 * question / imperative cue ("jarvis can you", "jarvis what's", "jarvis pull
 * up"). A wake word whose preceding token is a verb/preposition that takes it as
 * an object ("ask/tell/with/to/for/about/in jarvis") is a mention. Anything else
 * mid-sentence defaults to NOT addressed — the coworker-safe bias; the user can
 * always lead with the name to invoke.
 */
const ADDRESS_LEADING_FILLERS = new Set([
  'hey', 'hi', 'hello', 'ok', 'okay', 'so', 'well', 'um', 'uh', 'yo', 'alright', 'alrighty', 'and', 'now',
])

const ADDRESS_REFERENTIAL_PRECEDERS = new Set([
  'ask', 'asked', 'asks', 'asking', 'tell', 'told', 'tells', 'telling', 'tells',
  'with', 'to', 'for', 'from', 'about', 'in', 'on', 'by', 'of', 'at', 'or', 'than', 'like',
  'ping', 'pinged', 'email', 'emailed', 'message', 'messaged', 'let', 'get', 'got', 'have',
  'had', 'notify', 'notified', 'remind', 'reminded', 'call', 'called', 'via', 'through',
  'whether', 'if', 'using', 'use', 'told',
])

/** A greeting right before the name is an address wherever it falls ("...waiting. Hey Jarvis, are you there?"). */
const ADDRESS_GREETINGS = new Set(['hey', 'hi', 'hello', 'yo'])

const ADDRESS_FOLLOWERS = new Set([
  'are', 'you', 'your', 'youre', 'u', 'can', 'could', 'would', 'will', 'do', 'did', 'does',
  'please', 'what', 'whats', 'how', 'hows', 'why', 'when', 'where', 'which', 'who',
  'tell', 'give', 'show', 'help', 'explain', 'pull', 'find', 'look', 'check', 'gimme', 'whatcha',
])

// Meta-talk-ABOUT-the-bot vetoes. When the wake token is the COMMON name "David",
// agenda chatter and meta-talk put it in a vocative slot it never earned:
//   - "is that his wake word"        — discussing the bot's trigger word
//   - "do the david show and tell"   — the name is the OBJECT of a narrated
//                                       imperative (a meeting agenda item), not
//                                       an address.
// A possessive / article immediately before the wake token signals discussion
// ABOUT the bot ("his/her/their/its/the david"), not an address TO it.
const ADDRESS_ABOUT_PRECEDERS = new Set([
  'his', 'her', 'hers', 'their', 'theirs', 'its', 'the', 'a', 'an',
])
// Narrated-imperative frame where the wake token is the OBJECT of "do"/"the"
// ("do the <wake> show and tell", "the <wake> show and tell"): the trailing
// "show and tell" / "demo" / "segment" marks it as an agenda item, not a turn.
const ADDRESS_NARRATED_OBJECT_FOLLOWERS = new Set([
  'show', 'demo', 'segment', 'item', 'thing', 'bit', 'piece', 'part', 'section',
])

export function isAddressedToAgent(utterance: string, wakeWord: string, aliases: string[] = []): boolean {
  const wakeTokens = new Set([wakeWord, ...aliases].map((w) => normalizeTranscript(w)).filter(Boolean))
  if (wakeTokens.size === 0) return false
  const tokens = normalizeTranscript(utterance).split(' ').filter(Boolean)
  if (tokens.length === 0) return false

  const isWakeTok = (tok: string): boolean => {
    if (wakeTokens.has(tok)) return true
    if (tok.length < 4) return false
    return [...wakeTokens].some((w) => !w.includes(' ') && w.length >= 4 && levenshtein(tok, w) <= 1)
  }

  // Meta-talk-about-the-bot veto: the literal phrase "wake word" anywhere means
  // someone is discussing the bot's trigger word, never addressing it
  // ("is that his wake word david ..."). Reject the whole utterance.
  if (/\bwake word\b/.test(normalizeTranscript(utterance))) return false

  for (let i = 0; i < tokens.length; i++) {
    if (!isWakeTok(tokens[i]!)) continue
    // Object of a verb/preposition ("ask jarvis", "to jarvis") => mention; skip.
    if (i > 0 && ADDRESS_REFERENTIAL_PRECEDERS.has(tokens[i - 1]!)) continue
    // Possessive/article before the wake token ("his/the david") => talking
    // ABOUT the bot, not TO it. Skip this occurrence.
    if (i > 0 && ADDRESS_ABOUT_PRECEDERS.has(tokens[i - 1]!)) continue
    // Wake token as the OBJECT of a narrated imperative agenda item
    // ("do the david show and tell"): "<wake> show/demo/segment/..." => skip.
    if (ADDRESS_NARRATED_OBJECT_FOLLOWERS.has(tokens[i + 1] ?? '')) continue
    // Greeted by name, anywhere in the utterance => address.
    if (i > 0 && ADDRESS_GREETINGS.has(tokens[i - 1]!)) return true
    // First non-filler token => vocative ("jarvis ...", "hey jarvis ...").
    let j = 0
    while (j < i && ADDRESS_LEADING_FILLERS.has(tokens[j]!)) j++
    if (j === i) return true
    // Immediately followed by a direct-address / question / imperative cue.
    const next = tokens[i + 1]
    if (next && ADDRESS_FOLLOWERS.has(next)) return true
    // Last token => tail vocative ("what do you think jarvis").
    if (i === tokens.length - 1) return true
    // Otherwise: ambiguous mid-sentence mention — keep scanning, default false.
  }
  return false
}

/**
 * Meeting-flow / room-management speech ("let's burn down topics", "should we",
 * "moving on", "you guys", "we talked to ..."). In the follow-up window these
 * are people running the meeting AMONG THEMSELVES, not follow-ups to the agent.
 * Used to veto follow-up activation so the agent doesn't butt in on the room.
 */
const ROOM_MANAGEMENT_RE =
  /\b(let'?s|we (?:should|could|need to|gotta|have to|will|chatted|talked|do that|are going to|gonna)|should we|shall we|why don'?t we|how about we|moving on|next (?:topic|item|up)|first (?:topic|item|off)|our (?:first|next)|you guys|everyone|anybody|anyone|talk about anything|any updates|updates on the business|burn (?:down|through))\b/i

export function isRoomManagement(utterance: string): boolean {
  return ROOM_MANAGEMENT_RE.test(utterance)
}

/** A follow-up longer than this (words) is a monologue, not a direct question to the agent. */
export const FOLLOWUP_MAX_WORDS = 30

/**
 * Text-only addressee heuristic for the follow-up engagement window. The
 * realtime transcription path supplies no speaker label (the gate is called
 * with speaker undefined), so diarization is unavailable. This detects a
 * vocative addressed to a named human OTHER than the wake word, e.g.
 * "So Kai, what do you think?" — so the agent does not butt in on questions
 * aimed at a person in the room. Operates on the RAW case-preserved utterance.
 *
 * Required comma after the vocative is the actual addressing signal — it is
 * what separates "So Kai, what..." (vocative) from "What do you think" (no
 * vocative). ^-anchored: a post-posed vocative ("What do you think, Kai") is
 * NOT vetoed; the user re-asks with the wake word (acceptable residual).
 */
const VOCATIVE_RE =
  /^(?:[Ss]o|[Hh]ey|[Oo]kay|[Oo]k|[Ww]ell|[Nn]ow)?[,\s]*([A-Z][A-Za-z.'-]*)\s*,\s+(?:what|how|do|did|can|could|would|are|is|when|where|why|will|should)\b/i

export function isDirectedAtOtherHuman(
  utterance: string,
  wakeWord: string,
  aliases: string[] = [],
): boolean {
  const m = utterance.match(VOCATIVE_RE)
  if (!m) return false
  const v = m[1]!
  const wakeSet = new Set([wakeWord, ...aliases].map((w) => w.toLowerCase()))
  if (wakeSet.has(v.toLowerCase())) return false
  const STOP = new Set([
    'the', 'this', 'that', 'then', 'there', 'these', 'those',
    'i', 'we', 'you', 'it', 'so', 'okay', 'ok', 'hey', 'well', 'now', 'and', 'but',
  ])
  if (STOP.has(v.toLowerCase())) return false
  return true
}

const CORRECTION_ACKS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'right', 'sure',
  'got it', 'i got it', 'thanks', 'thank you', 'ok thanks', 'okay thanks',
])

const CORRECTION_PHRASES_RE =
  /\b(?:that s not|that is not|that wasn t|that was not|not what i (?:asked|meant|wanted)|not what i was looking for|not the (?:helpful )?answer|no i m not talking about|no i am not talking about|i m not talking about|i am not talking about)\b/i

const CORRECTION_AGENT_ASK_RE =
  /\b(?:(?:do|did) you (?:already )?(?:have|know|understand|remember|see)|can you (?:answer|clarify|explain|check|look|find|pull|tell|give|expand|help)|could you (?:answer|clarify|explain|check|look|find|pull|tell|give|expand|help)|what (?:do|did) you (?:mean|know|have|think)|are you (?:sure|saying))\b/i

const THIRD_PERSON_ROOM_TALK_RE =
  /\b(?:from your end|what [a-z]+ gives you|what [a-z]+ gave you|what [a-z]+ told you|what [a-z]+ says|what [a-z]+ said)\b/i

/**
 * True for a narrow class of post-answer corrections that should re-open the
 * gate immediately after the agent answered, even in multi-party rooms.
 */
export function isCorrectionFollowup(utterance: string): boolean {
  const norm = normalizeTranscript(utterance)
  if (!norm || CORRECTION_ACKS.has(norm)) return false

  const hasCorrection = CORRECTION_PHRASES_RE.test(norm)
  const hasAgentAsk = CORRECTION_AGENT_ASK_RE.test(norm)
  if (!hasCorrection && !hasAgentAsk) return false

  if (THIRD_PERSON_ROOM_TALK_RE.test(norm) && !hasAgentAsk) return false
  if (/\byou (?:guys|all|folks|both)\b/.test(norm)) return false

  return true
}

/**
 * Strip wake-word + alias tokens (and a leading "hey") from an utterance, for
 * use as a RETRIEVAL query. The wake word "jarvis" otherwise (a) matches the
 * agent's own meeting transcripts and (b) trips the self-referential demotion
 * bypass, so leaving it in poisons retrieval. Returns the original text if
 * stripping would empty it (e.g. a bare "jarvis"), so the query is never blank.
 */
export function stripWakeWords(text: string, wakeWord: string, aliases: string[] = []): string {
  const wakeTokens = new Set([wakeWord, ...aliases].map((w) => normalizeTranscript(w)).filter(Boolean))
  const kept = normalizeTranscript(text)
    .split(' ')
    .filter((t) => t && !wakeTokens.has(t))
  const stripped = kept.join(' ').replace(/^hey\s+/, '').trim()
  return stripped.length > 0 ? stripped : text
}

/**
 * Should we FORCE-COMMIT the realtime input buffer NOW, based on a streaming
 * PARTIAL transcript, instead of waiting for VAD silence? In a noisy multi-party
 * room true silence never arrives, so the transcription segment never closes and
 * an addressed question waits forever. When the accumulating partial is clearly
 * addressed to the agent AND reads as a complete question/command, the caller
 * manually commits the buffer to force segment closure -> retrieval -> answer.
 *
 * Pure and conservative: the caller adds the debounce (let ASR wording settle),
 * the once-per-turn guard, and the not-while-responding/dormant guards. This
 * only judges the TEXT. Under-triggering (waiting for the real completed event)
 * is safe; over-triggering would cut a half-spoken question, so we require real
 * content after the wake word.
 */
export function shouldCommitOnPartial(
  partial: string,
  wakeWord: string,
  aliases: string[] = [],
): boolean {
  if (!isAddressedToAgent(partial, wakeWord, aliases)) return false
  const stripped = stripWakeWords(partial, wakeWord, aliases)
  const tokens = normalizeTranscript(stripped).split(' ').filter(Boolean)
  // At least a few content tokens after the wake word so we never commit on a
  // bare "Jarvis" or "Jarvis, um". Commit when it reads like a question, or once
  // enough words have accumulated that it is plainly a real ask.
  if (tokens.length < 3) return false
  return looksLikeQuestion(stripped) || tokens.length >= 6
}

/**
 * Evaluate the gate for one completed user utterance. Pure function — callers
 * thread state through. `now` is injectable for tests.
 */
export function evaluateWakeGate(
  state: WakeGateState,
  utterance: string,
  config: WakeGateConfig,
  speaker?: string,
  now: number = Date.now(),
): WakeGateDecision {
  if (config.behaviorMode === 'observe') {
    return { activate: false, reason: 'observe mode', state }
  }

  if (
    config.allowedSpeakers &&
    config.allowedSpeakers.length > 0 &&
    speaker !== undefined &&
    !config.allowedSpeakers.some((s) => s.toLowerCase() === speaker.toLowerCase())
  ) {
    return { activate: false, reason: `speaker "${speaker}" not in allowed list`, state }
  }

  // Activation requires the wake word to ADDRESS the agent (vocative), not merely
  // mention it — "we talked to jarvis" / "ask jarvis later" are references and
  // must NOT trigger a response. isAddressedToAgent handles aliases internally.
  if (isAddressedToAgent(utterance, config.wakeWord, config.wakeAliases ?? [])) {
    const nextState: WakeGateState =
      speaker !== undefined && speaker.trim() !== ''
        ? { ...state, engagedSpeaker: speaker.trim() }
        : state
    return { activate: true, reason: 'addressed by name (vocative)', state: nextState }
  }

  if (config.facilitator === true) {
    if (normalizeTranscript(utterance) === '') {
      return { activate: false, reason: 'facilitator: nothing was said', state }
    }
    // A line said to another person is heard too: the coach is part of the whole
    // conversation, and the model decides whether to speak or call stay_quiet.
    return { activate: true, reason: 'facilitator: every turn is heard', state }
  }

  const windowMs = config.engagementWindowMs ?? DEFAULT_ENGAGEMENT_WINDOW_MS
  const correctionWindowMs = config.correctionFollowupWindowMs ?? DEFAULT_CORRECTION_FOLLOWUP_WINDOW_MS
  const wordCount = normalizeTranscript(utterance).split(' ').filter(Boolean).length
  const msSinceAgentSpoke =
    state.agentSpokeAt !== undefined
      ? now - state.agentSpokeAt
      : state.engagedUntil > 0
        ? now - (state.engagedUntil - windowMs)
        : null
  if (
    state.engagedUntil > now &&
    msSinceAgentSpoke !== null &&
    msSinceAgentSpoke >= 0 &&
    msSinceAgentSpoke <= correctionWindowMs &&
    wordCount >= 3 &&
    isCorrectionFollowup(utterance) &&
    !isDirectedAtOtherHuman(utterance, config.wakeWord, config.wakeAliases ?? [])
  ) {
    return {
      activate: true,
      reason: `correction follow-up within ${Math.round(correctionWindowMs / 1000)}s response window`,
      state,
    }
  }
  // Minimum-token guard: a sub-3-token utterance ("and 2", "okay yeah") is never
  // a follow-up worth activating on — even if a future predicate change lets it
  // pass looksLikeQuestion. This bounds the floor independently of the content
  // heuristics below.
  const FOLLOWUP_MIN_TOKENS = 3
  // Multi-party rooms INVERT the follow-up rule when speaker identity is unknown:
  // passive engagement-window carry-over is OFF unless positive addressing OR
  // Recall speaker attribution proves the SAME engagedSpeaker is continuing their
  // turn with no overlapping speech.
  if (
    state.engagedUntil > now &&
    wordCount >= FOLLOWUP_MIN_TOKENS &&
    isMultiParty(config) &&
    isAddressedToAgent(utterance, config.wakeWord, config.wakeAliases ?? [])
  ) {
    return {
      activate: true,
      reason: `addressed follow-up within ${Math.round(windowMs / 1000)}s window (multi-party)`,
      state,
    }
  }
  const sameEngagedSpeaker =
    speaker !== undefined &&
    state.engagedSpeaker !== undefined &&
    speaker.trim() !== '' &&
    speaker.trim().toLowerCase() === state.engagedSpeaker.trim().toLowerCase() &&
    !config.overlappingSpeech
  if (
    isMultiParty(config) &&
    sameEngagedSpeaker &&
    state.engagedUntil > now &&
    wordCount >= FOLLOWUP_MIN_TOKENS &&
    looksLikeQuestion(utterance) &&
    wordCount <= FOLLOWUP_MAX_WORDS &&
    !isDirectedAtOtherHuman(utterance, config.wakeWord, config.wakeAliases ?? []) &&
    !isRoomManagement(utterance)
  ) {
    return {
      activate: true,
      reason: `speaker-locked follow-up question from ${speaker!.trim()} within ${Math.round(windowMs / 1000)}s engagement window (multi-party)`,
      state,
    }
  }
  // 1:1 follow-up window: re-activate ONLY on a question plausibly still aimed at
  // the agent — not directed at another human, not meeting-flow/room-management,
  // and not a monologue. Bare "looks like a question within the window" let the
  // room's own conversation re-trigger the agent (the live out-of-turn bug).
  if (
    !isMultiParty(config) &&
    !config.overlappingSpeech &&
    state.engagedUntil > now &&
    wordCount >= FOLLOWUP_MIN_TOKENS &&
    looksLikeQuestion(utterance) &&
    wordCount <= FOLLOWUP_MAX_WORDS &&
    !isDirectedAtOtherHuman(utterance, config.wakeWord, config.wakeAliases ?? []) &&
    !isRoomManagement(utterance)
  ) {
    return {
      activate: true,
      reason: `follow-up question within ${Math.round(windowMs / 1000)}s engagement window`,
      state,
    }
  }

  // One person in the call: a question or a request needs no wake word and no recent
  // answer. Nobody else is there to be talking to. A plain remark still does not open
  // the gate, so thinking out loud is left alone.
  if (
    isSolo(config) &&
    !config.overlappingSpeech &&
    wordCount >= FOLLOWUP_MIN_TOKENS &&
    wordCount <= FOLLOWUP_MAX_WORDS &&
    (looksLikeQuestion(utterance) || looksLikeRequest(utterance)) &&
    // No isDirectedAtOtherHuman check: there is no other person to address, and that
    // check reads a leading "Okay," as somebody's name.
    !isRoomManagement(utterance)
  ) {
    return { activate: true, reason: 'question or request with one person in the call', state }
  }

  return { activate: false, reason: 'not addressed; no qualifying follow-up in window', state }
}

/** Call after the agent finishes speaking to open the follow-up window. */
export function markAgentSpoke(
  config: WakeGateConfig,
  now: number = Date.now(),
  engagedSpeaker?: string,
): WakeGateState {
  return {
    engagedUntil: now + (config.engagementWindowMs ?? DEFAULT_ENGAGEMENT_WINDOW_MS),
    agentSpokeAt: now,
    ...(engagedSpeaker !== undefined && engagedSpeaker.trim() !== ''
      ? { engagedSpeaker: engagedSpeaker.trim() }
      : {}),
  }
}

const PRESENCE_WORDS = new Set([
  'are', 'you', 'there', 'here', 'hello', 'hi', 'hey', 'can', 'hear', 'me',
  'okay', 'ok', 'yes', 'still', 'good', 'morning', 'afternoon', 'testing', 'test',
])

/**
 * True when the utterance is a bare presence check ("hey jarvis are you
 * there?", "can you hear me?") — the agent should just acknowledge, not run a
 * knowledge retrieval. Round-17's first answer rambled about its own setup
 * because "are you there" retrieved the agent's own build docs.
 */
export function isPresenceCheck(utterance: string, wakeWord: string, aliases: string[] = []): boolean {
  const wakeTokens = new Set([wakeWord, ...aliases].map((w) => normalizeTranscript(w)).filter(Boolean))
  const tokens = normalizeTranscript(utterance)
    .split(' ')
    .filter((t) => t && !wakeTokens.has(t))
  if (tokens.length === 0) return true
  if (tokens.length > 6) return false
  return tokens.every((t) => PRESENCE_WORDS.has(t))
}

/**
 * Stop-command detection. When detected, callers MUST cancel any in-flight
 * response, flush the player, and enter dormant mode (no activation until the
 * wake word is spoken again). Dormant is NOT the same as mutedRef — it's a
 * transient state the user triggered intentionally; only a wake word re-arms it.
 *
 * Matching strategy (revised after a live meeting where every real stop command
 * was spoken mid-sentence — "okay just be silent for now", "I need you to be
 * quiet until..." — and the old equals/endsWith matcher missed them all):
 * a contiguous whole-token RUN match anywhere in the utterance, NOT raw
 * substring (so "be quieter" does not match "be quiet"). Phrases are split into
 * two sets by false-positive risk.
 */
// Stop phrases that keep the historical always-fire behavior.
export const COMMAND_STOP_PHRASES = [
  'shut up', 'shush', 'stand down',
  'stop talking', 'stop speaking', 'stop answering', 'stop responding',
  "that's enough", 'thats enough',
]

// Gratitude/acknowledgment phrases are common room talk. They only fire when the
// agent plausibly owns the turn.
export const GRATITUDE_STOP_PHRASES = [
  'i got it', 'got it thanks', 'ok thanks', 'okay thanks',
]

/** Backward-compatible alias for callers/tests that still import the old name. */
export const ALWAYS_FIRE_STOP_PHRASES = COMMAND_STOP_PHRASES

// Stop phrases that ARE commonly said about/to the room ("be quiet everyone").
// These require an additional directed-at-agent cue to fire.
export const DIRECTED_ONLY_STOP_PHRASES = [
  'be quiet', 'go quiet', 'stay quiet',
  'be silent', 'stay silent', 'go silent',
]

/**
 * True when the utterance is a stop / silence command directed at the agent.
 * Normalized, so punctuation / capitalisation do not matter.
 *
 * COMMAND phrases match on a contiguous token-run, gated on the agent being
 * addressed OR owning the turn (speaking / just spoke) — see the ownership
 * comment in the body. DIRECTED_ONLY phrases (which the room commonly says to
 * each other) additionally require a second-person / imperative cue. We deliberately do NOT prefix-match the
 * DIRECTED_ONLY phrases — "be quiet when the CEO speaks" / "be quiet everyone"
 * are room-addressing, not commands to the agent. Single tokens
 * ("stop"/"enough"/"wait"/"quiet") stay excluded — too many false positives.
 */
/**
 * Output-side barge-in policy (mirror of the input-side wake-commit fix):
 * a bare server_vad speech onset must NOT interrupt the agent while it owns
 * the floor — in a real room VAD fires on background noise, cross-talk, and
 * side conversations, and cancelling on raw onset cut answers off mid-word.
 * While a response is in flight (generating/thinking) or audio is still
 * playing (including the buffered tail after response.done), interruption is
 * decided at the TRANSCRIPTION level instead: an explicit stop command or an
 * addressed/engaged gate activation cancels promptly; noise never does.
 * When the agent is idle, the onset may flush stale playout as before.
 */
export function shouldHoldFloorOnSpeechStarted(state: {
  responseActive: boolean
  audioPlaying: boolean
}): boolean {
  return state.responseActive || state.audioPlaying
}

export interface StopCommandContext {
  agentSpeaking: boolean
  msSinceAgentSpoke: number | null
}

export function isStopCommand(
  utterance: string,
  wakeWord: string,
  aliases: string[] = [],
  context?: StopCommandContext,
): boolean {
  const norm = normalizeTranscript(utterance)
  const wakeTokens = new Set([wakeWord, ...aliases].map((w) => normalizeTranscript(w)).filter(Boolean))
  // Strip wake-word tokens so "jarvis be quiet" → "be quiet".
  const stripped = norm
    .split(' ')
    .filter((t) => t && !wakeTokens.has(t))
    .join(' ')
    .trim()
  // Also strip leading "hey" filler: "hey be quiet" → "be quiet".
  const withoutHey = stripped.replace(/^hey\s+/, '').trim()

  // Whole-token-boundary contiguous run match (NOT raw substring) so
  // "be quieter" does not match "be quiet".
  const padded = ' ' + withoutHey + ' '
  const runMatch = (phrase: string): boolean => {
    const p = normalizeTranscript(phrase)
    return withoutHey === p || padded.includes(' ' + p + ' ')
  }

  // Turn ownership: you cannot tell a silent bot to shut up. An UN-ADDRESSED
  // stop phrase only counts when the agent is speaking now or spoke within
  // the recency window — the 2026-07-15 IRG meeting had human-to-human banter
  // ("I didn't tell them about your comment. You shut up!") dormant the idle
  // agent for the whole meeting. An ADDRESSED stop ("Jarvis, be quiet") is
  // always honored, including pre-emptive silencing while idle. Fail-safe
  // when context is absent (older callers/tests keep the broad behavior).
  const addressed = isAddressedToAgent(utterance, wakeWord, aliases)
  const recent =
    context !== undefined &&
    context.msSinceAgentSpoke !== null &&
    context.msSinceAgentSpoke >= 0 &&
    context.msSinceAgentSpoke <= DEFAULT_STOP_GRATITUDE_WINDOW_MS
  const ownsTurn = context === undefined || context.agentSpeaking || recent

  // COMMAND: contiguous run is enough, gated on address/turn-ownership.
  if (COMMAND_STOP_PHRASES.some(runMatch)) return addressed || ownsTurn

  // GRATITUDE/ACK: fail-safe when context is absent; otherwise require turn
  // ownership or a directed cue.
  if (GRATITUDE_STOP_PHRASES.some(runMatch) && context) {
    const secondPersonCue =
      /\byou\b/.test(norm) && !/\byou (?:guys|all|folks|both)\b/.test(norm)
    const directedCue = addressed || secondPersonCue
    if (context.agentSpeaking || recent || directedCue) return true
  }

  // DIRECTED_ONLY: a BARE imperative ("be quiet" with nothing else) is a command
  // to the agent. Anything wrapping the phrase ("be quiet everyone", "be quiet
  // when the CEO speaks", "we should be silent") is room-addressing and needs a
  // second-person / imperative directed cue. ("don't" normalizes to the two
  // tokens "don t" once the apostrophe is stripped, so match the joined form.)
  const directExact = DIRECTED_ONLY_STOP_PHRASES.some((p) => withoutHey === normalizeTranscript(p))
  if (directExact) return addressed || ownsTurn

  const directed =
    /\byou\b/.test(withoutHey) ||
    withoutHey.startsWith('i need you') ||
    withoutHey.includes('don t') ||
    withoutHey.includes('until i') ||
    withoutHey.includes('for now') ||
    withoutHey.includes('please')
  if (directed && DIRECTED_ONLY_STOP_PHRASES.some(runMatch)) return addressed || ownsTurn

  return false
}

/** Spoken text + when it ended (epoch ms). Threaded for self-echo rejection. */
export interface SpokenWindow {
  text: string
  endedAt: number
}

export const SELF_ECHO_WINDOW_MS = 2_500
export const SELF_ECHO_MIN_TOKENS = 4
export const SELF_ECHO_THRESHOLD = 0.7

/**
 * Fraction of `a`'s tokens that also appear in `b` (token-set containment, not
 * symmetric Jaccard). Used for self-echo: "what fraction of this inbound
 * transcript is composed of words the agent just said?" Robust to STT word
 * errors on echoed audio — a few mis-heard tokens only nudge the ratio.
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = normalizeTranscript(a).split(' ').filter(Boolean)
  const tb = new Set(normalizeTranscript(b).split(' ').filter(Boolean))
  if (ta.length === 0) return 0
  const uniqueA = new Set(ta)
  let inter = 0
  for (const t of uniqueA) if (tb.has(t)) inter++
  return inter / uniqueA.size
}

/**
 * True when an inbound transcript is the agent's OWN voice echoing back (a
 * remote participant off headphones replays the bot's audio into their mic ->
 * the meeting mix -> our bot's input, delayed). We hold the exact words the bot
 * just spoke, so this is delay-agnostic where acoustic AEC is not.
 *
 * Barge-in-safe: a real human talking over the bot says something DIFFERENT, so
 * its token overlap with the bot's text is low and it passes. Short utterances
 * (< SELF_ECHO_MIN_TOKENS) bypass the gate entirely — they can't open the wake
 * gate on their own anyway, and we must never drop a short genuine interjection.
 *
 * NOTE: matches against the FULL spoken text (not a played-prefix slice). The
 * ratio is normalized by INBOUND tokens, so a longer reference can only raise
 * recall of echo, never cause a real human utterance (different words) to be
 * dropped. The residual merged-transcript case (human speaks while echo is
 * still in their mic) is L2's job, not L1's.
 */
export function isSelfEcho(transcript: string, spoken: SpokenWindow, now: number): boolean {
  if (!spoken.text || spoken.endedAt === 0) return false
  if (now - spoken.endedAt > SELF_ECHO_WINDOW_MS) return false
  const inboundTokens = normalizeTranscript(transcript).split(' ').filter(Boolean)
  if (inboundTokens.length < SELF_ECHO_MIN_TOKENS) return false
  return tokenSetRatio(transcript, spoken.text) >= SELF_ECHO_THRESHOLD
}

/**
 * Fragment stitching: server VAD splits one spoken sentence into multiple
 * utterances ("you actually can tell me" / "the latest status on robo sdr"),
 * and a continuation fragment judged alone fails the question heuristic — the
 * agent goes silent mid-conversation (round-15 transcript). When an utterance
 * arrives within this window of a previous utterance that did NOT activate,
 * the gate also evaluates the concatenation.
 */
export const FRAGMENT_STITCH_WINDOW_MS = 6_000

export interface PendingFragment {
  text: string
  at: number
  speaker?: string
}

export interface StitchedDecision extends WakeGateDecision {
  /** The utterance to answer — the stitched sentence when stitching applied. */
  effectiveUtterance: string
  /** True when stitching across prev + utterance caused activation. */
  stitched?: boolean
}

/**
 * Evaluate the gate with fragment stitching. `prev` is the immediately
 * preceding utterance IF it did not activate the gate (callers clear it after
 * any activation). The stitched text is also used when the current fragment
 * activates on its own, so the forced-retrieval query carries the full sentence.
 */
export function evaluateWakeGateStitched(
  state: WakeGateState,
  utterance: string,
  config: WakeGateConfig,
  prev: PendingFragment | null,
  speaker?: string,
  now: number = Date.now(),
): StitchedDecision {
  const speakerMismatch =
    prev?.speaker !== undefined &&
    speaker !== undefined &&
    prev.speaker.trim().toLowerCase() !== speaker.trim().toLowerCase()
  const stitchable = prev !== null && now - prev.at <= FRAGMENT_STITCH_WINDOW_MS && !speakerMismatch
  const stitched = stitchable ? `${prev.text} ${utterance}` : utterance

  const alone = evaluateWakeGate(state, utterance, config, speaker, now)
  if (alone.activate) {
    // A wake-word (or follow-up) activation on the CURRENT utterance starts a
    // fresh turn addressed to the agent — answer the current utterance ONLY,
    // never prepend the prior fragment. The prior fragment was a separate
    // utterance, often directed at another person ("Hey John, how was your
    // week?" then "Hey Jarvis, can you hear me?" must be answered as a presence
    // check, NOT as John's question). Prepending it also poisons the forced-
    // retrieval query. The genuine VAD-split "Hey Jarvis" + "<question>" is
    // handled by the follow-up engagement window on the next utterance.
    return { ...alone, effectiveUtterance: utterance }
  }
  if (stitchable && stitched !== utterance) {
    // Current alone did NOT activate: the prior fragment may be a genuine VAD
    // continuation of THIS utterance (round-15). Only here do we stitch.
    //
    // MULTI-PARTY: stitching is the classic ambient-glue trap — a real prior
    // question to the bot gets concatenated onto a DIFFERENT speaker's stray
    // fragment ("...and 2") and the join passes looksLikeQuestion. So in a
    // multi-party room the STITCHED text must POSITIVELY address the agent
    // before it can activate; looksLikeQuestion alone is not enough. (In 1:1
    // the only other voice is the user, so the VAD-split is theirs — the
    // looksLikeQuestion path below stands unchanged.)
    const sameSpeakerLocked =
      speaker !== undefined &&
      state.engagedSpeaker !== undefined &&
      speaker.trim() !== '' &&
      speaker.trim().toLowerCase() === state.engagedSpeaker.trim().toLowerCase() &&
      !config.overlappingSpeech
    if (
      isMultiParty(config) &&
      !sameSpeakerLocked &&
      !isAddressedToAgent(stitched, config.wakeWord, config.wakeAliases ?? [])
    ) {
      return { ...alone, effectiveUtterance: stitched }
    }
    const joined = evaluateWakeGate(state, stitched, config, speaker, now)
    if (joined.activate) {
      return {
        ...joined,
        reason: `${joined.reason} (stitched fragment)`,
        effectiveUtterance: stitched,
        stitched: true,
      }
    }
  }
  // Nothing activated: carry the stitched text forward so a 3-fragment sentence
  // can accumulate (the caller stores effectiveUtterance as the next fragment).
  return { ...alone, effectiveUtterance: stitched }
}

/**
 * A request typed in the meeting chat. Returns the request text when `text` STARTS with
 * one of `names` (the wake word, the agent's name), optionally after "hey" or "@" and
 * followed by punctuation, and something follows it; otherwise undefined. Typed text is
 * exact, so no speech-recognition aliases are needed here.
 */
export function chatWakeRequest(text: string, names: string[]): string | undefined {
  const trimmed = text.trim()
  for (const name of names) {
    const clean = name.trim()
    if (clean === '') continue
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`^(?:hey\\s+|ok\\s+|@)?${escaped}(?![\\p{L}\\p{N}])[\\s,:;.!?-]*`, 'iu').exec(trimmed)
    if (!match) continue
    const request = trimmed.slice(match[0].length).trim()
    return request === '' ? undefined : request
  }
  return undefined
}

// ---------------------------------------------------------------------------
// "Leave the call" and "stop listening"
// ---------------------------------------------------------------------------

/**
 * Said to the agent as the WHOLE request, these make the bot leave the meeting. The phrase
 * must open the request and may be followed only by a few closing words ("now", "please"),
 * so "please leave a note for David" and "you can leave that out" are ordinary requests.
 */
export const LEAVE_PHRASES = [
  'leave the call', 'leave the meeting', 'leave this call', 'leave this meeting', 'leave',
  'drop off the call', 'drop off', 'hang up', 'go ahead and leave',
]

/** Said to the agent as the whole request, these stop the transcript and the answers until the wake word is used again. */
export const STOP_LISTENING_PHRASES = [
  'stop listening', 'stop recording', 'stop transcribing', 'stop taking notes', 'pause the notes', 'go off the record',
]

// Words allowed before the phrase ("ok please ...", "you can ...") and after it ("... for now please").
const COMMAND_LEAD = /^(?:(?:hey|ok|okay|please|now|can you|could you|would you|will you|you can|you may|you should|just) )+/
const COMMAND_TAIL = /^(?:(?:now|please|thanks|thank you|for now|for a minute|for a moment|for a bit|for a while|right now) ?)*$/

/** True when `request` is one of `phrases`, allowing only lead-in and closing words around it. */
function isWholeCommand(request: string, phrases: string[]): boolean {
  const norm = normalizeTranscript(request).replace(COMMAND_LEAD, '')
  return phrases.some((phrase) => {
    const p = normalizeTranscript(phrase)
    if (norm !== p && !norm.startsWith(p + ' ')) return false
    return COMMAND_TAIL.test(norm.slice(p.length).trim())
  })
}

/** The utterance with the wake word (and aliases) removed. */
function withoutWakeTokens(utterance: string, wakeWord: string, aliases: string[]): string {
  const wake = new Set([wakeWord, ...aliases].map((w) => normalizeTranscript(w)).filter(Boolean))
  return normalizeTranscript(utterance).split(' ').filter((t) => t && !wake.has(t)).join(' ')
}

/** A typed request (wake word already removed) that asks the bot to leave. */
export function isLeaveRequest(request: string): boolean {
  return isWholeCommand(request, LEAVE_PHRASES)
}

/** A typed request (wake word already removed) that asks the bot to stop listening. */
export function isStopListeningRequest(request: string): boolean {
  return isWholeCommand(request, STOP_LISTENING_PHRASES)
}

/**
 * A spoken "leave the call" directed at the agent. It must be addressed by the wake word
 * and be the whole request: people say "I have to leave the call" to each other all the time.
 */
export function isLeaveCommand(utterance: string, wakeWord: string, aliases: string[] = []): boolean {
  return isAddressedToAgent(utterance, wakeWord, aliases) && isWholeCommand(withoutWakeTokens(utterance, wakeWord, aliases), LEAVE_PHRASES)
}

/** A spoken "stop listening" directed at the agent (same rules as isLeaveCommand). */
export function isStopListeningCommand(utterance: string, wakeWord: string, aliases: string[] = []): boolean {
  return (
    isAddressedToAgent(utterance, wakeWord, aliases) &&
    isWholeCommand(withoutWakeTokens(utterance, wakeWord, aliases), STOP_LISTENING_PHRASES)
  )
}

// ---------------------------------------------------------------------------
// Casual turns
// ---------------------------------------------------------------------------

const CASUAL_PATTERNS = [
  /^(hi|hello|hey|hey there|hi there|hello there|good (morning|afternoon|evening))$/,
  /^(hi |hello |hey |so |and )?how (are|re) (you|things)( doing| going)?( today| this morning| this afternoon| tonight)?$/,
  /^(hi |hello |hey )?how s it going( today)?$/,
  /^(hi |hello |hey |so |and )?how s your (morning|day|afternoon|evening|night|week|weekend)( going| been)?( so far| today)?$/,
  /^(hi |hello |hey |so |and )?how (is|was|has) your (morning|day|afternoon|evening|night|week|weekend)( going| been)?( so far| today)?$/,
  /^(hi |hello |hey )?(how have you been|how you doing|how are we doing)$/,
  /^(hi |hello |hey )?how is it going( today)?$/,
  /^(hi |hello |hey )?what s up$/,
  /^(ok |okay |great |perfect |awesome )?(thanks|thank you)( so much| very much| a lot)?$/,
  /^(nice|good|great) to (meet|see|have) you( here| too)?$/,
  /^who are you$/,
  /^what are you$/,
  /^(can you )?(please )?(introduce yourself|tell (us|me|them|everyone) about yourself)$/,
  /^what (can|do) you do$/,
  /^what can you help (me |us )?with$/,
  /^(can|do) you hear (me|us)( ok| okay| now)?$/,
  /^are you (an? )?(ai|bot|robot|real|human|person)$/,
]

/**
 * A casual turn addressed to the agent: a greeting, "how are you", thanks, "who are
 * you", "what can you do". It is conversation, not a question about anyone's work, so
 * the caller answers it directly and skips the knowledge lookup. Matched on the WHOLE
 * utterance (wake word removed), so "how are you doing on the Northwind launch" is not casual.
 */
export function isCasualTurn(utterance: string, wakeWord: string, aliases: string[] = []): boolean {
  const text = withoutWakeTokens(utterance, wakeWord, aliases)
  if (text === '' || text.split(' ').length > 10) return false
  return CASUAL_PATTERNS.some((pattern) => pattern.test(text))
}

