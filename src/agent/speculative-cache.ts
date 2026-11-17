/**
 * R1a — per-turn speculative retrieval cache.
 *
 * As the live input transcription accumulates for a user turn, the provider
 * debounces and fires a prefetch against /api/voice/ob-search. Results land
 * here keyed by the normalized utterance. When the model later calls
 * `search_brain`, the tool handler checks this cache for a semantically-close
 * match (cached utterance covers >= MATCH_THRESHOLD of the query's content
 * tokens, or is a superset of the query) and serves it instantly —
 * `served_from: 'prefetch'` — instead of re-fetching.
 *
 * Pure, dependency-light, and unit-tested in isolation. Holds the last
 * CACHE_MAX entries (insertion-order LRU via Map).
 */

export interface SpeculativeEntry {
  /** Normalized utterance the prefetch was keyed on. */
  utterance: string
  /** Raw (untrimmed) hybrid-search rows the prefetch returned. */
  results: Record<string, unknown>[]
  /** Top RRF/similarity score across the results (0 when empty). */
  topScore: number
  timestamp: number
}

const CACHE_MAX = 5
/** Entries older than this are stale — the conversation has moved on. */
export const PREFETCH_TTL_MS = 120_000
/** Share of the QUERY's content tokens the cached utterance must cover. */
export const MATCH_THRESHOLD = 0.6
/**
 * Proactive context injection master switch (R1a). Default ON. Flip to false to
 * disable the `[knowledge-base context…]` injection if it causes the model to
 * double-talk or over-ground; speculative cache serving is unaffected.
 */
export const PROACTIVE_INJECTION_ENABLED = true
/**
 * Top-score floor for proactive injection — only inject on strong hits.
 * Calibrated to the RRF scale: hybrid_search (supabase/migrations/017, k=60,
 * weights 0.6/0.3/0.1) caps the score at (0.6+0.3+0.1)/(60+1) ≈ 0.0164
 * (≈0.033 with the compiled_truth 2x boost). 0.009 ≈ a rank-1 hit on the
 * semantic list alone (0.6/61 ≈ 0.0098), i.e. "top result is a genuinely
 * strong semantic match".
 */
export const INJECTION_SCORE_THRESHOLD = 0.009
/** How many top snippets to inject, and how long each may be. */
export const INJECTION_TOP_K = 3
export const INJECTION_SNIPPET_CHARS = 240

const cache = new Map<string, SpeculativeEntry>()

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'do',
  'does', 'for', 'from', 'has', 'have', 'i', 'if', 'in', 'is', 'it', 'me',
  'my', 'of', 'on', 'or', 'our', 'the', 'to', 'up', 'was', 'we', 'what',
  'when', 'where', 'who', 'why', 'with', 'you', 'your',
])

const QUESTION_WORDS = new Set(['what', 'who', 'when', 'where', 'why', 'how', 'which', 'whose'])

export function normalizeUtterance(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenize(text: string): string[] {
  return normalizeUtterance(text)
    .split(' ')
    .filter((t) => t.length > 0)
}

function contentTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)))
}

/**
 * Whether an utterance looks like a knowledge query worth prefetching. Keeps it
 * simple per spec: skip backchannels — fewer than 4 words AND no question word
 * AND no capitalized/named-entity-ish token. Everything else is fair game.
 */
export function looksLikeKnowledgeQuery(rawUtterance: string): boolean {
  const trimmed = rawUtterance.trim()
  if (!trimmed) return false
  const words = trimmed.split(/\s+/)
  if (words.length >= 4) return true

  const lowerTokens = tokenize(trimmed)
  if (lowerTokens.some((t) => QUESTION_WORDS.has(t))) return true

  // A named-entity heuristic: any non-leading capitalized word, or any
  // multi-char ALLCAPS token (acronyms like "BZ", "OKR"). Cheap and good enough.
  const hasNamedEntity = words.some((w, i) => {
    if (/^[A-Z]{2,}$/.test(w)) return true
    return i > 0 && /^[A-Z][a-z]/.test(w)
  })
  return hasNamedEntity
}

/**
 * Share of the QUERY's content tokens covered by the cached utterance (0..1).
 * Query-denominator on purpose: a cached PARTIAL utterance must not satisfy a
 * richer query (it was retrieved with less information — serving it would
 * poison the answer). A cached SUPERSET utterance covering the whole query is
 * fine (it was retrieved with more information).
 */
function coverageRatio(queryTokens: Set<string>, cachedTokens: Set<string>): number {
  if (queryTokens.size === 0 || cachedTokens.size === 0) return 0
  let shared = 0
  for (const t of queryTokens) if (cachedTokens.has(t)) shared++
  return shared / queryTokens.size
}

