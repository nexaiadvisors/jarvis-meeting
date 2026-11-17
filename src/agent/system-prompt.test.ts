import { describe, expect, it } from 'vitest'
import { buildMeetingSystemPrompt } from './system-prompt.js'
import type { MeetingAgent } from './types.js'

const baseAgent: MeetingAgent = {
  id: 'a1',
  name: 'Jarvis',
  role: 'Meeting Representative',
  behavior_mode: 'respond',
  speaking_style: 'concise',
  persona_mode: 'ai',
  voice_id: null,
  confidence_threshold: 0.7,
  allowed_topics: null,
  denied_topics: ['compensation'],
  escalation_rules: {},
  wake_word: null,
  voice_engine: 'realtime',
  realtime_model: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
}

// The comp leak was prompt-only enforcement that varied by persona. The
// hard-refusal sentence is now persona-INDEPENDENT (pushed unconditionally in
// buildMeetingSystemPrompt, system-prompt.ts ~lines 90-92), so it must appear
// for BOTH the team Jarvis ('ai') and David's delegate ('first_person').
describe('buildMeetingSystemPrompt — compensation HARD no-answer is persona-independent', () => {
  const HARD_REFUSAL = 'COMPENSATION and SALARY are a HARD no-answer topic.'

  it("includes the HARD no-answer comp sentence for persona_mode 'first_person'", () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'first_person' })
    expect(text).toContain(HARD_REFUSAL)
  })

  it("includes the HARD no-answer comp sentence for persona_mode 'ai'", () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'ai' })
    expect(text).toContain(HARD_REFUSAL)
  })
})

// The first_person delegate is now "Jarvis, David's AI representative" — it
// represents David, it does NOT claim to BE David, and the agent.role (which
// describes David, e.g. "Meeting Representative") must NOT attach to the
// "You are {name}" line as if it were Jarvis's own title.
describe('buildMeetingSystemPrompt — first_person delegate is Jarvis representing David', () => {
  it("frames the first_person identity as Jarvis, David's AI representative who never claims to be David", () => {
    const text = buildMeetingSystemPrompt(
      { title: 'Sprint Sync' },
      { ...baseAgent, name: 'Jarvis', role: 'Meeting Representative', persona_mode: 'first_person' },
    )
    expect(text).toContain("You are Jarvis, David's AI representative.")
    expect(text).toContain('never claim to be David')
    expect(text).toContain("grounded in David's own knowledge.")
    // role must NOT be welded onto the identity line as Jarvis's own title
    expect(text).not.toContain('You are Jarvis, Meeting Representative')
    // and the legacy "Speak as David in first person." line is gone
    expect(text).not.toContain('Speak as David in first person.')
  })
})

// The sidekick (first_person) tool list no longer carries these tools, so its
// prompt must not tell the model to call them. The team (ai) prompt keeps them.
describe('buildMeetingSystemPrompt — tool guidance follows the persona tool set', () => {
  const TEAM_ONLY_TOOLS = ['recent_commits', 'deep_answer', 'ingest_to_team_kb']

  it('both prompts send calendar questions to check_calendar', () => {
    for (const persona_mode of ['first_person', 'ai']) {
      expect(buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode })).toContain('call check_calendar')
    }
  })

  it('first_person prompt mentions none of recent_commits, deep_answer, ingest_to_team_kb', () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'first_person' })
    for (const name of TEAM_ONLY_TOOLS) expect(text).not.toContain(name)
  })

  it('first_person prompt does not tell the model to draft or send messages with a tool it lacks', () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'first_person' })
    expect(text).not.toContain('draft_slack_message')
    expect(text).not.toContain('send_slack_message')
    expect(text).toContain('You cannot send or draft messages')
  })

  it('first_person prompt keeps the OpenBrain lookup and note tools', () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'first_person' })
    for (const name of ['search_brain', 'get_brain_context', 'save_meeting_note', 'flag_for_david']) {
      expect(text).toContain(name)
    }
  })

  it('ai prompt still carries the guidance for the team tools', () => {
    const text = buildMeetingSystemPrompt({ title: 'Sprint Sync' }, { ...baseAgent, persona_mode: 'ai' })
    for (const name of ['recent_commits', 'deep_answer', 'ingest_to_team_kb', 'draft_slack_message', 'send_slack_message']) {
      expect(text).toContain(name)
    }
  })
})
