import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONAL_DENY_TERMS,
  WORK_SCOPE_ALLOWED_DOC_TYPES,
  filterWorkSafe,
  formatWorkContext,
  hasPersonalMarker as hasPersonalMarkerRaw,
  isCompensationDoc,
  isWorkSafe as isWorkSafeRaw,
  filterWorkScopedResults as filterWorkScopedResultsRaw,
  mergePersonalDenyTerms,
  overfetchLimit,
} from './work-scope.js'

// The terms this test owner put in PERSONAL_DENY_TERMS: two family names, a second
// business, and one owner-only key term. Every call below runs with them.
const OWNER_TERMS = ['milo', 'robin', 'sideshop', 'key:nexai']
type Doc = Parameters<typeof isWorkSafeRaw>[0]
type Hits = Parameters<typeof filterWorkScopedResultsRaw>[0]
const isWorkSafe = (doc: Doc, ns?: string[], terms: readonly string[] = [], ownerOnly = false) =>
  isWorkSafeRaw(doc, ns, [...OWNER_TERMS, ...terms], ownerOnly)
const filterWorkScopedResults = <T extends Hits[number]>(hits: T[], ns?: string[], terms: readonly string[] = [], ownerOnly = false) =>
  filterWorkScopedResultsRaw(hits, ns, [...OWNER_TERMS, ...terms], ownerOnly) as T[]
const hasPersonalMarker = (doc: Doc, terms: readonly string[] = []) => hasPersonalMarkerRaw(doc, [...OWNER_TERMS, ...terms])

describe('isWorkSafe', () => {
  it('allows the work namespace regardless of doc_type', () => {
    expect(isWorkSafe({ namespace: 'work', doc_type: 'document', entity_key: 'platform-arch' })).toBe(true)
    expect(isWorkSafe({ namespace: 'work', doc_type: 'email-thread', entity_key: 'thread-1' })).toBe(true)
  })

  it('allows second-brain work doc_types', () => {
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'work-output', entity_key: 'robo-sdr_main' })).toBe(true)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'lesson-learned', entity_key: 'fabric-livy' })).toBe(true)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'report', entity_key: 'r-1' })).toBe(true)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'plan', entity_key: 'p-1' })).toBe(true)
  })

  it('blocks mixed/unclassified doc_types until Phase C tags them', () => {
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'context-file', entity_key: 'company_decisions' })).toBe(false)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'signal', entity_key: 'sig-1' })).toBe(false)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'communication', entity_key: 'comm-1' })).toBe(false)
    expect(isWorkSafe({ namespace: 'wiki', doc_type: 'entity', entity_key: 'morgan' })).toBe(false)
  })

  it('unlocks mixed doc_types when metadata.audience=work (Phase C)', () => {
    expect(
      isWorkSafe({
        namespace: 'second-brain',
        doc_type: 'context-file',
        entity_key: 'company_decisions',
        metadata: { audience: 'work' },
      }),
    ).toBe(true)
    expect(
      isWorkSafe({ namespace: 'wiki', doc_type: 'entity', entity_key: 'morgan', metadata: { audience: 'work' } }),
    ).toBe(true)
  })

  it('blocks audience=personal even in otherwise-allowed categories', () => {
    expect(
      isWorkSafe({
        namespace: 'second-brain',
        doc_type: 'work-output',
        entity_key: 'side-thing',
        metadata: { audience: 'personal' },
      }),
    ).toBe(false)
  })

  it('deny patterns win over everything — allowed doc_type, audience=work, work namespace', () => {
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'plan', entity_key: 'sideshop_b2b_plan' })).toBe(false)
    expect(
      isWorkSafe({
        namespace: 'second-brain',
        doc_type: 'report',
        entity_key: 'personal_disputes_summary',
        metadata: { audience: 'work' },
      }),
    ).toBe(false)
    expect(isWorkSafe({ namespace: 'work', doc_type: 'document', entity_key: 'nexai-overlap-notes' })).toBe(false)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'contract', entity_key: 'lease-renewal-2026' })).toBe(false)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'research', entity_key: 'family-trip-ideas' })).toBe(false)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'reference', entity_key: 'user_md' })).toBe(false)
  })
})

