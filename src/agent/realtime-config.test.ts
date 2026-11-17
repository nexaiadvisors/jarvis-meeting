import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isAnalysisQuestion,
  isConversationMetaQuestion,
  REALTIME_TOOLS,
  TOOL_ROUTES,
  selectToolDefs,
  selectToolRoutes,
  buildRealtimeInstructions,
  formatRetrievalForInjection,
  isStatusQuestion,
  isDayScopedQuestion,
  MIN_RELEVANCE_SCORE,
  OPENBRAIN_UNREACHABLE_DIRECTIVE,
  resolveProviderConfig,
  resolveRealtimeModel,
  resolveRealtimeProvider,
  resolveRealtimeWsBase,
  resolveWakeWord,
} from './realtime-config.js'
import type { MeetingAgent } from './types.js'

const agent: MeetingAgent = {
  id: 'a1',
  name: 'Jarvis',
  role: 'Meeting Representative',
  behavior_mode: 'respond',
  speaking_style: 'concise',
  persona_mode: 'ai',
  voice_id: null,
  confidence_threshold: 0.7,
  allowed_topics: null,
  denied_topics: ['salary'],
  escalation_rules: {},
  wake_word: null,
  voice_engine: 'realtime',
  realtime_model: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
}

describe('REALTIME_TOOLS', () => {
  it('declares the expected tools, each with a dispatch route', () => {
    const names = REALTIME_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'search_brain',
      'search_meeting_transcript',
      'get_brain_context',
      'get_exact_document',
      'search_documents',
      'save_meeting_note',
      'flag_for_david',
      'draft_slack_message',
      'look_at_screen',
    'check_calendar',
      'deep_answer',
      'recent_commits',
      'ingest_to_team_kb',
      'send_slack_message',
      'create_doc',
      'create_whiteboard',
      'update_artifact',
      'approve_lookup',
    ])
    for (const name of names) {
      expect(TOOL_ROUTES[name]).toBeDefined()
      expect(TOOL_ROUTES[name]!.path.startsWith('/api/')).toBe(true)
    }
  })

  it('maps transcript search to the current meeting route', () => {
    expect(TOOL_ROUTES.search_meeting_transcript!.path).toBe('/api/meetings/:id/transcript-search')
    expect(TOOL_ROUTES.search_meeting_transcript!.body({ query: 'what did Alice say', k: 4 })).toEqual({
      query: 'what did Alice say',
      k: 4,
    })
  })

  it('maps flag_for_david args into the save route body', () => {
    const body = TOOL_ROUTES.flag_for_david!.body({ topic: 'budget', reason: 'needs sign-off' })
    expect(body.tags).toContain('meeting-flag')
    expect(String(body.content)).toContain('budget')
  })

  it('maps send_slack_message args into the send-slack route body', () => {
    expect(TOOL_ROUTES.send_slack_message!.path).toBe('/api/voice/send-slack')
    const channelBody = TOOL_ROUTES.send_slack_message!.body({ channel: 'david-playground', message: 'hi' })
    expect(channelBody).toEqual({ channel: 'david-playground', user: undefined, message: 'hi' })
    const dmBody = TOOL_ROUTES.send_slack_message!.body({ user: 'Morgan', message: 'ping' })
    expect(dmBody).toEqual({ channel: undefined, user: 'Morgan', message: 'ping' })
  })
})

