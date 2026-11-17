/**
 * Work-scope filter for the meeting agent's OpenBrain retrieval (plan §Phase B).
 *
 * The meeting agent runs in company meetings and (optionally) on the company
 * Azure tenant — personal-life content must never reach its model context.
 * Enforcement is SERVER-SIDE in the /api/voice/* routes (filter before the LLM
 * sees anything); the prompt is never the boundary.
 *
 * Decision order (deny wins):
 *   1. entity_key matches a personal deny pattern        -> blocked
 *   2. metadata.audience === 'personal'                  -> blocked
 *   3. metadata.audience === 'work'                      -> allowed (Phase C unlock)
 *   4. namespace in the allowed-namespace list           -> allowed
 *   5. second-brain doc_type in the work allowlist       -> allowed
 *   6. anything else (mixed/unclassified/wiki/personal)  -> blocked until Phase C
 *
 * Before the order above, a personal-life term at the start of a word in the entity_key or
 * the content blocks the doc, whatever its namespace, type or audience. The default stems
 * always apply; `personalDenyTerms` (config.personalDenyTerms) adds to them.
 *
 * The owner's identity is NOT this layer's job — the curated work-persona pack
 * (plan §Phase D) carries goals/preferences/style, so this filter can stay
 * conservative without making the agent generic.
 */

export interface ScopedDoc {
  namespace?: string | null
  doc_type?: string | null
  entity_key?: string | null
  metadata?: Record<string, unknown> | null
  /** Doc body — scanned for compensation markers (deny wins in BOTH scopes). */
  content?: string | null
}

// NOTE: the team knowledge base is NOT an OpenBrain namespace — it lives in a
// separate team-KB retrieval service and joins results at query time via
// fanOutSearch (dashboard/src/lib/voice/fanout.ts).
export const WORK_SCOPE_ALLOWED_NAMESPACES = ['work']

/**
 * second-brain doc_types the bot may speak from. Deliberately conservative: only types
 * that are work output by construction. Transcripts, meeting prep and notes, Slack
 * drafts, decisions and the daily/weekly rollups are NOT here, because they routinely
 * mix work with personal-life content (a pediatrician call is a `meeting-transcript`).
 */
export const WORK_SCOPE_ALLOWED_DOC_TYPES = [
  'work-output',
  'lesson-learned',
  'lesson',
  'plan',
  'implementation-plan',
  'task-plan',
  'prd',
  'report',
  'analysis',
  'analysis-report',
  'research',
  'research-report',
  'runbook',
  'playbook',
  'engineering-artifact',
  'pr-merge-event',
  'investigation',
  'handoff',
  'agent-run',
  'skill-doc',
]

/**
 * Extra second-brain doc_types admitted ONLY in the owner-only scope (the owner is the
 * one person in the call, see isOwnerOnly in meeting/registry.ts). These are the types
 * that hold client conversations. They stay blocked whenever anyone else is present,
 * because a call with one client could be quoted to another. Rollups stay blocked in
 * both scopes: one rollup mixes every project and personal items.
 */
export const OWNER_ONLY_EXTRA_DOC_TYPES = ['meeting-transcript', 'decision', 'meeting-prep']

/**
 * Prefix for a PERSONAL_DENY_TERMS entry that names an owner-only key term, for example
 * `key:sidebiz`. A document whose entity_key contains the term is private from guests,
 * but the owner may hear it in a call where the owner is the only person present. Use it
 * for the owner's own company notes (rate card, revenue plan, client packs).
 */
export const OWNER_ONLY_KEY_PREFIX = 'key:'

/**
 * Default personal-life STEMS (PERSONAL_DENY_TERMS adds to them, never replaces them).
 * A document is dropped when ANY term appears at the START of a word, case-insensitively,
 * in its entity_key OR its content, so a stem also catches plurals and joined forms:
 * `nann` -> nanny, nannies; `babysit` -> babysitter(s), babysitting; `pediatric` ->
 * pediatrics, pediatrician(s). Add your own family names, household names and any other
 * business in PERSONAL_DENY_TERMS: `milo` then catches Milo's, milo_fever and miloFever.
 */