describe('filterWorkSafe / overfetchLimit', () => {
  it('filters then truncates to the requested limit', () => {
    const docs = [
      { namespace: 'second-brain', doc_type: 'work-output', entity_key: 'a' },
      { namespace: 'second-brain', doc_type: 'context-file', entity_key: 'b' },
      { namespace: 'work', doc_type: 'document', entity_key: 'c' },
      { namespace: 'second-brain', doc_type: 'plan', entity_key: 'd' },
    ]
    const out = filterWorkSafe(docs, 2)
    expect(out.map((d) => d.entity_key)).toEqual(['a', 'c'])
  })

  it('overfetches 4x bounded at 40', () => {
    expect(overfetchLimit(8)).toBe(32)
    expect(overfetchLimit(15)).toBe(40)
    expect(overfetchLimit(0)).toBe(4)
  })
})

describe('formatWorkContext', () => {
  it('formats with data-age stamps', () => {
    const text = formatWorkContext([
      { entity_key: 'robo-sdr_main', content: 'Eval harness shipped.', updated_at: '2026-06-09T10:00:00Z' },
    ])
    expect(text).toContain('robo-sdr_main')
    expect(text).toContain('as of 2026-06-09')
  })

  it('returns empty string for no results', () => {
    expect(formatWorkContext([])).toBe('')
  })
})