describe('capability registry parity', () => {
  // David's sidekick (first_person) — OpenBrain, the live meeting transcript and the
  // Noted list only. Everything else is team-only (audience 'ai').
  const FIRST_PERSON = [
    'search_brain',
    'search_meeting_transcript',
    'get_brain_context',
    'get_exact_document',
    'save_meeting_note',
    'flag_for_david',
    'look_at_screen',
    'check_calendar',
    'create_doc',
    'create_whiteboard',
    'update_artifact',
    'approve_lookup',
  ]
  // Team Jarvis (ai): the full registry: the original 13 tools in their order, then the 3 artifact tools and approve_lookup.
  const AI = [
    'search_brain',
    'search_meeting_transcript',
    'get_brain_context',
    'get_exact_document',
    'search_documents',
    'save_meeting_note',
    'flag_for_david',
    'draft_slack_message',
    'look_at_screen',
    'check_calendar',
    'deep_answer',
    'recent_commits',
    'ingest_to_team_kb',
    'send_slack_message',
    'create_doc',
    'create_whiteboard',
    'update_artifact',
    'approve_lookup',
  ]
  const TEAM_ONLY = AI.filter((name) => !FIRST_PERSON.includes(name))

  it('first_person tool names are exactly the sidekick set, in order', () => {
    expect(selectToolDefs({ persona_mode: 'first_person' }).map((d) => d.name)).toEqual(FIRST_PERSON)
    expect(Object.keys(selectToolRoutes({ persona_mode: 'first_person' }))).toEqual(FIRST_PERSON)
  })

  it('ai tool set is the original 13 in order plus the 4 newer tools', () => {
    expect(AI).toHaveLength(18)
    expect(selectToolDefs({ persona_mode: 'ai' }).map((d) => d.name)).toEqual(AI)
    expect(Object.keys(selectToolRoutes({ persona_mode: 'ai' }))).toEqual(AI)
  })

  it('the sidekick never sees the team-only tools', () => {
    const names = selectToolDefs({ persona_mode: 'first_person' }).map((d) => d.name)
    expect(TEAM_ONLY).toEqual([
      'search_documents',
      'draft_slack_message',
      'deep_answer',
      'recent_commits',
      'ingest_to_team_kb',
      'send_slack_message',
    ])
    for (const name of TEAM_ONLY) expect(names).not.toContain(name)
  })

  it('send_slack_message is the team-only divergence', () => {
    expect(selectToolDefs({ persona_mode: 'ai' }).map((d) => d.name)).toContain('send_slack_message')
    expect(selectToolDefs({ persona_mode: 'first_person' }).map((d) => d.name)).not.toContain('send_slack_message')
  })

  it('a common (audience-all) tool is included for every agent', () => {
    expect(selectToolDefs({ persona_mode: 'first_person' }).map((d) => d.name)).toContain('search_brain')
    expect(selectToolDefs({ persona_mode: 'ai' }).map((d) => d.name)).toContain('search_brain')
  })

  it('derived globals equal the ai (superset) projection — the full registry', () => {
    expect(selectToolDefs({ persona_mode: 'ai' })).toEqual(REALTIME_TOOLS)
    expect(selectToolRoutes({ persona_mode: 'ai' })).toEqual(TOOL_ROUTES)
  })

  it('retrieval routes still pass scope=work after the regroup', () => {
    expect(selectToolRoutes({ persona_mode: 'first_person' }).search_brain!.body({ query: 'q' }).scope).toBe('work')
  })
})

describe('OPENBRAIN_UNREACHABLE_DIRECTIVE', () => {
  it('tells the model to say it cannot reach the notes and not to answer from memory', () => {
    expect(OPENBRAIN_UNREACHABLE_DIRECTIVE).toBe(
      "OpenBrain is unreachable right now. Tell the speaker you can't reach David's notes at the moment. Do not answer from memory.",
    )
  })
})

describe('get_exact_document route', () => {
  it('posts the exact namespace, doc_type and entity_key to the work-scoped route', () => {
    expect(TOOL_ROUTES.get_exact_document!.path).toBe('/api/voice/ob-get-document')
    expect(TOOL_ROUTES.get_exact_document!.body({ namespace: 'n', doc_type: 'd', entity_key: 'e' })).toEqual({
      namespace: 'n',
      doc_type: 'd',
      entity_key: 'e',
      scope: 'work',
    })
  })
})

