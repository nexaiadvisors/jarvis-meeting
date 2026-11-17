// Small display pieces used by more than one panel screen.

import type { ListedMeeting } from './api.js'

export function StatusBadge({ meeting }: { meeting: Pick<ListedMeeting, 'status' | 'failureCode'> }) {
  if (meeting.status === 'live') return <span className="badge ok">Live</span>
  if (meeting.status === 'failed') {
    return <span className="badge bad">Failed{meeting.failureCode ? `: ${meeting.failureCode}` : ''}</span>
  }
  return <span className="badge idle">Ended</span>
}

export function Notice({ notice }: { notice: { kind: 'info' | 'error'; text: string } | null }) {
  if (notice === null) return null
  return (
    <p className={`msg ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </p>
  )
}
