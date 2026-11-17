/**
 * The page for one meeting artifact: GET /a/<meetingId>/<artifactId>?t=<share token>.
 * A doc is a markdown editor with a live preview. A whiteboard is an Excalidraw canvas
 * (loaded on demand: it is large). Both autosave with the version they loaded, and both
 * poll for other people's saves.
 */

import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import './page.css'
import { parseMarkdown, type Block, type Inline } from './markdown.js'
import { AUTOSAVE_DELAY_MS, POLL_MS, artifactApiUrl, onPoll, parseArtifactLocation } from './sync.js'

const Whiteboard = lazy(() => import('./whiteboard.js'))

export interface ArtifactData {
  id: string
  kind: 'doc' | 'whiteboard'
  title: string
  content: string
  version: number
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.text
      case 'bold':
        return <strong key={i}>{inline(n.children)}</strong>
      case 'italic':
        return <em key={i}>{inline(n.children)}</em>
      case 'code':
        return <code key={i}>{n.text}</code>
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {inline(n.children)}
          </a>
        )
    }
  })
}

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'heading': {
      const Tag = `h${Math.min(b.level, 6)}` as 'h1'
      return <Tag key={key}>{inline(b.children)}</Tag>
    }
    case 'paragraph':
      return <p key={key}>{inline(b.children)}</p>
    case 'quote':
      return <blockquote key={key}>{inline(b.children)}</blockquote>
    case 'code':
      return (
        <pre key={key}>
          <code>{b.text}</code>
        </pre>
      )
    case 'rule':
      return <hr key={key} />
    case 'list': {
      const tasks = b.items.some((item) => item.checked !== undefined)
      const items = b.items.map((item, i) => (
        <li key={i}>
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly aria-label={item.checked ? 'Done' : 'Not done'} />}{' '}
          {inline(item.children)}
        </li>
      ))
      return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key} className={tasks ? 'af-tasks' : undefined}>{items}</ul>
    }
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>{b.header.map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr>
          </thead>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>{row.map((cell, i) => <td key={i}>{inline(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )
  }
}

function App() {
  const loc = useMemo(() => parseArtifactLocation(window.location.pathname, window.location.search), [])
  const [artifact, setArtifact] = useState<ArtifactData | null>(null)
  const [missing, setMissing] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  /** Set when someone else saved while this person had unsaved edits. Holds their version. */
  const [theirs, setTheirs] = useState<ArtifactData | null>(null)
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  /** Bumped when another person's version replaces the canvas, so the whiteboard reloads it. */
  const [remoteEpoch, setRemoteEpoch] = useState(0)

  const baseVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const latestRef = useRef({ title: '', content: '' })
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)
  /** Counts finished saves, so a poll that overlapped a save can be ignored. */
  const saveSeqRef = useRef(0)
  /**
   * True while the only unsaved change is automatic (a new whiteboard's Mermaid text
   * converted to shapes). Everyone who opens a new whiteboard makes that same change, so
   * a conflict on it is not a real conflict: the page quietly takes the stored version.
   */
  const autoOnlyRef = useRef(false)

  const adopt = useCallback((a: ArtifactData) => {
    baseVersionRef.current = a.version
    dirtyRef.current = false
    latestRef.current = { title: a.title, content: a.content }
    setArtifact(a)
    setTitle(a.title)
    setContent(a.content)
    setSaveState('saved')
    setTheirs(null)
    document.title = a.title
  }, [])

  const save = useCallback(async () => {
    if (!loc || savingRef.current || !dirtyRef.current) return
    savingRef.current = true
    setSaveState('saving')
    const sent = { ...latestRef.current }
    try {
      const res = await fetch(artifactApiUrl(loc), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: sent.content, title: sent.title, version: baseVersionRef.current }),
      })
      let retry = false
      if (res.status === 409) {
        const body = (await res.json()) as { current: ArtifactData }
        if (autoOnlyRef.current) {
          adopt(body.current)
          setRemoteEpoch((n) => n + 1)
        } else {
          // A real conflict: the person chooses. Nothing is sent again until they do.
          setTheirs(body.current)
          setSaveState('unsaved')
        }
      } else if (res.ok) {
        const body = (await res.json()) as { artifact: ArtifactData }
        baseVersionRef.current = body.artifact.version
        // Keystrokes that arrived while the save was in flight are still unsaved.
        dirtyRef.current = latestRef.current.content !== sent.content || latestRef.current.title !== sent.title
        if (!dirtyRef.current) autoOnlyRef.current = false
        setSaveState(dirtyRef.current ? 'unsaved' : 'saved')
        // Only keystrokes that arrived during a save that WORKED are sent straight away.
        // After a conflict or an error the next edit (or a button) triggers the next try.
        retry = dirtyRef.current
      } else {
        setSaveState('error')
      }
      savingRef.current = false
      saveSeqRef.current += 1
      if (retry && !saveTimerRef.current) scheduleSaveRef.current()
    } catch {
      setSaveState('error')
      savingRef.current = false
      saveSeqRef.current += 1
    }
  }, [loc, adopt])

  const scheduleSaveRef = useRef<() => void>(() => undefined)
  scheduleSaveRef.current = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void save()
    }, AUTOSAVE_DELAY_MS)
  }

  const edit = useCallback((next: { title?: string; content?: string }, automatic = false) => {
    // An automatic change stays "automatic only" until the person changes something.
    autoOnlyRef.current = automatic && (autoOnlyRef.current || !dirtyRef.current)
    latestRef.current = { ...latestRef.current, ...next }
    if (next.title !== undefined) setTitle(next.title)
    if (next.content !== undefined) setContent(next.content)
    dirtyRef.current = true
    setSaveState('unsaved')
    scheduleSaveRef.current()
  }, [])

  // Load once, then poll for other people's saves.
  useEffect(() => {
    if (!loc) {
      setMissing(true)
      return
    }
    let stopped = false
    const load = async (first: boolean) => {
      // A poll that overlaps one of this page's own saves can see that save's new version
      // before the save's reply is handled; such a poll is ignored.
      const seq = saveSeqRef.current
      if (!first && savingRef.current) return
      try {
        const res = await fetch(artifactApiUrl(loc))
        if (stopped) return
        if (res.status === 404) {
          if (first) setMissing(true)
          return
        }
        if (!res.ok) return
        const remote = ((await res.json()) as { artifact: ArtifactData }).artifact
        if (first) {
          adopt(remote)
          return
        }
        if (savingRef.current || seq !== saveSeqRef.current) return
        const action = onPoll({ baseVersion: baseVersionRef.current, dirty: dirtyRef.current && !autoOnlyRef.current }, remote.version)
        if (action === 'replace') {
          adopt(remote)
          setRemoteEpoch((n) => n + 1)
        } else if (action === 'warn') {
          setTheirs(remote)
        }
      } catch {
        // Offline for a moment: the next poll tries again.
      }
    }
    void load(true)
    const timer = setInterval(() => void load(false), POLL_MS)
    // Closing the tab inside the autosave delay must not lose the last edit. A keepalive
    // request outlives the page; browsers cap its body at about 64 KB.
    const flush = () => {
      if (!dirtyRef.current || autoOnlyRef.current || savingRef.current) return
      const body = JSON.stringify({ content: latestRef.current.content, title: latestRef.current.title, version: baseVersionRef.current })
      if (body.length > 60_000) return
      void fetch(artifactApiUrl(loc), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('pagehide', flush)
    }
  }, [loc, adopt])

  const keepMine = useCallback(() => {
    if (!theirs) return
    // Save over their version: base this edit on what is stored now.
    baseVersionRef.current = theirs.version
    setTheirs(null)
    dirtyRef.current = true
    autoOnlyRef.current = false
    void save()
  }, [theirs, save])

  const takeTheirs = useCallback(() => {
    if (!theirs) return
    adopt(theirs)
    setRemoteEpoch((n) => n + 1)
  }, [theirs, adopt])

  const preview = useMemo(() => (artifact?.kind === 'doc' ? parseMarkdown(content).map(block) : null), [artifact?.kind, content])

  if (missing) {
    return <p className="af-message">This link is not valid. Open the link from the meeting chat again.</p>
  }
  if (!artifact) {
    return <p className="af-message">Loading…</p>
  }

  const status = { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Not saved. It will try again on your next edit.' }[saveState]

  return (
    <div className="af-shell">
      <header className="af-bar">
        <span className="af-kind">{artifact.kind === 'doc' ? 'Doc' : 'Whiteboard'}</span>
        <input className="af-title" value={title} aria-label="Title" maxLength={200} onChange={(e) => edit({ title: e.target.value })} />
        <span className="af-status" role="status">
          {status}
        </span>
      </header>
      {theirs && (
        <div className="af-notice" role="alert">
          <span>Someone else saved this while you were editing.</span>
          <button type="button" onClick={takeTheirs} disabled={saveState === 'saving'}>
            Load their version
          </button>
          <button type="button" onClick={keepMine} disabled={saveState === 'saving'}>
            Keep mine and save
          </button>
        </div>
      )}
      {artifact.kind === 'doc' ? (
        <>
          <div className="af-tabs">
            <button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>
              Edit
            </button>
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>
              Preview
            </button>
          </div>
          <main className="af-doc" data-view={view}>
            <textarea value={content} aria-label="Markdown" spellCheck onChange={(e) => edit({ content: e.target.value })} />
            <article className="af-preview" aria-label="Preview">
              {preview}
            </article>
          </main>
        </>
      ) : (
        <main className="af-board">
          <Suspense fallback={<p className="af-message">Loading the whiteboard…</p>}>
            <Whiteboard key={remoteEpoch} content={content} onChange={(next, automatic) => edit({ content: next }, automatic)} />
          </Suspense>
        </main>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