describe('resolveWakeWord / resolveRealtimeModel', () => {
  it('falls back to agent name when wake_word is null', () => {
    expect(resolveWakeWord(agent)).toBe('Jarvis')
    expect(resolveWakeWord({ ...agent, wake_word: 'Delegate' })).toBe('Delegate')
  })

  it('uses agent override before env default for the model', () => {
    expect(resolveRealtimeModel({ realtime_model: 'gpt-realtime-2' })).toBe('gpt-realtime-2')
  })
})

describe('buildRealtimeInstructions', () => {
  it('keeps base guardrails and appends realtime rules with the wake word', () => {
    const text = buildRealtimeInstructions({ title: 'Sprint Sync' }, agent)
    expect(text).toContain('NEVER discuss these topics: salary')
    expect(text).toContain('COMPENSATION and SALARY are a HARD no-answer topic') // hard refusal, never a figure
    expect(text).toContain('Realtime engine rules:')
    expect(text).toContain('"Jarvis"')
    expect(text).toContain('let me check')
  })

  it('adds the send_slack_message confirm guidance for the ai persona only', () => {
    const aiText = buildRealtimeInstructions({ title: 'Sprint Sync' }, agent)
    expect(aiText).toContain('send_slack_message actually SENDS')
    expect(aiText).toContain('spoken confirmation')

    const delegateText = buildRealtimeInstructions({ title: 'Sprint Sync' }, { ...agent, persona_mode: 'first_person' })
    expect(delegateText).not.toContain('send_slack_message')
  })

  it('the sidekick instructions mention no tool the sidekick does not have', () => {
    const text = buildRealtimeInstructions({ title: 'Sprint Sync' }, { ...agent, persona_mode: 'first_person' })
    for (const name of [
      'recent_commits',
      'deep_answer',
      'ingest_to_team_kb',
      'search_documents',
      'draft_slack_message',
      'send_slack_message',
    ]) {
      expect(text).not.toContain(name)
    }
    // ...and still names the tools it does have.
    for (const name of ['search_brain', 'get_brain_context', 'save_meeting_note', 'flag_for_david']) {
      expect(text).toContain(name)
    }
  })

  it('the team (ai) instructions still carry the team tool guidance', () => {
    const text = buildRealtimeInstructions({ title: 'Sprint Sync' }, agent)
    for (const name of ['recent_commits', 'deep_answer', 'ingest_to_team_kb', 'draft_slack_message', 'send_slack_message']) {
      expect(text).toContain(name)
    }
  })

  it('blocks the interview-title misread — never claims a Principal title', () => {
    const text = buildRealtimeInstructions({ title: 'Principal Engineer Zoom' }, agent)
    expect(text).toContain('never state or imply he is a Principal')
    expect(text).not.toContain('Staff Engineer')
  })
})

describe('resolveRealtimeProvider / resolveProviderConfig / resolveRealtimeWsBase', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function stubAzure() {
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://myres.openai.azure.com/')
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'azkey')
    vi.stubEnv('AZURE_OPENAI_REALTIME_DEPLOYMENT', 'gpt-realtime-mini')
  }

  it('returns null when OPENAI_API_KEY is not set', () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(resolveRealtimeProvider()).toBeNull()
    expect(resolveProviderConfig(agent)).toBeNull()
    expect(resolveRealtimeWsBase()).toBeNull()
  })

  it('uses openai when OPENAI_API_KEY is set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    expect(resolveRealtimeProvider()).toBe('openai')
    const cfg = resolveProviderConfig(agent)!
    expect(cfg.provider).toBe('openai')
    expect(cfg.tokenUrl).toBe('https://api.openai.com/v1/realtime/client_secrets')
    expect(cfg.tokenHeaders.Authorization).toBe('Bearer sk-test')
    expect(cfg.callsUrl).toContain('https://api.openai.com/v1/realtime/calls?model=')
  })

  it('resolveRealtimeProvider ignores AZURE_OPENAI_* and returns openai only when OPENAI_API_KEY is set', () => {
    // Azure fully configured, no OpenAI key: no provider at all (Azure path is gone).
    vi.stubEnv('OPENAI_API_KEY', '')
    stubAzure()
    expect(resolveRealtimeProvider()).toBeNull()
    expect(resolveProviderConfig(agent)).toBeNull()
    expect(resolveRealtimeWsBase()).toBeNull()

    // Both configured: openai wins, whatever REALTIME_PROVIDER says, and nothing
    // Azure-shaped leaks into the resolved config or WS base.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    for (const preference of ['', 'azure', 'openai']) {
      vi.stubEnv('REALTIME_PROVIDER', preference)
      expect(resolveRealtimeProvider()).toBe('openai')
      const cfg = resolveProviderConfig(agent)!
      const ws = resolveRealtimeWsBase()!
      expect(ws.provider).toBe('openai')
      expect(ws.wsUrl.startsWith('wss://api.openai.com/v1/realtime?model=')).toBe(true)
      const serialized = JSON.stringify({ cfg, ws })
      expect(serialized).not.toContain('azure')
      expect(serialized).not.toContain('azkey')
      expect(serialized).not.toContain('api-key')
    }
  })
})

