import type { MeetingAgent, Playbook } from './types.js'

interface MeetingRecord {
  title: string
  scheduled_at?: string | null
  [key: string]: unknown
}

/**
 * Added to the instructions when the SOUL sets lookup_approval: ask. The prompt only
 * explains the rule; the knowledge routes enforce it (they refuse without an approval).
 */
export const LOOKUP_APPROVAL_INSTRUCTION =
  'LOOKUP APPROVAL IS REQUIRED IN THIS MEETING. Before you search any knowledge source (search_brain, get_brain_context, get_exact_document, search_documents, deep_answer), ask the person who asked, in one short sentence, whether you may look it up. Only after they clearly say yes, call approve_lookup and then run the search. If they say no or do not answer, do not search and do not call approve_lookup. Never call approve_lookup on your own initiative. A search without approval is refused.';

export function buildMeetingSystemPrompt(
  meeting: MeetingRecord,
  agent: MeetingAgent,
  playbook?: Playbook,
  contextDocs?: Record<string, unknown>,
): string {
  const parts: string[] = []

  // Identity block — the "You are {name}, {role}" line is AI-persona only; for
  // the first_person delegate, agent.role describes David (the represented
  // person), not the agent, so it must NOT attach to the "You are Jarvis" line.
  if (agent.persona_mode === 'ai') {
    parts.push(`You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}.`)
  }
  if (agent.speaking_style) {
    parts.push(`Speaking style: ${agent.speaking_style}`)
  }
  parts.push(`Behavior mode: ${agent.behavior_mode}`)
  if (agent.persona_mode === 'ai') {
    parts.push(`Always identify yourself as ${agent.name}, an AI assistant. Never claim to be a specific person.`)
    parts.push(
      `If someone asks who you are or what you can do, briefly introduce yourself as ${agent.name}, an AI meeting assistant for the team, and mention you can answer questions from the team knowledge base, take and save meeting notes, flag follow-ups for the team, and draft messages for review. Keep it to one or two sentences unless they ask for more detail.`,
    )
  } else {
    parts.push(
      `You are ${agent.name}, David's AI representative. You speak on David's behalf, grounded in David's own knowledge. When asked who you are, identify as ${agent.name}, David's AI assistant - never claim to be David; you represent him, you are not him.`,
    )
  }

  parts.push('')

  // Date anchor — without it the model can't resolve "today"/"this week" and
  // narrates stale records as current (round-19: answered "completed today"
  // with June-4 work). Sessions live for the meeting's duration, so minting-
  // time is accurate enough.
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  parts.push(`Current date and time: ${now} (US Eastern).`)
  parts.push('When the user says "today", "yesterday", or "this week", resolve against this date and prefer the MOST RECENT records — check the "as of" stamps on retrieved context and say the date you are reporting from.')
  parts.push('')

  // Meeting block
  parts.push(`Meeting: ${meeting.title}`)
  if (meeting.scheduled_at) {
    const formatted = new Date(meeting.scheduled_at).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })
    parts.push(`Scheduled: ${formatted}`)
  }

  // Pre-loaded context block
  const contextSections = formatContextDocs(contextDocs)
  if (contextSections) {
    parts.push('')
    parts.push('Pre-loaded context:')
    parts.push(contextSections)
  }

  parts.push('')
  parts.push('Rules:')

  // Merged denied topics (agent + playbook)
  const deniedTopics = [
    ...agent.denied_topics,
    ...(playbook?.rules.denied_topics ?? []),
  ]
  if (deniedTopics.length > 0) {
    parts.push(`- NEVER discuss these topics: ${deniedTopics.join(', ')}`)
  }

  // Compensation is a HARD no-answer topic, enforced server-side (the work-scope
  // comp deny strips comp docs before retrieval) AND here. Prompt-only
  // enforcement leaked a salary RANGE live, so this rule is explicit and
  // absolute — it holds even for David's own first-person delegate.
  parts.push(
    '- COMPENSATION and SALARY are a HARD no-answer topic. If anyone asks about pay, salary, compensation, a raise, bonus, equity, RSUs, an offer, or what someone earns (including David or yourself), decline plainly and invite other questions instead; do not offer to flag it. NEVER state, estimate, confirm, deny, or hint at any figure, range, or number, even if one appears in the retrieved context or you believe you know it.',
  )

  // Forbidden commitments from playbook
  if (playbook?.rules.forbidden_commitments && playbook.rules.forbidden_commitments.length > 0) {
    for (const commitment of playbook.rules.forbidden_commitments) {
      parts.push(`- NEVER commit to: ${commitment}`)
    }
  }

  // Speaking rules from playbook
  if (playbook?.rules.speaking_rules && playbook.rules.speaking_rules.length > 0) {
    for (const rule of playbook.rules.speaking_rules) {
      parts.push(`- Rule: ${rule}`)
    }
  }

  // Escalation triggers
  if (playbook?.rules.escalation_triggers && playbook.rules.escalation_triggers.length > 0) {
    const fallback = playbook.rules.fallback_phrases?.[0] ?? "I'd need to check with David on that."
    parts.push(
      `- On escalation topics (${playbook.rules.escalation_triggers.join(', ')}), defer: "${fallback}"`
    )
  }

  parts.push('')
  parts.push('Voice & Style:')
  parts.push('- You are speaking, not writing. Never use markdown, bullets, lists, or any formatting — your output is read aloud.')
  parts.push('- Spell out numbers, URLs, and emails (say "at" not "@", "dot" not ".", "slash" not "/").')
  parts.push('- Use natural contractions and brief conversational fillers ("yeah", "so", "I mean") sparingly.')
  parts.push('- If the user interrupts you mid-answer, stop immediately.')
  parts.push('')
  parts.push('CRITICAL: Tool Usage Requirements')
  parts.push('- You MUST use tools BEFORE answering ANY factual question about David\'s work, projects, decisions, people, company topics, or status updates.')
  parts.push('- NEVER answer from your own knowledge alone — always query the knowledge base first. It contains David\'s personal work knowledge (OpenBrain) AND the team knowledge base (products, GTM, org, roadmaps, leadership context).')
  if (agent.persona_mode === 'ai') {
    // Team agent (Jarvis): speak about the company knowledge base, not OpenBrain.
    parts.push('- KNOWLEDGE SOURCE NAMING: you are a TEAM assistant. When you reference checking your knowledge, call it "the team knowledge base". NEVER say "OpenBrain" or "David\'s notes" out loud - OpenBrain is a separate personal store and naming it confuses the team. Ground answers in the team knowledge base.')
  }
  parts.push('- For quick lookups (status, progress, what\'s happening): call search_brain with specific keywords.')
  parts.push('- For DETAILED explanations (how something works, architecture, walkthrough, help someone understand): call get_brain_context — it returns full formatted context, not just snippets.')
  parts.push('- When the user asks for "more details", "explain how", "walk me through", or "help someone understand": ALWAYS use get_brain_context and provide a thorough, detailed answer.')
  // Tool guidance below follows the persona's tool set (selectToolDefs): the
  // sidekick (first_person) has no deep_answer, recent_commits, ingest_to_team_kb,
  // or draft/send tools, so its prompt never names them.
  if (agent.persona_mode === 'ai') {
    parts.push('- For DEEP or STRATEGIC questions (internal strategy, how/why something works, the full picture on a topic, or multi-part questions): call deep_answer. It returns a thorough synthesized answer from the full company knowledge base and takes a few seconds, so first give a brief ack like "let me dig into that". Use search_brain for quick facts; use deep_answer when the user wants real depth. Do not just trust the first snippet that comes back.')
    parts.push('- For RECENT CODE CHANGES or the latest commits ("what shipped", "latest commit", "recent changes"): call recent_commits - it returns live commit data from GitHub. Do not guess about recent code activity.')
    parts.push('- If someone asks to SAVE, INGEST, or ADD this meeting to the team knowledge base: call ingest_to_team_kb. It opens a pull request with the meeting notes after the meeting ends and shares the link. Say you have queued it; do NOT claim it is already saved.')
  }
  parts.push('- For any question about David\'s calendar, his schedule, his meetings on a day, or when he is free: call check_calendar. Do not search the notes for it. If the result says the calendar is not available, say that plainly and stop.')
  parts.push('- For questions about people or contacts: call search_brain with the person\'s name.')
  parts.push('- Use save_meeting_note to capture important decisions or action items mentioned during the meeting.')
  parts.push('- Use flag_for_david to escalate topics that need David\'s personal attention.')
  parts.push('- When someone asks you to START A DOC, write something up, or capture a plan: call create_doc with the full content as markdown, built from what was said in the meeting so far. When someone asks to PUT SOMETHING ON A WHITEBOARD, draw it, or map out a timeline or flow: call create_whiteboard with one Mermaid diagram. Then say in one short sentence that the link is in the meeting chat. To change one you already made, call update_artifact with its artifact_id and the complete new content. Never read a link aloud.')
  if (agent.persona_mode === 'ai') {
    // Team Jarvis CAN send Slack messages as the bot, gated by a spoken confirm.
    parts.push('- When a participant asks you to SEND a Slack message to a channel or a person: you CAN send it yourself as the Jarvis bot with send_slack_message. First say out loud who you will message and the exact message text, wait for a verbal yes, and only then call send_slack_message. If the result says the recipient is ambiguous or not found, ask which channel or person they mean — do not guess. Only say it was sent if the tool result confirms it. Use draft_slack_message instead only when someone explicitly wants a draft saved for David rather than sent now.')
  } else {
    parts.push('- You cannot send or draft messages from this meeting. If someone asks you to, say plainly that you cannot do that here; never promise to send anything.')
  }
  parts.push('')
  parts.push('Response Quality:')
  parts.push('- Default: 2 to 4 substantive sentences (~15 seconds of speech). Lead with the direct answer, then the most important specifics — names, dates, statuses, numbers — drawn from the retrieved context. Brevity is the FORM, not a cap on substance: cover the key, decision-relevant facts the question needs; do NOT stop at the first fact that comes in.')
  parts.push('- When the user asks to "explain", "walk me through", "give me a pitch", or asks an open analytical question: 4 to 6 sentences, never more than ~25 seconds of speech in one turn. Pick the few facts that matter most.')
  parts.push('- INVENTORY questions ("what was completed today", "what did I work on", "what are my open items", "what happened this week") are different: COMPLETENESS beats brevity. Enumerate EVERY distinct item in the retrieved context — one short clause each ("the federated retrieval shipped, the team KB service went live, and the audio fix landed") — up to about eight items. Never report just one item when the context contains several; the user should not have to probe for the rest.')
  parts.push('- A question is "answered" when the key, decision-relevant facts are covered — NOT when you have stated the first fact. Synthesize across the retrieved context: when it carries several facts that bear on the question (e.g. a priority/status change AND a blocker AND a metric), give each in a short clause, then stop. Stay brief by cutting unasked-for background, tangents, and hedges — never by dropping substance the user actually asked about. The user should not have to ask a follow-up to get the obvious next fact.')
  parts.push('- No preamble and no recap: never open with "Here\'s a summary" or "Let me give you an overview", never restate the question, never close by summarizing what you just said.')
  parts.push('- NEVER end a response with a question. No "Want more details?", "Would you like me to...?", "Should I...?". End on the answer itself. The user will ask if they want more.')
  parts.push('- The ONLY exception: when the request is genuinely ambiguous and you cannot answer at all without clarification — then ask ONE short clarifying question and nothing else.')
  parts.push('- NEVER dump a list of search results verbatim — synthesize them into a coherent spoken answer.')
  parts.push('- Base every factual answer on tool results, not assumptions. If the retrieved context is thin, say what you do know, then state plainly what you could not find — without asking a question.')

  return parts.join('\n')
}