describe('compensation is a HARD no-answer topic (deny wins)', () => {
  const compByKey = [
    { namespace: 'work', doc_type: 'transcript', entity_key: 'transcript_morgan_2026-03-11_negotiation' },
    { namespace: 'work', doc_type: 'document', entity_key: 'comp-decision-2026' },
    { namespace: 'work', doc_type: 'document', entity_key: 'equity-grant-schedule' },
    { namespace: 'second-brain', doc_type: 'note', entity_key: 'salary-history' },
    { namespace: 'second-brain', doc_type: 'work-output', entity_key: 'offer-letter-draft' },
    { namespace: 'second-brain', doc_type: 'note', entity_key: 'payband-bands' },
  ]
  for (const doc of compByKey) {
    it(`denies comp entity_key "${doc.entity_key}"`, () => {
      expect(isWorkSafe(doc)).toBe(false)
    })
  }

  it('denies by CONTENT even when the entity_key looks innocuous', () => {
    const doc = {
      namespace: 'work',
      doc_type: 'document',
      entity_key: 'morgan_call_prep_2026-03-12',
      content: 'TOPIC 1: Comp Decision. Key Numbers: base salary and a signing bonus.',
    }
    expect(isCompensationDoc(doc)).toBe(true)
    expect(isWorkSafe(doc)).toBe(false)
  })

  it('filters comp docs out of an otherwise work-safe set', () => {
    const docs = [
      { namespace: 'second-brain', doc_type: 'work-output', entity_key: 'fabric_2026-06-24' },
      { namespace: 'work', doc_type: 'transcript', entity_key: 'transcript_morgan_negotiation' },
    ]
    expect(filterWorkSafe(docs, 10).map((d) => d.entity_key)).toEqual(['fabric_2026-06-24'])
  })

  it('does NOT over-block ordinary work docs', () => {
    const ok = {
      namespace: 'second-brain',
      doc_type: 'work-output',
      entity_key: 'fabric-pipeline_2026-06-24',
      content: 'Shipped the Bronze ingest and fixed the Livy concurrency cap.',
    }
    expect(isCompensationDoc(ok)).toBe(false)
    expect(isWorkSafe(ok)).toBe(true)
  })

  it('denies a figure doc by FULL-content label even when entity_key is innocuous', () => {
    const offerPrep = {
      namespace: 'work',
      doc_type: 'document',
      entity_key: 'morgan_offer_call_prep',
      content: 'Offer call prep. Discuss the Total Comp target and base salary; bonus split.',
    }
    expect(isCompensationDoc(offerPrep)).toBe(true)
    expect(isWorkSafe(offerPrep)).toBe(false)
  })

  it('does NOT deny people/career docs that merely MENTION compensation (precision)', () => {
    const roster = {
      namespace: 'second-brain',
      doc_type: 'context-file',
      entity_key: 'company_people',
      content: 'Pat Rad is final approver on hiring decisions and compensation. Skeptical on principal leveling due to equity sensitivity.',
    }
    expect(isCompensationDoc(roster)).toBe(false)
    const career = {
      namespace: 'second-brain',
      doc_type: 'reference',
      entity_key: 'career',
      content: 'Career path notes: bonus and equity vest over time; RSU schedule mentioned.',
    }
    expect(isCompensationDoc(career)).toBe(false)
  })

  it('DENIES the figure-laden career doc (the live leak) by broadened CONTENT regex', () => {
    // The real `career` doc leaked a comp range because the OLD narrow regex did
    // not match these phrasings. The broadened COMP_DENY_CONTENT_RE (mirrored from
    // services/ob-retrieval/scope.ts) must catch each one — deny wins.
    const career = {
      namespace: 'second-brain',
      doc_type: 'reference',
      entity_key: 'career',
      content:
        'Base comp increase under discussion. Bonus: 15% -> 25%. Equity: 0.25% (25 basis points), 4-year vest. Reviewing the terms of an employment offer.',
    }
    expect(isCompensationDoc(career)).toBe(true)
    expect(isWorkSafe(career)).toBe(false)
  })

  it('matches each broadened comp content phrase individually (precision preserved on bare mentions)', () => {
    const denied = [
      'Base comp increase planned for next cycle.',
      'Bonus: 15% -> 25% this year.',
      'Equity: 0.25% (25 basis points), 4-year vest.',
      'Reviewing the terms of an employment offer.',
      'A pay raise is on the table.',
    ]
    for (const content of denied) {
      expect(isCompensationDoc({ namespace: 'second-brain', doc_type: 'reference', entity_key: 'career', content })).toBe(true)
    }
    // Bare mentions with no figure/artifact stay answerable.
    expect(
      isCompensationDoc({
        namespace: 'second-brain',
        doc_type: 'reference',
        entity_key: 'career',
        content: 'Career notes: discussed bonus and equity broadly; no numbers.',
      }),
    ).toBe(false)
  })
})

describe('isWorkSafe allowed-namespace list', () => {
  it('denies namespace "initech" when allowedNamespaces is []', () => {
    expect(isWorkSafe({ namespace: 'initech', doc_type: 'document', entity_key: 'x' }, [])).toBe(false)
  })

  it('an empty list allows no namespace wholesale, even the built-in default "work"', () => {
    expect(isWorkSafe({ namespace: 'work', doc_type: 'document', entity_key: 'platform-arch' })).toBe(true)
    expect(isWorkSafe({ namespace: 'work', doc_type: 'document', entity_key: 'platform-arch' }, [])).toBe(false)
  })

  it('allows exactly the namespaces it is given', () => {
    const doc = { namespace: 'initech', doc_type: 'document', entity_key: 'x' }
    expect(isWorkSafe(doc, ['initech'])).toBe(true)
    expect(isWorkSafe(doc, ['work'])).toBe(false)
  })

  it('an empty list still admits allow-listed second-brain doc_types', () => {
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'work-output', entity_key: 'w-1' }, [])).toBe(true)
    expect(isWorkSafe({ namespace: 'second-brain', doc_type: 'report', entity_key: 'd-1' }, [])).toBe(true)
  })

  it('the bot work filter allows exactly these second-brain doc_types', () => {
    expect([...WORK_SCOPE_ALLOWED_DOC_TYPES].sort()).toEqual(
      [
        'work-output', 'lesson-learned', 'lesson', 'plan', 'implementation-plan', 'task-plan', 'prd', 'report',
        'analysis', 'analysis-report', 'research', 'research-report', 'runbook', 'playbook',
        'engineering-artifact', 'pr-merge-event', 'investigation', 'handoff', 'agent-run', 'skill-doc',
      ].sort(),
    )
  })

  it.each([
    'meeting-transcript', 'transcript', 'meeting-prep', 'meeting-note', 'slack-draft', 'decision',
    'daily_rollup', 'weekly_rollup',
  ])('no longer admits doc_type %s in second-brain (they mix work with personal content)', (doc_type) => {
    expect(isWorkSafe({ namespace: 'second-brain', doc_type, entity_key: 'clean-key', content: 'plain work text' }, [])).toBe(false)
  })

  it('deny patterns still win with a custom namespace list', () => {
    expect(isWorkSafe({ namespace: 'initech', doc_type: 'document', entity_key: 'user_md' }, ['initech'])).toBe(false)
    expect(
      isWorkSafe(
        { namespace: 'initech', doc_type: 'document', entity_key: 'plan', content: 'base salary and a signing bonus' },
        ['initech'],
      ),
    ).toBe(false)
  })
})