describe('TOOL_ROUTES work scope', () => {
  it('retrieval tools always pass scope=work; write tools do not need it', () => {
    expect(TOOL_ROUTES.search_brain!.body({ query: 'q' }).scope).toBe('work')
    expect(TOOL_ROUTES.get_brain_context!.body({ query: 'q' }).scope).toBe('work')
    expect(TOOL_ROUTES.get_exact_document!.body({ namespace: 'n', doc_type: 'd', entity_key: 'e' }).scope).toBe('work')
    expect(TOOL_ROUTES.search_documents!.body({ query: 'q' }).scope).toBe('work')
  })
})

describe('formatRetrievalForInjection', () => {
  it('includes data-age stamps from updated_at', () => {
    const text = formatRetrievalForInjection('roadmap status', [
      { entity_key: 'roadmap-q2', content: 'Phase B shipped.', updated_at: '2026-06-01T10:00:00Z' },
    ])
    expect(text).toContain('roadmap-q2')
    expect(text).toContain('as of 2026-06-01')
  })

  it('tells the model not to guess when there are no results', () => {
    const text = formatRetrievalForInjection('unknown topic', [])
    expect(text).toContain('no relevant results')
    expect(text).toContain('NO grounded knowledge')
    expect(text).toContain('based on the data')
    expect(text).toContain('meeting chatter')
  })

  it('with no results, still refuses work questions but allows live-data and general-knowledge handling', () => {
    const text = formatRetrievalForInjection('how is the weather in Los Angeles', [])
    expect(text).toContain('Never answer this kind from general knowledge')
    expect(text).toContain('do not have live access')
    expect(text).toContain('answer in one or two sentences from general knowledge')
  })

  it('drops live-meeting noise below the relevance floor and declines honestly', () => {
    expect(MIN_RELEVANCE_SCORE).toBe(0.15)
    const text = formatRetrievalForInjection('what is the retrieval status', [
      { text: 'meeting chatter that matched weakly', source: 'openbrain/noise', score: 0.01, date: '2026-07-08' },
    ])
    expect(text).toContain('NO grounded knowledge')
    expect(text).not.toContain('meeting chatter that matched weakly')
  })

  it('renders the connector shape {text, source, date} with content + date + title (the empty-content bug)', () => {
    // HTTP connector path returns text/source/date (NOT content/entity_key/created_at).
    // Before the fix, content was empty and the title was "note" — the agent answered
    // from doc names alone ("voice AI for today's work").
    const text = formatRetrievalForInjection('what did i do today', [
      { text: 'Shipped the second-brain connector and onboarding flow.', source: 'jarvis-meeting-connector-side-2026-06-24', score: 1, date: '2026-06-24' },
    ])
    expect(text).toContain('Shipped the second-brain connector') // content, not empty
    expect(text).toContain('jarvis-meeting-connector-side-2026-06-24') // title from source
    expect(text).toContain('as of 2026-06-24') // date tag
    expect(text).toContain('Today is') // current-date grounding header
    expect(text).toContain('Answer ONLY from the retrieved results')
  })

  it('appends the thorough-synthesis directive for STATUS questions', () => {
    const results = [{ entity_key: 'robo-sdr-status', content: 'deprioritized; focus outbound.', updated_at: '2026-06-22T10:00:00Z' }]
    const status = formatRetrievalForInjection('what is the status of the AI receptionist', results)
    expect(status).toContain('COMPLETE picture')
    expect(status).toContain('LEAD with the current priority')
    // a plain factual question does NOT get the directive (brevity preserved)
    const factual = formatRetrievalForInjection('what is the qualified-lead threshold', results)
    expect(factual).not.toContain('COMPLETE picture')
  })
})

