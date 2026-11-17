/**
 * Owner panel: the private page David opens on his laptop or phone to send the
 * bot into a meeting, watch the live transcript and the Noted items, make the bot
 * say a typed line, mute it, and make it leave.
 *
 * Auth is the HttpOnly `jm_owner` cookie set by POST /panel/login. The owner
 * token is only ever held in the sign-in field while it is typed: it is not
 * rendered back, not stored anywhere (no localStorage, no sessionStorage) and
 * is cleared as soon as the form is submitted. Whether we are signed in is
 * learned by asking the server (a 401 on GET /api/owner/meetings means no).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ApiError,
  api,
  checkMeetingLink,
  clock,
  isUnauthorized,
  messageOf,
  type ListedMeeting,
  type UpcomingCalendarMeeting,
  type JoinMode,
  type UpcomingCalendarResponse,
  type AvatarCatalogResponse,
  type AvatarProviderOption,
} from './api.js'
import { LiveView } from './live-view.js'
import { Notice, StatusBadge } from './ui.js'

const MEETINGS_POLL_MS = 5_000
const KB_HEALTH_POLL_MS = 15_000

function SignIn({ onSignedIn, startMessage }: { onSignedIn: () => void; startMessage: string | null }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(startMessage)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const typed = token
    setToken('')
    if (typed === '') {
      setError('Enter your owner token.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('/panel/login', { method: 'POST', body: { token: typed } })
      onSignedIn()
    } catch (err) {
      setError(isUnauthorized(err) ? 'That token was not accepted.' : messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2>Sign in</h2>
      <div className="field">
        <label htmlFor="owner-token">Owner token</label>
        <input
          id="owner-token"
          name="owner-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in...' : 'Sign in'}
      </button>
      <Notice notice={error ? { kind: 'error', text: error } : null} />
    </form>
  )
}

function JoinForm({ onJoined, onExpired }: { onJoined: (meetingId: string) => void; onExpired: () => void }) {
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem = checkMeetingLink(link)
    setLinkError(problem)
    setError(null)
    if (problem !== null) return
    setBusy(true)
    try {
      const body: { meeting_url: string; title?: string } = { meeting_url: link.trim() }
      if (title.trim() !== '') body.title = title.trim()
      const joined = await api<{ meetingId: string }>('/v1/dispatch', { method: 'POST', body })
      setLink('')
      setTitle('')
      onJoined(joined.meetingId)
    } catch (err) {
      if (isUnauthorized(err)) onExpired()
      else if (err instanceof ApiError && err.status === 502) setError(`Could not start the bot (${err.message}). Nothing joined.`)
      else setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2>Send Jarvis into a meeting</h2>
      <div className="field">
        <label htmlFor="meeting-link">Meeting link</label>
        <input
          id="meeting-link"
          type="url"
          inputMode="url"
          placeholder="https://meet.google.com/..."
          value={link}
          onChange={(e) => setLink(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={linkError !== null}
          aria-describedby={linkError !== null ? 'meeting-link-error' : undefined}
        />
        {linkError !== null && (
          <p className="msg error" id="meeting-link-error" role="alert">
            {linkError}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="meeting-title">Title (optional)</label>
        <input id="meeting-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </div>
      <fieldset className="field plain">
        <legend className="label">Mode</legend>
        <div className="modes">
          <label className="mode on">
            <input type="radio" name="mode" value="sidekick" checked onChange={() => {}} />
            <span>
              Sidekick
              <small>Listens, takes notes, speaks when asked</small>
            </span>
          </label>
          <label className="mode off">
            <input type="radio" name="mode" value="stand-in" disabled />
            <span>
              Stand-in
              <small>coming later</small>
            </span>
          </label>
        </div>
      </fieldset>
      <button type="submit" disabled={busy}>
        {busy ? 'Sending the bot...' : 'Join meeting'}
      </button>
      <Notice notice={error ? { kind: 'error', text: error } : null} />
    </form>
  )
}

function UpcomingCalendarCard({
  status,
  onToggleSkip,
  onSetJoinMode,
  onOpenMeeting,
}: {
  status: UpcomingCalendarResponse | null
  onToggleSkip: (eventKey: string, skip: boolean) => Promise<void>
  onSetJoinMode: (mode: JoinMode) => Promise<void>
  onOpenMeeting: (meetingId: string) => void
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  if (!status || (!status.enabled && status.upcoming.length === 0)) return null

  async function toggle(item: UpcomingCalendarMeeting) {
    if (busyKey !== null) return
    setBusyKey(item.eventKey)
    try {
      await onToggleSkip(item.eventKey, item.willJoin)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <section className="card" aria-labelledby="upcoming-heading">
      <div className="bar" style={{ marginBottom: 8 }}>
        <h2 id="upcoming-heading" style={{ marginBottom: 0 }}>
          Calendar Auto-Join
        </h2>
        <span className={`badge ${status.enabled ? 'ok' : 'idle'}`}>
          {status.enabled ? 'Active' : 'Off'}
        </span>
      </div>
      <label style={{ display: 'block', marginBottom: 10 }}>
        <span className="sub" style={{ display: 'block', marginBottom: 4 }}>
          Which meetings Jarvis joins on its own
        </span>
        <select
          aria-label="Join rule"
          value={status.joinMode ?? 'all'}
          disabled={!status.enabled}
          onChange={(e) => void onSetJoinMode(e.target.value as JoinMode)}
        >
          <option value="all">Every meeting on my calendar</option>
          <option value="internal_only">Only meetings with no outside guests</option>
          <option value="manual">None. I switch on each meeting myself</option>
        </select>
        <span className="sub" style={{ display: 'block', marginTop: 4 }}>
          The Skip / Auto-join button on a meeting always wins over this rule.
        </span>
      </label>
      {status.lastError && <Notice notice={{ kind: 'error', text: status.lastError }} />}
      {status.upcoming.length === 0 ? (
        <p className="empty">No upcoming video meetings in the next 24 hours.</p>
      ) : (
        <ul className="meeting-list">
          {status.upcoming.map((u) => (
            <li
              key={u.eventKey}
              className="pick"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <span className="title">{u.title}</span>
                <span className="sub">
                  <span
                    className={`badge ${
                      u.status === 'dispatched' ? 'ok' : u.willJoin ? 'ok' : 'idle'
                    }`}
                  >
                    {u.status === 'dispatched'
                      ? 'Joined'
                      : u.willJoin
                        ? 'Auto-join'
                        : 'Skipped'}
                  </span>
                  <span>
                    {clock(u.startIso)} – {clock(u.endIso)}
                  </span>
                  <span>{u.calendarId}</span>
                </span>
              </div>
              {u.status === 'dispatched' && u.meetingId ? (
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => onOpenMeeting(u.meetingId!)}
                >
                  Open
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary small"
                  disabled={busyKey === u.eventKey}
                  onClick={() => void toggle(u)}
                >
                  {u.willJoin ? 'Skip' : 'Auto-join'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AvatarSwitcherCard({
  catalog,
  onSelect,
}: {
  catalog: AvatarCatalogResponse | null
  onSelect: (provider: AvatarProviderOption['id']) => Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  if (!catalog || catalog.providers.length === 0) return null

  async function pick(id: AvatarProviderOption['id']) {
    if (busyId !== null || id === catalog!.activeProvider) return
    setBusyId(id)
    try {
      await onSelect(id)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="card" aria-labelledby="avatar-heading">
      <div className="bar" style={{ marginBottom: 8 }}>
        <h2 id="avatar-heading" style={{ marginBottom: 0 }}>
          Live Avatar Engine (4 Options)
        </h2>
        <span className="badge ok">{catalog.activeProvider}</span>
      </div>
      <ul className="meeting-list">
        {catalog.providers.map((p) => {
          const isActive = p.id === catalog.activeProvider
          return (
            <li
              key={p.id}
              className="pick"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <span className="title">
                  {p.name} <small style={{ opacity: 0.7 }}>({p.vendor})</small>
                </span>
                <span className="sub">
                  <span className={`badge ${isActive ? 'ok' : 'idle'}`}>
                    {isActive ? 'Active on Tile' : 'Available'}
                  </span>
                  <span>{p.tagline}</span>
                </span>
              </div>
              <button
                type="button"
                className={isActive ? 'small' : 'secondary small'}
                disabled={isActive || busyId === p.id}
                onClick={() => void pick(p.id)}
              >
                {isActive ? 'Selected' : busyId === p.id ? 'Switching...' : 'Use Avatar'}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function MeetingList({ meetings, onOpen }: { meetings: ListedMeeting[]; onOpen: (id: string) => void }) {
  return (
    <section className="card" aria-labelledby="meetings-heading">
      <h2 id="meetings-heading">Meetings</h2>
      {meetings.length === 0 ? (
        <p className="empty">No meetings yet. Paste a link above to send Jarvis in.</p>
      ) : (
        <ul className="meeting-list">
          {meetings.map((m) => (
            <li key={m.id}>
              <button type="button" className="pick" onClick={() => onOpen(m.id)}>
                <span className="title">{m.title}</span>
                <span className="sub">
                  <StatusBadge meeting={m} />
                  {m.status === 'live' && <span>{m.inCall ? 'In the call' : 'Waiting to be let in'}</span>}
                  {m.muted && m.status === 'live' && <span>Muted</span>}
                  <span>{m.notesCount === 1 ? '1 noted' : `${m.notesCount} noted`}</span>
                  <span className="key">OpenBrain: {m.obEntityKey}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function KbBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="badge idle">OpenBrain: checking</span>
  return ok ? <span className="badge ok">OpenBrain: connected</span> : <span className="badge bad" role="status">OpenBrain: unreachable</span>
}

type Phase = 'checking' | 'signed-out' | 'ready'

function App() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [signedOutMessage, setSignedOutMessage] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [meetings, setMeetings] = useState<ListedMeeting[]>([])
  const [upcomingStatus, setUpcomingStatus] = useState<UpcomingCalendarResponse | null>(null)
  const [avatarCatalog, setAvatarCatalog] = useState<AvatarCatalogResponse | null>(null)
  const [kbOk, setKbOk] = useState<boolean | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const phaseRef = useRef<Phase>('checking')
  phaseRef.current = phase

  const expire = useCallback((message: string | null) => {
    setSignedOutMessage(message)
    setOpenId(null)
    setMeetings([])
    setUpcomingStatus(null)
    setKbOk(null)
    setPhase('signed-out')
  }, [])
  const onExpired = useCallback(() => expire('Your session ended. Sign in again.'), [expire])

  // The server is the only source of truth for "am I signed in": ask it.
  const refreshMeetings = useCallback(async () => {
    try {
      const [res, up, av] = await Promise.all([
        api<{ meetings: ListedMeeting[] }>('/api/owner/meetings'),
        api<UpcomingCalendarResponse>('/api/owner/upcoming').catch(() => null),
        api<AvatarCatalogResponse>('/api/owner/avatar-provider').catch(() => null),
      ])
      setMeetings(res.meetings)
      if (up !== null) setUpcomingStatus(up)
      if (av !== null) setAvatarCatalog(av)
      setOffline(false)
      setPhase('ready')
    } catch (err) {
      if (isUnauthorized(err)) {
        // A first look that finds no cookie is just "not signed in"; losing the cookie while signed in is an expiry.
        if (phaseRef.current === 'ready') onExpired()
        else expire(null)
      } else setOffline(true)
    }
  }, [expire, onExpired])

  const setJoinMode = useCallback(
    async (mode: JoinMode) => {
      try {
        const res = await api<UpcomingCalendarResponse>('/api/owner/join-mode', { method: 'POST', body: { mode } })
        setUpcomingStatus(res)
      } catch (err) {
        if (isUnauthorized(err)) onExpired()
      }
    },
    [onExpired],
  )

  const toggleUpcomingSkip = useCallback(
    async (eventKey: string, skip: boolean) => {
      try {
        const res = await api<UpcomingCalendarResponse>('/api/owner/upcoming/skip', {
          method: 'POST',
          body: { eventKey, skip },
        })
        setUpcomingStatus(res)
      } catch (err) {
        if (isUnauthorized(err)) onExpired()
      }
    },
    [onExpired],
  )

  const selectAvatarProvider = useCallback(
    async (provider: AvatarProviderOption['id']) => {
      try {
        const res = await api<AvatarCatalogResponse>('/api/owner/avatar-provider', {
          method: 'POST',
          body: { provider },
        })
        setAvatarCatalog(res)
      } catch (err) {
        if (isUnauthorized(err)) onExpired()
      }
    },
    [onExpired],
  )

  useEffect(() => {
    void refreshMeetings()
  }, [refreshMeetings])

  useEffect(() => {
    if (phase !== 'ready') return
    const timer = setInterval(() => void refreshMeetings(), MEETINGS_POLL_MS)
    return () => clearInterval(timer)
  }, [phase, refreshMeetings])

  useEffect(() => {
    if (phase !== 'ready') return
    let stopped = false
    const check = async () => {
      try {
        const res = await api<{ ok: boolean }>('/api/owner/kb-health')
        if (!stopped) setKbOk(res.ok)
      } catch {
        if (!stopped) setKbOk(false)
      }
    }
    void check()
    const timer = setInterval(() => void check(), KB_HEALTH_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [phase])

  async function signOut() {
    await api('/panel/logout', { method: 'POST' }).catch(() => undefined)
    expire(null)
  }

  return (
    <>
      <header className="bar">
        <h1>Jarvis</h1>
        {phase === 'ready' && (
          <div className="bar-actions">
            <KbBadge ok={kbOk} />
            <button type="button" className="secondary small" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {phase === 'checking' && (
        <p className="empty" role="status">
          {offline ? (
            <>
              Cannot reach the server.{' '}
              <button type="button" className="link-button" onClick={() => void refreshMeetings()}>
                Try again
              </button>
            </>
          ) : (
            'Loading...'
          )}
        </p>
      )}

      {phase === 'signed-out' && (
        <SignIn
          startMessage={signedOutMessage}
          onSignedIn={() => {
            setSignedOutMessage(null)
            void refreshMeetings()
          }}
        />
      )}

      {phase === 'ready' && (
        <>
          {offline && (
            <p className="msg error" role="alert">
              Cannot reach the server. Showing the last list.
            </p>
          )}
          {openId !== null ? (
            <LiveView
              key={openId}
              id={openId}
              listed={meetings.find((m) => m.id === openId)}
              onBack={() => setOpenId(null)} onExpired={onExpired} onChanged={() => void refreshMeetings()} />
          ) : (
            <>
              <JoinForm
                onExpired={onExpired}
                onJoined={(meetingId) => {
                  void refreshMeetings()
                  setOpenId(meetingId)
                }}
              />
              <UpcomingCalendarCard
                status={upcomingStatus}
                onToggleSkip={toggleUpcomingSkip}
                onSetJoinMode={setJoinMode}
                onOpenMeeting={setOpenId}
              />
              <AvatarSwitcherCard
                catalog={avatarCatalog}
                onSelect={selectAvatarProvider}
              />
              <MeetingList meetings={meetings} onOpen={setOpenId} />
            </>
          )}
        </>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
