// Non-blocking background task execution ("Converse While Working")
//
// Allows Jarvis to race slow OpenBrain searches or tool calls against a
// fast-path latency budget (default 650ms). When a retrieval exceeds the
// budget, Jarvis immediately acknowledges in conversation ("Let me pull that
// up in the background"), displays a live progress pill on the meeting tile,
// and delivers the grounded result at the next silence gap when neither the
// agent nor overlapping human speakers hold the floor.

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';

export interface BackgroundTask {
  id: string;
  meetingId: string;
  label: string;
  query: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  elapsedMs?: number;
  delivered: boolean;
  summary?: string;
}

export const DEFAULT_FAST_RETRIEVAL_BUDGET_MS = 650;

const tasksByMeeting = new Map<string, Map<string, BackgroundTask>>();

export function upsertBackgroundTask(task: BackgroundTask): BackgroundTask {
  let map = tasksByMeeting.get(task.meetingId);
  if (!map) {
    map = new Map<string, BackgroundTask>();
    tasksByMeeting.set(task.meetingId, map);
  }
  const copy: BackgroundTask = { ...task };
  map.set(copy.id, copy);
  // Keep at most 20 recent tasks per meeting
  if (map.size > 20) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  return copy;
}

export function listBackgroundTasks(meetingId: string): BackgroundTask[] {
  const map = tasksByMeeting.get(meetingId);
  if (!map) return [];
  return Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function clearBackgroundTasks(meetingId?: string): void {
  if (meetingId !== undefined) {
    tasksByMeeting.delete(meetingId);
  } else {
    tasksByMeeting.clear();
  }
}

export type BudgetRaceResult<T> =
  | { kind: 'fast'; value: T; elapsedMs: number }
  | { kind: 'background'; promise: Promise<{ value: T; elapsedMs: number }> };

/**
 * Race a promise against `budgetMs`. If `work` settles before the timer,
 * returns `{ kind: 'fast', value, elapsedMs }`. Otherwise returns
 * `{ kind: 'background', promise }` so the caller can acknowledge immediately
 * and await `promise` asynchronously without cancelling the in-flight request.
 */
export async function raceWithBudget<T>(
  work: Promise<T>,
  budgetMs: number = DEFAULT_FAST_RETRIEVAL_BUDGET_MS,
  nowFn: () => number = Date.now,
): Promise<BudgetRaceResult<T>> {
  const startedAt = nowFn();
  const timedWork = work.then((value) => ({
    value,
    elapsedMs: Math.max(0, nowFn() - startedAt),
  }));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutSentinel = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), budgetMs);
  });

  try {
    const winner = await Promise.race([
      timedWork.then((res) => ({ timeout: false as const, res })),
      timeoutSentinel,
    ]);
    if (!winner.timeout) {
      return { kind: 'fast', value: winner.res.value, elapsedMs: winner.res.elapsedMs };
    }
    return { kind: 'background', promise: timedWork };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface FloorStateForBackgroundDelivery {
  isSpeaking: boolean;
  activeResponse: boolean;
  overlappingSpeech: boolean;
  muted: boolean;
  dormant: boolean;
}

/**
 * True only when the floor is clear to deliver a completed background task
 * result: agent is not speaking/generating, humans are not in overlapping
 * cross-talk, and agent is neither muted nor dormant.
 */
export function canDeliverBackgroundResult(floor: FloorStateForBackgroundDelivery): boolean {
  if (floor.muted || floor.dormant) return false;
  if (floor.isSpeaking || floor.activeResponse) return false;
  if (floor.overlappingSpeech) return false;
  return true;
}

export function formatBackgroundAckDirective(question: string, label: string): string {
  return [
    `[BACKGROUND TASK STARTED: ${label}]`,
    `OpenBrain retrieval for "${question}" is still running in the background.`,
    `Reply right now with ONE brief, natural acknowledgment sentence (for example: "Let me pull that up in the background—keep going, and I'll chime in as soon as I have it.") and do NOT guess or fabricate the answer before the background task finishes.`,
  ].join('\n');
}

export function formatBackgroundCompletionDirective(
  question: string,
  label: string,
  groundedContext: string,
): string {
  return [
    `[BACKGROUND TASK COMPLETED: ${label}]`,
    `The background retrieval for "${question}" has finished:`,
    groundedContext,
    `Deliver a concise 1–2 sentence grounded follow-up answer now using only the retrieved facts above.`,
  ].join('\n');
}