describe('formatRetrievalForInjection — persona', () => {
  const analysisQ = 'Jarvis what do you think we should prioritize'
  const rows = [{ source: 'second-brain/plan/x', text: 'Pod operating system proposal', score: 0.9 }] as never

  it('ai persona: the analysis directive points at deep_answer and relaxes the grounding rule', () => {
    const out = formatRetrievalForInjection(analysisQ, rows, 'ai')
    expect(out).toContain('YOUR ANALYSIS or OPINION')
    expect(out).toContain('deep_answer')
    expect(out).toContain('suspended')
  })

  it('omitting the persona fails closed: the strict rule, no deep_answer hint', () => {
    const out = formatRetrievalForInjection(analysisQ, rows)
    expect(out).toBe(formatRetrievalForInjection(analysisQ, rows, ''))
    expect(out).not.toContain('deep_answer')
    expect(out).not.toContain('YOUR ANALYSIS or OPINION')
    expect(out).not.toContain('suspended')
    expect(out).toContain('Answer ONLY from the retrieved results')
  })

  it('first_person (the sidekick): no deep_answer hint and the retrieved-facts rule stays in force', () => {
    const out = formatRetrievalForInjection(analysisQ, rows, 'first_person')
    expect(out).not.toContain('deep_answer')
    expect(out).not.toContain('YOUR ANALYSIS or OPINION')
    expect(out).not.toContain('suspended')
    expect(out).toContain('Answer ONLY from the retrieved results')
    expect(out).toContain('Pod operating system proposal')
  })

  it('first_person with nothing retrieved still declines instead of reasoning from memory', () => {
    const out = formatRetrievalForInjection('what are the risks here', [], 'first_person')
    expect(out).toContain('NO grounded knowledge')
    expect(out).not.toContain('deep_answer')
    expect(out).not.toContain('No strong retrieval hits')
  })

  it('an unknown or blank persona fails closed to the strict rule', () => {
    for (const persona of ['', 'something-else']) {
      const out = formatRetrievalForInjection(analysisQ, rows, persona)
      expect(out, persona).not.toContain('deep_answer')
      expect(out, persona).toContain('Answer ONLY from the retrieved results')
    }
  })

  it('first_person never mentions deep_answer for any kind of question', () => {
    for (const q of [
      analysisQ,
      'what is the status of the AI receptionist',
      'what did I complete today',
      'summarize what we discussed so far',
      'what are the risks of going benefits-first',
      'what is the pod operating system',
    ]) {
      expect(formatRetrievalForInjection(q, rows, 'first_person'), q).not.toContain('deep_answer')
      expect(formatRetrievalForInjection(q, [], 'first_person'), q).not.toContain('deep_answer')
    }
  })
})

describe('save_meeting_note tool description', () => {
  it('says the note lands in the meeting notes and reaches OpenBrain after the call', () => {
    const def = REALTIME_TOOLS.find((t) => t.name === 'save_meeting_note')
    expect(def?.description).toBe(
      "Save a note to this meeting's notes (stored in David's OpenBrain after the call)",
    )
  })
})