describe('filterWorkScopedResults (second-layer filter on kb-server {text, source, score})', () => {
  const r = (source: string, text = 'body') => ({ text, source, score: 1 })

  it('drops initech/document/x when allowedNamespaces is []', () => {
    expect(filterWorkScopedResults([r('initech/document/x')], [])).toEqual([])
  })

  it('keeps second-brain/report/2026-W42', () => {
    const kept = r('second-brain/report/2026-W42')
    expect(filterWorkScopedResults([kept], [])).toEqual([kept])
  })

  it('drops second-brain/meeting-transcript/user_md (personal deny pattern)', () => {
    expect(filterWorkScopedResults([r('second-brain/meeting-transcript/user_md')], [])).toEqual([])
  })

  it('drops a source with fewer than 3 segments', () => {
    expect(filterWorkScopedResults([r('second-brain/weekly_rollup'), r('kb-doc'), r('')], ['second-brain'])).toEqual([])
  })

  it('drops a malformed source with an empty namespace, doc_type or entity_key segment', () => {
    expect(
      filterWorkScopedResults(
        [r('/weekly_rollup/2026-W42'), r('second-brain//2026-W42'), r('second-brain/weekly_rollup/')],
        ['second-brain'],
      ),
    ).toEqual([])
  })

  it('keeps an entity_key that itself contains "/"', () => {
    const kept = r('second-brain/work-output/projects/atlas/status')
    expect(filterWorkScopedResults([kept], [])).toEqual([kept])
  })

  it('applies the personal deny patterns to the whole slash-joined entity_key', () => {
    expect(filterWorkScopedResults([r('second-brain/work-output/personal/notes')], [])).toEqual([])
    expect(filterWorkScopedResults([r('second-brain/work-output/atlas/sideshop-plan')], [])).toEqual([])
  })

  it('drops compensation content even from an otherwise allowed source', () => {
    const comp = r('second-brain/report/d-1', 'Total comp target is discussed; base salary and a signing bonus.')
    expect(filterWorkScopedResults([comp], [])).toEqual([])
  })

  it('admits a whole namespace only when it is in the list', () => {
    const doc = r('initech/document/runbook-1')
    expect(filterWorkScopedResults([doc], ['initech'])).toEqual([doc])
    expect(filterWorkScopedResults([doc], ['other'])).toEqual([])
  })

  it('keeps order and the extra fields of kept results', () => {
    const a = { text: 'a', source: 'second-brain/report/a', score: 0.9, date: '2026-10-15' }
    const b = { text: 'b', source: 'initech/document/b', score: 0.8 }
    const c = { text: 'c', source: 'second-brain/plan/c', score: 0.7 }
    expect(filterWorkScopedResults([a, b, c], [])).toEqual([a, c])
  })
})

