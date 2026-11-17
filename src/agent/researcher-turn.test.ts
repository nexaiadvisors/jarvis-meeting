import { describe, expect, it } from 'vitest'
import { researcherAckDirective, researcherAnswerDirective } from './researcher-turn.js'
import { ASK_CLAUDE_CODE_TOOL, ASK_RESEARCHER_TOOL, BUZZ_TALKER_RULES, DELEGATE_TALKER_RULES, DRAFT_BUZZ_TOOL, SEND_BUZZ_TOOL, RESEARCHER_TALKER_RULES, buildRealtimeInstructions, selectToolDefs, selectToolRoutes } from './realtime-config.js'
import { chooseAnswerRoute } from './answer-route.js'

const agent = {
  id: 'david', name: 'Jarvis', role: '', behavior_mode: 'delegate', speaking_style: null, persona_mode: 'first_person', voice_id: null,
  confidence_threshold: 0, allowed_topics: null, denied_topics: ['salary'], escalation_rules: {}, wake_word: 'Jarvis', created_at: '', updated_at: '',
}

describe('researcher turn wording', () => {
  it('hands the answer over with an order not to add facts', () => {
    const text = researcherAnswerDirective('who is the client?', { answer: ' The client is Pat Lee. ' })
    expect(text).toContain('[LOOKUP COMPLETE]')
    expect(text).toContain('The client is Pat Lee.')
    expect(text).toContain('Do not add facts')
  })

  it('tells the talker to admit a failed lookup', () => {
    expect(researcherAnswerDirective('q', { answer: '', instruction: 'Say you could not look that up.' })).toContain('Say you could not look that up.')
    const fallback = researcherAnswerDirective('q', { error: 'HTTP 500' })
    expect(fallback).toContain('[LOOKUP FAILED]')
    expect(fallback).toContain('Do not guess')
  })

  it('asks for one short line while the lookup runs', () => {
    expect(researcherAckDirective()).toContain('five words or fewer')
  })
})

describe('researcher mode tools and prompt', () => {
  const researcher = { ...agent, knowledge_mode: 'researcher' }

  it('gives the talker ask_researcher in place of every direct lookup tool', () => {
    const names = selectToolDefs(researcher).map((d) => d.name)
    expect(names).toContain(ASK_RESEARCHER_TOOL)
    for (const gone of ['search_brain', 'get_brain_context', 'get_exact_document', 'check_calendar']) expect(names).not.toContain(gone)
    expect(names).toEqual(expect.arrayContaining(['search_meeting_transcript', 'save_meeting_note', 'flag_for_david', 'create_doc']))
    expect(selectToolRoutes(researcher)[ASK_RESEARCHER_TOOL]!.path).toBe('/api/voice/ask-researcher')
    expect(selectToolRoutes(researcher)[ASK_RESEARCHER_TOOL]!.body({ question: 'q' })).toEqual({ question: 'q' })
  })

  it('keeps the direct tools, and no researcher tool, in direct mode', () => {
    const names = selectToolDefs(agent).map((d) => d.name)
    expect(names).toContain('search_brain')
    expect(names).not.toContain(ASK_RESEARCHER_TOOL)
    expect(selectToolDefs({ ...agent, knowledge_mode: 'direct' }).map((d) => d.name)).toEqual(names)
  })

  it('removes every instruction about the direct tools and adds the researcher rules', () => {
    const text = buildRealtimeInstructions({ title: 'Sync' }, researcher)
    for (const gone of ['search_brain', 'get_brain_context', 'check_calendar', 'retrieval results']) expect(text).not.toContain(gone)
    expect(text).toContain(RESEARCHER_TALKER_RULES)
    // Safety rules are not tool guidance and must survive the filter.
    expect(text).toContain('COMPENSATION and SALARY are a HARD no-answer topic')
    expect(text).toContain('NEVER discuss these topics')
    expect(text).not.toContain('first say a SHORT acknowledgment')
    expect(text).toContain('Behavior mode')
    expect(buildRealtimeInstructions({ title: 'Sync' }, agent)).toContain('search_brain')
  })

  it('never searches the notes before an answer', () => {
    const input = { wakeWord: 'Jarvis', mode: 'forced' as const, hasPrefetchedResults: true, meetingScoped: true, researcher: true }
    expect(chooseAnswerRoute('what did I finish today', input)).toBe('model')
    expect(chooseAnswerRoute('Jarvis, how are you?', input)).toBe('casual')
  })
})

describe('handing tasks to Claude Code', () => {
  const delegating = { ...agent, knowledge_mode: 'researcher', delegate_tasks: true }

  it('offers ask_claude_code only when the agent may delegate', () => {
    expect(selectToolDefs(delegating).map((d) => d.name)).toContain(ASK_CLAUDE_CODE_TOOL)
    expect(selectToolDefs({ ...agent, knowledge_mode: 'researcher' }).map((d) => d.name)).not.toContain(ASK_CLAUDE_CODE_TOOL)
    expect(selectToolDefs(agent).map((d) => d.name)).not.toContain(ASK_CLAUDE_CODE_TOOL)
    expect(selectToolRoutes(delegating)[ASK_CLAUDE_CODE_TOOL]!.path).toBe('/api/voice/delegate')
    expect(selectToolRoutes(delegating)[ASK_CLAUDE_CODE_TOOL]!.body({ task: 't' })).toEqual({ task: 't' })
  })

  it('adds the delegation rules to the prompt only then', () => {
    expect(buildRealtimeInstructions({ title: 'Sync' }, delegating)).toContain(DELEGATE_TALKER_RULES)
    expect(buildRealtimeInstructions({ title: 'Sync' }, { ...agent, knowledge_mode: 'researcher' })).not.toContain('Handing work to Claude Code')
  })
})

describe('Buzz messaging tools', () => {
  const withBuzz = { ...agent, knowledge_mode: 'researcher', buzz_messaging: true }

  it('offers the draft and send tools only when Buzz is on', () => {
    const names = selectToolDefs(withBuzz).map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining([DRAFT_BUZZ_TOOL, SEND_BUZZ_TOOL]))
    expect(selectToolDefs({ ...agent, knowledge_mode: 'researcher' }).map((d) => d.name)).not.toContain(SEND_BUZZ_TOOL)
    expect(selectToolRoutes(withBuzz)[SEND_BUZZ_TOOL]!.body({ draft_id: 'd1' })).toEqual({ draftId: 'd1' })
    expect(selectToolRoutes(withBuzz)[DRAFT_BUZZ_TOOL]!.body({ channel: '3cats', message: 'hi', mention: ['Nick'] })).toEqual({ channel: '3cats', message: 'hi', mention: ['Nick'] })
  })

  it('replaces the "you cannot send" rule with the read-back rules', () => {
    const text = buildRealtimeInstructions({ title: 'Sync' }, withBuzz)
    expect(text).toContain(BUZZ_TALKER_RULES)
    expect(text).not.toContain('You cannot send or draft messages from this meeting')
    expect(buildRealtimeInstructions({ title: 'Sync' }, { ...agent, knowledge_mode: 'researcher' })).toContain('You cannot send or draft messages from this meeting')
  })
})
