// The live view of one meeting: status, controls (say / mute / leave), Noted items and transcript.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api, clock, isAbort, isUnauthorized, messageOf, type ListedMeeting, type MeetingState } from './api.js'
import { Notice, StatusBadge } from './ui.js'

/** The live view re-reads the meeting this often. */
const LIVE_POLL_MS = 2_000
const SAY_MAX_CHARS = 500
/** Keep the transcript DOM small on a four-hour call; the full text stays on the server. */
const TRANSCRIPT_SHOWN = 150

/** A scrolling list that stays pinned to the newest item unless the reader scrolled up. */
function Feed({ label, className, count, children }: { label: string; className: string; count: number; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [count])
  return (
    <ul
      ref={ref}
      className={`feed ${className}`}
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {children}
    </ul>
  )
}

export function LiveView({
  id,
  listed,
  onBack,
  onExpired,
  onChanged,
}: {
  id: string
  /** This meeting's row from the server's list (failure reason, OpenBrain key); absent until the list has it. */
  listed: ListedMeeting | undefined
  onBack: () => void
  onExpired: () => void
  onChanged: () => void
}) {
  const [meeting, setMeeting] = useState<MeetingState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [sayText, setSayText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  const status = meeting?.status
  const polling = !gone && (status === undefined || status === 'live')

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api<{ meeting: MeetingState }>(`/api/meetings/${encodeURIComponent(id)}`, { signal })
        setMeeting(res.meeting)
        setLoadError(null)
      } catch (err) {
        if (isAbort(err)) return
        if (isUnauthorized(err)) onExpired()
        else if (err instanceof ApiError && err.status === 404) setGone(true)
        else setLoadError(messageOf(err))
      }
    },
    [id, onExpired],
  )

  // Poll every LIVE_POLL_MS while the meeting is live. One request at a time, and
  // polling stops once the meeting has ended (its last state is already on screen).
  useEffect(() => {
    if (!polling) return
    const controller = new AbortController()
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await load(controller.signal)
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), LIVE_POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [polling, load])

  async function run(action: () => Promise<string>) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      setNotice({ kind: 'info', text: await action() })
      await load()
      onChanged()
    } catch (err) {
      if (isUnauthorized(err)) onExpired()
      else if (err instanceof ApiError && err.code === 'NOT_LIVE') setNotice({ kind: 'error', text: 'This meeting is not live any more.' })
      else if (err instanceof ApiError && err.code === 'LEAVE_FAILED') {
        setNotice({ kind: 'error', text: `Could not make Jarvis leave (${err.message}). It may still be in the call. Try again.` })
      }
      else setNotice({ kind: 'error', text: messageOf(err) })
    } finally {
      setBusy(false)
    }
  }

  const command = (body: object) => api(`/api/meetings/${encodeURIComponent(id)}/commands`, { method: 'POST', body })

  const live = status === 'live'
  const muted = meeting?.metadata.muted === true
  const saying = sayText.trim() !== ''

  const say = () =>
    run(async () => {
      await command({ type: 'say', text: sayText })
      setSayText('')
      return 'Sent. Jarvis will say it in a moment.'
    })

  const toggleMute = () =>
    run(async () => {
      await command({ type: muted ? 'unmute' : 'mute' })
      return muted ? 'Jarvis is unmuted.' : 'Jarvis is muted.'
    })

  const leave = () =>
    run(async () => {
      setConfirmLeave(false)
      await api(`/api/owner/meetings/${encodeURIComponent(id)}/leave`, { method: 'POST' })
      return 'Jarvis is leaving the meeting.'
    })

  const lines = meeting?.transcript ?? []
  const shown = lines.slice(-TRANSCRIPT_SHOWN)
  const notes = meeting?.notes ?? []

  return (
    <>
      <div className="bar">
        <button type="button" className="secondary small" onClick={onBack}>
          Back to meetings
        </button>
      </div>

      <section className="card" aria-labelledby="live-heading">
        <h2 id="live-heading">{meeting?.title ?? 'Meeting'}</h2>
        {meeting && (
          <p className="hint">
            <StatusBadge meeting={{ status: meeting.status, failureCode: listed?.failureCode }} />{' '}
            {live ? (meeting.inCall ? 'In the call' : 'Waiting to be let in') : ''}
            {live && muted ? ' · Muted' : ''}
            {live ? ` · ${meeting.participantCount} ${meeting.participantCount === 1 ? 'person' : 'people'} here` : ''}
          </p>
        )}
        {gone && <p className="msg error" role="alert">The server no longer knows this meeting. It may have restarted.</p>}
        {loadError !== null && <p className="msg error" role="alert">{loadError}</p>}
        {!meeting && !gone && loadError === null && <p className="empty">Loading...</p>}
        {listed !== undefined && <p className="hint">OpenBrain: {listed.obEntityKey}</p>}
      </section>

      <section className="card" aria-labelledby="controls-heading">
        <h2 id="controls-heading">Controls</h2>
        <div className="field">
          <label htmlFor="say-text">Say this</label>
          <textarea
            id="say-text"
            value={sayText}
            maxLength={SAY_MAX_CHARS}
            onChange={(e) => setSayText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && live && saying && !busy) {
                e.preventDefault()
                void say()
              }
            }}
            disabled={!live}
            placeholder="Type what Jarvis should say out loud"
          />
          <p className={`counter ${sayText.length >= SAY_MAX_CHARS ? 'full' : ''}`} aria-live="polite">
            {sayText.length}/{SAY_MAX_CHARS}
          </p>
          <button type="button" onClick={() => void say()} disabled={!live || !saying || busy}>
            Say this
          </button>
        </div>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void toggleMute()} disabled={!live || busy}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          {confirmLeave ? (
            <>
              <button type="button" className="danger" onClick={() => void leave()} disabled={!live || busy}>
                Yes, leave now
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmLeave(false)}>
                Keep it in
              </button>
            </>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmLeave(true)} disabled={!live || busy}>
              Leave
            </button>
          )}
        </div>
        <Notice notice={notice} />
      </section>

      <section className="card" aria-labelledby="noted-heading">
        <h2 id="noted-heading">Noted</h2>
        {notes.length === 0 ? (
          <p className="empty">Nothing noted yet.</p>
        ) : (
          <Feed label="Noted items" className="notes" count={notes.length}>
            {notes.map((n, i) => (
              <li key={i} className={n.kind}>
                <span className="who">{n.kind === 'flag' ? 'Flagged for you' : 'Noted'}</span>
                <span className="when">{clock(n.at)}</span>
                <div>{n.text}</div>
              </li>
            ))}
          </Feed>
        )}
      </section>

      <section className="card" aria-labelledby="transcript-heading">
        <h2 id="transcript-heading">Transcript</h2>
        {lines.length === 0 ? (
          <p className="empty">No speech yet.</p>
        ) : (
          <>
            {lines.length > shown.length && <p className="hint">Showing the latest {shown.length} of {lines.length} lines.</p>}
            <Feed label="Transcript" className="transcript" count={lines.length}>
              {shown.map((l, i) => (
                <li key={lines.length - shown.length + i}>
                  <span className="who">{l.speaker || 'Unknown'}</span>
                  <span className="when">{clock(l.timestamp)}</span>
                  <div>{l.text}</div>
                </li>
              ))}
            </Feed>
          </>
        )}
      </section>
    </>
  )
}
