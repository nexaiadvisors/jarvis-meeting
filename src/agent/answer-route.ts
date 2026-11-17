// Decides how the agent answers one request: at once, or after a lookup.
//
// The first live calls (2026-11-14) ran a notes search before EVERY answer. Each turn
// started seconds late and small talk got "I don't have that information". The policy
// now follows what production voice agents do: answer directly by default and let the
// model call its search tool when the question needs the notes; look up first only for
// the question types whose tuned handling depends on it. Pure, so it is unit tested.

import { isCasualTurn, isPresenceCheck } from './wake-gate.js'
import { isDayScopedQuestion } from './realtime-config.js'

/** 'model': the model answers and calls search tools itself. 'forced': a lookup runs before every answer. */
export type RetrievalMode = 'model' | 'forced'

export type AnswerRoute =
  /** "Are you there?": one short confirmation, no lookup. */
  | 'presence'
  /** Greeting or small talk: answer directly, no lookup. */
  | 'casual'
  /** Search the notes first and hand the results to the model. */
  | 'lookup_first'
  /** Respond at once; the model calls search_brain when the question is about the work notes. */
  | 'model'

export interface AnswerRouteInput {
  wakeWord: string
  aliases?: string[]
  mode: RetrievalMode
  /** A matching search already finished while the person was speaking: its results cost nothing to use. */
  hasPrefetchedResults: boolean
  /** The question is about what was said earlier in this meeting. */
  meetingScoped: boolean
  /** A researcher does the lookups: the page never searches the notes before an answer. */
  researcher?: boolean
}

/** Parse MEETING_RETRIEVAL_MODE. Anything but "forced" is the default, 'model'. */
export function parseRetrievalMode(value: string | undefined): RetrievalMode {
  return (value ?? '').trim().toLowerCase() === 'forced' ? 'forced' : 'model'
}

const CALENDAR_QUESTION_RE =
  /\bcalendar\b|\bmy schedule\b|\bam i (?:free|busy|available)\b|\b(?:meetings?|calls?) do i have\b/i

/**
 * A question about the owner's calendar. It is answered by the check_calendar tool, never
 * by a notes search: "what is on my calendar today" is also day-scoped, and the lookup-first
 * path answered it from today's notes (text test, 2026-11-14).
 */
export function isCalendarQuestion(question: string): boolean {
  return CALENDAR_QUESTION_RE.test(question)
}

export function chooseAnswerRoute(question: string, input: AnswerRouteInput): AnswerRoute {
  const aliases = input.aliases ?? []
  if (isPresenceCheck(question, input.wakeWord, aliases)) return 'presence'
  if (isCasualTurn(question, input.wakeWord, aliases)) return 'casual'
  // Researcher mode: the model picks ask_researcher or answers directly. Nothing is searched first.
  if (input.researcher) return 'model'
  // Before the forced and day-scoped rules: injected notes would stand in for the calendar.
  if (isCalendarQuestion(question)) return 'model'
  if (input.mode === 'forced') return 'lookup_first'
  // Day-scoped questions ("what did I finish today") need the wide, complete result set
  // the lookup-first path fetches; "earlier in this meeting" needs the transcript search.
  // Status questions are NOT here: their widened query ("status northwind active on hold
  // deprioritized ...") found nothing where the model's own search ("Northwind status")
  // found the note (text test against the live notes, 2026-11-14).
  if (input.hasPrefetchedResults || input.meetingScoped) return 'lookup_first'
  if (isDayScopedQuestion(question)) return 'lookup_first'
  return 'model'
}

/**
 * After a lookup-first search: should its results be handed to the model? In 'model' mode
 * an EMPTY result is not handed over. Telling the model "nothing was found" made it refuse
 * questions its own, better-worded search could answer; with nothing injected it searches
 * itself and only then says it has no answer.
 */
export function shouldInjectLookup(mode: RetrievalMode, resultCount: number): boolean {
  return mode === 'forced' || resultCount > 0
}

// ---------------------------------------------------------------------------
// The explicit lookup decision
// ---------------------------------------------------------------------------
//
// Left to choose freely, the realtime model sometimes SAID "let me check" and then made
// up an answer without calling the search tool (text test on the deployed code,
// 2026-11-14: an invented Northwind status). So a 'model' turn has two steps. Step one is
// silent: the model MUST call a tool. It calls a real tool (search, create a doc, save a
// note) or `answer_directly`, which does nothing. Only step two speaks. A work question
// can then only be answered after a search has actually run, or after the model has
// explicitly declared that no lookup is needed.

export const ANSWER_DIRECTLY_TOOL = 'answer_directly'

export const ANSWER_DIRECTLY_DEF = {
  type: 'function',
  name: ANSWER_DIRECTLY_TOOL,
  description:
    'Call this, and nothing else, when the request needs NO lookup and NO action: a greeting, small talk, a question about yourself, a question about what was just said in this conversation, simple arithmetic, or plainly general knowledge that has nothing to do with David. NEVER call this for anything about David, his work, company, projects, products, clients, people, schedule, past meetings, decisions, plans or status: for those call search_brain with specific keywords, even for a follow-up question about a topic already discussed, unless the answer is already in the retrieved results above.',
  parameters: { type: 'object', properties: {}, required: [] },
} as const

/**
 * Step one of a 'model' turn: the model must choose a tool, and says nothing. `sessionTools`
 * are the tools the session already has; `answer_directly` is added for this response only.
 */
export function decisionResponseEvent(sessionTools: unknown[]): Record<string, unknown> {
  return {
    type: 'response.create',
    response: {
      tool_choice: 'required',
      output_modalities: ['text'],
      tools: [...sessionTools.filter((t) => (t as { name?: unknown }).name !== ANSWER_DIRECTLY_TOOL), ANSWER_DIRECTLY_DEF],
    },
  }
}

/** Step two after `answer_directly`: speak the answer, with no tool call possible. */
export function directAnswerEvent(): Record<string, unknown> {
  return { type: 'response.create', response: { tool_choice: 'none' } }
}

