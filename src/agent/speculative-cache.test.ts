import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeUtterance,
  looksLikeKnowledgeQuery,
  storePrefetch,
  matchPrefetch,
  buildInjectionBlock,
  MATCH_THRESHOLD,
  INJECTION_SCORE_THRESHOLD,
  PROACTIVE_INJECTION_ENABLED,
  PREFETCH_TTL_MS,
  clearSpeculativeCache,
  __speculativeCacheSize,
} from './speculative-cache.js'

// Realistic hybrid_search RRF scores (migrations/017, k=60): the maximum
// possible fused score is 1/61 ≈ 0.0164; a rank-1 semantic-only hit is
// 0.6/61 ≈ 0.0098. Tests use this scale, not fabricated 0..1 similarities.
const RRF_MAX = 1 / 61
const RRF_STRONG = 0.012
const RRF_WEAK = 0.004

beforeEach(() => {
  clearSpeculativeCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeUtterance', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeUtterance('  What about MORGAN?! ')).toBe('what about morgan')
  })
})

describe('looksLikeKnowledgeQuery (backchannel skip)', () => {
  it('treats 4+ word utterances as queries', () => {
    expect(looksLikeKnowledgeQuery('tell me about the funnel')).toBe(true)
  })

  it('treats short utterances with a question word as queries', () => {
    expect(looksLikeKnowledgeQuery('what is OKR')).toBe(true)
  })

  it('treats short utterances naming an entity as queries', () => {
    expect(looksLikeKnowledgeQuery('about Morgan')).toBe(true) // capitalized entity
    expect(looksLikeKnowledgeQuery('the OKR doc')).toBe(true) // ALLCAPS acronym
  })

  it('skips short backchannels with no question word or entity', () => {
    expect(looksLikeKnowledgeQuery('yeah okay')).toBe(false)
    expect(looksLikeKnowledgeQuery('uh huh')).toBe(false)
    expect(looksLikeKnowledgeQuery('')).toBe(false)
  })
})

describe('storePrefetch', () => {
  it('does NOT store empty result sets (no poisoning by partial utterances)', () => {
    const entry = storePrefetch('partial utterance that matched nothing', [])
    expect(entry).toBeNull()
    expect(__speculativeCacheSize()).toBe(0)
    expect(matchPrefetch('partial utterance that matched nothing')).toBeNull()
  })

  it('returns the stored entry so the caller can build an injection block', () => {
    const entry = storePrefetch('funnel status', [{ id: 'a', content: 'x', rrf_score: RRF_STRONG }])
    expect(entry?.utterance).toBe('funnel status')
    expect(entry?.topScore).toBeCloseTo(RRF_STRONG)
  })
})

describe('matchPrefetch (hit / miss / threshold)', () => {
  it('returns an exact normalized match', () => {
    storePrefetch('what is the funnel status', [{ id: 'a', content: 'x', rrf_score: RRF_STRONG }])
    const hit = matchPrefetch('What is the funnel status?')
    expect(hit?.results[0]!.id).toBe('a')
  })

  it('matches when the CACHED utterance is a superset of the query', () => {
    storePrefetch('what is the status of the funnel report today', [{ id: 'b', content: 'x', rrf_score: RRF_STRONG }])
    expect(matchPrefetch('funnel report today')?.results[0]!.id).toBe('b')
  })

  it('does NOT let a cached PARTIAL utterance satisfy a richer query (poisoning guard)', () => {
    // Cached partial is a substring of the query — it was retrieved with less
    // information, so serving it would poison the answer. Coverage: 2/5 = 0.4.
    storePrefetch('funnel status', [{ id: 'p', content: 'x', rrf_score: RRF_STRONG }])
    expect(matchPrefetch('funnel status compared to october revenue numbers')).toBeNull()
  })

  it('matches when the cached utterance covers >= threshold of the QUERY tokens', () => {
    // query content tokens {voice, agent, latency} all covered → 3/3 = 1.0 >= 0.6.
    storePrefetch('the voice agent latency fix', [{ id: 'c', content: 'x', rrf_score: RRF_STRONG }])
    expect(matchPrefetch('voice agent latency')?.results[0]!.id).toBe('c')
    expect(MATCH_THRESHOLD).toBeGreaterThan(0)
  })

  it('misses when coverage is below threshold', () => {
    storePrefetch('voice agent latency', [{ id: 'd', content: 'x', rrf_score: RRF_STRONG }])
    expect(matchPrefetch('quarterly revenue forecast')).toBeNull()
  })

  it('returns null on an empty cache', () => {
    expect(matchPrefetch('anything')).toBeNull()
  })

  it('expires entries past the TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'))
    storePrefetch('what is the funnel status', [{ id: 't', content: 'x', rrf_score: RRF_STRONG }])

    vi.setSystemTime(new Date(Date.now() + PREFETCH_TTL_MS + 1000))
    expect(matchPrefetch('what is the funnel status')).toBeNull()
    expect(__speculativeCacheSize()).toBe(0) // expired entry evicted
  })

  it('evicts to the last 5 entries (LRU)', () => {
    // Semantically-disjoint utterances so eviction is observable without the
    // fuzzy coverage matcher cross-matching surviving neighbors.
    const utterances = [
      'quarterly revenue forecast',
      'kubernetes cluster migration',
      'dentist appointment scheduling',
      'guitar lesson recommendations',
      'mortgage refinance options',
      'birthday party catering ideas',
      'european vacation itinerary',
    ]
    utterances.forEach((u, i) => storePrefetch(u, [{ id: `r${i}`, content: 'x', rrf_score: RRF_STRONG }]))

    expect(__speculativeCacheSize()).toBe(5)
    // The two oldest are gone.
    expect(matchPrefetch(utterances[0]!)).toBeNull()
    expect(matchPrefetch(utterances[1]!)).toBeNull()
    // The five most recent survive.
    expect(matchPrefetch(utterances[6]!)?.results[0]!.id).toBe('r6')
    expect(matchPrefetch(utterances[2]!)?.results[0]!.id).toBe('r2')
  })
})

