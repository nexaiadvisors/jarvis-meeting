/**
 * Pure helpers for the meeting page, unit tested without a DOM.
 */

export interface PageData {
  meeting: { id: string; title: string; status: 'live' | 'completed' | 'failed'; startedAt: string }
  botName: string
  notes: { kind: 'note' | 'flag'; text: string; at: string }[]
  summary: {
    bluf: string
    decisions: string[]
    actionItems: { owner: string; task: string; due?: string }[]
    generated: boolean
  } | null
  transcript: { speaker: string; text: string; timestamp: string; kind?: 'chat' }[]
  artifacts: { id: string; kind: 'doc' | 'whiteboard'; title: string; updatedAt: string }[]
}

/** Poll every few seconds during the call, slowly while the summary is being written, then stop. */
/** A meeting may run up to 2 hours; allow that plus half an hour for the summary. */
export const MAX_SUMMARY_WAIT_MS = 2.5 * 60 * 60 * 1000

export function nextPollMs(data: PageData | null, nowMs: number = Date.now()): number | null {
  if (!data) return 5000
  if (data.meeting.status === 'live') return 4000
  // A failed meeting gets no summary. A finished one normally gets it within minutes;
  // after half an hour the page stops asking.
  if (data.meeting.status === 'failed' || data.summary) return null
  const endedLongAgo = nowMs - Date.parse(data.meeting.startedAt) > MAX_SUMMARY_WAIT_MS
  return endedLongAgo ? null : 15000
}

/** Where the page lives: /m/<meetingId>?t=<share token>. */
export function parseMeetingLocation(pathname: string, search: string): { meetingId: string; token: string } | null {
  const match = /^\/m\/([^/]+)\/?$/.exec(pathname)
  const token = new URLSearchParams(search).get('t')
  if (!match || !token) return null
  return { meetingId: decodeURIComponent(match[1]), token }
}

/** The link to one artifact's page; the same share token opens it. */
export function artifactLink(loc: { meetingId: string; token: string }, artifactId: string): string {
  return `/a/${encodeURIComponent(loc.meetingId)}/${encodeURIComponent(artifactId)}?t=${encodeURIComponent(loc.token)}`
}

/** "10:42" in the viewer's own time zone, or '' when the timestamp is unusable. */
export function clockTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function statusLabel(data: PageData): string {
  if (data.meeting.status === 'live') return 'Live now'
  if (data.meeting.status === 'failed') return 'The bot could not join this meeting'
  return data.summary ? 'Ended' : 'Ended. Writing the summary…'
}
