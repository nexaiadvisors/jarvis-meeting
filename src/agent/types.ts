/**
 * Minimal type definitions needed by the ported behavior modules.
 *
 * These shapes are copied VERBATIM from the heavy source modules that are NOT
 * ported in this increment:
 *   - MeetingAgent / Playbook / PlaybookRules: dashboard/src/lib/meetings/safety-check.ts
 *   - ToolCallResult / UIAction / UIActionType: dashboard/src/lib/voice/types.ts
 *   - FunctionDeclaration: the minimal subset of @google/genai's type used by tools.ts
 */

// --- from meetings/safety-check.ts ---

export interface MeetingAgent {
  id: string
  name: string
  role: string | null
  behavior_mode: string
  speaking_style: string | null
  persona_mode: string
  voice_id: string | null
  confidence_threshold: number
  allowed_topics: string[] | null
  denied_topics: string[]
  escalation_rules: Record<string, unknown>
  /** Wake-gate activation phrase; NULL falls back to name. Avoid the owner's name. */
  wake_word?: string | null
  /** 'legacy' (transcript->Gemini->TTS clips) | 'realtime' (Output Media + OpenAI realtime). */
  voice_engine?: string | null
  /** OpenAI realtime model override; NULL uses OPENAI_REALTIME_MODEL env default. */
  realtime_model?: string | null
  /**
   * 'researcher': the agent has one knowledge tool, ask_researcher, and never searches or
   * reads raw notes itself. Anything else: the agent calls the search tools directly.
   */
  knowledge_mode?: string | null
  /** True when the agent may hand a task to Claude Code (ask_claude_code). */
  delegate_tasks?: boolean | null
  /** True when the agent may draft and, after a spoken yes, send a Buzz message. */
  buzz_messaging?: boolean | null
  created_at: string
  updated_at: string
}

export interface PlaybookRules {
  speaking_rules?: string[]
  denied_topics?: string[]
  forbidden_commitments?: string[]
  fallback_phrases?: string[]
  escalation_triggers?: string[]
}

export interface Playbook {
  id: string
  name: string
  rules: PlaybookRules
  created_at: string
}

// --- from voice/types.ts ---

export type UIActionType = 'show_panel' | 'navigate' | 'highlight' | 'toast' | 'compose'

export interface PanelLayout {
  panel: string
  props: Record<string, unknown>
  position: 'main' | 'sidebar' | 'overlay'
  size?: 'sm' | 'md' | 'lg' | 'full'
}

export interface UIAction {
  type: UIActionType
  panel?: string
  path?: string
  entityKey?: string
  message?: string
  layout?: PanelLayout[]
  props?: Record<string, unknown>
}

export interface ToolCallResult {
  result: Record<string, unknown>
  uiAction?: UIAction
}

// --- minimal @google/genai FunctionDeclaration (only the subset tools.ts uses) ---

export interface FunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

// --- minimal browser `window` global (only the subset tools.ts uses) ---
//
// tools.ts guards every access with `typeof window !== 'undefined'`; in this
// Node service `window` is always undefined at runtime, so this declaration is
// purely to satisfy the type checker without pulling in the full DOM lib.
//
// The conditional type keeps this file usable under BOTH compiler configs: the
// service tsconfig (no DOM lib) gets the minimal shim, while the browser build
// (web/tsconfig.json, DOM lib) resolves `window` to the real `Window & typeof
// globalThis` so this declaration merges identically with the DOM lib's own
// `var window` instead of conflicting with it. Type-only — no runtime effect.
declare global {
  interface MinimalWindowLocation {
    origin: string
  }
  interface MinimalWindow {
    location: MinimalWindowLocation
  }
}
// Detect the DOM lib via `globalThis.document` (DOM-only) rather than via
// `window` itself, which would be a self-reference (TS2502). Kept in its own
// block for the same reason.
type DomLibPresent = typeof globalThis extends { document: { title: string } } ? true : false
declare global {
  // eslint-disable-next-line no-var
  var window: DomLibPresent extends true ? (typeof globalThis)['window'] : MinimalWindow | undefined
}
