import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DISALLOWED_TOOLS, delegatePrompt, parseDisallowedTools, runClaudeCode, splitDelegateResult } from './claude-code.js';
import { __clearDelegateTasksForTests, DELEGATE_MAX_PER_MEETING, releaseDelegateSlot, reserveDelegateSlot } from './tasks.js';
import { pullRequestStatus, searchPullRequests } from '../researcher/github.js';

/** A fake child process that prints `stdout` and closes, or never closes. */
function fakeSpawn(stdout: string | null) {
  const calls: Array<{ bin: string; args: string[]; options: Record<string, any> }> = [];
  const spawnProcess = ((bin: string, args: string[], options: Record<string, any>) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
    child.stdout = new EventEmitter();
    child.kill = vi.fn();
    if (stdout !== null) {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
      });
    }
    return child;
  }) as never;
  return { spawnProcess, calls };
}
const options = { bin: '/x/claude', cwd: '/tmp', timeoutMs: 5000, maxBudgetUsd: 2, disallowedTools: DEFAULT_DISALLOWED_TOOLS };

describe('runClaudeCode', () => {
  it('runs headless, read by JSON, with denied-unless-allowed permissions and no service secrets', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-service-secret';
    const { spawnProcess, calls } = fakeSpawn(JSON.stringify({ result: 'SPOKEN: Done.\n\nDetails.', is_error: false, total_cost_usd: 0.31, permission_denials: [{}] }));
    const result = await runClaudeCode('do the thing', { ...options, spawnProcess });
    expect(result).toMatchObject({ ok: true, result: 'SPOKEN: Done.\n\nDetails.', costUsd: 0.31, deniedTools: 1 });
    const call = calls[0]!;
    expect(call.bin).toBe('/x/claude');
    expect(call.args.slice(0, 2)).toEqual(['-p', 'do the thing']);
    expect(call.args).toEqual(expect.arrayContaining(['--output-format', 'json', '--permission-mode', 'dontAsk', '--max-budget-usd', '2']));
    // The shell and file writes are denied at the tool layer, as the last flag.
    expect(call.args.slice(-5)).toEqual(['--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit']);
    expect(call.options.stdio[0]).toBe('ignore');
    expect(call.options.cwd).toBe('/tmp');
    expect(Object.keys(call.options.env)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(call.options.env)).not.toContain('sk-service-secret');
    delete process.env['OPENAI_API_KEY'];
  });

  it('reports a failed run, unreadable output and a timeout without throwing', async () => {
    expect(await runClaudeCode('t', { ...options, spawnProcess: fakeSpawn(JSON.stringify({ result: 'Not logged in', is_error: true })).spawnProcess })).toMatchObject({ ok: false, error: 'EXIT', result: '' });
    expect(await runClaudeCode('t', { ...options, spawnProcess: fakeSpawn('not json').spawnProcess })).toMatchObject({ ok: false, error: 'OUTPUT' });
    expect(await runClaudeCode('t', { ...options, timeoutMs: 20, spawnProcess: fakeSpawn(null).spawnProcess })).toMatchObject({ ok: false, error: 'TIMEOUT' });
  });
});

describe('delegatePrompt and splitDelegateResult', () => {
  it('states the meeting rules and carries the task', () => {
    const prompt = delegatePrompt('draft a reply to Pat', 'David');
    expect(prompt).toContain('Task: draft a reply to Pat');
    expect(prompt).toContain('Do NOT send a message or email');
    expect(prompt).toContain('switched off for this run');
    expect(prompt).toContain('SPOKEN:');
  });

  it('separates the line to say from the details', () => {
    expect(splitDelegateResult('SPOKEN: I drafted the reply and saved it.\n\nDraft: drafts/jc.md\nWaiting: your send.')).toEqual({
      spoken: 'I drafted the reply and saved it.',
      details: 'Draft: drafts/jc.md\nWaiting: your send.',
    });
  });

  it('falls back to the first two sentences when the marker is missing', () => {
    const out = splitDelegateResult('**Done.** I found three emails. The newest is from Friday. More below.');
    expect(out.spoken).toBe('Done. I found three emails.');
    expect(out.details).toContain('More below.');
  });
});

describe('delegate slots', () => {
  it('allows one running task per meeting and a fixed number in all', () => {
    __clearDelegateTasksForTests();
    expect(reserveDelegateSlot('m')).toBeNull();
    expect(reserveDelegateSlot('m')).toBe('BUSY');
    expect(reserveDelegateSlot('other')).toBeNull();
    releaseDelegateSlot('m');
    for (let i = 1; i < DELEGATE_MAX_PER_MEETING; i += 1) {
      expect(reserveDelegateSlot('m')).toBeNull();
      releaseDelegateSlot('m');
    }
    expect(reserveDelegateSlot('m')).toBe('LIMIT');
  });
});

describe('GitHub lookups', () => {
  it('lists the signed-in user\'s pull requests in a compact shape', async () => {
    const run = vi.fn(async () => [{ title: 'feat: researcher', number: 6, state: 'merged', isDraft: false, updatedAt: '2026-11-14', repository: { nameWithOwner: 'nexaiadvisors/jarvis-meeting' } }]);
    const out = (await searchPullRequests(run, { query: 'researcher', state: 'closed', limit: 5 })) as { pull_requests: unknown[] };
    expect(run.mock.calls[0]![0]).toEqual(expect.arrayContaining(['search', 'prs', 'researcher', '--author', '@me', '--limit', '5', '--state', 'closed']));
    expect(out.pull_requests[0]).toEqual({ repo: 'nexaiadvisors/jarvis-meeting', number: 6, title: 'feat: researcher', state: 'merged', updated: '2026-11-14' });
  });

  it('refuses a repo or number that is not well formed, before calling gh', async () => {
    const run = vi.fn(async () => ({}));
    await expect(pullRequestStatus(run, { repo: 'x; rm -rf', number: 1 })).rejects.toThrow();
    await expect(pullRequestStatus(run, { repo: 'a/b', number: -2 })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('summarizes one pull request and its checks', async () => {
    const run = vi.fn(async () => ({ title: 't', state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }));
    const out = (await pullRequestStatus(run, { repo: 'a/b', number: 3 })) as { state: string; checks: unknown[] };
    expect(out.state).toBe('DRAFT');
    expect(out.checks).toEqual([{ name: 'test', result: 'SUCCESS' }]);
  });
});

describe('parseDisallowedTools', () => {
  it('denies the shell and file writes unless told otherwise', () => {
    expect(parseDisallowedTools(undefined)).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit']);
    expect(parseDisallowedTools('  ')).toEqual(DEFAULT_DISALLOWED_TOOLS);
  });

  it('takes a custom list, and "none" clears it', () => {
    expect(parseDisallowedTools('Write, Edit, Bash(git push:*)')).toEqual(['Write', 'Edit', 'Bash(git push:*)']);
    expect(parseDisallowedTools('none')).toEqual([]);
  });
});
