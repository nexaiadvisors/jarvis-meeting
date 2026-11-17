// SOUL schema — the file-based persona definition for a meeting teammate.
//
// A SOUL.md file is YAML front-matter (between leading `---` fences) plus a
// prose body. The front-matter uses snake_case keys; this module validates it
// with zod and maps it to the camelCase `Soul` shape the rest of the service
// consumes. The prose body becomes `Soul.prose` and is appended to the realtime
// instructions.

import { z } from 'zod';

export type PersonaMode = 'first_person' | 'ai';
export type KbType = 'openbrain' | 'folder';
export type KbRoute = 'delegate' | 'jarvis';

export interface Soul {
  owner: string;
  name: string;
  wakeWord: string;
  personaMode: PersonaMode;
  voice: string;
  language: string;
  knowledgeBackend: {
    type: KbType;
    endpoint: string;
    route: KbRoute;
  };
  delivery: ('slack' | 'email' | 'ob')[];
  ingest: boolean;
  deniedTopics: string[];
  aiDisclosure: string;
  /** Where answers to spoken requests go: aloud ('voice', default) or the meeting chat ('chat'). */
  replyMode: 'voice' | 'chat';
  /** 'ask': the agent must get a spoken or typed yes from the requester before each knowledge lookup. */
  lookupApproval: 'none' | 'ask';
  /** Who answers wake-word requests: the built-in realtime agent, or an outside agent over MCP. */
  brain: 'builtin' | 'external';
  /**
   * 'assistant' (default): waits to be addressed by name. 'facilitator': leads the call,
   * hears every turn and decides itself when to speak (src/agent/facilitator.ts).
   */
  mode: 'assistant' | 'facilitator' | 'stand_in';
  /**
   * stand_in only: the first thing the bot says once the other person has spoken
   * (src/agent/stand-in.ts). Empty means a built-in line that says it is an AI.
   */
  openingLine: string;
  /**
   * stand_in only: when the briefing lacks an answer, answer in the owner's voice from
   * what the persona knows about him, or a plausible answer, instead of saying it does
   * not know. For role-play and tests. Default false: briefing facts only.
   */
  improvise: boolean;
  prose: string;
}

/**
 * Zod schema for the YAML front-matter (snake_case). Defaults keep a minimal
 * SOUL valid: only `name` is strictly required. `knowledge_backend` defaults to
 * an empty openbrain backend. NOTE: the retrieval route is NOT a front-matter
 * field — it is ALWAYS derived from `persona_mode` by the mapper (see toSoul),
 * so the owner gate cannot be bypassed via a contradictory explicit route. Any
 * `route` key in the front-matter is ignored (zod strips unknown keys).
 */
export const SoulFrontMatter = z.object({
  owner: z.string().default(''),
  name: z.string().min(1, 'name is required'),
  wake_word: z.string().default(''),
  persona_mode: z.enum(['first_person', 'ai']).default('first_person'),
  voice: z.string().default('marin'),
  language: z.string().default('en'),
  knowledge_backend: z
    .object({
      type: z.enum(['openbrain', 'folder']).default('openbrain'),
      endpoint: z.string().default(''),
    })
    .default({ type: 'openbrain', endpoint: '' }),
  delivery: z.array(z.enum(['slack', 'email', 'ob'])).default([]),
  ingest: z.boolean().default(false),
  denied_topics: z.array(z.string()).default([]),
  ai_disclosure: z.string().default(''),
  reply_mode: z.enum(['voice', 'chat']).default('voice'),
  lookup_approval: z.enum(['none', 'ask']).default('none'),
  brain: z.enum(['builtin', 'external']).default('builtin'),
  mode: z.enum(['assistant', 'facilitator', 'stand_in']).default('assistant'),
  opening_line: z.string().default(''),
  improvise: z.boolean().default(false),
});

export type SoulFrontMatterParsed = z.infer<typeof SoulFrontMatter>;

/** Map validated snake_case front-matter + prose body to the camelCase Soul. */
export function toSoul(fm: SoulFrontMatterParsed, prose: string): Soul {
  // Route is ALWAYS derived from persona_mode (never taken from front-matter)
  // so the two owner-gate enforcement points (session keyed on persona_mode,
  // retrieval keyed on route) can never disagree:
  // 'ai' -> 'jarvis' (team-KB-only), 'first_person' -> 'delegate' (owner backend).
  const route: KbRoute = fm.persona_mode === 'ai' ? 'jarvis' : 'delegate';
  return {
    owner: fm.owner,
    name: fm.name,
    wakeWord: fm.wake_word,
    personaMode: fm.persona_mode,
    voice: fm.voice,
    language: fm.language,
    knowledgeBackend: {
      type: fm.knowledge_backend.type,
      endpoint: fm.knowledge_backend.endpoint,
      route,
    },
    delivery: fm.delivery,
    ingest: fm.ingest,
    deniedTopics: fm.denied_topics,
    aiDisclosure: fm.ai_disclosure,
    replyMode: fm.reply_mode,
    lookupApproval: fm.lookup_approval,
    brain: fm.brain,
    mode: fm.mode,
    openingLine: fm.opening_line.trim(),
    improvise: fm.improvise,
    prose: prose.trim(),
  };
}
