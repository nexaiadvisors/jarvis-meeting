// Shapes and request helpers shared by the owner panel's screens.

export interface ListedMeeting {
  id: string
  title: string
  status: 'live' | 'completed' | 'failed'
  inCall: boolean
  muted: boolean
  notesCount: number
  obEntityKey: string
  failureCode?: string
}

export interface UpcomingCalendarMeeting {
  eventKey: string
  title: string
  calendarId: string
  startIso: string
  endIso: string
  meetingUrl: string
  willJoin: boolean
  status: 'scheduled' | 'skipped' | 'dispatched'
  meetingId?: string
  skipReason?: string
}

export type JoinMode = 'all' | 'internal_only' | 'manual'

export interface UpcomingCalendarResponse {
  enabled: boolean
  joinMode?: JoinMode
  lastPollAt: string | null
  lastError: string | null
  upcoming: UpcomingCalendarMeeting[]
}

export interface TranscriptLine {
  speaker: string
  text: string
  timestamp: string
}

export interface SavedNote {
  kind: 'note' | 'flag'
  text: string
  at: string
  by: 'agent' | 'owner'
}

export interface AvatarProviderOption {
  id: 'google-live-avatar' | 'simli' | 'heygen-live-avatar' | 'alibaba-live-avatar'
  name: string
  vendor: string
  tagline: string
  cloudConfigured: boolean
}

export interface AvatarCatalogResponse {
  activeProvider: AvatarProviderOption['id']
  providers: AvatarProviderOption[]
}

export interface MeetingState {
  id: string
  title: string
  status: 'live' | 'completed' | 'failed'
  metadata: { muted: boolean }
  participantCount: number
  inCall: boolean
  transcript: TranscriptLine[]
  notes: SavedNote[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** One JSON request to this server. Throws ApiError with the server's message on a non-2xx. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown }
  if (!res.ok) {
    const code = typeof data.code === 'string' ? data.code : ''
    throw new ApiError(
      res.status,
      code,
      code === 'ORIGIN_MISMATCH'
        ? 'The server refused this because the page is not on its public address. Open the panel from the public URL.'
        : typeof data.error === 'string'
          ? data.error
          : `Request failed (${res.status})`,
    )
  }
  return data as T
}

export const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401
export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong.')

export function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Returns an error message for a bad meeting link, or null when it looks fine. */
export function checkMeetingLink(raw: string): string | null {
  const link = raw.trim()
  if (link === '') return 'Enter the meeting link.'
  try {
    const url = new URL(link)
    if (url.protocol === 'https:' || url.protocol === 'http:') return null
  } catch {
    // fall through to the message below
  }
  return 'That does not look like a meeting link. It should start with https://'
}
