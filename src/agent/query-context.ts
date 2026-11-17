export interface RecentTurn {
  speaker: string
  text: string
  isAgent: boolean
}

export interface BuildSearchQueryOptions {
  wakeWord: string
  aliases?: string[]
  maxTerms?: number
}

export interface SearchQueryContext {
  query: string
  contextTerms: string[]
}

const DEFAULT_MAX_TERMS = 24
const CONTEXT_TURN_LIMIT = 6
const MIN_WAKE_CONTENT_TERMS = 4

export const ANAPHORA_PATTERNS: readonly RegExp[] = [
  /\bthis\b/i,
  /\bthat\b/i,
  /\bit\b/i,
  /\bthese\b/i,
  /\bthose\b/i,
  /\bthe\s+(?:first|second|third|fourth|fifth|last|previous|other)\s+(?:issue|question|thing|one|item|point|topic)\b/i,
]

export const SEARCH_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'able',
  'about',
  'actually',
  'after',
  'again',
  'all',
  'also',
  'am',
  'an',
  'and',
  'another',
  'any',
  'are',
  'around',
  'as',
  'at',
  'be',
  'been',
  'being',
  'built',
  'but',
  'by',
  'can',
  'could',
  'context',
  'did',
  'do',
  'does',
  'doing',
  'don',
  'explain',
  'explained',
  'explaining',
  'for',
  'from',
  'get',
  'give',
  'go',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hey',
  'hi',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'issue',
  'it',
  'just',
  'know',
  'like',
  'me',
  'mentioned',
  'might',
  'more',
  'need',
  'of',
  'ok',
  'okay',
  'on',
  'one',
  'or',
  'other',
  'our',
  'please',
  'question',
  'really',
  'said',
  'say',
  'see',
  'she',
  'should',
  'so',
  'some',
  'something',
  'specific',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'this',
  'those',
  'to',
  'turn',
  'up',
  'us',
  'was',
  'we',
  'well',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
])

const GREETING_TOKENS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'so', 'well', 'and'])

interface Token {
  raw: string
  normalized: string
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase()
}

/**
 * Speech-vs-corpus vocabulary canonicalization, applied BEFORE tokenization.
 * People say (and STT transcribes) some terms hyphenated or as two words, but
 * the knowledge base writes them as one word. The tokenizer splits on
 * non-alphanumerics, so "on-site" becomes "on" + "site"; "on" is a stopword and
 * gets dropped, leaving "site" — which matches recurring "engineering huddle"
 * transcripts, NOT the Product Onsite. Canonicalizing to the corpus spelling
 * ("onsite") restores the match. Verified 2026-07-15: "on-site engineering
 * meeting" retrieved April eng-huddles; "onsite engineering meeting" surfaces
 * the onsite docs at the top. Keep this list tight — one entry per real
 * vocabulary mismatch observed in a meeting, canonical form on the right.
 */
const VOCAB_CANONICALIZATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bon[-\s]?site\b/gi, 'onsite'],
]

function canonicalizeVocab(text: string): string {
  let out = text
  for (const [pattern, replacement] of VOCAB_CANONICALIZATIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function tokenize(text: string): Token[] {
  return [...canonicalizeVocab(text).matchAll(/[A-Za-z0-9]+/g)].map((match) => {
    const raw = match[0]!
    return { raw, normalized: normalizeToken(raw) }
  })
}

function isAcronym(token: Token): boolean {
  return /^[A-Z]{2,}$/.test(token.raw)
}

function isDomainToken(token: Token): boolean {
  if (!token.normalized) return false
  if (SEARCH_QUERY_STOPWORDS.has(token.normalized)) return false
  if (/\d/.test(token.normalized)) return true
  if (isAcronym(token)) return true
  return token.normalized.length >= 3
}

function wakeTokenSet(wakeWord: string, aliases: string[] = []): Set<string> {
  return new Set([wakeWord, ...aliases].flatMap((word) => tokenize(word).map((token) => token.normalized)))
}

function dedupeAppend(target: string[], seen: Set<string>, terms: string[], maxTerms: number): void {
  for (const term of terms) {
    if (target.length >= maxTerms) return
    if (seen.has(term)) continue
    seen.add(term)
    target.push(term)
  }
}

function stripWakeAndGreetingTokens(text: string, wakeWord: string, aliases: string[] = []): Token[] {
  const wakeTokens = wakeTokenSet(wakeWord, aliases)
  return tokenize(text).filter((token, index) => {
    if (wakeTokens.has(token.normalized)) return false
    if (index <= 2 && GREETING_TOKENS.has(token.normalized)) return false
    return true
  })
}

function contentTermsFromTokens(tokens: Token[]): string[] {
  return tokens.filter(isDomainToken).map((token) => token.normalized)
}

function containsAnaphora(text: string): boolean {
  return ANAPHORA_PATTERNS.some((pattern) => pattern.test(text))
}

function shouldHarvestContext(wakeUtterance: string, wakeTerms: string[]): boolean {
  return wakeTerms.length < MIN_WAKE_CONTENT_TERMS || containsAnaphora(wakeUtterance)
}

function harvestContextTerms(
  recentTurns: RecentTurn[],
  opts: Required<Pick<BuildSearchQueryOptions, 'wakeWord' | 'aliases'>>,
  maxTerms: number,
): string[] {
  const contextTerms: string[] = []
  const seen = new Set<string>()
  const nonAgentTurns = recentTurns.filter((turn) => !turn.isAgent).slice(-CONTEXT_TURN_LIMIT).reverse()

  for (const turn of nonAgentTurns) {
    if (contextTerms.length >= maxTerms) break
    const terms = contentTermsFromTokens(stripWakeAndGreetingTokens(turn.text, opts.wakeWord, opts.aliases))
    dedupeAppend(contextTerms, seen, terms, maxTerms)
  }

  return contextTerms
}

export function buildSearchQuery(
  wakeUtterance: string,
  recentTurns: RecentTurn[],
  opts: BuildSearchQueryOptions,
): SearchQueryContext {
  const maxTerms = Math.max(1, opts.maxTerms ?? DEFAULT_MAX_TERMS)
  const aliases = opts.aliases ?? []
  const wakeTerms = contentTermsFromTokens(stripWakeAndGreetingTokens(wakeUtterance, opts.wakeWord, aliases))
  const queryTerms: string[] = []
  const seen = new Set<string>()

  dedupeAppend(queryTerms, seen, wakeTerms, maxTerms)

  let contextTerms: string[] = []
  if (shouldHarvestContext(wakeUtterance, wakeTerms) && queryTerms.length < maxTerms) {
    contextTerms = harvestContextTerms(recentTurns, { wakeWord: opts.wakeWord, aliases }, maxTerms - queryTerms.length)
    dedupeAppend(queryTerms, seen, contextTerms, maxTerms)
    contextTerms = contextTerms.filter((term) => queryTerms.includes(term))
  }

  return {
    query: queryTerms.join(' '),
    contextTerms,
  }
}