describe('isStatusQuestion', () => {
  it('detects status / overview / priority-state questions', () => {
    for (const q of [
      'what is the status of the AI receptionist',
      'give me an overview of robo-sdr',
      'where do things stand with the receptionist',
      'is the project still active or on hold',
      'has it been deprioritized',
      "what's the latest on the receptionist",
    ]) {
      expect(isStatusQuestion(q)).toBe(true)
    }
  })

  it('does NOT flag plain factual questions (brevity preserved)', () => {
    for (const q of [
      'what is the qualified-lead threshold',
      'who set up the telephony repo',
      'what did we decide about Zendesk',
    ]) {
      expect(isStatusQuestion(q)).toBe(false)
    }
  })
})

describe('isDayScopedQuestion', () => {
  it('detects single-day scopes — including the pronoun-free live phrasing', () => {
    for (const q of [
      'what did I complete today',
      'what was completed today',
      'what did I do yesterday',
      'anything from this morning',
    ]) {
      expect(isDayScopedQuestion(q)).toBe(true)
    }
  })

  it('does NOT flag range/relative temporal or plain questions', () => {
    for (const q of ['what did we ship this week', 'latest status on the connector', 'what is the connector contract']) {
      expect(isDayScopedQuestion(q)).toBe(false)
    }
  })
})

describe('formatRetrievalForInjection — day-scoped enumeration', () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ entity_key: `item-${i}`, content: `did thing ${i}`, date: '2026-06-24' }))

  it('appends the enumeration directive for a day-scoped question', () => {
    const text = formatRetrievalForInjection('what did I complete today', mk(3))
    expect(text).toContain('DAY-SCOPED question')
    expect(text).toContain('Enumerate EVERY distinct item')
  })

  it('the day directive OVERRIDES the status directive when a question is both', () => {
    const text = formatRetrievalForInjection("what's the status of everything today", mk(3))
    expect(text).toContain('DAY-SCOPED question')
    expect(text).not.toContain('COMPLETE picture') // status directive suppressed
  })

  it('injects the WHOLE day (slice 40), not just the top 12', () => {
    const text = formatRetrievalForInjection('what did I complete today', mk(45))
    expect(text).toContain('item-12') // 13th item — would be cut at the 12-slice
    expect(text).toContain('item-39') // 40th item — survives the 40-cap
    expect(text).not.toContain('item-40') // 41st item — cut at the 40-cap
  })

  it('a plain question still caps at 12 and gets no day directive', () => {
    const text = formatRetrievalForInjection('what is the qualified-lead threshold', mk(15))
    expect(text).not.toContain('item-12')
    expect(text).not.toContain('DAY-SCOPED question')
  })
})

describe('conversation-meta questions', () => {
  const mkDocs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ entity_key: `item-${i}`, content: `onsite topic ${i}`, date: '2026-07-14' }))

  it('summarize-this-meeting questions bypass retrieval grounding', () => {
    const out = formatRetrievalForInjection("Jarvis, give me a detailed summary of everything we've discussed.", [])
    expect(out).toContain("THIS meeting's own conversation")
    expect(out).not.toContain('NO grounded knowledge')
  })
  it('normal knowledge questions still get the grounding directive', () => {
    const out = formatRetrievalForInjection('what is the pod operating system', [])
    expect(out).toContain('NO grounded knowledge')
  })
  it('a temporal window beats the meta phrasing: "what did we discuss yesterday" is NOT conversation-meta', () => {
    expect(isConversationMetaQuestion('Jarvis, what did we discuss yesterday?')).toBe(false)
    expect(isConversationMetaQuestion('what did we talk about last week')).toBe(false)
    expect(isConversationMetaQuestion('summarize what we covered on 2026-07-14')).toBe(false)
  })
  it('"what did we discuss yesterday" injects the retrieved docs (day-scoped), not the meeting-only directive', () => {
    const out = formatRetrievalForInjection('Jarvis, what did we discuss yesterday?', mkDocs(30) as never)
    expect(out).not.toContain("THIS meeting's own conversation")
    expect(out).toContain('Knowledge retrieval')
    expect(out).toContain('item-0')
    expect(out).toContain('item-29') // day-scoped: whole window survives, not top-12
    expect(out).toContain('DAY-SCOPED question')
  })
  it('an explicit this-meeting anchor still wins over a temporal marker', () => {
    expect(isConversationMetaQuestion('what have we covered so far today')).toBe(true)
    expect(isConversationMetaQuestion('summarize this meeting so far')).toBe(true)
    expect(isConversationMetaQuestion('recap what we discussed in this meeting')).toBe(true)
  })
})