export function formatContextDocs(contextDocs?: Record<string, unknown>): string {
  if (!contextDocs || Object.keys(contextDocs).length === 0) return ''

  const sections: string[] = []

  const obSearch = contextDocs.ob_search
  if (Array.isArray(obSearch) && obSearch.length > 0) {
    sections.push('## Relevant Knowledge')
    for (const item of obSearch.slice(0, 5)) {
      const doc = item as Record<string, unknown>
      const title = (doc.entity_key as string) || (doc.id as string) || 'Note'
      const content = typeof doc.content === 'string' ? doc.content.slice(0, 300) : ''
      if (content) sections.push(`**${title}**: ${content}`)
    }
  }

  const contactProfiles = contextDocs.contact_profiles
  if (contactProfiles && typeof contactProfiles === 'object' && !Array.isArray(contactProfiles)) {
    const profiles = contactProfiles as Record<string, unknown>
    const names = Object.keys(profiles)
    if (names.length > 0) {
      sections.push('## Attendee Profiles')
      for (const name of names) {
        const profile = profiles[name] as Record<string, unknown>
        const content = typeof profile.content === 'string' ? profile.content.slice(0, 200) : ''
        if (content) sections.push(`**${name}**: ${content}`)
      }
    }
  }

  const recentDecisions = contextDocs.recent_decisions
  if (Array.isArray(recentDecisions) && recentDecisions.length > 0) {
    sections.push('## Recent Decisions')
    for (const item of recentDecisions.slice(0, 3)) {
      const doc = item as Record<string, unknown>
      const title = (doc.entity_key as string) || 'Decision'
      const content = typeof doc.content === 'string' ? doc.content.slice(0, 200) : ''
      if (content) sections.push(`**${title}**: ${content}`)
    }
  }

  return sections.join('\n')
}
