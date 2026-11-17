// Bookkeeping for tasks handed to Claude Code from a meeting: at most one running per
// meeting, and a cap per meeting, because each run costs money and takes minutes.

export const DELEGATE_MAX_PER_MEETING = 10;

interface MeetingTasks {
  running: number;
  started: number;
}

const tasks = new Map<string, MeetingTasks>();

export type DelegateRefusal = 'BUSY' | 'LIMIT';

/** Reserve a slot for one task. Returns the reason when the meeting may not start one. */
export function reserveDelegateSlot(meetingId: string): DelegateRefusal | null {
  const state = tasks.get(meetingId) ?? { running: 0, started: 0 };
  if (state.running > 0) return 'BUSY';
  if (state.started >= DELEGATE_MAX_PER_MEETING) return 'LIMIT';
  tasks.set(meetingId, { running: state.running + 1, started: state.started + 1 });
  return null;
}

export function releaseDelegateSlot(meetingId: string): void {
  const state = tasks.get(meetingId);
  if (state) tasks.set(meetingId, { ...state, running: Math.max(0, state.running - 1) });
}

export function __clearDelegateTasksForTests(): void {
  tasks.clear();
}