describe('analysis mode (opinion / strategic questions)', () => {
  it('detects opinion-seeking intent', () => {
    for (const q of [
      'Jarvis what do you think we should prioritize',
      "Jarvis what's your take on the pod structure",
      'Jarvis poke holes in this plan',
      'Jarvis what are the risks of going benefits-first',
      'Jarvis play devils advocate on the BHAG',
      'Jarvis what are we missing here',
      'Jarvis should we go AI first or human first',
    ]) {
      expect(isAnalysisQuestion(q), q).toBe(true)
    }
  })
  it('detects insight-seeking intent (2026-07-15 live failure phrasings)', () => {
    for (const q of [
      'Hey Javis, based on what we discussed yesterday, what are some insights you can provide?',
      "That's what happened yesterday, but what insight can you extract from it that we can use in our strategy?",
      'Jarvis what are the key takeaways from the onsite',
      'Jarvis can you give us some insights from yesterday',
      "Jarvis what's your insight on the pod structure",
    ]) {
      expect(isAnalysisQuestion(q), q).toBe(true)
    }
  })
  it('does NOT match plain factual questions', () => {
    for (const q of [
      'Jarvis what is the pod operating system',
      'Jarvis what did we complete last week',
      'Jarvis what did Riley say yesterday',
      "Jarvis what's our Q3 revenue forecast",
      'Jarvis what insights did Riley share yesterday', // attribution recall, not an ask for MY analysis
      'Jarvis what did we discuss yesterday', // day-scoped recall, not analysis
    ]) {
      expect(isAnalysisQuestion(q), q).toBe(false)
    }
  })
  it('an insight ask about yesterday gets the analysis directive, NOT the day-scoped enumeration', () => {
    const docs = Array.from({ length: 30 }, (_, i) => ({ entity_key: `item-${i}`, content: `onsite topic ${i}`, date: '2026-07-14' }))
    const out = formatRetrievalForInjection(
      'Hey Javis, based on what we discussed yesterday, what are some insights you can provide?',
      docs as never,
      'ai',
    )
    expect(out).toContain('YOUR ANALYSIS or OPINION')
    expect(out).not.toContain('DAY-SCOPED question')
    expect(out).not.toContain('Enumerate EVERY distinct item')
  })
  it('analysis outranks conversation-meta: an opinion ask about the discussion gets the analysis directive', () => {
    const out = formatRetrievalForInjection("Jarvis, what do you think about everything we've discussed so far?", [], 'ai')
    expect(out).toContain('YOUR ANALYSIS or OPINION')
    expect(out).not.toContain("THIS meeting's own conversation")
  })
  it('injects the reasoning-licensed directive, not the strict grounding one', () => {
    const out = formatRetrievalForInjection('what do you think we should prioritize', [
      { source: 'second-brain/plan/x', text: 'Pod operating system proposal', score: 0.9 } as never,
    ], 'ai')
    expect(out).toContain('YOUR ANALYSIS or OPINION')
    expect(out).toContain('suspended')
    expect(out).toContain('Compensation and salary remain entirely off-limits')
    expect(out).not.toContain('Answer ONLY from the retrieved results')
  })
  it('still gives an evidence base even with no strong retrieval hits', () => {
    const out = formatRetrievalForInjection('what are the risks here', [], 'ai')
    expect(out).toContain('YOUR ANALYSIS or OPINION')
    expect(out).toContain('No strong retrieval hits')
  })
})
