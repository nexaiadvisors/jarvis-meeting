import { describe, expect, it } from 'vitest'
import {
  ANAPHORA_PATTERNS,
  SEARCH_QUERY_STOPWORDS,
  buildSearchQuery,
  type RecentTurn,
} from './query-context.js'

const opts = {
  wakeWord: 'Jarvis',
  aliases: ['travis', 'jervis', 'gervis', 'jarvas'],
}

function expectTerms(query: string, terms: string[]): void {
  const tokens = new Set(query.split(/\s+/).filter(Boolean))
  for (const term of terms) {
    expect(tokens.has(term), `${query} should contain ${term}`).toBe(true)
  }
}

describe('buildSearchQuery', () => {
  it('canonicalizes "on-site"/"on site" to the corpus term "onsite" (2026-07-15 live retrieval miss)', () => {
    // Live failure: "on-site" tokenized to "on"+"site", "on" is a stopword, so
    // the query became "site engineering meeting" and matched recurring eng
    // huddles instead of the Product Onsite. The corpus spells it "onsite".
    for (const utterance of [
      'Jarvis, what can you tell me about the on-site engineering meeting?',
      'Jarvis, what happened at the on site engineering meeting?',
      'Jarvis, recap the onsite engineering meeting',
    ]) {
      const result = buildSearchQuery(utterance, [], opts)
      expectTerms(result.query, ['onsite', 'engineering', 'meeting'])
      expect(result.query).not.toMatch(/\bsite\b/) // never the bare mangled "site"
    }
  })

  it('pulls campaign allocation and dd1 context from prior turns when the wake utterance says "this"', () => {
    const result = buildSearchQuery(
      'Hey Jarvis, do you have context about this?',
      [
        {
          speaker: 'Kai',
          text: "...there's one specific thread that mentioned something about dd1 or 1dd ... the campaign allocation ...",
          isAgent: false,
        },
      ],
      opts,
    )

    expectTerms(result.query, ['campaign', 'allocation', 'dd1'])
    expect(result.contextTerms).toEqual(expect.arrayContaining(['campaign', 'allocation', 'dd1', '1dd']))
    expect(result.query).not.toContain('jarvis')
  })

  it('pulls tivli, queue, and call routing terms from prior non-agent turns', () => {
    const result = buildSearchQuery(
      'That was a question for you, Jarvis.',
      [
        {
          speaker: 'Kai',
          text: "...if the call is from, I don't know, Tivli or another source or another queue, it might be an issue. Can we investigate that?",
          isAgent: false,
        },
      ],
      opts,
    )

    expectTerms(result.query, ['call', 'tivli', 'queue'])
    expect(result.contextTerms).toEqual(expect.arrayContaining(['call', 'tivli', 'queue']))
  })

  it('keeps data-list terms and pulls vendor numbers, zendesk, and salesforce from prior turns', () => {
    const turns: RecentTurn[] = [
      {
        speaker: 'David',
        text: 'The data list for Kai came from vendor numbers first, then enrichment.',
        isAgent: false,
      },
      {
        speaker: 'Kai',
        text: 'We also reconciled Zendesk tickets against Salesforce contacts before sharing it.',
        isAgent: false,
      },
    ]

    const result = buildSearchQuery(
      'Hi, and Jarvis, would you be able to explain how we built the data list for Kai?',
      turns,
      opts,
    )

    expectTerms(result.query, ['data', 'list', 'kai', 'vendor', 'numbers', 'zendesk', 'salesforce'])
    expect(result.contextTerms).toEqual(expect.arrayContaining(['vendor', 'numbers', 'zendesk', 'salesforce']))
  })

  it('passes a content-rich wake utterance through as content words without harvesting context', () => {
    const result = buildSearchQuery(
      'Hey Jarvis, what is the status of AI receptionist compliance recording retention?',
      [
        {
          speaker: 'Kai',
          text: 'Unrelated Tivli queue call routing tangent.',
          isAgent: false,
        },
      ],
      opts,
    )

    expect(result.query).toBe('status ai receptionist compliance recording retention')
    expect(result.contextTerms).toEqual([])
  })

  it('never includes agent turns in harvested context', () => {
    const result = buildSearchQuery(
      'Hey Jarvis, what about this?',
      [
        {
          speaker: 'Jarvis',
          text: 'The campaign allocation dd1 answer came from an agent turn and must not be searched.',
          isAgent: true,
        },
        {
          speaker: 'Kai',
          text: 'The human context was the Tivli call queue.',
          isAgent: false,
        },
      ],
      opts,
    )

    expectTerms(result.query, ['tivli', 'call', 'queue'])
    expect(result.query).not.toContain('campaign')
    expect(result.query).not.toContain('allocation')
    expect(result.query).not.toContain('dd1')
  })

  it('exports deterministic stopwords and anaphora patterns', () => {
    expect(SEARCH_QUERY_STOPWORDS.has('this')).toBe(true)
    expect(ANAPHORA_PATTERNS.some((pattern) => pattern.test('the third issue'))).toBe(true)
  })
})