/**
 * Store a prefetch result. Empty result sets are NOT cached — a partial
 * utterance that matched nothing must not mask a later, fuller query (the live
 * fetch should run instead). Returns the stored entry (so the caller can
 * immediately build an injection block from it) or null when skipped.
 */
export function storePrefetch(utterance: string, results: Record<string, unknown>[]): SpeculativeEntry | null {
  const key = normalizeUtterance(utterance)
  if (!key || results.length === 0) return null
  const topScore = results.reduce((max, r) => {
    const s = Number(r.rrf_score ?? r.similarity ?? r.score ?? 0)
    return Number.isFinite(s) && s > max ? s : max
  }, 0)
  const entry: SpeculativeEntry = { utterance: key, results, topScore, timestamp: Date.now() }
  // Re-insert to mark MRU.
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return entry
}

function isExpired(entry: SpeculativeEntry): boolean {
  return Date.now() - entry.timestamp > PREFETCH_TTL_MS
}

/**
 * Temporal expression in an utterance, if any. A cached prefetch for one time
 * window must never serve a query about a different one ("what did I complete
 * last week" vs "...today" share almost all content tokens but are disjoint
 * questions).
 */
const TEMPORAL_SIGNATURE_RE = /\b(today|yesterday|tomorrow|this week|last week|past week|next week|this month|last month)\b/
export function temporalSignature(text: string): string | null {
  const m = text.toLowerCase().match(TEMPORAL_SIGNATURE_RE)
  return m?.[1] ?? null
}

/**
 * Find a cached prefetch that semantically covers `query`. A hit requires a
 * fresh (within PREFETCH_TTL_MS) entry AND one of:
 *  - exact normalized match, OR
 *  - the CACHED utterance is a superset containing the query (never the
 *    reverse — a cached partial utterance must not satisfy a richer query), OR
 *  - the cached utterance covers >= MATCH_THRESHOLD of the QUERY's content
 *    tokens (stopwords stripped).
 * Returns the entry (and re-marks it MRU) or null.
 */
export function matchPrefetch(query: string): SpeculativeEntry | null {
  const norm = normalizeUtterance(query)
  if (!norm) return null

  const direct = cache.get(norm)
  if (direct) {
    if (isExpired(direct)) {
      cache.delete(norm)
    } else {
      cache.delete(norm)
      cache.set(norm, direct)
      return direct
    }
  }

  const queryTokens = contentTokens(query)
  let best: SpeculativeEntry | null = null
  let bestRatio = 0

  for (const entry of [...cache.values()]) {
    if (isExpired(entry)) {
      cache.delete(entry.utterance)
      continue
    }
    if (temporalSignature(entry.utterance) !== temporalSignature(query)) {
      // Different (or missing-vs-present) time window — never serve across it.
      continue
    }
    if (entry.utterance.includes(norm)) {
      // Cached utterance is the superset — strongest signal, most recent wins.
      best = entry
      bestRatio = 1
      continue
    }
    const ratio = coverageRatio(queryTokens, contentTokens(entry.utterance))
    if (ratio >= MATCH_THRESHOLD && ratio > bestRatio) {
      best = entry
      bestRatio = ratio
    }
  }

  if (best) {
    cache.delete(best.utterance)
    cache.set(best.utterance, best)
  }
  return best
}

/**
 * Build the compact, clearly-labeled context block to proactively inject when a
 * prefetch returns strong hits. Returns null when injection is disabled, the
 * top score is below the floor, or there's nothing to inject.
 */
export function buildInjectionBlock(entry: SpeculativeEntry | null): string | null {
  if (!PROACTIVE_INJECTION_ENABLED) return null
  if (!entry || entry.results.length === 0) return null
  if (entry.topScore < INJECTION_SCORE_THRESHOLD) return null

  const snippets = entry.results
    .slice(0, INJECTION_TOP_K)
    .map((r) => {
      const label = (r.entity_key as string) || (r.doc_type as string) || 'note'
      const content = typeof r.content === 'string' ? r.content : ''
      const snippet = content.replace(/\s+/g, ' ').trim().slice(0, INJECTION_SNIPPET_CHARS)
      return snippet ? `- (${label}) ${snippet}` : null
    })
    .filter((s): s is string => s !== null)

  if (snippets.length === 0) return null

  return `[knowledge-base context for the current question — retrieved automatically, NOT user input; ground on it if relevant, otherwise ignore it]\n${snippets.join('\n')}\n[end of knowledge-base context]`
}

/** Clear the speculative cache (called on session stop; also used by tests). */
export function clearSpeculativeCache(): void {
  cache.clear()
}

/** Test-only: current cache size. */
export function __speculativeCacheSize(): number {
  return cache.size
}
