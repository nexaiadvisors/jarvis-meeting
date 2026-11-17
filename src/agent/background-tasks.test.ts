import { describe, it, expect, beforeEach } from 'vitest';
import {
  raceWithBudget,
  canDeliverBackgroundResult,
  upsertBackgroundTask,
  listBackgroundTasks,
  clearBackgroundTasks,
  formatBackgroundAckDirective,
  formatBackgroundCompletionDirective,
} from './background-tasks.js';

describe('Phase 2 — Non-Blocking Background Task Execution', () => {
  beforeEach(() => {
    clearBackgroundTasks();
  });

  it('returns kind=fast when the promise resolves within the latency budget', async () => {
    const res = await raceWithBudget(
      new Promise<string>((resolve) => setTimeout(() => resolve('fast-hit'), 15)),
      200,
    );
    expect(res.kind).toBe('fast');
    if (res.kind === 'fast') {
      expect(res.value).toBe('fast-hit');
    }
  });

  it('returns kind=background when the promise exceeds the latency budget, and resolves later', async () => {
    const res = await raceWithBudget(
      new Promise<string>((resolve) => setTimeout(() => resolve('deep-search-result'), 80)),
      15,
    );
    expect(res.kind).toBe('background');
    if (res.kind === 'background') {
      const done = await res.promise;
      expect(done.value).toBe('deep-search-result');
      expect(done.elapsedMs).toBeGreaterThanOrEqual(50);
    }
  });

  it('gates background delivery on silence, non-overlapping speech, and unmuted/non-dormant state', () => {
    expect(
      canDeliverBackgroundResult({
        isSpeaking: false,
        activeResponse: false,
        overlappingSpeech: false,
        muted: false,
        dormant: false,
      }),
    ).toBe(true);

    expect(
      canDeliverBackgroundResult({
        isSpeaking: true,
        activeResponse: false,
        overlappingSpeech: false,
        muted: false,
        dormant: false,
      }),
    ).toBe(false);

    expect(
      canDeliverBackgroundResult({
        isSpeaking: false,
        activeResponse: false,
        overlappingSpeech: true,
        muted: false,
        dormant: false,
      }),
    ).toBe(false);

    expect(
      canDeliverBackgroundResult({
        isSpeaking: false,
        activeResponse: false,
        overlappingSpeech: false,
        muted: true,
        dormant: false,
      }),
    ).toBe(false);
  });

  it('tracks per-meeting background task lifecycle and formats directives', () => {
    upsertBackgroundTask({
      id: 'bg-1',
      meetingId: 'm-1',
      label: 'Searching OpenBrain',
      query: 'Sideshop Q4 revenue',
      status: 'running',
      startedAt: 1000,
      delivered: false,
    });
    expect(listBackgroundTasks('m-1')).toHaveLength(1);
    expect(listBackgroundTasks('m-1')[0]?.status).toBe('running');

    upsertBackgroundTask({
      id: 'bg-1',
      meetingId: 'm-1',
      label: 'Searching OpenBrain',
      query: 'Sideshop Q4 revenue',
      status: 'completed',
      startedAt: 1000,
      completedAt: 2400,
      elapsedMs: 1400,
      delivered: true,
      summary: '3 docs matched',
    });
    expect(listBackgroundTasks('m-1')[0]?.status).toBe('completed');
    expect(listBackgroundTasks('m-1')[0]?.delivered).toBe(true);

    expect(formatBackgroundAckDirective('What is Sideshop Q4 revenue?', 'Searching OpenBrain')).toContain(
      'BACKGROUND TASK STARTED',
    );
    expect(
      formatBackgroundCompletionDirective('What is Sideshop Q4 revenue?', 'Searching OpenBrain', 'Doc 1: $120k'),
    ).toContain('BACKGROUND TASK COMPLETED');
  });
});
