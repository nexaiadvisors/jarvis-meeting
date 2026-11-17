/**
 * The page for one meeting: GET /m/<meetingId>?t=<share token>. It shows the summary and
 * action items (after the call), the notes, the docs and whiteboards, and the transcript.
 * During the call it refreshes itself every few seconds. All text is rendered as text.
 */

import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { artifactLink, clockTime, nextPollMs, parseMeetingLocation, statusLabel, type PageData } from './view.js'

function App() {
  const loc = useMemo(() => parseMeetingLocation(window.location.pathname, window.location.search), [])
  const [data, setData] = useState<PageData | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!loc) {
      setMissing(true)
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      let latest: PageData | null = null
      try {
        const res = await fetch(`/api/meeting-page/${encodeURIComponent(loc.meetingId)}?t=${encodeURIComponent(loc.token)}`)
        if (stopped) return
        if (res.status === 404) {
          setMissing(true)
          return
        }
        if (res.ok) {
          latest = (await res.json()) as PageData
          setData(latest)
          document.title = latest.meeting.title
        }
      } catch {
        // Offline for a moment: try again on the next tick.
      }
      if (stopped) return
      const wait = nextPollMs(latest)
      if (wait !== null) timer = setTimeout(() => void load(), wait)
    }
    void load()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [loc])

  if (missing || !loc) return <p className="mp-message">This link is not valid. Open the link from the meeting chat or the recap email again.</p>
  if (!data) return <p className="mp-message">Loading…</p>

  const { meeting, summary, notes, artifacts, transcript } = data
  const started = new Date(meeting.startedAt)

  return (
    <main>
      <h1>{meeting.title}</h1>
      <p className="mp-meta">
        {Number.isNaN(started.getTime()) ? '' : `${started.toLocaleDateString([], { dateStyle: 'medium' })} · `}
        <span className={meeting.status === 'live' ? 'mp-live' : undefined} role="status">
          {statusLabel(data)}
        </span>
      </p>

      <section aria-labelledby="mp-summary">
        <h2 id="mp-summary">Summary</h2>
        {summary ? (
          <>
            <p>{summary.bluf}</p>
            {summary.decisions.length > 0 && (
              <>
                <h2>Decisions</h2>
                <ul>
                  {summary.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="mp-empty">Written a few minutes after the meeting ends.</p>
        )}
      </section>

      <section aria-labelledby="mp-actions">
        <h2 id="mp-actions">Action items</h2>
        {summary && summary.actionItems.length > 0 ? (
          <ul>
            {summary.actionItems.map((item, i) => (
              <li key={i}>
                <span className="mp-owner">{item.owner}</span>: {item.task}
                {item.due ? <span className="mp-due"> (due {item.due})</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mp-empty">{summary ? 'None recorded.' : 'Listed after the meeting ends.'}</p>
        )}
      </section>

      <section aria-labelledby="mp-artifacts">
        <h2 id="mp-artifacts">Docs and whiteboards</h2>
        {artifacts.length > 0 ? (
          <ul className="mp-artifacts">
            {artifacts.map((a) => (
              <li key={a.id}>
                <span className="mp-kind">{a.kind === 'doc' ? 'Doc' : 'Whiteboard'}</span>
                <a href={artifactLink(loc, a.id)}>{a.title}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mp-empty">None yet. Ask {data.botName} to start a doc or put something on a whiteboard.</p>
        )}
      </section>

      <section aria-labelledby="mp-notes">
        <h2 id="mp-notes">Notes</h2>
        {notes.length > 0 ? (
          <ul>
            {notes.map((n, i) => (
              <li key={i}>
                {n.kind === 'flag' ? <span className="mp-tag">Flag</span> : null}
                {n.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mp-empty">No notes yet.</p>
        )}
      </section>

      <section aria-labelledby="mp-transcript">
        <h2 id="mp-transcript">Transcript</h2>
        {transcript.length > 0 ? (
          <div className="mp-transcript" tabIndex={0}>
            {transcript.map((line, i) => (
              <div className="mp-line" key={i}>
                <span className="mp-time">{clockTime(line.timestamp)}</span>
                <span>
                  <span className="mp-speaker">{line.speaker || 'Unknown'}</span>
                  {line.kind === 'chat' ? <span className="mp-tag"> chat</span> : null}: {line.text}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mp-empty">Nothing said yet.</p>
        )}
      </section>
    </main>
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
