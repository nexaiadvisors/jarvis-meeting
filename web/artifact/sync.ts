/**
 * Save and refresh rules for the artifact page, kept free of the DOM so they are unit
 * tested. The page holds the version it last loaded (`baseVersion`) and whether the
 * person has edits that are not saved yet (`dirty`).
 */

/** How long after the last keystroke the page saves. */
export const AUTOSAVE_DELAY_MS = 800
/** How often the page asks the server for other people's saves. Under the 5 s promise. */
export const POLL_MS = 3000

export interface LocalState {
  baseVersion: number
  dirty: boolean
}

export type PollAction =
  /** Nothing new on the server. */
  | 'none'
  /** Someone else saved and there are no local edits: show their version. */
  | 'replace'
  /** Someone else saved while this person was typing: keep the local text and warn. */
  | 'warn'

/** What to do when a poll returns the server's current version number. */
export function onPoll(local: LocalState, remoteVersion: number): PollAction {
  if (remoteVersion <= local.baseVersion) return 'none'
  return local.dirty ? 'warn' : 'replace'
}

/** Where the page lives: /a/<meetingId>/<artifactId>?t=<share token>. */
export function parseArtifactLocation(pathname: string, search: string): { meetingId: string; artifactId: string; token: string } | null {
  const match = /^\/a\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
  const token = new URLSearchParams(search).get('t')
  if (!match || !token) return null
  return { meetingId: decodeURIComponent(match[1]), artifactId: decodeURIComponent(match[2]), token }
}

/** The API address for this artifact. */
export function artifactApiUrl(loc: { meetingId: string; artifactId: string; token: string }): string {
  return `/api/artifacts/${encodeURIComponent(loc.meetingId)}/${encodeURIComponent(loc.artifactId)}?t=${encodeURIComponent(loc.token)}`
}

/** A whiteboard's stored content once it holds Excalidraw shapes. */
export interface StoredScene {
  type: 'excalidraw'
  elements: unknown[]
  files?: Record<string, unknown>
}

/** The stored Excalidraw scene, or null when the content is still Mermaid text (or anything else). */
export function parseScene(content: string): StoredScene | null {
  try {
    const value = JSON.parse(content) as Partial<StoredScene> | null
    if (value && value.type === 'excalidraw' && Array.isArray(value.elements)) {
      return { type: 'excalidraw', elements: value.elements, ...(value.files ? { files: value.files } : {}) }
    }
  } catch {
    // Not JSON: Mermaid text.
  }
  return null
}