export const DEFAULT_PERSONAL_DENY_TERMS = [
  'pediatric',
  'nann',
  'preschool',
  'babysit',
  'mortgage',
]

/**
 * High-precision personal markers in entity keys. Deny ALWAYS wins — even over
 * an (mis)classified audience tag or an allowed doc_type.
 */
export const WORK_SCOPE_DENY_KEY_PATTERNS: RegExp[] = [
  /^personal/i,
  /^user_md$/i,
  /\blease\b|^lease|-lease/i,
  /dispute/i,
  /family/i,
]

/**
 * Compensation / salary is a HARD no-answer topic. Enforcement was prompt-only
 * and leaked a salary RANGE live; this is the server-side half. Any doc whose
 * entity_key OR content indicates salary, compensation, an offer, equity, or a
 * negotiation is denied in BOTH scopes so a figure never reaches the model.
 * Comp docs can live in the `work` namespace (e.g.
 * transcript_morgan_..._negotiation) which isWorkSafe would otherwise ADMIT,
 * so this deny must win first. Mirrors services/ob-retrieval/scope.ts.
 */
export const COMP_DENY_KEY_PATTERNS: RegExp[] = [
  /\bnegotiation\b/i,
  /\bsalar(?:y|ies)\b/i,
  /\bcompensation\b/i,
  /\bcomp[-_ ]?(decision|review|band|plan|package|analysis|increase)\b/i,
  /\bbase[-_ ]?comp\b/i,
  /\boffer[-_ ]?(letter|call|prep)\b/i,
  /\bemployment[-_ ]?offer\b/i,
  /\bpay[-_ ]?(band|stub|roll|slip|raise)\b/i,
  /\bpayband\b/i,
  /\b(equity|rsus?|stock[-_ ]?options?)\b/i,
  /\btotal[-_ ]?comp\b/i,
]

// CONTENT match stays high-precision on the BARE comp nouns (salary, compensation,
// equity, rsu) — those appear in people/career/company docs ("Pat is final
// approver on compensation"; "bonus and equity vest over time") that must stay
// answerable for "who is X" and role/career questions, so a bare mention is NOT
// denied. What IS denied: explicit figure-labels, comp artifacts, and — the leak
// that motivated the broadening — comp terms sitting NEXT TO an actual number /
// percent / "basis points" / an "N-year vest". The real `career` doc leaked
// because it carried "Base comp increase", "Bonus: 15% -> 25%", "Equity: 0.25%
// (25 basis points), 4-year vest", "terms of an employment offer", and a
// "Negotiation" of that offer — none of which the old narrow regex matched.
// Scanned against FULL (hydrated) content. Mirrors services/ob-retrieval/scope.ts.
export const COMP_DENY_CONTENT_RE =
  /\b(base salary|base pay|base comp(?:ensation)?|comp(?:ensation)? increase|total comp(?:ensation)?|comp package|comp(?:ensation)? decision|compensation (?:package|range|discussion|negotiation)|offer letter|employment offer|signing bonus|annual bonus|pay ?band|pay raise|basis points|salary (?:range|expectation|history|negotiation|band|figure))\b|\b\d+[-\s]year vest\b|\b(?:bonus|equity)\b[^.\n]{0,40}?(?:\d|%|basis points)|(?:\d|%|basis points)[^.\n]{0,40}?\b(?:bonus|equity)\b|\bnegotiation\b[^.\n]{0,40}?\boffer\b|\boffer\b[^.\n]{0,40}?\bnegotiation\b/i