describe('buildInjectionBlock (threshold + format)', () => {
  it('fires at realistic RRF scale — top score <= 1/61 still injects', () => {
    const entry = storePrefetch('funnel status', [
      { entity_key: 'funnel-report', content: 'Conversion is up ten percent.', rrf_score: RRF_MAX },
      { entity_key: 'standup', content: 'Discussed funnel.', rrf_score: RRF_STRONG },
    ])
    const block = buildInjectionBlock(entry)
    expect(PROACTIVE_INJECTION_ENABLED).toBe(true)
    expect(RRF_MAX).toBeLessThanOrEqual(1 / 61)
    expect(block).toContain('[knowledge-base context')
    expect(block).toContain('NOT user input')
    expect(block).toContain('Conversion is up ten percent.')
    expect(block).toContain('(funnel-report)')
    expect(block).toContain('[end of knowledge-base context]')
  })

  it('returns null when the top score is below the injection floor', () => {
    expect(RRF_WEAK).toBeLessThan(INJECTION_SCORE_THRESHOLD)
    const entry = storePrefetch('weak hit', [{ entity_key: 'x', content: 'meh', rrf_score: RRF_WEAK }])
    expect(buildInjectionBlock(entry)).toBeNull()
  })

  it('keeps the injection floor reachable on the RRF scale', () => {
    // Guard against re-introducing an unreachable threshold (review finding 2):
    // the floor must sit below the maximum possible fused RRF score.
    expect(INJECTION_SCORE_THRESHOLD).toBeLessThan(RRF_MAX)
  })

  it('returns null for a null entry (empty results are never stored)', () => {
    expect(buildInjectionBlock(null)).toBeNull()
    expect(buildInjectionBlock(storePrefetch('empty results', []))).toBeNull()
  })

  it('caps the injection at the top 3 snippets', () => {
    const entry = storePrefetch('many hits here now', [
      { entity_key: 'a', content: 'one', rrf_score: RRF_MAX },
      { entity_key: 'b', content: 'two', rrf_score: RRF_MAX },
      { entity_key: 'c', content: 'three', rrf_score: RRF_MAX },
      { entity_key: 'd', content: 'four', rrf_score: RRF_MAX },
    ])
    const block = buildInjectionBlock(entry) ?? ''
    expect(block).toContain('(a)')
    expect(block).toContain('(c)')
    expect(block).not.toContain('(d)')
  })
})

describe('temporal signature guard', () => {
  it('a last-week prefetch never serves a today query', () => {
    clearSpeculativeCache()
    storePrefetch('hey jarvis what did i complete last week', [{ entity_key: 'x', content: 'last week stuff', score: 0.9 }])
    expect(matchPrefetch('hey jarvis what did i complete today')).toBeNull()
  })
  it('same window still matches', () => {
    clearSpeculativeCache()
    storePrefetch('hey jarvis what did i complete last week', [{ entity_key: 'x', content: 'last week stuff', score: 0.9 }])
    expect(matchPrefetch('jarvis what did i complete last week')).not.toBeNull()
  })
})
