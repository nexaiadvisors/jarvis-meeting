/**
 * The bot page's meeting session token and the one place it makes API calls.
 *
 * The dispatch URL carries a signed, meeting-scoped `session_token`. Every
 * /api/meetings/:id/* and /api/voice/* route requires it as a bearer token, so every
 * request this page makes goes through authedFetch(). main.tsx has no raw fetch().
 */

const TOKEN_PARAM = 'session_token'

let cachedToken: string | null = null
let tokenRead = false

/**
 * Read the session token from the page URL, remove it from the address bar, and
 * remember it. The first call does the work; later calls (including reconnects long
 * after the URL was cleaned) return the cached value. Null when the URL has none.
 */
export function readSessionTokenOnce(): string | null {
  if (tokenRead) return cachedToken
  tokenRead = true
  const url = new URL(window.location.href)
  const token = url.searchParams.get(TOKEN_PARAM)
  if (token) {
    url.searchParams.delete(TOKEN_PARAM)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  cachedToken = token || null
  return cachedToken
}

/** fetch() with `Authorization: Bearer <session token>` added. Everything else passes through. */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = readSessionTokenOnce()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