/** True when a doc is about compensation by entity_key OR content. */
export function isCompensationDoc(doc: ScopedDoc): boolean {
  // Normalize entity-key delimiters to spaces so \b word-boundaries fire: '_' is
  // a \w char, so /\bnegotiation\b/ would NOT match 'transcript_..._negotiation'.
  const key = (doc.entity_key ?? '').replace(/[_-]+/g, ' ')
  if (key.trim() !== '' && COMP_DENY_KEY_PATTERNS.some((p) => p.test(key))) return true
  const content = typeof doc.content === 'string' ? doc.content : ''
  return content !== '' && COMP_DENY_CONTENT_RE.test(content)
}

/**
 * The terms in force: the defaults plus any extra terms (PERSONAL_DENY_TERMS), trimmed,
 * blanks dropped, de-duplicated case-insensitively. Extra terms can only add to the defaults.
 */
export function mergePersonalDenyTerms(extra: readonly string[] = []): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const raw of [...DEFAULT_PERSONAL_DENY_TERMS, ...extra]) {
    const term = raw.trim()
    if (term === '' || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    merged.push(term)
  }
  return merged
}

const personalPatternCache = new Map<string, RegExp>()

/** One case-insensitive pattern: any term at the start of a word (not touching a letter or digit before it). */
function personalTermsPattern(extra: readonly string[]): RegExp {
  const terms = mergePersonalDenyTerms(extra).filter((t) => !t.toLowerCase().startsWith(OWNER_ONLY_KEY_PREFIX))
  const cacheKey = terms.join('\u0000')
  const cached = personalPatternCache.get(cacheKey)
  if (cached !== undefined) return cached
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join('|')})`, 'i')
  personalPatternCache.set(cacheKey, pattern)
  return pattern
}

/**
 * Expose every word start before matching: `_` becomes a space and a space is inserted at
 * each lowercase-to-uppercase boundary, so `milo_fever`, `miloFever` and `MiloLee`
 * all show their term at a word start. (`Napoleon` still has no word start.)
 */
function normalizeForTermMatch(text: string): string {
  return text.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}

/**
 * True when the entity_key or the content has a personal-life term at the start of a word.
 * The default stems always apply; `extraTerms` (config.personalDenyTerms) only adds to them.
 */
export function hasPersonalMarker(doc: ScopedDoc, extraTerms: readonly string[] = []): boolean {
  const pattern = personalTermsPattern(extraTerms)
  const key = doc.entity_key ?? ''
  const content = typeof doc.content === 'string' ? doc.content : ''
  return (
    (key !== '' && pattern.test(normalizeForTermMatch(key))) ||
    (content !== '' && pattern.test(normalizeForTermMatch(content)))
  )
}

/** True when the entity_key contains a `key:` term from PERSONAL_DENY_TERMS (case-insensitive). */
function hasOwnerOnlyKeyTerm(key: string, terms: readonly string[]): boolean {
  const lower = key.toLowerCase()
  return terms.some((raw) => {
    const term = raw.trim().toLowerCase()
    return term.startsWith(OWNER_ONLY_KEY_PREFIX) && term.length > OWNER_ONLY_KEY_PREFIX.length && lower.includes(term.slice(OWNER_ONLY_KEY_PREFIX.length))
  })
}

/** How many extra results to overfetch before filtering (late-binding recall cushion). */
export const WORK_SCOPE_OVERFETCH = 4
export const WORK_SCOPE_MAX_FETCH = 40

function audienceOf(doc: ScopedDoc): string | undefined {
  const a = doc.metadata?.audience
  return typeof a === 'string' ? a.toLowerCase() : undefined
}

/**
 * `allowedNamespaces` is the list of namespaces admitted wholesale. It defaults to
 * the built-in WORK_SCOPE_ALLOWED_NAMESPACES so existing callers keep their
 * behavior; the meeting bot passes config.workScopeNamespaces, whose default is
 * [] (no namespace wholesale — only the second-brain doc_type allowlist applies).
 *
 * `ownerOnly` widens the scope for a call where the owner is the only person present:
 * OWNER_ONLY_EXTRA_DOC_TYPES are admitted and the `key:` terms are lifted. Every
 * other deny (personal keys and terms, compensation, a personal audience) still wins.
 */
export function isWorkSafe(
  doc: ScopedDoc,
  allowedNamespaces: string[] = WORK_SCOPE_ALLOWED_NAMESPACES,
  personalDenyTerms: readonly string[] = [],
  ownerOnly = false,
): boolean {
  const key = doc.entity_key ?? ''
  if (key && WORK_SCOPE_DENY_KEY_PATTERNS.some((p) => p.test(key))) return false
  if (key && !ownerOnly && hasOwnerOnlyKeyTerm(key, personalDenyTerms)) return false
  if (isCompensationDoc(doc)) return false // hard no-answer topic — overrides every allow
  if (hasPersonalMarker(doc, personalDenyTerms)) return false // personal-life term in key or content — overrides every allow

  const audience = audienceOf(doc)
  if (audience === 'personal') return false
  if (audience === 'work') return true

  if (doc.namespace && allowedNamespaces.includes(doc.namespace)) return true
  if (doc.namespace === 'second-brain' && doc.doc_type && WORK_SCOPE_ALLOWED_DOC_TYPES.includes(doc.doc_type)) {
    return true
  }
  if (ownerOnly && doc.namespace === 'second-brain' && doc.doc_type && OWNER_ONLY_EXTRA_DOC_TYPES.includes(doc.doc_type)) {
    return true
  }
  return false
}

export function filterWorkSafe<T extends ScopedDoc>(docs: T[], limit: number): T[] {
  // Arrow wrapper on purpose: Array#filter would pass the index as the 2nd argument.
  return docs.filter((d) => isWorkSafe(d)).slice(0, limit)
}

/**
 * Second-layer filter for kb-server search results ({text, source, score}), where
 * `source` is `<namespace>/<doc_type>/<entity_key...>` (the entity_key may itself
 * contain "/"). The kb-server instance already enforces its own retrieval scope;
 * this keeps the bot from depending on that alone. Fail-closed: a source with
 * fewer than three segments, or with an empty namespace, doc_type or entity_key,
 * cannot be classified and is dropped.
 */
export function filterWorkScopedResults<T extends { text: string; source: string }>(
  results: T[],
  allowedNamespaces: string[],
  personalDenyTerms: readonly string[] = [],
  ownerOnly = false,
): T[] {
  return results.filter((result) => {
    const [namespace, doc_type, ...rest] = result.source.split('/')
    const entity_key = rest.join('/')
    if (!namespace || !doc_type || !entity_key) return false
    return isWorkSafe({ namespace, doc_type, entity_key, content: result.text }, allowedNamespaces, personalDenyTerms, ownerOnly)
  })
}

/** Overfetch size for a requested limit, bounded to keep ob CLI calls cheap. */
export function overfetchLimit(limit: number): number {
  return Math.min(WORK_SCOPE_MAX_FETCH, Math.max(limit, 1) * WORK_SCOPE_OVERFETCH)
}

interface ContextResult extends ScopedDoc {
  content?: string
  created_at?: string
  updated_at?: string
  id?: string
}

/**
 * Compact markdown formatter for scope-filtered context (replaces `ob
 * get-context` output when scope='work', since that formatted text can't be
 * filtered post-hoc). Includes data-age stamps per plan §Phase 3.
 */
export function formatWorkContext(results: ContextResult[]): string {
  if (results.length === 0) return ''
  const lines = results.map((r) => {
    const title = r.entity_key || r.id || 'note'
    const when = r.updated_at || r.created_at
    const age = when ? ` (as of ${String(when).slice(0, 10)})` : ''
    const content = typeof r.content === 'string' ? r.content.slice(0, 1500) : ''
    return `**${title}**${age}: ${content}`
  })
  return `## Relevant Knowledge (work scope)\n${lines.join('\n')}`
}
