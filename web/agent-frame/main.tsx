/**
 * Realtime meeting agent frame — rendered INSIDE the meeting by the Recall.ai
 * bot via Output Media (the bot streams this page's audio/video into the call,
 * and pipes the meeting's mixed audio in as this page's microphone).
 *
 * Transport: OpenAI/Azure Realtime over a WebSocket (NOT WebRTC). Audio is
 * PCM16 @ 24kHz both directions — the meeting mic is captured by a WavRecorder
 * AudioWorklet and streamed up as input_audio_buffer.append; the model's speech
 * arrives as response.output_audio.delta and is played by a WavStreamPlayer
 * AudioWorklet. We DON'T use a WebRTC remote track: a remote track played in
 * Recall's headless renderer bridges two clocks (Chromium NetEQ playout vs.
 * Recall's audio capture) and the bridge under/over-runs, which is heard as
 * choppy speech in the meeting. A single page-clocked AudioWorklet render — the
 * pattern in Recall's own voice-agent-demo — is captured cleanly.
 *
 * The session is configured with create_response: false, so the model NEVER
 * speaks on its own. The deterministic wake gate (wake-gate.ts) triggers
 * responses: wake word in the current utterance, or a follow-up question inside
 * the engagement window. On activation we force OpenBrain retrieval and inject
 * the results before response.create (retrieve-then-answer), so answers are
 * grounded in live knowledge, not model weights.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { WavRecorder, WavStreamPlayer } from 'wavtools'
import {
  isAddressedToAgent,
  DEFAULT_ENGAGEMENT_WINDOW_MS,
  DEFAULT_CORRECTION_FOLLOWUP_WINDOW_MS,
  evaluateWakeGateStitched,
  isPresenceCheck,
  isSelfEcho,
  isLeaveCommand,
  isStopCommand,
  isStopListeningCommand,
  markAgentSpoke,
  shouldHoldFloorOnSpeechStarted,
  stripWakeWords,
  shouldCommitOnPartial,
  isSolo,
  isPromptEcho,
  SOLO_BARGE_IN_MS,
  tokenSetRatio,
  type PendingFragment,
  type SpokenWindow,
  type WakeGateConfig,
  type WakeGateState,
} from '../../src/agent/wake-gate.js'
import {
  FACILITATOR_FINAL_NUDGE_DIRECTIVE,
  FACILITATOR_MAX_NUDGES,
  FACILITATOR_NUDGE_DIRECTIVE,
  FACILITATOR_OPEN_DELAY_MS,
  FACILITATOR_OPEN_DIRECTIVE,
  FACILITATOR_MIN_SPEECH_MS,
  FACILITATOR_SETTLE_MS,
  FACILITATOR_SILENCE_NUDGE_MS,
  STAY_QUIET_TOOL,
  rosterDirective,
  speakerDirective,
  standInOpenDirective,
} from '../../src/agent/facilitator.js'
import {
  TOOL_ROUTES,
  ASK_RESEARCHER_TOOL,
  selectToolRoutes,
  formatRetrievalForInjection,
  isStatusQuestion,
  isDayScopedQuestion,
  STATUS_QUERY_EXPANSION,
  CASUAL_TURN_DIRECTIVE,
} from '../../src/agent/realtime-config.js'
import { buildSearchQuery, type RecentTurn } from '../../src/agent/query-context.js'
import { DEFAULT_CHARS_PER_SEC, lastSentence, pacedCaption, speakingRate } from '../../src/agent/caption-pace.js'
import { ANAM_VIDEO_ID, startAnamFace, type AnamFace } from './anam-face.js'
import {
  RESEARCHER_ACK_AFTER_MS,
  RESEARCHER_STARTED_OUTPUT,
  researcherAckDirective,
  researcherAnswerDirective,
} from '../../src/agent/researcher-turn.js'
import {
  ANSWER_DIRECTLY_TOOL,
  chooseAnswerRoute,
  decisionResponseEvent,
  directAnswerEvent,
  shouldInjectLookup,
  type RetrievalMode,
} from '../../src/agent/answer-route.js'
import {
  DEFAULT_FAST_RETRIEVAL_BUDGET_MS,
  canDeliverBackgroundResult,
  formatBackgroundAckDirective,
  formatBackgroundCompletionDirective,
  raceWithBudget,
  type BackgroundTask,
} from '../../src/agent/background-tasks.js'
import { FORCED_RETRIEVAL_TIMEOUT_MS } from '../../src/retrieval/knowledge-client.js'
// matchPrefetch and storePrefetch are imported under other names (and the local search
// helper is not called "prefetch") so that searching this file for a raw network call, the
// word "fetch" followed by an opening parenthesis, matches nothing: every request goes
// through authedFetch, and the one raw call lives in session.ts.
import {
  buildInjectionBlock,
  looksLikeKnowledgeQuery,
  matchPrefetch as matchSpeculativeHit,
  storePrefetch as storeSpeculativeHit,
  clearSpeculativeCache,
} from '../../src/agent/speculative-cache.js'
import {
  createConnectionOpenWatchdog,
  getReconnectDecision,
  isTerminalMeetingStatus,
  resetReconnectAttempt,
} from '../../src/agent/reconnect-policy.js'
import type { MeetingCommand, QueuedCommand } from '../../src/meeting/commands.js'
import { authedFetch, readSessionTokenOnce } from './session.js'
import {
  AvatarStage,
  computePcm16SpeechMetrics,
  type SpeechMetrics,
} from './avatar-stage.js'
import {
  isValidAvatarProviderId,
  type AvatarProviderId,
} from '../../src/avatar/providers.js'
import {
  CHAT_REPLY_WINDOW_MS,
  COMMAND_POLL_MS,
  injectionFor,
  nextSeq,
  planCommand,
  prefetchResultsToStore,
  selectCommandsToRun,
  shouldSendDeferredResponse,
  toolOutputFor,
  withChatReply,
} from './commands.js'

type AgentState = 'connecting' | 'reconnecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended'

interface SessionConfig {
  wsUrl: string
  wsProtocols?: string[]
  sessionUpdate: Record<string, unknown>
  provider: string
  model: string
  voice: string
  meeting: { id: string; title: string }
  agent: { name: string; wakeWord: string; behaviorMode: string; personaMode: string; subtitle: string; replyMode?: string; notesOnly?: boolean; facilitator?: boolean; standIn?: boolean; openingLine?: string; brain?: string; knowledgeMode?: string; avatarProvider?: string; delegateTasks?: boolean; buzzMessaging?: boolean }
  engagementWindowMs: number
  /** Wake-triggered manual commit (server MEETING_WAKE_COMMIT; default true). */
  wakeCommit?: boolean
  /** 'model' (default) or 'forced' (server MEETING_RETRIEVAL_MODE). */
  retrievalMode?: string
}

interface TranscriptEntry {
  speaker: string
  text: string
}

interface EarlierMeetingTranscriptResult {
  speaker: string
  text: string
  timestamp: string
}

const CONTEXT_REFRESH_MS = 10 * 60 * 1000
const STATUS_POLL_MS = 15 * 1000
// Let ASR wording settle after the last partial delta before force-committing a
// wake-worded question, so we never commit a half-spoken ask.
const WAKE_COMMIT_DEBOUNCE_MS = 450
const SEED_TRANSCRIPT_ENTRIES = 30
// Wake-word aliases for the LIVE gate: derived from the session's ACTUAL wake
// word, not hardcoded. Each known wake word maps to a tight set of benign STT
// mishearings (homophones only) so the bot still wakes when its name is slightly
// misheard, without widening false-positives. An unknown wake word gets NO
// aliases (exact-match only) — inventing homophones for an arbitrary name would
// risk waking on unrelated tokens. Keyed on the normalized (lowercased) word.
const WAKE_ALIAS_MAP: Record<string, string[]> = {
  jarvis: ['jervis', 'jarvus', 'jarvas'],
  sparkie: ['sparky', 'sparkey', 'sparki'],
}

/** Aliases for the live gate, derived from the session wake word (see WAKE_ALIAS_MAP). */
function deriveWakeAliases(wakeWord: string): string[] {
  return WAKE_ALIAS_MAP[wakeWord.trim().toLowerCase()] ?? []
}

/** How long the accumulating live transcription is debounced before a prefetch fires. */
const PREFETCH_DEBOUNCE_MS = 600
/** Recent transcript turns kept in memory for query-context building. */
const RECENT_TURNS_MAX = 40

/**
 * When this page loaded. Owner commands queued before this moment are for a previous
 * copy of the page (this one was reloaded) and are not replayed.
 */
const PAGE_LOADED_AT = Date.now()

/**
 * Wake-gate participantCount to assume before the first lifecycle poll has
 * delivered the LIVE registry count (or whenever the count is genuinely
 * unavailable). 3 = multi-party (>2), which forces the anti-barge-in posture
 * (activation requires positive addressing). Erring multi-party when the count
 * is unknown matches the gate's purpose — stop unwanted interjections — and a
 * true 1:1 is corrected within one STATUS_POLL_MS once the poll reports it.
 */
const MULTIPARTY_SAFETY_DEFAULT = 3
// Base track id. A FRESH per-response id is derived from this each turn
// (responseTrackIdRef). wavtools' interrupt() permanently adds the playing
// track id to an internal `interruptedTrackIds` set, after which add16BitPCM
// SILENTLY DROPS all audio for that id. Reusing one constant id meant the first
// barge-in/stop poisoned the track forever — every later response showed text
// captions but produced no audio. A unique id per response confines the poison
// to the response that was actually interrupted.
const RESPONSE_TRACK_ID = 'meeting-response'
/**
 * Hard ceiling on continuous agent speech. The mic stays open (full-duplex) so
 * humans CAN barge in, but this governor force-cancels and flushes playout as a
 * runaway-answer bound — a backstop for a response that never ends on its own.
 * The prompt's brevity rules are the soft layer.
 */
const MAX_SPEECH_MS = 35_000
const EARLIER_MEETING_QUESTION_RE = /\b(earlier|at the (start|beginning)|this meeting|did (\w+ )?say)\b/i

function shouldSearchEarlierMeeting(question: string): boolean {
  return EARLIER_MEETING_QUESTION_RE.test(question)
}

function transcriptResultsFrom(data: unknown): EarlierMeetingTranscriptResult[] {
  if (!data || typeof data !== 'object') return []
  const results = (data as Record<string, unknown>).results
  if (!Array.isArray(results)) return []
  return results.filter(
    (entry): entry is EarlierMeetingTranscriptResult =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).speaker === 'string' &&
      typeof (entry as Record<string, unknown>).text === 'string' &&
      typeof (entry as Record<string, unknown>).timestamp === 'string',
  )
}

function formatEarlierMeetingResults(results: EarlierMeetingTranscriptResult[]): string {
  if (results.length === 0) return ''
  return [
    'From earlier in this meeting (matching transcript turns):',
    ...results.map((result) => `[${result.timestamp}] ${result.speaker}: ${result.text}`),
    'Use these meeting-transcript results as the source for the earlier-discussion part of the answer.',
  ].join('\n')
}

/**
 * Wire format to/from the realtime API: PCM16 @ 24kHz (the only rate the
 * audio/pcm session format supports). NOT necessarily the AudioContext rate —
 * the worklets run at the DEVICE's native rate and we resample in JS, because
 * Recall's renderer audio device runs at 44.1kHz and its capture of a
 * non-native-rate AudioContext corrupts the audio (a locally generated sine
 * through a 24kHz context came out as static in-meeting on both Meet and Zoom).
 */
const WIRE_SAMPLE_RATE = 24000

/** Linear-interpolation PCM16 resampler. Fine for speech; chunk-local. */
function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Int16Array(outLen)
  const step = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[idx] ?? input[input.length - 1]
    const b = input[idx + 1] ?? a
    out[i] = (a + (b - a) * frac) | 0
  }
  return out
}

/** ArrayBuffer -> base64 without spreading huge arrays onto the call stack. */
function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** base64 PCM16 -> Int16Array for the WavStreamPlayer. */
function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}

/**
 * Diagnostic tone (toggled live via meetings.metadata.test_tone): a locally
 * generated sine played through the SAME AudioWorklet pipeline as model speech,
 * with zero Azure involvement. Garbled tone in-meeting => the corruption is in
 * the capture/encode stage after our page (Recall renderer or platform), not
 * in realtime audio delivery. Clean tone + garbled speech => delta pacing.
 */
function makeTonePcm(seconds: number, sampleRate: number, hz = 440): Int16Array {
  const n = Math.floor(sampleRate * seconds)
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    // 0.3 amplitude — audible without blasting the meeting.
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.3 * 32767)
  }
  return pcm
}

/**
 * Pull entity keys out of a tool result for the retrieval audit log. HTTP /search
 * rows carry {text, source, score} with NO entity_key/id, so fall back to
 * `source` — otherwise the audit log recorded empty doc_keys for every forced
 * retrieval (the live results are source-tagged, not entity-keyed).
 */
function extractDocKeys(output: Record<string, unknown>): string[] {
  const keys: string[] = []
  // The researcher route reports the notes it read as a flat list.
  if (Array.isArray(output.doc_keys)) {
    for (const key of output.doc_keys) if (typeof key === 'string' && key) keys.push(key)
  }
  for (const field of ['results', 'documents'] as const) {
    const arr = output[field]
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const doc = item as Record<string, unknown>
        const key = (doc.entity_key as string) || (doc.id as string) || (doc.source as string)
        if (key) keys.push(key)
      }
    }
  }
  const single = output.document as Record<string, unknown> | null | undefined
  if (single && typeof single === 'object') {
    const key = (single.entity_key as string) || (single.id as string) || (single.source as string)
    if (key) keys.push(key)
  }
  return keys
}

/** Pull `source` values out of a result set for the retrieval audit log. */
function extractSources(results: Array<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const r of results) {
    const src = r.source
    if (typeof src === 'string' && src) out.push(src)
  }
  return out
}