describe('personal-term deny (key AND content, word-start prefix, case-insensitive, additive)', () => {
  const r = (source: string, text = 'quarterly platform notes') => ({ text, source, score: 1 })

  it('the default terms are exactly the agreed stems', () => {
    expect(DEFAULT_PERSONAL_DENY_TERMS).toEqual([
      'pediatric', 'nann', 'preschool', 'babysit', 'mortgage',
    ])
  })

  it('drops a second-brain/meeting-transcript/... result (doc type no longer allowed)', () => {
    expect(filterWorkScopedResults([r('second-brain/meeting-transcript/2026-10-15-standup')], [])).toEqual([])
  })

  it('drops a second-brain/work-output/x result whose content mentions "Milo"', () => {
    expect(filterWorkScopedResults([r('second-brain/work-output/x', 'We moved Milo bedtime back to eight.')], [])).toEqual([])
  })

  it('keeps a clean second-brain/work-output result', () => {
    const kept = r('second-brain/work-output/x', 'Shipped the owner panel and the replay script.')
    expect(filterWorkScopedResults([kept], [])).toEqual([kept])
  })

  // The reviewer's list: plurals, joined forms and camelCase of the default stems.
  it.each([
    'nannies', 'babysitters', 'preschools', 'pediatricians', 'pediatrics', 'mortgages',
    'sideshop', 'SideshopPets', 'sideshop.com', 'RobinLee', 'miloFever', 'milo_fever', "Milo's",
    'nanny', 'nanny-share', 'babysitting', 'Pediatrician', 'ROBIN',
  ])('drops a work-output result whose content has %s', (word) => {
    expect(filterWorkScopedResults([r('second-brain/work-output/x', `Notes: ${word} came up.`)], [])).toEqual([])
  })

  it.each([
    'miloFever', 'milo_fever', 'milo-fever', 'RobinLee', 'SideshopPets', 'nannies-schedule',
    'pediatricians-list', 'mortgage_rates', 'babysitters', 'preschools',
  ])('drops a work-output result whose entity_key is %s', (key) => {
    expect(filterWorkScopedResults([r(`second-brain/work-output/${key}`)], [])).toEqual([])
  })

  it('matches at a word start only: Napoleon (no word start) is kept', () => {
    const napoleon = r('second-brain/report/a', 'Napoleon is not a deploy target.')
    expect(filterWorkScopedResults([napoleon], [])).toEqual([napoleon])
    expect(hasPersonalMarker({ entity_key: 'napoleon-notes' })).toBe(false)
  })

  it('a stem matches longer words that start with it (conservative by design)', () => {
    expect(hasPersonalMarker({ content: 'Milow reviewed the plan.' })).toBe(true)
    expect(hasPersonalMarker({ content: 'a mortgagee clause' })).toBe(true)
  })

  it('a personal term wins over an allowed namespace and over metadata.audience=work', () => {
    expect(
      isWorkSafe({ namespace: 'initech', doc_type: 'document', entity_key: 'x', content: 'ask the nannies' }, ['initech']),
    ).toBe(false)
    expect(
      isWorkSafe({ namespace: 'wiki', doc_type: 'entity', entity_key: 'x', content: 'Milo', metadata: { audience: 'work' } }),
    ).toBe(false)
  })

  it('extra terms ADD to the defaults: a custom term is denied and "milo" still is', () => {
    const extra = ['zebra']
    const zebra = r('second-brain/report/z', 'The zebra project plan.')
    const milo = r('second-brain/report/l', 'Milo joined the standup.')
    const clean = r('second-brain/report/c', 'Shipped the owner panel.')
    expect(filterWorkScopedResults([zebra, milo, clean], [], extra)).toEqual([clean])
  })

  it('an empty extra list still applies the defaults', () => {
    expect(filterWorkScopedResults([r('second-brain/report/l', 'Milo joined the standup.')], [], [])).toEqual([])
  })

  it('mergePersonalDenyTerms keeps the defaults first, trims, drops blanks and de-duplicates', () => {
    expect(mergePersonalDenyTerms([' Foo ', '', 'NANN', 'foo'])).toEqual([...DEFAULT_PERSONAL_DENY_TERMS, 'Foo'])
    expect(mergePersonalDenyTerms()).toEqual([...DEFAULT_PERSONAL_DENY_TERMS])
  })

  it('regex characters in an extra term are matched literally', () => {
    expect(hasPersonalMarker({ content: 'axb' }, ['a.b'])).toBe(false)
    expect(hasPersonalMarker({ content: 'see a.b here' }, ['a.b'])).toBe(true)
    expect(hasPersonalMarker({ content: 'x' }, ['(', '['])).toBe(false)
  })

  it('hasPersonalMarker checks the entity_key and the content, not the namespace or doc_type', () => {
    expect(hasPersonalMarker({ entity_key: 'milo-notes' })).toBe(true)
    expect(hasPersonalMarker({ content: 'Robin called' })).toBe(true)
    expect(hasPersonalMarker({ namespace: 'milo', doc_type: 'milo', entity_key: 'ok', content: 'ok' })).toBe(false)
    expect(hasPersonalMarker({})).toBe(false)
  })
})