function AgentFramePage({ meetingId }: { meetingId: string }) {
  const [state, setState] = useState<AgentState>('connecting')
  const [agentName, setAgentName] = useState('Agent')
  const [subtitle, setSubtitle] = useState('AI representative for David')
  const [wakeWord, setWakeWord] = useState('')
  const [lastReason, setLastReason] = useState('')
  // Camera-tile content: the question being answered, the live caption of the
  // agent's speech, and which knowledge lanes fed the answer.
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [caption, setCaption] = useState('')
  const [lanes, setLanes] = useState<{ openbrain: string; teamKb: string } | null>(null)
  const [activeBgTask, setActiveBgTask] = useState<BackgroundTask | null>(null)
  // null until the session says which avatar this meeting uses: nothing is drawn before then.
  const [avatarProvider, setAvatarProvider] = useState<AvatarProviderId | null>(null)
  /** The video face could not start: the drawn avatar is shown instead of the loading card. */
  const [faceFailed, setFaceFailed] = useState(false)
  const speechMetricsRef = useRef<SpeechMetrics>({ rms: 0, zcr: 0, updatedAt: 0 })
  const bgTaskSeqRef = useRef(0)

  const wsRef = useRef<WebSocket | null>(null)
  // Bumps whenever a recoverable transport loss invalidates async work started
  // by the old socket (retrievals, tool calls, and playout-drain polling).
  // Those operations must never write into the freshly minted connection.
  const transportGenerationRef = useRef(0)
  // Ref mirror of agentName: callbacks read this so their identity stays stable
  // when state updates.
  const agentNameRef = useRef('Agent')
  // Per-agent tool routes, derived from the single capability registry via the
  // same selector the server uses, so the client dispatch map can never drift
  // from the audience-filtered tools the model was actually given. Set on
  // session-config load; defaults to the full map until then.
  const toolRoutesRef = useRef(TOOL_ROUTES)
  const seenEventTypesRef = useRef<Set<string>>(new Set())

  // wavtools AudioWorklet nodes (loaded dynamically — browser-only).
  const playerRef = useRef<WavStreamPlayer | null>(null)
  const recorderRef = useRef<WavRecorder | null>(null)
  // The device-native AudioContext rate the worklets run at (44.1kHz in
  // Recall's renderer, 48kHz on most local hardware). Set during startup.
  const deviceRateRef = useRef(WIRE_SAMPLE_RATE)
  // Full-duplex: mic stays recording while the agent speaks. isSpeakingRef
  // tracks agent speech for state display and the runaway-speech governor only;
  // it does NOT gate audio delivery. Recall Output-Media excludes the bot's own
  // rendered output from the page mic (synthetic streams in headless Chromium),
  // so there is no acoustic self-echo to gate — VAD stays at full sensitivity.
  const isSpeakingRef = useRef(false)
  // Dormant mode: set by a stop command ("be quiet", "stand down", etc.).
  // While dormant the wake gate is bypassed — ALL utterances are ignored until
  // the wake word is spoken explicitly. Cleared on the next wake-word utterance.
  const dormantRef = useRef(false)
  // Persona ('first_person' delegate vs 'ai' Jarvis) — drives deterministic
  // knowledge routing (delegate: OpenBrain-first; jarvis: team-KB-only).
  const personaModeRef = useRef<string>('')
  // Rolling window of recent transcript turns (user + agent) used to build the
  // context-aware search query (buildSearchQuery) — agent turns are marked
  // isAgent:true so query-context can drop them from context harvesting.
  const recentTurnsRef = useRef<RecentTurn[]>([])
  // Speculative prefetch: the accumulating live user transcription and its
  // debounce timer. As the user speaks, a prefetch fires ~PREFETCH_DEBOUNCE_MS
  // after the latest fragment against the SAME buildSearchQuery path, so
  // activateResponse can serve from cache on a MATCH_THRESHOLD hit.
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetchAccumRef = useRef<string>('')

  // Wake-triggered manual commit: accumulate streaming partial-transcript deltas
  // so an addressed complete question can force-commit the input buffer instead
  // of waiting for VAD silence (noisy multi-party rooms never go silent). Reset
  // per user turn on the completed transcription.
  const wakeCommitEnabledRef = useRef(true)
  const partialTranscriptRef = useRef<string>('')
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const manualCommitPendingRef = useRef(false)

  const gateStateRef = useRef<WakeGateState>({ engagedUntil: 0 })
  const gateConfigRef = useRef<WakeGateConfig | null>(null)
  // Real-time multi-party speaker state from Recall participant_events + transcript.data
  const speakerStateRef = useRef<{
    activeSpeakers: string[]
    lastSpeaker: string | null
    overlappingSpeech: boolean
  }>({
    activeSpeakers: [],
    lastSpeaker: null,
    overlappingSpeech: false,
  })
  // Previous non-activating utterance, for VAD fragment stitching.
  const pendingFragmentRef = useRef<PendingFragment | null>(null)
  const activeResponseRef = useRef<boolean>(false)
  // Mute state, set by the owner-command poll (every GET /commands response carries it).
  const mutedRef = useRef<boolean>(false)
  // Highest owner-command seq handled. A ref, not an effect local, so it survives the
  // effect re-running and a command is never run twice.
  const commandSeqRef = useRef(0)
  // Bumped by every owner `mute` and `say`. An answer waiting on retrieval or a tool call
  // captures it first and gives up its response.create if it moved (the owner took over).
  const commandGenerationRef = useRef(0)
  // An owner `say` persists its own text when it runs (runCommand), so the response.done
  // that follows must not persist the same words again. A count rather than a flag
  // because two says can be queued before the first response.created arrives.
  const pendingCommandResponsesRef = useRef(0)
  // Written replies. While Date.now() is before chatReplyUntilRef, responses are text-only
  // and the finished text is posted to the meeting chat (a typed request is being
  // answered). replyModeRef 'chat' (SOUL reply_mode) does the same for every answer.
  // Typed requests that arrive while the bot is busy wait in pendingAsksRef.
  const chatReplyUntilRef = useRef(0)
  // The realtime event handler is defined before runCommand; it reaches it through this ref.
  const runCommandRef = useRef<((cmd: MeetingCommand) => void) | null>(null)
  const replyModeRef = useRef<'voice' | 'chat'>('voice')
  const notesOnlyRef = useRef(false)
  // Facilitator mode (SOUL mode: facilitator): the bot leads the call. It opens the
  // session itself, hears every turn, and speaks again when the room goes silent.
  const facilitatorRef = useRef(false)
  // Stand-in mode (SOUL mode: stand_in) takes turns like a facilitator but never leads:
  // it does not open on a timer and never fills a silence. Its first reply carries the
  // opening line that says it is an AI.
  const standInRef = useRef(false)
  const standInOpeningRef = useRef('')
  const coachOpenedRef = useRef(false)
  /** When the service first reported a person in the call (0 = nobody yet). */
  const coachHumansSinceRef = useRef(0)
  const coachNudgesRef = useRef(0)
  /** The list of people last told to the model ('' = not told yet in this session). */
  const coachRosterKeyRef = useRef('')
  const lastHumanSpokeAtRef = useRef(0)
  /** True between the voice detector's "speech started" and "speech stopped". */
  const humanSpeakingRef = useRef(false)
  /** The facilitator's pending turn: who spoke last, and the timer that waits for the pause. */
  const coachPendingRef = useRef<{ speaker?: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  /** When the voice detector last reported the start and the end of speech (0 = never). */
  const speechStartedAtRef = useRef(0)
  const speechStoppedAtRef = useRef(0)
  /** When the facilitator last asked the model for a turn. */
  const coachTurnAtRef = useRef(0)
  const retrievalModeRef = useRef<RetrievalMode>('model')
  /** True when a Claude researcher does the lookups (agent.knowledgeMode === 'researcher'). */
  const researcherRef = useRef(false)
  /** Stops an answer when the one person in the call keeps talking over it. */
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** For pacing the caption: audio received for the current response, and when it starts playing. */
  const captionAudioRef = useRef({ receivedSec: 0, startsAt: 0 })
  /** When everything queued for playout so far will have played (ms since epoch). */
  const playoutEndsAtRef = useRef(0)
  /** Characters per second of speech, learned from finished answers (caption pacing). */
  const captionRateRef = useRef(DEFAULT_CHARS_PER_SEC)
  /** The Anam video face, when one is streaming. */
  const faceRef = useRef<AnamFace | null>(null)
  const faceStateRef = useRef({ starting: false, startedAt: 0, maxMs: 0, syncMs: 0, lastUsedAt: 0, retryAfter: 0, audioFromFace: false })
  /** Audio held back until the face starts speaking it (play callbacks, in order). */
  const heldAudioRef = useRef<Array<() => void>>([])
  /** Per answer: has the face's own audio started, and the timer that watches for it. */
  const onsetRef = useRef<{ released: boolean; watch: ReturnType<typeof setInterval> | null }>({ released: false, watch: null })
  /** Reads the loudness of the face's own audio track, when it has one. */
  const faceLevelRef = useRef<{ read: () => number; close: () => void } | null>(null)
  /** The vocabulary prompt given to speech-to-text, to recognise it coming back as a transcript. */
  const sttPromptRef = useRef('')
  /** A silent path for the page's player, used while the face carries the voice. */
  const silentGainRef = useRef<GainNode | null>(null)
  const playerMutedRef = useRef<{ node: AudioNode | null; muted: boolean }>({ node: null, muted: false })
  const [faceReady, setFaceReady] = useState(false)
  // The face was closed after a long silence (not: still loading). `faceStill` is its last frame.
  const [faceIdle, setFaceIdle] = useState(false)
  const [faceStill, setFaceStill] = useState<string | null>(null)
  // Quiet mode (dormant), mirrored into state so the tile can say so.
  const [quiet, setQuiet] = useState(false)
  const dormantSinceRef = useRef(0)
  const serverWakeAtRef = useRef(0)
  const avatarProviderRef = useRef<AvatarProviderId>('google-live-avatar')
  /** Whether the current answer goes through the face (decided at its first audio chunk). */
  const responseUsesFaceRef = useRef<boolean | null>(null)
  /** Audio chunks held back so the voice lines up with the face's lips. */
  const pendingAudioTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  /** The session's tool definitions, re-sent with answer_directly for the silent decision step. */
  const sessionToolsRef = useRef<unknown[]>([])
  const listeningPausedRef = useRef(false)
  /** When this page last changed the pause itself; a poll that raced that change is ignored. */
  const listeningChangedAtRef = useRef(0)
  const brainRef = useRef<'builtin' | 'external'>('builtin')
  const pendingAsksRef = useRef<MeetingCommand[]>([])
  /** Run the next waiting typed request, if the bot is free (not answering, not speaking, no written reply pending). */
  const drainPendingAsk = useCallback(() => {
    if (activeResponseRef.current || isSpeakingRef.current || Date.now() < chatReplyUntilRef.current) return
    const next = pendingAsksRef.current.shift()
    if (next) runCommandRef.current?.(next)
  }, [])
  const currentResponseFromCommandRef = useRef(false)
  const responseTextRef = useRef<string>('')
  // Transcript of the audio of the current response only (no text-only output).
  const spokenAudioRef = useRef('')
  // L0: id of the assistant message item currently being spoken. Captured from
  // the audio delta; required to address conversation.item.truncate on barge-in.
  const activeItemIdRef = useRef<string | null>(null)
  // Fresh wavtools track id per response (see RESPONSE_TRACK_ID) so an interrupt
  // can't permanently silence later responses.
  const responseTrackSeqRef = useRef(0)
  const responseTrackIdRef = useRef<string>(RESPONSE_TRACK_ID)
  // L1: the text the agent most recently spoke + when it ended, for rejecting
  // its own delayed echo (a remote participant off headphones replays it).
  const lastSpokenRef = useRef<SpokenWindow>({ text: '', endedAt: 0 })
  const startedRef = useRef(false)
  // Diagnostic tone scheduling — when the next tone may start (epoch ms).
  const toneUntilRef = useRef(0)
  // Speech governor timer (see MAX_SPEECH_MS).
  const speechGovernorRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const chatReply = Date.now() < chatReplyUntilRef.current || replyModeRef.current === 'chat'
      ws.send(JSON.stringify(withChatReply(event, chatReply)))
    }
  }, [])

  /** Telemetry to the server log — the bot's browser console is otherwise unobservable. */
  const logClient = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => {
      console.error(`[agent-frame] ${level}: ${message}`)
      authedFetch(`/api/meetings/${meetingId}/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message: message.slice(0, 2000) }),
      }).catch(() => {})
    },
    [meetingId],
  )

  /** Stream a meeting-mic PCM chunk up as realtime input (device rate -> 24kHz wire). */
  const sendMicChunk = useCallback(
    (data: { mono: ArrayBuffer }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        const wirePcm = resamplePcm16(new Int16Array(data.mono), deviceRateRef.current, WIRE_SAMPLE_RATE)
        ws.send(
          JSON.stringify({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(wirePcm.buffer) }),
        )
      }
    },
    [],
  )

  // NOTE: pauseMic/resumeMic were removed — the agent is full-duplex now (mic
  // stays recording while speaking). If half-duplex ever returns, restore them.

  /**
   * Audit trail: record which OpenBrain docs were injected into the session,
   * plus the retrieval-quality signals the meeting-state route persists
   * (searched_query, sources, top_score, lanes, elapsed_ms). `extra` is optional
   * so tool-call telemetry (which only has doc keys) can still log a thin record.
   */
  const logRetrieval = useCallback(
    (
      tool: string,
      query: string | undefined,
      docKeys: string[],
      extra?: {
        searched_query?: string
        sources?: string[]
        top_score?: number | null
        lanes?: Record<string, unknown>
        elapsed_ms?: number | null
        served_from?: string
      },
    ) => {
      authedFetch(`/api/meetings/${meetingId}/retrieval-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool,
          query,
          doc_keys: docKeys.slice(0, 50),
          ...(extra?.searched_query !== undefined ? { searched_query: extra.searched_query } : {}),
          ...(extra?.sources !== undefined ? { sources: extra.sources.slice(0, 50) } : {}),
          ...(extra?.top_score !== undefined ? { top_score: extra.top_score } : {}),
          ...(extra?.lanes !== undefined ? { lanes: extra.lanes } : {}),
          ...(extra?.elapsed_ms !== undefined ? { elapsed_ms: extra.elapsed_ms } : {}),
          ...(extra?.served_from !== undefined ? { served_from: extra.served_from } : {}),
        }),
      }).catch(() => {})
    },
    [meetingId],
  )

  const injectSystemText = useCallback(
    (text: string) => {
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }],
        },
      })
    },
    [sendEvent],
  )

  const reportBackgroundTask = useCallback(
    (task: BackgroundTask) => {
      setActiveBgTask(task.status === 'running' || !task.delivered ? task : null)
      authedFetch(`/api/meetings/${encodeURIComponent(meetingId)}/background-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
      }).catch(() => {})
    },
    [meetingId],
  )

  const scheduleBackgroundDelivery = useCallback(
    (
      task: BackgroundTask,
      directive: string,
      capturedTransportGen: number,
      capturedCommandGen: number,
    ) => {
      let attempts = 0
      const pollSilence = () => {
        if (transportGenerationRef.current !== capturedTransportGen) {
          setActiveBgTask(null)
          return
        }
        if (
          !shouldSendDeferredResponse({
            capturedGeneration: capturedCommandGen,
            currentGeneration: commandGenerationRef.current,
            muted: mutedRef.current,
          }) ||
          dormantRef.current
        ) {
          setActiveBgTask(null)
          return
        }
        const ready = canDeliverBackgroundResult({
          isSpeaking: isSpeakingRef.current,
          activeResponse: activeResponseRef.current,
          overlappingSpeech: speakerStateRef.current.overlappingSpeech,
          muted: mutedRef.current,
          dormant: dormantRef.current,
        })
        if (ready || attempts >= 40) {
          injectSystemText(directive)
          activeResponseRef.current = true
          sendEvent({ type: 'response.create' })
          reportBackgroundTask({ ...task, delivered: true })
          setTimeout(() => setActiveBgTask(null), 2500)
          return
        }
        attempts += 1
        setTimeout(pollSilence, 250)
      }
      setTimeout(pollSilence, 200)
    },
    [injectSystemText, reportBackgroundTask, sendEvent],
  )

  /**
   * An answer that waited on retrieval or a tool call is not sent: the owner muted or
   * spoke over it meanwhile. Logs the reason (never the question) and, unless something
   * else is already speaking, drops the "thinking" tile state.
   */
  const skipDeferredResponse = useCallback(
    (what: string) => {
      logClient('info', `${what} not sent: ${mutedRef.current ? 'muted' : 'owner command took over'}`)
      if (!isSpeakingRef.current && !activeResponseRef.current) setState('idle')
    },
    [logClient],
  )

  /**
   * Build the retrieval query for an utterance, applying the context-aware
   * buildSearchQuery pass over the recent transcript, THEN the status/day-scoped
   * expansions on top of the built query. Returns the query actually sent to the
   * search route. Shared by the live activation path and the speculative prefetch
   * so both key on identical text.
   */
  const buildRetrievalQuery = useCallback((utterance: string): string => {
    const config = gateConfigRef.current
    const built = config
      ? buildSearchQuery(utterance, recentTurnsRef.current, {
          wakeWord: config.wakeWord,
          aliases: config.wakeAliases ?? [],
        }).query
      : utterance
    // buildSearchQuery strips wake/greeting/stopwords; if it empties out (e.g. a
    // bare wake word), fall back to the wake-stripped raw text so the query is
    // never blank.
    const baseQuery = built.trim().length > 0
      ? built
      : config
        ? stripWakeWords(utterance, config.wakeWord, config.wakeAliases ?? [])
        : utterance
    // Status questions expand with priority/state terms so the decision-defining
    // doc surfaces alongside operational notes (applied to the BUILT query).
    return isStatusQuestion(utterance) ? `${baseQuery} ${STATUS_QUERY_EXPANSION}` : baseQuery
  }, [])

  /**
   * R1a speculative prefetch: debounced against the accumulating live user
   * transcription. Fires the SAME buildSearchQuery path + /api/voice/ob-search
   * call, then stores the raw rows in the speculative cache keyed on the
   * utterance so activateResponse can serve them instantly.
   */
  const runSpeculativeSearch = useCallback(
    (utterance: string) => {
      if (!looksLikeKnowledgeQuery(utterance)) return
      const searchQuery = buildRetrievalQuery(utterance)
      if (!searchQuery.trim()) return
      const dayQ = isDayScopedQuestion(utterance)
      const statusQ = isStatusQuestion(utterance)
      const searchLimit = dayQ ? 40 : statusQ ? 10 : 6
      authedFetch('/api/voice/ob-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery,
          limit: searchLimit,
          scope: 'work',
          personaMode: personaModeRef.current,
          meetingId,
          timeoutMs: FORCED_RETRIEVAL_TIMEOUT_MS,
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          // Nothing is cached when OpenBrain was unreachable: a hit would skip the
          // directive, so the live path has to run and inject it.
          const results = prefetchResultsToStore(data)
          // Key the cache on the raw utterance (matchSpeculativeHit normalizes and
          // token-covers), so the model's later query matches regardless of the
          // built-query expansion.
          storeSpeculativeHit(utterance, results)
        })
        .catch(() => {})
    },
    [buildRetrievalQuery, meetingId],
  )

  /**
   * One facilitator turn: no lookup, no routing. The model has heard the room (every
   * committed turn is in the conversation), so it is asked to respond, optionally after
   * a one-line note (who spoke, or that the room is silent). It may answer by calling
   * stay_quiet, which says nothing.
   */
  const coachTurn = useCallback(
    (directive?: string) => {
      if (mutedRef.current || notesOnlyRef.current || dormantRef.current) return
      if (wsRef.current?.readyState !== WebSocket.OPEN) return
      chatReplyUntilRef.current = 0
      if (activeResponseRef.current) {
        sendEvent({ type: 'response.cancel' })
        activeResponseRef.current = false
      }
      setState('thinking')
      ensureFace()
      if (directive) injectSystemText(directive)
      activeResponseRef.current = true
      coachTurnAtRef.current = Date.now()
      sendEvent({ type: 'response.create' })
    },
    [sendEvent, injectSystemText],
  )

  /**
   * A person stopped speaking. The facilitator takes its turn `delayMs` later, unless
   * speech starts again first (the handler for "speech started" cancels the wait). It
   * also waits for its own voice to end. The turn starts from the end of speech, not from
   * the written transcript: the transcript arrives about two seconds later, and waiting
   * for it made every reply late (test call 2026-11-16). The model answers from the audio.
   */
  const coachSettle = useCallback(
    (speaker?: string, delayMs: number = FACILITATOR_SETTLE_MS) => {
      const pending = coachPendingRef.current
      if (pending) clearTimeout(pending.timer)
      const who = speaker ?? pending?.speaker
      const wait = (ms: number): ReturnType<typeof setTimeout> =>
        setTimeout(() => {
          const still = coachPendingRef.current
          if (!still) return
          const busy = humanSpeakingRef.current || activeResponseRef.current || isSpeakingRef.current
          if (busy) {
            still.timer = wait(300)
            return
          }
          coachPendingRef.current = null
          logClient('info', `facilitator: taking a turn ${Date.now() - speechStoppedAtRef.current} ms after speech stopped`)
          const who = still.speaker ? speakerDirective(still.speaker) : undefined
          if (standInRef.current && !coachOpenedRef.current) {
            coachOpenedRef.current = true
            logClient('info', 'stand-in: first turn, opening line')
            coachTurn([standInOpenDirective(standInOpeningRef.current), who].filter(Boolean).join(' '))
            return
          }
          coachTurn(who)
        }, ms)
      coachPendingRef.current = { ...(who ? { speaker: who } : {}), timer: wait(delayMs) }
    },
    [coachTurn, logClient],
  )

  /**
   * Runs once a second in facilitator mode. Opens the session once a person is in the
   * call, and speaks again when nobody has said anything for a while: twice, then one
   * line saying it will wait. After that it is silent until someone speaks.
   */
  const coachTick = useCallback(() => {
    if (!facilitatorRef.current || mutedRef.current || notesOnlyRef.current || dormantRef.current) return
    // A stand-in waits to be spoken to: no opening on a timer, no silence nudges.
    if (standInRef.current) return
    if (activeResponseRef.current || isSpeakingRef.current) return
    if (coachPendingRef.current || humanSpeakingRef.current) return
    if (partialTranscriptRef.current.trim() !== '' || speakerStateRef.current.activeSpeakers.length > 0) return
    const now = Date.now()
    if (!coachOpenedRef.current) {
      if (coachHumansSinceRef.current === 0 || now - coachHumansSinceRef.current < FACILITATOR_OPEN_DELAY_MS) return
      coachOpenedRef.current = true
      coachNudgesRef.current = 0
      lastHumanSpokeAtRef.current = now
      logClient('info', 'facilitator: opening the session')
      coachTurn(FACILITATOR_OPEN_DIRECTIVE)
      return
    }
    if (coachNudgesRef.current > FACILITATOR_MAX_NUDGES) return
    const lastActivity = Math.max(
      lastHumanSpokeAtRef.current,
      gateStateRef.current.agentSpokeAt ?? 0,
      lastSpokenRef.current.endedAt,
      playoutEndsAtRef.current,
    )
    if (now - lastActivity < FACILITATOR_SILENCE_NUDGE_MS) return
    coachNudgesRef.current += 1
    lastHumanSpokeAtRef.current = now
    const last = coachNudgesRef.current > FACILITATOR_MAX_NUDGES
    logClient('info', `facilitator: the room is silent, nudge ${coachNudgesRef.current}${last ? ' (last)' : ''}`)
    coachTurn(last ? FACILITATOR_FINAL_NUDGE_DIRECTIVE : FACILITATOR_NUDGE_DIRECTIVE)
  }, [coachTurn, logClient])

  /** Forced retrieve-then-answer: pre-fetch OpenBrain context, inject, respond. */
  const activateResponse = useCallback(
    async (question: string) => {
      const transportGeneration = transportGenerationRef.current
      const commandGeneration = commandGenerationRef.current
      // A spoken request takes over from a written reply that is still pending, so this
      // answer is spoken (unless the SOUL sets reply_mode chat).
      chatReplyUntilRef.current = 0
      // One response at a time: a second trigger while one is in flight piles
      // up consecutive answers (round-15 transcript had back-to-back replies).
      if (activeResponseRef.current) {
        sendEvent({ type: 'response.cancel' })
        activeResponseRef.current = false
      }
      setState('thinking')
      setCurrentQuestion(question)
      ensureFace()

      // Route the request (src/agent/answer-route.ts). Presence checks and small talk are
      // answered directly. Most other requests are answered at once too, and the model
      // calls search_brain itself when the question is about the work notes. Only the
      // question types that need the wide lookup (day-scoped, status, earlier in this
      // meeting), or a search that already finished while the person spoke, look up first.
      const config = gateConfigRef.current
      const route = config
        ? chooseAnswerRoute(question, {
            wakeWord: config.wakeWord,
            aliases: config.wakeAliases ?? [],
            mode: retrievalModeRef.current,
            hasPrefetchedResults: Boolean(matchSpeculativeHit(question)?.results.length),
            meetingScoped: shouldSearchEarlierMeeting(question),
            researcher: researcherRef.current,
          })
        : 'lookup_first'
      if (route !== 'lookup_first') {
        if (route === 'presence') {
          injectSystemText(
            'The user is just checking you are present. Reply with one brief sentence confirming you are here and listening — nothing else.',
          )
        } else if (route === 'casual') {
          injectSystemText(CASUAL_TURN_DIRECTIVE)
        }
        logClient('info', `answer route: ${route}`)
        activeResponseRef.current = true
        // 'model': a silent first step in which the model must pick a tool (a search, an
        // action, or answer_directly). It speaks only in the step after that, so it
        // cannot say "let me check" and then answer without having searched.
        sendEvent(route === 'model' ? decisionResponseEvent(sessionToolsRef.current) : { type: 'response.create' })
        return
      }

      try {
        // Context-aware query: buildSearchQuery harvests salient terms from the
        // recent transcript (and strips the wake word — "jarvis" otherwise
        // matches the agent's own meeting transcripts and trips the self-
        // referential demotion bypass). The status/day expansions apply on top of
        // the BUILT query. The full question is still the injection label below.
        const searchQuery = buildRetrievalQuery(question)
        // Day-scoped questions ("what did I complete today") want the day's WHOLE
        // inventory — the connector returns up to ~40, so request that many.
        // Status questions want the COMPLETE picture, so pull a wider set (10).
        // Plain questions stay tight (6).
        const dayQ = isDayScopedQuestion(question)
        const statusQ = isStatusQuestion(question)
        const searchLimit = dayQ ? 40 : statusQ ? 10 : 6

        // Earlier-in-meeting assist: the realtime context truncates and each
        // reconnect re-seeds only recent turns, so questions about what was
        // SAID earlier in this meeting also search the meeting's own on-disk
        // transcript. Fired in parallel; injected after the knowledge context.
        const meetingScoped = shouldSearchEarlierMeeting(question)
        const transcriptHitsPromise: Promise<EarlierMeetingTranscriptResult[]> =
          meetingScoped
            ? authedFetch(`/api/meetings/${encodeURIComponent(meetingId)}/transcript-search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: question, k: 6 }),
              })
                .then((r) => (r.ok ? r.json() : { results: [] }))
                .then(transcriptResultsFrom)
                .catch(() => [])
            : Promise.resolve([])

        // R1a: serve from the speculative prefetch cache when the accumulating
        // live transcription already prefetched a semantically-close utterance
        // (0ms, no request). A matched-but-empty entry is not cached (storeSpeculativeHit
        // drops empties), so a hit always carries results.
        const prefetched = matchSpeculativeHit(question)
        if (prefetched && prefetched.results.length > 0) {
          const results = prefetched.results
          logRetrieval('forced_retrieval', question, extractDocKeys({ results }), {
            searched_query: searchQuery,
            sources: extractSources(results),
            top_score: prefetched.topScore,
            served_from: 'prefetch',
          })
          injectSystemText(
            formatRetrievalForInjection(
              question,
              results as Parameters<typeof formatRetrievalForInjection>[1],
              personaModeRef.current,
            ),
          )
          // Proactive injection: only on a strong-enough top score, gated by the
          // cache's master switch + score floor (buildInjectionBlock enforces both).
          const injectionBlock = buildInjectionBlock(prefetched)
          if (injectionBlock) injectSystemText(injectionBlock)
        } else {
          const searchFetchPromise = authedFetch('/api/voice/ob-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // scope:'work' + personaMode: the route routes by persona — the
            // Delegate (first_person) checks OpenBrain first (delegate-safe),
            // Jarvis (ai) checks the team KB only. No bucket-inference. timeoutMs lets
            // the forced (retrieve-then-answer) path wait longer than a passing
            // tool call would.
            body: JSON.stringify({
              query: searchQuery,
              limit: searchLimit,
              scope: 'work',
              personaMode: personaModeRef.current,
              meetingId,
              timeoutMs: FORCED_RETRIEVAL_TIMEOUT_MS,
            }),
          }).then(async (res) => (res.ok ? ((await res.json()) as Record<string, unknown>) : { results: [] }))

          const raced = await raceWithBudget(searchFetchPromise, DEFAULT_FAST_RETRIEVAL_BUDGET_MS)
          if (transportGeneration !== transportGenerationRef.current) return

          if (raced.kind === 'fast') {
            const data = raced.value
            const results = Array.isArray(data.results) ? data.results : []
            if (data.lanes) setLanes(data.lanes as { openbrain: string; teamKb: string })
            logRetrieval('forced_retrieval', question, extractDocKeys({ results }), {
              searched_query: searchQuery,
              sources: extractSources(results),
              top_score: typeof data.top_score === 'number' ? data.top_score : null,
              lanes: (data.lanes as Record<string, unknown>) ?? undefined,
              elapsed_ms: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : raced.elapsedMs,
              served_from: 'live',
            })
            // An empty lookup is not announced to the model (model mode): it then runs its
            // own search and only says it has no answer if that finds nothing either.
            if (shouldInjectLookup(retrievalModeRef.current, results.length) || data.unreachable === true) {
              injectSystemText(
                injectionFor(data, formatRetrievalForInjection(question, results, personaModeRef.current)),
              )
            }
          } else {
            // Phase 2: Retrieval exceeded fast-path budget (650ms). Immediately
            // acknowledge in conversation while OpenBrain finishes in the background.
            bgTaskSeqRef.current += 1
            const bgTask: BackgroundTask = {
              id: `bg-${bgTaskSeqRef.current}-${Date.now()}`,
              meetingId,
              label: 'Searching OpenBrain…',
              query: searchQuery,
              status: 'running',
              startedAt: Date.now(),
              delivered: false,
            }
            reportBackgroundTask(bgTask)
            injectSystemText(formatBackgroundAckDirective(question, bgTask.label))
            if (
              shouldSendDeferredResponse({
                capturedGeneration: commandGeneration,
                currentGeneration: commandGenerationRef.current,
                muted: mutedRef.current,
              })
            ) {
              activeResponseRef.current = true
              sendEvent({ type: 'response.create' })
            }

            void raced.promise
              .then(({ value: data, elapsedMs }) => {
                if (transportGeneration !== transportGenerationRef.current) return
                const results = Array.isArray(data.results) ? data.results : []
                if (data.lanes) setLanes(data.lanes as { openbrain: string; teamKb: string })
                logRetrieval('forced_retrieval', question, extractDocKeys({ results }), {
                  searched_query: searchQuery,
                  sources: extractSources(results),
                  top_score: typeof data.top_score === 'number' ? data.top_score : null,
                  lanes: (data.lanes as Record<string, unknown>) ?? undefined,
                  elapsed_ms: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : elapsedMs,
                  served_from: 'background',
                })
                const groundedContext = injectionFor(
                  data,
                  formatRetrievalForInjection(question, results, personaModeRef.current),
                )
                const completedTask: BackgroundTask = {
                  ...bgTask,
                  label: 'OpenBrain search ready',
                  status: 'completed',
                  completedAt: Date.now(),
                  elapsedMs,
                  delivered: false,
                  summary: `${results.length} result${results.length === 1 ? '' : 's'}`,
                }
                reportBackgroundTask(completedTask)
                scheduleBackgroundDelivery(
                  completedTask,
                  formatBackgroundCompletionDirective(question, completedTask.label, groundedContext),
                  transportGeneration,
                  commandGeneration,
                )
              })
              .catch(() => {
                reportBackgroundTask({
                  ...bgTask,
                  status: 'failed',
                  completedAt: Date.now(),
                  delivered: true,
                })
                setActiveBgTask(null)
              })
            return
          }
        }
        if (meetingScoped) {
          const transcriptHits = await transcriptHitsPromise
          if (transportGeneration !== transportGenerationRef.current) return
          if (transcriptHits.length > 0) {
            logRetrieval('search_meeting_transcript', question, [])
            injectSystemText(formatEarlierMeetingResults(transcriptHits))
          }
        }
      } catch (err) {
        if (transportGeneration !== transportGenerationRef.current) return
        console.error('[agent-frame] forced retrieval failed:', err)
        injectSystemText(
          `Knowledge retrieval failed for "${question}". Answer only if you can do so from the pre-loaded meeting context; otherwise say you can't verify right now.`,
        )
      }
      if (transportGeneration !== transportGenerationRef.current) return
      if (
        !shouldSendDeferredResponse({
          capturedGeneration: commandGeneration,
          currentGeneration: commandGenerationRef.current,
          muted: mutedRef.current,
        })
      ) {
        skipDeferredResponse('answer')
        return
      }
      activeResponseRef.current = true
      sendEvent({ type: 'response.create' })
    },
    [
      injectSystemText,
      sendEvent,
      logRetrieval,
      meetingId,
      buildRetrievalQuery,
      skipDeferredResponse,
      reportBackgroundTask,
      scheduleBackgroundDelivery,
    ],
  )

  /** Dispatch a model function call against the same-origin service routes. */
  const handleFunctionCall = useCallback(
    async (name: string, callId: string, argsJson: string) => {
      const transportGeneration = transportGenerationRef.current
      const commandGeneration = commandGenerationRef.current
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(argsJson || '{}')
      } catch {
        // leave args empty; tool will surface an error
      }
      if (name === STAY_QUIET_TOOL) {
        // The facilitator chose to say nothing this turn. Close the call; ask for no response.
        sendEvent({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true }) },
        })
        logClient('info', 'facilitator: stayed quiet')
        setState('idle')
        return
      }
      if (name === ANSWER_DIRECTLY_TOOL) {
        // The model declared that no lookup is needed. Close the call and let it speak,
        // with tools off for that response.
        sendEvent({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true }) },
        })
        if (transportGeneration !== transportGenerationRef.current) return
        if (
          !shouldSendDeferredResponse({
            capturedGeneration: commandGeneration,
            currentGeneration: commandGenerationRef.current,
            muted: mutedRef.current,
          })
        ) {
          return
        }
        activeResponseRef.current = true
        sendEvent(directAnswerEvent())
        return
      }
      if (name === ASK_RESEARCHER_TOOL && toolRoutesRef.current[name]) {
        // The researcher takes seconds. Close the call at once so it never dangles, say a
        // short line if the answer is not back quickly, and speak the answer when it lands.
        const question = typeof args.question === 'string' ? args.question : ''
        sendEvent({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(RESEARCHER_STARTED_OUTPUT) },
        })
        const lookup: Promise<Record<string, unknown>> = authedFetch(toolRoutesRef.current[name]!.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, meetingId, personaMode: personaModeRef.current }),
        })
          .then(async (res) => toolOutputFor(toolRoutesRef.current[name]!.path, res.status, await res.json().catch(() => null)))
          .catch((err) => ({ error: err instanceof Error ? err.message : 'fetch failed' }))
        const canSpeak = () =>
          transportGeneration === transportGenerationRef.current &&
          shouldSendDeferredResponse({
            capturedGeneration: commandGeneration,
            currentGeneration: commandGenerationRef.current,
            muted: mutedRef.current,
          })
        const quick = await Promise.race([
          lookup,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), RESEARCHER_ACK_AFTER_MS)),
        ])
        if (quick !== null) {
          logRetrieval(name, question, extractDocKeys(quick))
          if (!canSpeak()) {
            skipDeferredResponse('researcher answer')
            return
          }
          injectSystemText(researcherAnswerDirective(question, quick))
          activeResponseRef.current = true
          sendEvent(directAnswerEvent())
          return
        }
        bgTaskSeqRef.current += 1
        const bgTask: BackgroundTask = {
          id: `bg-${bgTaskSeqRef.current}-${Date.now()}`,
          meetingId,
          label: 'Looking that up…',
          query: question,
          status: 'running',
          startedAt: Date.now(),
          delivered: false,
        }
        reportBackgroundTask(bgTask)
        if (canSpeak()) {
          injectSystemText(researcherAckDirective())
          activeResponseRef.current = true
          sendEvent(directAnswerEvent())
        }
        const output = await lookup
        if (transportGeneration !== transportGenerationRef.current) return
        logRetrieval(name, question, extractDocKeys(output))
        const completedTask: BackgroundTask = {
          ...bgTask,
          label: 'Answer ready',
          status: typeof output.answer === 'string' && output.answer !== '' ? 'completed' : 'failed',
          completedAt: Date.now(),
          elapsedMs: Date.now() - bgTask.startedAt,
          delivered: false,
        }
        reportBackgroundTask(completedTask)
        scheduleBackgroundDelivery(completedTask, researcherAnswerDirective(question, output), transportGeneration, commandGeneration)
        return
      }
      const route = toolRoutesRef.current[name]
      let output: Record<string, unknown>
      if (!route) {
        output = { error: `Unknown tool: ${name}` }
      } else {
        try {
          const path = route.path.replace(':id', encodeURIComponent(meetingId))
          const res = await authedFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // personaMode drives per-persona knowledge routing for tool-invoked
            // searches too (search_brain / get_brain_context).
            body: JSON.stringify({ ...route.body(args), meetingId, personaMode: personaModeRef.current }),
          })
          // Read the body whatever the status: ob-get-document's 502 carries the
          // unreachable signal, which toolOutputFor turns into the directive.
          const body: unknown = await res.json().catch(() => null)
          output = toolOutputFor(route.path, res.status, body)
          if (name === 'search_meeting_transcript') {
            const results = transcriptResultsFrom(output)
            if (results.length > 0) {
              output = { ...output, context: formatEarlierMeetingResults(results) }
            }
          }
        } catch (err) {
          output = { error: err instanceof Error ? err.message : 'fetch failed' }
        }
      }
      if (transportGeneration !== transportGenerationRef.current) return
      console.error(`[agent-frame] tool ${name} ->`, JSON.stringify(output).slice(0, 200))
      logRetrieval(name, typeof args.query === 'string' ? args.query : undefined, extractDocKeys(output))
      sendEvent({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      })
      // The tool result is still handed back (the call must not dangle), but no spoken
      // answer follows it if the owner muted or spoke over this turn while it ran.
      if (
        !shouldSendDeferredResponse({
          capturedGeneration: commandGeneration,
          currentGeneration: commandGenerationRef.current,
          muted: mutedRef.current,
        })
      ) {
        skipDeferredResponse('tool answer')
        return
      }
      activeResponseRef.current = true
      sendEvent({ type: 'response.create' })
    },
    [sendEvent, logRetrieval, meetingId, skipDeferredResponse, injectSystemText, reportBackgroundTask, scheduleBackgroundDelivery],
  )

  const persistUtterance = useCallback(
    (text: string) => {
      if (!text.trim()) return
      authedFetch(`/api/meetings/${meetingId}/agent-utterance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker: agentNameRef.current, text }),
      }).catch((err) => console.error('[agent-frame] persist utterance failed:', err))
    },
    [meetingId],
  )

  /** Poll the player until its buffer drains, then restore the VAD threshold. */
  const drainThenResume = useCallback(() => {
    const player = playerRef.current
    const transportGeneration = transportGenerationRef.current
    let tries = 0
    const poll = async () => {
      if (transportGeneration !== transportGenerationRef.current) return
      tries += 1
      let active = false
      try {
        active = Boolean(await player?.getTrackSampleOffset()) || pendingAudioTimersRef.current.size > 0 || heldAudioRef.current.length > 0
      } catch {
        active = false
      }
      if (!active || tries > 100 || !isSpeakingRef.current) {
        if (speechGovernorRef.current) {
          clearTimeout(speechGovernorRef.current)
          speechGovernorRef.current = null
        }
        isSpeakingRef.current = false
        setState('idle')
        // Leave the last sentence on the tile until the next answer starts.
        setCaption(lastSentence(responseTextRef.current))
        drainPendingAsk()
      } else {
        setTimeout(() => void poll(), 120)
      }
    }
    void poll()
  }, [])

  /**
   * L0: stop local playout AND tell the server how much audio the human
   * actually heard (conversation.item.truncate). On a raw WebSocket the server
   * does NOT manage playout — without truncate it keeps the full unspoken
   * response in context ("thinks it said more than the human heard"), which
   * desyncs follow-ups and makes barge-in feel erratic. interrupt() is async
   * and resolves {trackId, offset, currentTime} or null (idle/no track);
   * currentTime is wall-clock seconds (rate-normalized), so *1000 = ms heard.
   */
  const flushAndTruncate = useCallback(async () => {
    let off: { trackId: string | null; offset: number; currentTime: number } | null = null
    try {
      off = (await playerRef.current?.interrupt()) ?? null
    } catch {
      off = null
    }
    if (activeItemIdRef.current && off && off.trackId && typeof off.currentTime === 'number') {
      const audioEndMs = Math.max(0, Math.floor(off.currentTime * 1000))
      sendEvent({
        type: 'conversation.item.truncate',
        item_id: activeItemIdRef.current,
        content_index: 0,
        audio_end_ms: audioEndMs,
      })
      logClient('info', `truncate item=${activeItemIdRef.current} audio_end_ms=${audioEndMs}`)
    }
  }, [sendEvent, logClient])

  /** Hard stop: cancel the response and flush+truncate playout (see MAX_SPEECH_MS). */
  const stopSpeaking = useCallback(
    (why: string) => {
      logClient('warn', `stopSpeaking: ${why}`)
      if (activeResponseRef.current) {
        sendEvent({ type: 'response.cancel' })
        activeResponseRef.current = false
        // Capture what was spoken so its delayed echo can be rejected (L1).
        lastSpokenRef.current = { text: responseTextRef.current, endedAt: Date.now() }
      }
      for (const timer of pendingAudioTimersRef.current) clearTimeout(timer)
      pendingAudioTimersRef.current.clear()
      heldAudioRef.current = []
      if (onsetRef.current.watch) clearInterval(onsetRef.current.watch)
      onsetRef.current = { released: false, watch: null }
      faceRef.current?.interrupt()
      void flushAndTruncate()
      playoutEndsAtRef.current = 0
      if (speechGovernorRef.current) {
        clearTimeout(speechGovernorRef.current)
        speechGovernorRef.current = null
      }
      isSpeakingRef.current = false
      setState('idle')
    },
    [sendEvent, logClient, flushAndTruncate],
  )

  /**
   * Run one owner command (see planCommand). The wire events come from the plan; the
   * cancel goes through stopSpeaking, which sends the wire cancel only while a response
   * is active and always flushes audio the player has already buffered (the model
   * finishes long before the speech does). The `say` text is meeting content and is
   * never logged.
   */
  const runCommand = useCallback(
    (cmd: MeetingCommand) => {
      // A mute or say takes over from any answer still waiting on retrieval or a tool
      // call (see commandGenerationRef). Bumped even if the say is dropped below.
      if (cmd.type === 'wake') {
        // The owner called the agent by name (per-speaker transcript). It matters only in
        // quiet mode, when this page's own transcript missed the name. Never while
        // listening is paused, and not for the echo of the request that made it quiet.
        if (!dormantRef.current || listeningPausedRef.current || notesOnlyRef.current) return
        if (Date.now() - dormantSinceRef.current < 6000) return
        logClient('info', 'wake: the owner called by name (meeting transcript); leaving quiet mode')
        dormantRef.current = false
        serverWakeAtRef.current = Date.now()
        setLastReason('woken by name')
        if (!mutedRef.current) void activateResponse(cmd.text)
        return
      }
      if (cmd.type === 'ask') {
        if (notesOnlyRef.current) return
        if (cmd.reply === 'voice') {
          // A spoken request that the outside brain did not answer in time: answer it aloud.
          if (!mutedRef.current && !dormantRef.current) void activateResponse(cmd.text)
          return
        }
        // A typed request never interrupts: it waits while the bot is answering or
        // speaking, and response.done runs it. It is dropped mid-reconnect, like a say.
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          logClient('warn', 'chat request dropped: realtime socket not open')
          return
        }
        if (activeResponseRef.current || isSpeakingRef.current || Date.now() < chatReplyUntilRef.current) {
          if (pendingAsksRef.current.length < 5) pendingAsksRef.current.push(cmd)
          return
        }
        const askPlan = planCommand(cmd, { activeResponse: false, isSpeaking: false })
        logClient('info', 'chat request: answering in chat')
        chatReplyUntilRef.current = Date.now() + CHAT_REPLY_WINDOW_MS
        for (const event of askPlan.events) sendEvent(event)
        activeResponseRef.current = true
        return
      }
      if (cmd.type !== 'unmute') {
        commandGenerationRef.current += 1
        // The owner took over: a written reply still pending is dropped, so this say is spoken.
        chatReplyUntilRef.current = 0
      }
      if (cmd.type === 'say' && wsRef.current?.readyState !== WebSocket.OPEN) {
        // Mid-reconnect there is nothing to speak through, and the command would
        // expire in 30 s anyway. Not persisting it keeps the transcript honest.
        logClient('warn', 'owner say command dropped: realtime socket not open')
        return
      }
      const plan = planCommand(cmd, {
        activeResponse: activeResponseRef.current,
        isSpeaking: isSpeakingRef.current,
      })
      logClient('info', `owner command: ${cmd.type}`)
      if (plan.events.some((event) => event.type === 'response.cancel')) {
        stopSpeaking(`owner ${cmd.type} command`)
      }
      for (const event of plan.events) {
        if (event.type !== 'response.cancel') sendEvent(event)
      }
      if (plan.events.some((event) => event.type === 'response.create')) {
        // Set now, not on response.created: a second command in the same poll batch
        // must see this response as active and cancel it.
        activeResponseRef.current = true
        pendingCommandResponsesRef.current += 1
      }
      if (plan.muted !== undefined) mutedRef.current = plan.muted
      if (plan.spokenText) persistUtterance(plan.spokenText)
    },
    [logClient, stopSpeaking, sendEvent, persistUtterance, activateResponse],
  )
  runCommandRef.current = runCommand

  /**
   * The written transcript shows the last sound was not a person speaking (noise, or the
   * facilitator's own voice coming back). Undo the turn that the sound started.
   */
  const coachDiscard = useCallback(
    (why: string) => {
      if (!facilitatorRef.current) return
      if (coachPendingRef.current) {
        clearTimeout(coachPendingRef.current.timer)
        coachPendingRef.current = null
        return
      }
      const fromThatSound = speechStoppedAtRef.current > 0 && coachTurnAtRef.current >= speechStoppedAtRef.current
      if (fromThatSound && Date.now() - coachTurnAtRef.current < 8000 && (activeResponseRef.current || isSpeakingRef.current)) {
        logClient('info', `facilitator: dropping the turn (${why})`)
        stopSpeaking(`facilitator: ${why}`)
        setState('listening')
      }
    },
    [logClient, stopSpeaking],
  )

  const handleUserUtterance = useCallback(
    (transcript: string) => {
      const config = gateConfigRef.current
      if (!config) return

      // "Leave the call" and "stop listening" are obeyed even while muted or notes-only.
      // Both must be addressed to the agent by its wake word.
      if (isLeaveCommand(transcript, config.wakeWord, config.wakeAliases)) {
        logClient('warn', 'leave command received: asking the server to leave the call')
        stopSpeaking('leave command from user')
        authedFetch(`/api/meetings/${meetingId}/leave-request`, { method: 'POST' }).catch((err) =>
          console.error('[agent-frame] leave request failed:', err),
        )
        return
      }
      const setListening = (paused: boolean) => {
        listeningPausedRef.current = paused
        listeningChangedAtRef.current = Date.now()
        authedFetch(`/api/meetings/${meetingId}/listening`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused }),
        }).catch((err) => console.error('[agent-frame] listening update failed:', err))
      }
      if (isStopListeningCommand(transcript, config.wakeWord, config.wakeAliases)) {
        logClient('warn', 'stop listening command received: transcript paused, going dormant')
        stopSpeaking('stop listening command from user')
        dormantRef.current = true
        gateStateRef.current = { engagedUntil: 0 }
        pendingFragmentRef.current = null
        setListening(true)
        setState('idle')
        setLastReason('dormant: stop listening')
        return
      }
      // The wake word again ends the pause; the utterance then flows on as usual.
      if (listeningPausedRef.current && isAddressedToAgent(transcript, config.wakeWord, config.wakeAliases)) {
        logClient('info', 'wake word heard: listening resumed')
        setListening(false)
      }

      // A notes-only meeting (an outside guest is present): listen, never answer.
      if (mutedRef.current || notesOnlyRef.current) return

      // Stop-command check (Fix B): detect "be quiet" / "stand down" / etc.
      // Must run BEFORE the wake gate so it fires even if the engagement window
      // is open (someone asking a question immediately after saying "enough").
      //
      // Context-gated gratitude: "ok thanks" / "got it thanks" ONLY count as a
      // stop when the agent plausibly owns the turn (speaking now, or spoke
      // recently). The 2026-07-08 meeting had the bot mishear Kai's "OK, thanks a
      // million" to David as a stop-and-go-quiet — the context guard prevents
      // that. agentSpokeAt is threaded by markAgentSpoke; fall back to the last
      // spoken window's endedAt when the gate hasn't recorded it yet.
      const now = Date.now()
      const agentSpokeAt = gateStateRef.current.agentSpokeAt ?? (lastSpokenRef.current.endedAt || null)
      const msSinceAgentSpoke = agentSpokeAt !== null ? now - agentSpokeAt : null
      if (
        isStopCommand(transcript, config.wakeWord, config.wakeAliases, {
          agentSpeaking: isSpeakingRef.current,
          msSinceAgentSpoke,
        })
      ) {
        logClient('warn', `stop command received ("${transcript.slice(0, 80)}") — going dormant silently`)
        // Cancel/flush whatever it was saying, then go dormant. No spoken
        // acknowledgment — the removed "Understood, I'll stay quiet" reply is
        // exactly what the 2026-07-08 mis-hearing turned into an unwanted
        // interjection. Dormant state is reflected only on the tile/status.
        stopSpeaking('stop command from user')
        dormantRef.current = true
        // Close the engagement window so a follow-up doesn't re-activate.
        gateStateRef.current = { engagedUntil: 0 }
        pendingFragmentRef.current = null
        setState('idle')
        setLastReason('dormant: stop command')
        return
      }

      // Record this user turn for context-aware query building (buildSearchQuery
      // harvests salient terms from recent NON-agent turns). Kept even while
      // dormant — the room context is still useful for the next real activation.
      recentTurnsRef.current.push({ speaker: 'user', text: transcript, isAgent: false })
      // Someone spoke: the facilitator's silence count starts over.
      lastHumanSpokeAtRef.current = now
      coachNudgesRef.current = 0
      if (recentTurnsRef.current.length > RECENT_TURNS_MAX) {
        recentTurnsRef.current = recentTurnsRef.current.slice(-RECENT_TURNS_MAX)
      }

      // R1a speculative prefetch: as the live transcription accumulates, debounce
      // and fire a prefetch against the SAME buildSearchQuery path so a later
      // activation can serve from cache. Only when not dormant (a dormant bot
      // won't answer, so prefetching is wasted). The debounce collapses a burst
      // of VAD-split fragments into one prefetch on the latest text.
      if (!dormantRef.current && !researcherRef.current) {
        prefetchAccumRef.current = transcript
        if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
        prefetchTimerRef.current = setTimeout(() => {
          prefetchTimerRef.current = null
          runSpeculativeSearch(prefetchAccumRef.current)
        }, PREFETCH_DEBOUNCE_MS)
      }

      // The service already woke this page for this same call by name: do not answer twice.
      if (Date.now() - serverWakeAtRef.current < 8000 && isAddressedToAgent(transcript, config.wakeWord, config.wakeAliases ?? [])) {
        logClient('info', 'wake: already answered from the meeting transcript; skipping the page copy')
        return
      }
      // Dormant mode: ALL utterances are suppressed until the wake word is
      // spoken explicitly. The wake word itself clears dormant and activates.
      if (dormantRef.current) {
        // Re-arm from dormant only on a genuine ADDRESS (vocative), not a passing
        // mention of the name — same coworker rule as activation.
        const hasWake = isAddressedToAgent(transcript, config.wakeWord, config.wakeAliases ?? [])
        if (hasWake) {
          logClient('info', `wake word heard while dormant — re-arming ("${transcript.slice(0, 80)}")`)
          dormantRef.current = false
          // Fall through to normal gate evaluation below.
        } else {
          // While listening is paused nothing that is said may be stored, the client log included.
          logClient('info', listeningPausedRef.current ? 'listening paused: utterance not kept' : `dormant — suppressing utterance ("${transcript.slice(0, 240)}")`)
          setLastReason('dormant: waiting for wake word')
          return
        }
      }

      const spkState = speakerStateRef.current
      const currentSpeaker =
        spkState.activeSpeakers.length === 1
          ? spkState.activeSpeakers[0]
          : (spkState.lastSpeaker ?? undefined)
      config.overlappingSpeech = spkState.overlappingSpeech

      const decision = evaluateWakeGateStitched(
        gateStateRef.current,
        transcript,
        config,
        pendingFragmentRef.current,
        currentSpeaker,
        now,
      )
      gateStateRef.current = decision.state
      setLastReason(decision.reason)
      logClient(
        'info',
        `gate ${decision.activate ? 'OPEN' : 'closed'} (speaker=${currentSpeaker ?? 'unknown'}, overlap=${Boolean(config.overlappingSpeech)}, "${transcript.slice(0, 80)}") — ${decision.reason}`,
      )
      if (!decision.activate && facilitatorRef.current) coachDiscard('nothing was said')
      if (decision.activate && facilitatorRef.current) {
        // The facilitator hears every turn, so a murmur while it is speaking must not cut
        // it off. Only its name does that.
        pendingFragmentRef.current = null
        // A person spoke, so the session is under way even if the opening never ran.
        coachOpenedRef.current = true
        // The usual case: the turn already started when the speech ended, before this text arrived.
        if (speechStoppedAtRef.current > 0 && coachTurnAtRef.current >= speechStoppedAtRef.current) return
        if (isAddressedToAgent(transcript, config.wakeWord, config.wakeAliases ?? []) && (activeResponseRef.current || isSpeakingRef.current)) {
          stopSpeaking('facilitator: called by name while speaking')
        }
        // No turn yet (a very short sound, or it was speaking): take one now, unless one is already waiting.
        if (!coachPendingRef.current) coachSettle(currentSpeaker, 100)
        return
      }
      if (decision.activate) {
        // Addressed barge-in: a genuine new question (wake word or engaged
        // follow-up) while the agent is mid-answer stops playback promptly —
        // this is the ONLY speech path allowed to interrupt now that bare VAD
        // onsets hold the floor (noisy-room guard in speech_started).
        if (activeResponseRef.current || isSpeakingRef.current) {
          stopSpeaking('addressed barge-in: new question while speaking')
        }
        pendingFragmentRef.current = null
        if (brainRef.current === 'external') {
          // An outside agent answers (SOUL brain: external). The server sends the request
          // back as an `ask` command if nobody answers in time. If the hand-over itself
          // fails, the built-in agent answers now.
          const question = decision.effectiveUtterance
          authedFetch(`/api/meetings/${meetingId}/requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: question.slice(0, 1000), from: speakerStateRef.current.lastSpeaker ?? '' }),
          })
            .then((res) => {
              if (!res.ok) void activateResponse(question)
            })
            .catch(() => void activateResponse(question))
        } else {
          void activateResponse(decision.effectiveUtterance)
        }
      } else {
        // Keep the stitched text so a 3-fragment sentence accumulates (tail-capped
        // so continuous room chatter can't grow it unboundedly).
        pendingFragmentRef.current = {
          text: decision.effectiveUtterance.slice(-300),
          at: Date.now(),
          speaker: currentSpeaker,
        }
      }
    },
    [activateResponse, coachSettle, coachDiscard, logClient, stopSpeaking, runSpeculativeSearch],
  )

  const handleServerEvent = useCallback(
    (raw: MessageEvent) => {
      let event: Record<string, unknown>
      try {
        event = JSON.parse(String(raw.data))
      } catch {
        return
      }
      const type = String(event.type ?? '')

      switch (type) {
        case 'conversation.item.input_audio_transcription.delta': {
          // Streaming partial transcript. In a noisy multi-party room the
          // segment never closes on silence, so we watch the accumulating
          // partial and, once it is clearly an ADDRESSED complete question,
          // force-commit the input buffer to end the turn immediately rather
          // than waiting for VAD. Guarded: only when enabled, not dormant, not
          // already responding (barge-in owns that), and once per turn.
          const chunk = String(event.delta ?? '')
          if (!chunk) break
          partialTranscriptRef.current = (partialTranscriptRef.current + chunk).slice(-600)
          if (
            !wakeCommitEnabledRef.current ||
            dormantRef.current ||
            activeResponseRef.current ||
            manualCommitPendingRef.current
          ) {
            break
          }
          const cfg = gateConfigRef.current
          if (!cfg) break
          if (shouldCommitOnPartial(partialTranscriptRef.current, cfg.wakeWord, cfg.wakeAliases ?? [])) {
            if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
            const commitGen = transportGenerationRef.current
            commitTimerRef.current = setTimeout(() => {
              commitTimerRef.current = null
              // Re-check guards at fire time — the room may have changed, or the
              // socket may have been swapped by a reconnect.
              if (
                manualCommitPendingRef.current ||
                activeResponseRef.current ||
                dormantRef.current ||
                transportGenerationRef.current !== commitGen ||
                wsRef.current?.readyState !== WebSocket.OPEN
              ) {
                return
              }
              manualCommitPendingRef.current = true
              logClient('info', `wake-commit: forcing turn on addressed question: "${partialTranscriptRef.current.slice(0, 80)}"`)
              // Force segment closure -> transcription.completed -> wake gate ->
              // retrieval -> response.create (the existing path). server_vad
              // stays as backup; the committed turn is the one we answer, and
              // the duplicate guard below drops any trailing VAD completion.
              sendEvent({ type: 'input_audio_buffer.commit' })
            }, WAKE_COMMIT_DEBOUNCE_MS)
          }
          break
        }
        case 'conversation.item.input_audio_transcription.completed': {
          // New user turn resolved: reset the partial accumulator + commit guard
          // so the next question is judged fresh.
          partialTranscriptRef.current = ''
          manualCommitPendingRef.current = false
          if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current)
            commitTimerRef.current = null
          }
          const transcript = String(event.transcript ?? '')
          if (isPromptEcho(transcript, sttPromptRef.current)) {
            logClient('info', `prompt echo dropped: "${transcript.slice(0, 60)}"`)
            coachDiscard('the sound was not speech')
            break
          }
          if (!transcript.trim()) coachDiscard('nothing was said')
          if (transcript.trim()) {
            // L1: drop the agent's own delayed echo before the wake gate. Log
            // the overlap ratio on every transcript (instrumentation) so we can
            // confirm whether echo is happening and tune the threshold.
            const now = Date.now()
            const ratio = tokenSetRatio(transcript, lastSpokenRef.current.text)
            if (isSelfEcho(transcript, lastSpokenRef.current, now)) {
              logClient(
                'info',
                `self-echo dropped (ratio=${ratio.toFixed(2)}, +${now - lastSpokenRef.current.endedAt}ms): "${transcript.slice(0, 60)}"`,
              )
              coachDiscard('it heard its own voice')
              break
            }
            if (ratio >= 0.4) {
              logClient('info', `near-echo passed (ratio=${ratio.toFixed(2)}): "${transcript.slice(0, 60)}"`)
            }
            handleUserUtterance(transcript)
          }
          break
        }
        case 'conversation.item.input_audio_transcription.failed': {
          logClient('error', `transcription failed: ${JSON.stringify(event).slice(0, 300)}`)
          break
        }
        case 'response.output_audio.delta':
        case 'response.audio.delta': {
          // L0: capture the assistant item_id so we can address truncate on
          // barge-in. Sourced from the audio delta (response.created has no
          // top-level item_id). Logged once to confirm Azure GA WS emits it.
          if (!activeItemIdRef.current && event.item_id) {
            activeItemIdRef.current = String(event.item_id)
            logClient('info', `response item_id=${activeItemIdRef.current}`)
          }
          // First chunk of a response: mark speaking and start the runaway
          // governor. Mic stays open (full-duplex); no echo gating needed.
          if (!isSpeakingRef.current) {
            isSpeakingRef.current = true
            setState('speaking')
            // Open the follow-up engagement window NOW, not only at response.done.
            // Anchoring it to speech-start makes wake-word-free follow-ups land
            // reliably even when response.done is delayed or races the follow-up's
            // transcription (the live miss: "what is the telephony" / "when was the
            // last compliance meeting" were gate-closed seconds after Jarvis spoke).
            // It is refreshed again at response.done.
            const cfg = gateConfigRef.current
            if (cfg) {
              gateStateRef.current = markAgentSpoke(
                cfg,
                Date.now(),
                gateStateRef.current.engagedSpeaker,
              )
            }
            if (!speechGovernorRef.current) {
              speechGovernorRef.current = setTimeout(
                () => stopSpeaking(`continuous speech exceeded ${MAX_SPEECH_MS / 1000}s`),
                MAX_SPEECH_MS,
              )
            }
          }
          const delta = String(event.delta ?? '')
          if (delta) {
            try {
              const wirePcm = base64ToInt16(delta)
              speechMetricsRef.current = computePcm16SpeechMetrics(wirePcm)
              const trackId = responseTrackIdRef.current
              const play = () => {
                // Caption pacing: when this response's audio starts playing (after any
                // audio still queued ahead of it) and how much of it has arrived.
                const chunkSec = wirePcm.length / WIRE_SAMPLE_RATE
                const nowMs = Date.now()
                if (captionAudioRef.current.receivedSec === 0) {
                  captionAudioRef.current.startsAt = Math.max(nowMs, playoutEndsAtRef.current)
                }
                captionAudioRef.current.receivedSec += chunkSec
                playoutEndsAtRef.current = Math.max(nowMs, playoutEndsAtRef.current) + chunkSec * 1000
                const devicePcm = resamplePcm16(wirePcm, WIRE_SAMPLE_RATE, deviceRateRef.current)
                playerRef.current?.add16BitPCM(devicePcm, trackId)
                // While the face carries the voice, the page's player keeps running (it
                // times the captions, the end of speech and interruptions) but is silent.
                routePlayer(responseUsesFaceRef.current === true && faceStateRef.current.audioFromFace)
              }
              // One answer is played one way from start to finish. A face that comes up
              // mid-answer starts with the next answer, or the voice would jump by syncMs.
              if (responseUsesFaceRef.current === null) responseUsesFaceRef.current = faceRef.current !== null
              const face = responseUsesFaceRef.current ? faceRef.current : null
              if (face) {
                // The face gets the audio now and shows it about syncMs later, so the
                // page's own playout waits that long: the voice and the lips line up.
                face.pushAudio(wirePcm)
                faceStateRef.current.lastUsedAt = Date.now()
                if (faceStateRef.current.audioFromFace || onsetRef.current.released) {
                  // The face carries the voice, or its lips are already moving on this
                  // answer: this chunk simply joins the queue.
                  play()
                } else if (faceLevelRef.current) {
                  // Hold the audio until the face itself starts speaking it, then start
                  // the page's playout at that moment. Both then play the same audio from
                  // the same instant, so the voice and the lips line up.
                  heldAudioRef.current.push(play)
                  watchForFaceOnset()
                } else {
                  // No audio track to listen to: fall back to a fixed delay.
                  const timer = setTimeout(() => {
                    pendingAudioTimersRef.current.delete(timer)
                    play()
                  }, faceStateRef.current.syncMs)
                  pendingAudioTimersRef.current.add(timer)
                }
              } else {
                play()
              }
            } catch (err) {
              logClient('warn', `pcm enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          break
        }
        case 'response.output_text.delta':
        case 'response.text.delta': {
          // A text-only response (a written reply for the meeting chat): collect it, show no caption.
          responseTextRef.current += String(event.delta ?? '')
          break
        }
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta': {
          spokenAudioRef.current += String(event.delta ?? '')
          // The caption is revealed by the pacing timer, in step with the voice.
          responseTextRef.current += String(event.delta ?? '')
          break
        }
        case 'input_audio_buffer.speech_started': {
          humanSpeakingRef.current = true
          speechStartedAtRef.current = Date.now()
          // Speech again before the turn started: the person had not finished.
          if (coachPendingRef.current) {
            clearTimeout(coachPendingRef.current.timer)
            coachPendingRef.current = null
          }
          // Normal turn onset (server_vad fires on EVERY speech start, incl.
          // room/background noise). Noisy-room guard: while the agent owns the
          // floor (response in flight or audio still playing/draining), a bare
          // VAD onset must NOT cancel or flush — that was the live failure
          // (noise cutting Jarvis off mid-answer). Barge-in is decided at the
          // TRANSCRIPTION level instead: isStopCommand goes dormant via
          // stopSpeaking, and an addressed/engaged gate activation interrupts
          // in handleUserUtterance before answering. interrupt_response is
          // false server-side (realtime-session.ts), so the server no longer
          // auto-cancels either.
          if (
            shouldHoldFloorOnSpeechStarted({
              responseActive: activeResponseRef.current,
              audioPlaying: isSpeakingRef.current,
            })
          ) {
            // L1: keep the echo window current with what has been spoken SO FAR
            // so a delayed echo of the in-progress answer is still rejected
            // (the old cancel block captured this as a side effect).
            if (responseTextRef.current) {
              lastSpokenRef.current = { text: responseTextRef.current, endedAt: Date.now() }
            }
            // One person in the call: nobody else can be making that sound, so talking
            // over the answer for a moment stops it. A short noise (a cough, a blip of
            // echo) ends before the timer does and changes nothing. With more people in
            // the room the floor is held, as before.
            const gate = gateConfigRef.current
            if (gate && isSolo(gate) && !bargeInTimerRef.current) {
              bargeInTimerRef.current = setTimeout(() => {
                bargeInTimerRef.current = null
                if (activeResponseRef.current || isSpeakingRef.current) {
                  stopSpeaking('barge-in: the one person in the call spoke over the answer')
                  setState('listening')
                }
              }, SOLO_BARGE_IN_MS)
              logClient('info', 'speech during agent turn — one person in the call; stopping if it continues')
              break
            }
            logClient('info', 'speech during agent turn — holding floor; barge-in defers to transcription')
            break
          }
          // Idle: flush any stale playout remnants (no-ops when nothing
          // played) and reflect that someone is talking.
          void flushAndTruncate()
          setState('listening')
          break
        }
        case 'input_audio_buffer.speech_stopped': {
          humanSpeakingRef.current = false
          {
            const now = Date.now()
            const spokenMs = now - speechStartedAtRef.current
            speechStoppedAtRef.current = now
            // A very short sound is more often noise than a word: wait for its transcript.
            if (facilitatorRef.current && spokenMs < FACILITATOR_MIN_SPEECH_MS) {
              logClient('info', `facilitator: short sound (${spokenMs} ms), waiting for its transcript`)
            }
            if (facilitatorRef.current && !dormantRef.current && !mutedRef.current && !notesOnlyRef.current && spokenMs >= FACILITATOR_MIN_SPEECH_MS) {
              const spk = speakerStateRef.current
              coachSettle(spk.activeSpeakers.length === 1 ? spk.activeSpeakers[0] : (spk.lastSpeaker ?? undefined))
            }
          }
          // The person stopped before the barge-in timer ran out: it was a short sound.
          if (bargeInTimerRef.current) {
            clearTimeout(bargeInTimerRef.current)
            bargeInTimerRef.current = null
          }
          break
        }
        case 'response.created': {
          activeResponseRef.current = true
          responseTextRef.current = ''
          spokenAudioRef.current = ''
          captionAudioRef.current = { receivedSec: 0, startsAt: 0 }
          responseUsesFaceRef.current = null
          onsetRef.current.released = false
          // Responses are created in the order we asked for them, so the next
          // created one belongs to a queued owner `say` while any are pending.
          currentResponseFromCommandRef.current = pendingCommandResponsesRef.current > 0
          if (currentResponseFromCommandRef.current) pendingCommandResponsesRef.current -= 1
          // Fresh track id for this response so a prior interrupt's poisoned id
          // can't drop this response's audio (wavtools interruptedTrackIds).
          responseTrackSeqRef.current += 1
          responseTrackIdRef.current = `${RESPONSE_TRACK_ID}-${responseTrackSeqRef.current}`
          setCaption('')
          break
        }
        case 'response.function_call_arguments.done': {
          const name = String(event.name ?? '')
          const callId = String(event.call_id ?? '')
          const argsJson = String(event.arguments ?? '{}')
          void handleFunctionCall(name, callId, argsJson)
          break
        }
        case 'response.done': {
          activeResponseRef.current = false
          // A queued line (an owner `say`, a Buzz read-back): tell the service what was
          // actually said, from the transcript of the audio. A Buzz send depends on it.
          // Only the transcript of the audio counts: text the model wrote but did not speak
          // is not something David heard.
          const spokenAloud = spokenAudioRef.current.trim()
          spokenAudioRef.current = ''
          if (currentResponseFromCommandRef.current && spokenAloud) {
            authedFetch('/api/voice/spoken', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: spokenAloud, meetingId, personaMode: personaModeRef.current }),
            }).catch(() => {})
          }
          faceRef.current?.endUtterance()
          // Learn the speaking rate from this answer; the next captions use it. With a
          // face, audio is still held back here, so the count would be short: skip it.
          if (pendingAudioTimersRef.current.size === 0 && heldAudioRef.current.length === 0) {
            captionRateRef.current = speakingRate(
              responseTextRef.current.length,
              captionAudioRef.current.receivedSec,
              captionRateRef.current,
            )
          }
          activeItemIdRef.current = null // L0: clear item id for the next turn
          const config = gateConfigRef.current
          const writtenReply =
            !currentResponseFromCommandRef.current &&
            (Date.now() < chatReplyUntilRef.current || replyModeRef.current === 'chat')
          if (writtenReply) {
            // Nothing was spoken. A response that only called a tool has no text yet: the
            // window stays open for the follow-up response that carries the answer.
            const reply = responseTextRef.current.trim()
            const status = (event.response as { status?: unknown } | undefined)?.status
            if (status !== undefined && status !== 'completed') {
              // Cancelled, failed or cut short: post nothing (a partial answer would
              // mislead) and stop treating later responses as written replies.
              chatReplyUntilRef.current = 0
            } else if (reply) {
              chatReplyUntilRef.current = 0
              authedFetch(`/api/meetings/${meetingId}/chat-reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: reply.slice(0, 4000) }),
              }).catch((err) => console.error('[agent-frame] chat reply failed:', err))
              recentTurnsRef.current.push({ speaker: agentNameRef.current, text: reply, isAgent: true })
              if (recentTurnsRef.current.length > RECENT_TURNS_MAX) {
                recentTurnsRef.current = recentTurnsRef.current.slice(-RECENT_TURNS_MAX)
              }
            }
          } else if (responseTextRef.current.trim()) {
            // An owner `say` was already persisted when the command ran.
            if (!currentResponseFromCommandRef.current) persistUtterance(responseTextRef.current.trim())
            if (config) {
              gateStateRef.current = markAgentSpoke(
                config,
                Date.now(),
                gateStateRef.current.engagedSpeaker,
              )
            }
            // L1: capture the just-spoken text so its delayed echo is rejected.
            lastSpokenRef.current = { text: responseTextRef.current, endedAt: Date.now() }
            // Record the agent turn (isAgent:true) so buildSearchQuery excludes
            // the bot's own words from context-term harvesting on the next turn.
            recentTurnsRef.current.push({
              speaker: agentNameRef.current,
              text: responseTextRef.current.trim(),
              isAgent: true,
            })
            if (recentTurnsRef.current.length > RECENT_TURNS_MAX) {
              recentTurnsRef.current = recentTurnsRef.current.slice(-RECENT_TURNS_MAX)
            }
          }
          responseTextRef.current = ''
          spokenAudioRef.current = ''
          currentResponseFromCommandRef.current = false
          // If nothing is playing out, answer the next typed request that was waiting.
          // While audio drains, drainThenResume does this when the speech ends.
          drainPendingAsk()
          // Audio is still draining from the player; settle back to idle once
          // playout finishes (drainThenResume polls the player buffer).
          if (isSpeakingRef.current) {
            drainThenResume()
          } else {
            setState('idle')
          }
          break
        }
        case 'error': {
          const code = (event.error as Record<string, unknown> | undefined)?.code ?? event.code
          if (code === 'response_cancel_not_active') {
            logClient('info', `benign cancel race: ${JSON.stringify(event).slice(0, 200)}`)
          } else if (code === 'input_audio_buffer_commit_empty') {
            // Manual wake-commit raced a server_vad auto-commit (buffer already
            // flushed). Harmless — the auto-committed turn still flows through.
            manualCommitPendingRef.current = false
            logClient('info', 'benign commit race: buffer already committed by VAD')
          } else {
            logClient('error', `realtime event: ${JSON.stringify(event).slice(0, 300)}`)
            if (Date.now() < chatReplyUntilRef.current) {
              // The API refused something while a written reply was pending. Give up on
              // that reply so the next spoken answer is spoken and later requests run.
              chatReplyUntilRef.current = 0
              activeResponseRef.current = false
              drainPendingAsk()
            }
          }
          break
        }
        default: {
          // Log each unseen event type once — catches renamed/unexpected server
          // events without flooding the telemetry channel.
          if (!seenEventTypesRef.current.has(type)) {
            seenEventTypesRef.current.add(type)
            logClient('info', `event type seen: ${type}`)
          }
          break
        }
      }
    },
    [handleFunctionCall, handleUserUtterance, coachSettle, coachDiscard, persistUtterance, sendEvent, logClient, drainThenResume, stopSpeaking, flushAndTruncate],
  )

  /**
   * Wait for the face to start speaking the audio it was just sent, then start the held
   * playout. Releases anyway after 2.5 s so a silent face can never mute the agent.
   */
  const watchForFaceOnset = useCallback(() => {
    if (onsetRef.current.watch) return
    const sentAt = Date.now()
    const release = (why: string) => {
      if (onsetRef.current.watch) clearInterval(onsetRef.current.watch)
      onsetRef.current = { released: true, watch: null }
      const held = heldAudioRef.current
      heldAudioRef.current = []
      for (const play of held) play()
      logClient('info', `face: voice started with the lips, ${Date.now() - sentAt} ms after the audio was sent (${why})`)
    }
    onsetRef.current.watch = setInterval(() => {
      const level = faceLevelRef.current?.read() ?? 0
      if (level > 0.012) release('face audio heard')
      else if (Date.now() - sentAt > 2500) release('no face audio in 2.5 s')
    }, 15)
  }, [logClient])

  /**
   * Send the page's player to the speakers, or to a silent path. The player's worklet
   * node is replaced whenever playout restarts, so the route is applied per node.
   */
  const routePlayer = useCallback((muted: boolean) => {
    const player = playerRef.current as unknown as { stream: AudioNode | null; context: AudioContext | null } | null
    const node = player?.stream ?? null
    const context = player?.context ?? null
    if (!node || !context) return
    const state = playerMutedRef.current
    if (state.node === node && state.muted === muted) return
    // A new node starts connected to the speakers.
    const wasMuted = state.node === node ? state.muted : false
    if (wasMuted === muted) {
      playerMutedRef.current = { node, muted }
      return
    }
    try {
      if (muted) {
        if (!silentGainRef.current || silentGainRef.current.context !== context) {
          const gain = context.createGain()
          gain.gain.value = 0
          gain.connect(context.destination)
          silentGainRef.current = gain
        }
        node.disconnect(context.destination)
        node.connect(silentGainRef.current)
      } else {
        if (silentGainRef.current) node.disconnect(silentGainRef.current)
        node.connect(context.destination)
      }
      playerMutedRef.current = { node, muted }
    } catch (err) {
      logClient('warn', `face: could not ${muted ? 'silence' : 'restore'} the page player (${err instanceof Error ? err.message : String(err)})`)
    }
  }, [logClient])

  /**
   * Start the Anam face if this meeting uses it and none is streaming. Called when the
   * agent is about to answer, so a silent meeting opens no session: Anam bills for every
   * minute a session is open. Failure leaves the drawn avatar and normal audio in place.
   */
  const ensureFace = useCallback(() => {
    const st = faceStateRef.current
    if (avatarProviderRef.current !== 'anam' || faceRef.current || st.starting || Date.now() < st.retryAfter) return
    st.starting = true
    const startedAt = Date.now()
    void (async () => {
      try {
        const res = await authedFetch(`/api/meetings/${encodeURIComponent(meetingId)}/avatar-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'anam' }),
        })
        const grant = (await res.json().catch(() => null)) as {
          transport?: string
          audioSyncOffsetMs?: number
          maxSeconds?: number
          fallbackReason?: string
          credentials?: { sessionToken?: string }
        } | null
        const token = grant?.credentials?.sessionToken
        if (!res.ok || grant?.transport !== 'anam-webrtc' || !token) {
          throw new Error(grant?.fallbackReason ?? `avatar-session HTTP ${res.status}`)
        }
        const face = await startAnamFace(token)
        const video = document.getElementById(ANAM_VIDEO_ID) as HTMLVideoElement | null
        // Voice from the face's own stream keeps the lips and the sound together. If the
        // browser will not play it with sound, the page's player stays the voice.
        let audioFromFace = (grant as { audioFrom?: string }).audioFrom !== 'page'
        if (video) {
          video.muted = !audioFromFace
          if (audioFromFace) {
            try {
              await video.play()
            } catch (err) {
              audioFromFace = false
              video.muted = true
              logClient('warn', `face: video would not play with sound (${err instanceof Error ? err.message : String(err)}); the page plays the voice`)
            }
          }
        } else {
          audioFromFace = false
        }
        // Listen to the face's own audio (never played here) to know when its lips start.
        const faceStream = video?.srcObject instanceof MediaStream ? video.srcObject : null
        if (!audioFromFace && faceStream && faceStream.getAudioTracks().length > 0) {
          try {
            const context = new AudioContext()
            const analyser = context.createAnalyser()
            analyser.fftSize = 512
            context.createMediaStreamSource(faceStream).connect(analyser)
            const samples = new Float32Array(analyser.fftSize)
            faceLevelRef.current = {
              read: () => {
                analyser.getFloatTimeDomainData(samples)
                let sum = 0
                for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!
                return Math.sqrt(sum / samples.length)
              },
              close: () => void context.close().catch(() => undefined),
            }
          } catch (err) {
            logClient('warn', `face: cannot listen to the face audio (${err instanceof Error ? err.message : String(err)}); using a fixed delay`)
          }
        }
        faceRef.current = face
        faceStateRef.current = {
          starting: false,
          startedAt: Date.now(),
          maxMs: (grant.maxSeconds ?? 600) * 1000,
          syncMs: typeof grant.audioSyncOffsetMs === 'number' ? grant.audioSyncOffsetMs : 900,
          lastUsedAt: Date.now(),
          retryAfter: 0,
          audioFromFace,
        }
        setFaceReady(true)
        setFaceIdle(false)
        setFaceFailed(false)
        logClient('info', `face: anam video streaming after ${Date.now() - startedAt} ms (voice from ${audioFromFace ? 'the face stream' : faceLevelRef.current ? 'the page, started with the lips' : `the page, delayed ${faceStateRef.current.syncMs} ms`})`)
      } catch (err) {
        // Do not retry on every question: wait two minutes.
        faceStateRef.current = { ...faceStateRef.current, starting: false, retryAfter: Date.now() + 120_000, audioFromFace: false }
        setFaceFailed(true)
        logClient('warn', `face: anam did not start (${err instanceof Error ? err.message : String(err)}); keeping the drawn avatar`)
      }
    })()
  }, [meetingId, logClient])

  useEffect(() => {
    const timer = setInterval(() => {
      setQuiet((was) => {
        if (dormantRef.current && !was) dormantSinceRef.current = Date.now()
        return dormantRef.current
      })
    }, 500)
    return () => clearInterval(timer)
  }, [])

  // Close the face when its session is about to expire or it has not spoken for ten minutes.
  useEffect(() => {
    const timer = setInterval(() => {
      const face = faceRef.current
      if (!face || isSpeakingRef.current || pendingAudioTimersRef.current.size > 0 || heldAudioRef.current.length > 0) return
      const st = faceStateRef.current
      const now = Date.now()
      const expiring = now - st.startedAt > st.maxMs - 15_000
      const idle = now - st.lastUsedAt > 600_000
      if (!expiring && !idle) return
      if (!expiring) {
        // Keep the last frame: an idle agent shows a still face, never the loading card.
        try {
          const video = document.getElementById(ANAM_VIDEO_ID) as HTMLVideoElement | null
          if (video && video.videoWidth > 0) {
            const side = Math.min(video.videoWidth, video.videoHeight)
            const canvas = document.createElement('canvas')
            canvas.width = 420
            canvas.height = 420
            canvas.getContext('2d')?.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 420, 420)
            setFaceStill(canvas.toDataURL('image/jpeg', 0.85))
          }
        } catch {
          setFaceStill(null)
        }
        setFaceIdle(true)
      }
      faceRef.current = null
      setFaceReady(false)
      faceLevelRef.current?.close()
      faceLevelRef.current = null
      void face.stop()
      logClient('info', `face: anam closed (${expiring ? 'session limit' : 'idle 10 min'})`)
      // At the session limit a new face is opened at once; after a long silence the next
      // question opens it.
      if (expiring) ensureFace()
    }, 5000)
    return () => clearInterval(timer)
  }, [logClient, ensureFace])

  // Reveal the caption in step with the voice (src/agent/caption-pace.ts).
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isSpeakingRef.current) return
      const audio = captionAudioRef.current
      const playedSec = audio.startsAt > 0 ? (Date.now() - audio.startsAt) / 1000 : 0
      setCaption(pacedCaption(responseTextRef.current, playedSec, captionRateRef.current))
    }, 120)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    let ended = false
    let meetingStatus: string | null = 'live'
    let connecting = false
    let audioInitialized = false
    let reconnectAttempt = resetReconnectAttempt()
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let socketOpenWatchdog: ReturnType<typeof createConnectionOpenWatchdog> | undefined
    let refreshTimer: ReturnType<typeof setInterval> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let commandTimer: ReturnType<typeof setInterval> | undefined
    let commandPollInFlight = false

    const canReconnect = () =>
      getReconnectDecision({ ended, cancelled, meetingStatus, attempt: reconnectAttempt }).reconnect

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    }

    const clearSocketOpenWatchdog = () => {
      socketOpenWatchdog?.clear()
      socketOpenWatchdog = undefined
    }

    // Reconnecting starts a fresh realtime conversation. Do not let a response,
    // gate window, caption, or queued playout from the dead socket leak into it.
    const resetRecoverableSessionState = () => {
      transportGenerationRef.current += 1
      activeResponseRef.current = false
      activeItemIdRef.current = null
      responseTextRef.current = ''
      spokenAudioRef.current = ''
      pendingCommandResponsesRef.current = 0
      currentResponseFromCommandRef.current = false
      chatReplyUntilRef.current = 0
      pendingAsksRef.current = []
      isSpeakingRef.current = false
      gateStateRef.current = { engagedUntil: 0 }
      pendingFragmentRef.current = null
      lastSpokenRef.current = { text: '', endedAt: 0 }
      prefetchAccumRef.current = ''
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current)
        prefetchTimerRef.current = null
      }
      if (speechGovernorRef.current) {
        clearTimeout(speechGovernorRef.current)
        speechGovernorRef.current = null
      }
      setCurrentQuestion('')
      setCaption('')
      setLanes(null)
      void playerRef.current?.interrupt().catch(() => {})
    }

    const configureSession = (config: SessionConfig) => {
      agentNameRef.current = config.agent.name
      setAgentName(config.agent.name)
      setSubtitle(config.agent.subtitle)
      researcherRef.current = config.agent.knowledgeMode === 'researcher'
      toolRoutesRef.current = selectToolRoutes({
        persona_mode: config.agent.personaMode,
        knowledge_mode: researcherRef.current ? 'researcher' : 'direct',
        delegate_tasks: config.agent.delegateTasks === true,
        buzz_messaging: config.agent.buzzMessaging === true,
      })
      personaModeRef.current = config.agent.personaMode
      replyModeRef.current = config.agent.replyMode === 'chat' ? 'chat' : 'voice'
      notesOnlyRef.current = config.agent.notesOnly === true
      facilitatorRef.current = config.agent.facilitator === true
      standInRef.current = config.agent.standIn === true
      standInOpeningRef.current = typeof config.agent.openingLine === 'string' ? config.agent.openingLine : ''
      // A new voice session knows nothing: tell it who is here again.
      coachRosterKeyRef.current = ''
      humanSpeakingRef.current = false
      retrievalModeRef.current = config.retrievalMode === 'forced' ? 'forced' : 'model'
      sessionToolsRef.current = Array.isArray(config.sessionUpdate?.tools) ? (config.sessionUpdate.tools as unknown[]) : []
      const sttPrompt = (config.sessionUpdate as { audio?: { input?: { transcription?: { prompt?: unknown } } } } | undefined)?.audio?.input?.transcription?.prompt
      sttPromptRef.current = typeof sttPrompt === 'string' ? sttPrompt : ''
      brainRef.current = config.agent.brain === 'external' ? 'external' : 'builtin'
      const sessionAvatar = isValidAvatarProviderId(config.agent.avatarProvider) ? config.agent.avatarProvider : 'google-live-avatar'
      setAvatarProvider(sessionAvatar)
      avatarProviderRef.current = sessionAvatar
      // Open the video face as the page loads, so it is on screen before the first answer.
      ensureFace()
      wakeCommitEnabledRef.current = config.wakeCommit !== false
      setWakeWord(config.agent.wakeWord)
      gateConfigRef.current = {
        wakeWord: config.agent.wakeWord,
        // Aliases derived from the ACTUAL session wake word (no hardcoded name).
        wakeAliases: deriveWakeAliases(config.agent.wakeWord),
        behaviorMode: config.agent.behaviorMode,
        ...(config.agent.facilitator === true ? { facilitator: true } : {}),
        engagementWindowMs: config.engagementWindowMs ?? DEFAULT_ENGAGEMENT_WINDOW_MS,
        // Post-answer correction re-activation window. The gate re-opens on a
        // corrective follow-up ("that's not what I asked") within this window of
        // the agent's last-response completion (markAgentSpoke stamps
        // agentSpokeAt at speech-start and response.done). Set explicitly so the
        // correction path doesn't silently depend on the module default.
        correctionFollowupWindowMs: DEFAULT_CORRECTION_FOLLOWUP_WINDOW_MS,
        // SAFETY DEFAULT: until the first lifecycle poll delivers the LIVE count,
        // assume a multi-party room (require addressing). The whole point of the
        // gate is to stop unwanted interjections, so an unknown count errs toward
        // the anti-barge-in posture rather than treating the room as a 1:1.
        // The poll below replaces this with the registry's authoritative count
        // (registry humans + 1 for the bot) every STATUS_POLL_MS.
        participantCount: MULTIPARTY_SAFETY_DEFAULT,
      }
      logClient('info', `session config: provider=${config.provider}, model=${config.model}, transport=ws`)
    }

    /**
     * Re-read lifecycle immediately around a reconnect, rather than trusting the
     * 15s display poll. This closes the terminal-state race where a completed
     * meeting could otherwise mint a fresh browser socket during the poll gap.
     */
    const refreshMeetingLifecycle = async () => {
      try {
        const response = await authedFetch(`/api/meetings/${meetingId}`)
        if (!response.ok || cancelled) return
        const data = await response.json()
        const meeting = data?.meeting ?? data
        if (typeof meeting?.status === 'string') meetingStatus = meeting.status
        if (isTerminalMeetingStatus(meetingStatus)) {
          ended = true
          clearReconnectTimer()
          setState('ended')
        }
      } catch {
        // A transient lifecycle-read failure must not turn a live meeting into a
        // terminal error; the mint route still enforces live status server-side.
      }
    }

    const seedTranscript = (ws: WebSocket) => {
      // Seed conversation with recent meeting transcript so a page reload or a
      // recovered socket does not lose the room's context. The ownership check
      // prevents a delayed fetch from injecting into a newer socket.
      authedFetch(`/api/meetings/${meetingId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || ended || wsRef.current !== ws) return
          const transcript: TranscriptEntry[] = data?.meeting?.transcript ?? data?.transcript ?? []
          if (Array.isArray(transcript) && transcript.length > 0) {
            const recent = transcript
              .slice(-SEED_TRANSCRIPT_ENTRIES)
              .map((t) => `${t.speaker}: ${t.text}`)
              .join('\n')
            injectSystemText(`Meeting so far (most recent turns):\n${recent}`)
          }
        })
        .catch(() => {})
    }

    const scheduleReconnect = (reason: string) => {
      if (reconnectTimer) return
      const decision = getReconnectDecision({ ended, cancelled, meetingStatus, attempt: reconnectAttempt })
      if (!decision.reconnect || decision.delayMs === null) return

      resetRecoverableSessionState()
      reconnectAttempt = decision.nextAttempt
      setState('reconnecting')
      logClient('warn', `reconnecting in ${decision.delayMs}ms (attempt ${reconnectAttempt}): ${reason}`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        void connect()
      }, decision.delayMs)
    }

    async function initializeAudio(): Promise<void> {
      if (audioInitialized) return

      // AudioWorklet players — loaded dynamically so wavtools never runs at
      // SSR. Both contexts run at the DEVICE's native rate (Recall's capture
      // corrupts non-native-rate contexts — see WIRE_SAMPLE_RATE comment);
      // resamplePcm16 converts to/from the 24kHz wire format.
      const probeCtx = new AudioContext()
      const deviceRate = probeCtx.sampleRate
      await probeCtx.close().catch(() => {})
      deviceRateRef.current = deviceRate
      const { WavRecorder, WavStreamPlayer } = await import('wavtools')
      const player = new WavStreamPlayer({ sampleRate: deviceRate })
      await player.connect()
      playerRef.current = player
      const recorder = new WavRecorder({ sampleRate: deviceRate })
      await recorder.begin()
      if (cancelled || ended) {
        await recorder.end().catch(() => {})
        return
      }
      recorderRef.current = recorder
      // Record exactly once per frame lifetime. sendMicChunk resolves
      // wsRef.current at send time, so the same mic stream follows a recovered
      // socket without duplicate callbacks or AudioWorklet setup.
      recorder.record(sendMicChunk).catch((err) =>
        logClient('error', `recorder.record failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      audioInitialized = true
      logClient('info', `audio worklets ready (player + recorder) at device rate ${deviceRate}Hz, wire ${WIRE_SAMPLE_RATE}Hz`)
    }

    /**
     * Owner-command poll (GET /commands?after=<last seq>, once a second). Advances the
     * cursor past everything returned, runs only what was queued since this page
     * loaded, and applies the registry's mute state from EVERY response so the state
     * is right even after the mute command itself has expired. Stops when the meeting
     * ends.
     */
    const pollCommands = async () => {
      if (ended || cancelled) {
        if (commandTimer) clearInterval(commandTimer)
        commandTimer = undefined
        return
      }
      if (commandPollInFlight) return
      commandPollInFlight = true
      try {
        const res = await authedFetch(
          `/api/meetings/${encodeURIComponent(meetingId)}/commands?after=${commandSeqRef.current}&include_state=1`,
        )
        if (!res.ok) return
        const data = await res.json()
        if (cancelled || ended) return
        const commands: QueuedCommand[] = Array.isArray(data?.commands) ? data.commands : []
        commandSeqRef.current = nextSeq(commands, commandSeqRef.current)
        for (const cmd of selectCommandsToRun(commands, PAGE_LOADED_AT)) runCommand(cmd)
        if (typeof data?.muted === 'boolean') mutedRef.current = data.muted
        // The server holds the "stop listening" state: it changes when someone types the
        // request (or the wake word) in chat, and a reloaded page learns it here.
        if (typeof data?.listeningPaused === 'boolean' && Date.now() - listeningChangedAtRef.current > 3000) {
          if (data.listeningPaused && !listeningPausedRef.current) {
            listeningPausedRef.current = true
            dormantRef.current = true
            gateStateRef.current = { engagedUntil: 0 }
          } else if (!data.listeningPaused && listeningPausedRef.current) {
            listeningPausedRef.current = false
            dormantRef.current = false
          }
        }
        if (data?.speakerState && typeof data.speakerState === 'object') {
          const spk = data.speakerState as {
            activeSpeakers?: string[]
            lastSpeaker?: string | null
            overlappingSpeech?: boolean
          }
          speakerStateRef.current = {
            activeSpeakers: Array.isArray(spk.activeSpeakers) ? spk.activeSpeakers : [],
            lastSpeaker: typeof spk.lastSpeaker === 'string' ? spk.lastSpeaker : null,
            overlappingSpeech: Boolean(spk.overlappingSpeech),
          }
          if (gateConfigRef.current) {
            gateConfigRef.current.overlappingSpeech = speakerStateRef.current.overlappingSpeech
          }
        }
        if (typeof data?.participantCount === 'number' && data.participantCount >= 0 && gateConfigRef.current) {
          gateConfigRef.current.participantCount = data.participantCount + 1
        }
        if (facilitatorRef.current && Array.isArray(data?.participants) && wsRef.current?.readyState === WebSocket.OPEN) {
          const names = (data.participants as unknown[]).filter((n): n is string => typeof n === 'string')
          const key = `n:${[...names].sort().join('|')}`
          if (key !== coachRosterKeyRef.current) {
            coachRosterKeyRef.current = key
            logClient('info', `facilitator: ${names.length} people in the call; told the model`)
            injectSystemText(rosterDirective(names))
          }
        }
        if (typeof data?.participantCount === 'number') {
          if (data.participantCount >= 1) {
            if (coachHumansSinceRef.current === 0) coachHumansSinceRef.current = Date.now()
          } else {
            coachHumansSinceRef.current = 0
          }
        }
        coachTick()
        if (isValidAvatarProviderId(data?.avatarProvider)) {
          setAvatarProvider(data.avatarProvider)
          avatarProviderRef.current = data.avatarProvider
        }
      } catch {
        // Transient failure: the next tick asks again from the same cursor.
      } finally {
        commandPollInFlight = false
      }
    }

    const startLifecycleLoops = () => {
      // Mid-meeting context refresh (plan §5 P3): re-run OB injection and hand
      // the fresh context to whichever socket is current at that instant.
      refreshTimer = setInterval(() => {
        authedFetch(`/api/meetings/${meetingId}/context-refresh`, { method: 'POST' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.contextText) {
              injectSystemText(`Refreshed meeting context (as of ${data.injectedAt}):\n${data.contextText}`)
            }
          })
          .catch(() => {})
      }, CONTEXT_REFRESH_MS)

      commandTimer = setInterval(() => void pollCommands(), COMMAND_POLL_MS)

      // Lifecycle poll: participant count, status, shuts down cleanly when the meeting
      // completes. Mute state is NOT read here: the command poll owns it (a 15 s poll
      // could overwrite a fresher value with a stale one).
      pollTimer = setInterval(() => {
        authedFetch(`/api/meetings/${meetingId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            const meeting = data?.meeting ?? data
            if (!meeting) return
            if (typeof meeting.status === 'string') meetingStatus = meeting.status
            // LIVE participant count: keep the wake gate's participantCount fresh
            // as people join/leave. The registry tracks OTHER humans (the bot is
            // not counted), but the gate's contract is TOTAL participants incl.
            // the bot — so add 1. A 3-human room => registry 3 => gate 4 (multi-
            // party); a true 1:1 => registry 1 => gate 2 (NOT multi-party, so 1:1
            // follow-up responsiveness is preserved). When the field is missing
            // (older server / transient), keep the multi-party safety default
            // rather than dropping to 1:1.
            const cfg = gateConfigRef.current
            if (cfg) {
              const others = meeting.participantCount
              cfg.participantCount = typeof others === 'number' && others >= 0 ? others + 1 : MULTIPARTY_SAFETY_DEFAULT
            }
            // Diagnostic tone: toggle live with
            //   UPDATE meetings SET metadata = jsonb_set(metadata,'{test_tone}','true') WHERE id=...
            const toneOn = meeting.metadata?.test_tone === 'true' || meeting.metadata?.test_tone === true
            if (toneOn && !isSpeakingRef.current && Date.now() > toneUntilRef.current) {
              const toneSecs = 5
              toneUntilRef.current = Date.now() + toneSecs * 1000 + 2000
              try {
                playerRef.current?.add16BitPCM(makeTonePcm(toneSecs, deviceRateRef.current), `tone-${Date.now()}`)
                logClient('info', `tone test: playing ${toneSecs}s 440Hz sine via AudioWorklet @ ${deviceRateRef.current}Hz`)
              } catch (err) {
                logClient('warn', `tone test failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }
            if (isTerminalMeetingStatus(meetingStatus)) {
              ended = true
              clearReconnectTimer()
              setState('ended')
              wsRef.current?.close()
            }
          })
          .catch(() => {})
      }, STATUS_POLL_MS)
    }

    async function connect(): Promise<void> {
      if (connecting || wsRef.current || !canReconnect()) return
      connecting = true
      try {
        await refreshMeetingLifecycle()
        if (!canReconnect()) return

        // SUP-18: signed meeting-scoped session token. authedFetch adds it to every
        // request; readSessionTokenOnce() cached it from the URL on the first call
        // (and scrubbed it), so a reconnect long after still has it.
        if (!readSessionTokenOnce()) throw new Error('missing meeting session token')
        const sessionRes = await authedFetch(`/api/meetings/${meetingId}/realtime-session`, {
          method: 'POST',
        })
        if (!sessionRes.ok) {
          const detail = await sessionRes.json().catch(() => ({}))
          if (detail.code === 'meeting_not_live') {
            meetingStatus = typeof detail.status === 'string' ? detail.status : 'completed'
            ended = true
            clearReconnectTimer()
            setState('ended')
            return
          }
          throw new Error(detail.error ?? `realtime-session ${sessionRes.status}`)
        }
        const config: SessionConfig = await sessionRes.json()
        await refreshMeetingLifecycle()
        if (!canReconnect()) return

        configureSession(config)
        const ws = new WebSocket(config.wsUrl, config.wsProtocols)
        wsRef.current = ws
        const isCurrentSocket = () => wsRef.current === ws
        let socketOpened = false
        let sessionReady = false
        const openWatchdog = createConnectionOpenWatchdog(() => {
          if (!isCurrentSocket() || !canReconnect()) return
          logClient('warn', 'ws open timed out; closing socket so recovery can retry')
          ws.close(4000, 'realtime connection timeout')
        })
        socketOpenWatchdog = openWatchdog

        ws.onopen = async () => {
          socketOpened = true
          if (!isCurrentSocket() || !canReconnect()) {
            ws.close()
            return
          }
          // session.update MUST be the first act on open, before any await:
          // the provider's default session auto-responds (server_vad with
          // create_response:true) and mic audio is already streaming, so any
          // async gap before this send is an ungated auto-response window on
          // every (re)connect.
          try {
            ws.send(JSON.stringify({ type: 'session.update', session: config.sessionUpdate }))
          } catch (err) {
            logClient('error', `session.update failed: ${err instanceof Error ? err.message : String(err)}`)
            ws.close()
            return
          }
          sessionReady = true
          await refreshMeetingLifecycle()
          if (!isCurrentSocket() || !canReconnect()) {
            ws.close()
            return
          }
          if (socketOpenWatchdog === openWatchdog) clearSocketOpenWatchdog()
          reconnectAttempt = resetReconnectAttempt()
          logClient('info', 'ws open — session live')
          // turn_detection stays at full sensitivity for the whole session.
          // SAFE because Recall Output-Media excludes the bot's own audio from
          // the page mic — no self-echo to gate. RE-VALIDATE if the transport
          // ever moves to a WebRTC remote-track / real-device path.
          setState('idle')
          seedTranscript(ws)
        }
        ws.onmessage = (event) => {
          if (!sessionReady || !isCurrentSocket() || !canReconnect()) return
          handleServerEvent(event)
        }
        ws.onerror = () => {
          if (!isCurrentSocket() || !canReconnect()) return
          // Browsers follow an error with close. Scheduling only from close keeps
          // error + close from creating duplicate backoff loops.
          logClient('error', 'ws error; waiting for close before retrying')
        }
        ws.onclose = (e) => {
          if (!isCurrentSocket()) return
          if (socketOpenWatchdog === openWatchdog) clearSocketOpenWatchdog()
          wsRef.current = null
          logClient(e.wasClean ? 'info' : 'error', `ws closed (code=${e.code}${e.reason ? `, ${e.reason.slice(0, 120)}` : ''})`)
          if (canReconnect()) scheduleReconnect(`socket closed (code=${e.code})`)
        }
        if (!socketOpened) openWatchdog.start()
      } catch (err) {
        if (canReconnect()) {
          logClient('error', `realtime session setup failed: ${err instanceof Error ? err.message : String(err)}`)
          scheduleReconnect('session mint or socket setup failed')
        }
      } finally {
        connecting = false
      }
    }

    async function start() {
      try {
        await initializeAudio()
        if (!canReconnect()) return
        startLifecycleLoops()
        await connect()
      } catch (err) {
        logClient('error', `audio startup failed: ${err instanceof Error ? err.message : String(err)}`)
        if (!cancelled) setState('error')
      }
    }

    void start()
    return () => {
      cancelled = true
      transportGenerationRef.current += 1
      clearReconnectTimer()
      clearSocketOpenWatchdog()
      // Allow a clean restart if the effect legitimately re-runs (StrictMode
      // double-mount in dev, or meeting change).
      startedRef.current = false
      if (refreshTimer) clearInterval(refreshTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (commandTimer) clearInterval(commandTimer)
      if (speechGovernorRef.current) {
        clearTimeout(speechGovernorRef.current)
        speechGovernorRef.current = null
      }
      // R1a: drop the pending prefetch and clear the speculative cache on session
      // stop so a later meeting can't serve this meeting's prefetched results.
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current)
        prefetchTimerRef.current = null
      }
      clearSpeculativeCache()
      recorderRef.current?.end().catch(() => {})
      recorderRef.current = null
      void playerRef.current?.interrupt().catch(() => {})
      playerRef.current = null
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [meetingId, handleServerEvent, injectSystemText, logClient, sendMicChunk, runCommand])

  const stateLabel: Record<AgentState, string> = {
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    idle: wakeWord ? `Say “${wakeWord}” to ask me something` : 'Standing by',
    listening: 'Listening…',
    thinking: 'Checking OpenBrain…',
    speaking: 'Speaking',
    error: 'Agent error — check service logs',
    ended: 'Meeting ended',
  }

  // This page IS the bot's camera tile — keep it legible and honest about being
  // an AI (disclosure norm; EU AI Act Art. 50).
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b1220',
        color: '#e2e8f0',
        fontFamily: 'system-ui, sans-serif',
        gap: '12px',
      }}
    >
      {/* The Anam face. Always in the page so the SDK can attach to it; shown once it
          streams. Muted: the page plays the voice itself (see anam-face.ts). */}
      <video
        id={ANAM_VIDEO_ID}
        autoPlay
        playsInline
        muted
        style={{
          display: faceReady ? 'block' : 'none',
          width: 420,
          height: 420,
          objectFit: 'cover',
          borderRadius: 28,
          boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
          border: `3px solid ${state === 'speaking' ? '#22c55e' : state === 'thinking' ? '#eab308' : 'rgba(255,255,255,0.15)'}`,
        }}
      />
      {faceReady ? null : avatarProvider === null || (avatarProvider === 'anam' && !faceFailed) ? (
        // The video face is on its way: a loading card, never the drawn avatar.
        <div
          style={{
            width: 420,
            height: 420,
            borderRadius: 28,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 18,
            background: 'radial-gradient(circle at 50% 40%, #1f2937, #0b1220)',
            border: '3px solid rgba(255,255,255,0.12)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
          }}
        >
          {faceIdle ? (
            <>
              {faceStill ? (
                <img src={faceStill} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 28, opacity: 0.55 }} />
              ) : null}
              <div style={{ position: 'relative', fontSize: 18, color: '#e2e8f0', textAlign: 'center', padding: '0 24px', textShadow: '0 1px 6px rgba(0,0,0,0.8)' }}>
                {quiet ? `Quiet. Say “Hey ${wakeWord || agentName}” to wake me.` : 'Listening'}
              </div>
            </>
          ) : (
            <>
              <style>{'@keyframes jarvis-face-spin { to { transform: rotate(360deg) } }'}</style>
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: '50%',
                  border: '4px solid rgba(255,255,255,0.15)',
                  borderTopColor: '#34d399',
                  animation: 'jarvis-face-spin 0.9s linear infinite',
                }}
              />
              <div style={{ fontSize: 18, color: '#cbd5e1' }}>Joining…</div>
            </>
          )}
        </div>
      ) : (
        <AvatarStage
          provider={avatarProvider}
          agentState={state}
          speechMetricsRef={speechMetricsRef}
        />
      )}
      <div style={{ fontSize: 28, fontWeight: 600 }}>{agentName}</div>
      <div style={{ fontSize: 16, opacity: 0.8 }}>{subtitle}</div>
      {wakeWord ? (
        <div
          style={{
            fontSize: 14,
            marginTop: 4,
            padding: '4px 12px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#cbd5e1',
          }}
        >
          Wake word: “{wakeWord}”
        </div>
      ) : null}
      <div style={{ fontSize: 18, marginTop: 8 }}>{stateLabel[state]}</div>

      {activeBgTask ? (
        <div
          style={{
            fontSize: 13,
            marginTop: 4,
            padding: '5px 14px',
            borderRadius: 999,
            background:
              activeBgTask.status === 'running'
                ? 'rgba(59,130,246,0.18)'
                : 'rgba(34,197,94,0.18)',
            border: `1px solid ${
              activeBgTask.status === 'running'
                ? 'rgba(59,130,246,0.45)'
                : 'rgba(34,197,94,0.45)'
            }`,
            color: activeBgTask.status === 'running' ? '#93c5fd' : '#86efac',
          }}
        >
          ⚙ {activeBgTask.label}
          {activeBgTask.summary ? ` (${activeBgTask.summary})` : ''}
        </div>
      ) : null}

      {currentQuestion && (state === 'thinking' || state === 'speaking') ? (
        <div style={{ fontSize: 15, opacity: 0.65, fontStyle: 'italic', maxWidth: 760, textAlign: 'center' }}>
          “{currentQuestion.length > 140 ? `…${currentQuestion.slice(-140)}` : currentQuestion}”
        </div>
      ) : null}

      {caption && (state === 'speaking' || state === 'idle' || state === 'listening') ? (
        <div
          style={{
            fontSize: 17,
            lineHeight: 1.45,
            maxWidth: 820,
            maxHeight: 120,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'flex-end',
            textAlign: 'center',
            color: '#cbd5e1',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 12,
            padding: '10px 18px',
          }}
        >
          <span>{caption.length > 320 ? `…${caption.slice(-320)}` : caption}</span>
        </div>
      ) : null}

      {lanes ? (
        <div style={{ display: 'flex', gap: 8, position: 'absolute', bottom: 28 }}>
          {(
            [
              ['OpenBrain', lanes.openbrain],
              ['Team KB', lanes.teamKb],
            ] as const
          ).map(([label, status]) => (
            <span
              key={label}
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 999,
                background: status === 'ok' ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.12)',
                color: status === 'ok' ? '#4ade80' : '#94a3b8',
                border: `1px solid ${status === 'ok' ? 'rgba(34,197,94,0.4)' : 'rgba(148,163,184,0.25)'}`,
              }}
            >
              {label} {status === 'ok' ? '✓' : status === 'empty' ? '–' : '✕'}
            </span>
          ))}
        </div>
      ) : null}

      {process.env.NODE_ENV !== 'production' && lastReason ? (
        <div style={{ fontSize: 12, opacity: 0.5, position: 'absolute', bottom: 8 }}>{lastReason}</div>
      ) : null}
    </div>
  )
}

const meetingId = window.location.pathname.split('/').filter(Boolean).pop() ?? ''
createRoot(document.getElementById('root')!).render(<AgentFramePage meetingId={meetingId} />)