describe('owner-only scope (only the owner is in the call)', () => {
  const sb = (doc_type: string, entity_key: string, content = 'client call notes') => ({
    namespace: 'second-brain',
    doc_type,
    entity_key,
    content,
  })

  it('admits transcripts, decisions and meeting prep that the guest scope blocks', () => {
    for (const type of ['meeting-transcript', 'decision', 'meeting-prep']) {
      expect(isWorkSafe(sb(type, 'northwind-call'), [], [])).toBe(false)
      expect(isWorkSafe(sb(type, 'northwind-call'), [], [], true)).toBe(true)
    }
  })

  it('admits a "nexai" entity key that the guest scope blocks', () => {
    expect(isWorkSafe(sb('plan', 'nexai-revenue-bridge'), [], [])).toBe(false)
    expect(isWorkSafe(sb('plan', 'nexai-revenue-bridge'), [], [], true)).toBe(true)
  })

  it('still blocks rollups and unclassified types', () => {
    expect(isWorkSafe(sb('daily_rollup', 'daily-rollup-2026-10-16'), [], [], true)).toBe(false)
    expect(isWorkSafe(sb('weekly_rollup', 'weekly-rollup-2026-W44'), [], [], true)).toBe(false)
    expect(isWorkSafe(sb('context-file', 'company_decisions'), [], [], true)).toBe(false)
  })

  it('still blocks personal keys, personal terms, compensation and a personal audience', () => {
    expect(isWorkSafe(sb('decision', 'sideshop-b2b-pricing'), [], [], true)).toBe(false)
    expect(isWorkSafe(sb('decision', 'family-trip'), [], [], true)).toBe(false)
    expect(isWorkSafe(sb('meeting-transcript', 'call-1', 'the nanny called about Milo'), [], [], true)).toBe(false)
    expect(isWorkSafe(sb('meeting-transcript', 'call-2', 'base salary is on the offer letter'), [], [], true)).toBe(false)
    expect(isWorkSafe({ ...sb('decision', 'd-1'), metadata: { audience: 'personal' } }, [], [], true)).toBe(false)
  })

  it('filterWorkScopedResults applies the owner-only scope when asked', () => {
    const hits = [
      { text: 'Pat agreed to the January launch', source: 'second-brain/decision/decision-northwind-0' },
      { text: 'rollup', source: 'second-brain/daily_rollup/daily-rollup-2026-10-16' },
    ]
    expect(filterWorkScopedResults(hits, [], [])).toEqual([])
    expect(filterWorkScopedResults(hits, [], [], true).map((h) => h.source)).toEqual([
      'second-brain/decision/decision-northwind-0',
    ])
  })
})
