// Hands a task from the meeting to Claude Code on this machine (`claude -p`, headless).
//
// This is how the meeting agent reaches what David's Claude Code can reach (skills,
// connectors, repos) without each one being rebuilt as a meeting tool. The run uses
// Claude Code's own permission settings in "dontAsk" mode: a tool that is not already
// allowed there is denied, never prompted for. On top of that the run is started with a
// deny list (DEFAULT_DISALLOWED_TOOLS): no shell and no file writes, so the read-only
// rule holds at the tool layer and not only in the prompt. The task text comes from a
// model's tool call and the run reads untrusted text (mail, web pages), so the prompt
// alone is not a boundary.

import { spawn } from 'node:child_process';

export interface ClaudeCodeResult {
  ok: boolean;
  /** The run's final text. Empty when it failed. */
  result: string;
  /** Why it failed, when it did. */
  error?: 'TIMEOUT' | 'EXIT' | 'OUTPUT' | 'SPAWN';
  costUsd: number | null;
  durationMs: number;
  /** Tools the run asked for and was refused. */
  deniedTools: number;
}

export interface ClaudeCodeOptions {
  bin: string;
  cwd: string;
  timeoutMs: number;
  maxBudgetUsd: number;
  /** Tools the run may never use, whatever Claude Code's own settings allow. */
  disallowedTools: string[];
  /** Test seam: start the process. Defaults to node's spawn. */
  spawnProcess?: typeof spawn;
}

export type ClaudeCodeRunner = (task: string) => Promise<ClaudeCodeResult>;

/** Denied by default: the shell (most side effects go through it) and every file write. */
export const DEFAULT_DISALLOWED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'];

/** CLAUDE_CODE_DISALLOWED_TOOLS: a comma separated list (a rule may hold spaces); "none" clears the default. */
export function parseDisallowedTools(value: string | undefined): string[] {
  const text = (value ?? '').trim();
  if (text === '') return DEFAULT_DISALLOWED_TOOLS;
  if (text.toLowerCase() === 'none') return [];
  return text.split(',').map((tool) => tool.trim()).filter((tool) => tool !== '');
}

/** What Claude Code is told around the task. `SPOKEN:` gives the agent a line to say. */
export function delegatePrompt(task: string, ownerName: string): string {
  return [
    `You were started by ${ownerName}'s meeting assistant. ${ownerName} asked for this out loud, in a live meeting, and is not at a keyboard. Nobody can answer a question or approve a permission prompt during this run.`,
    '',
    'Rules for this run:',
    '- Do the read-only part of the work. Reading, searching and summarizing are fine. The shell and file-writing tools are switched off for this run; if the task needs them, say what you would do and stop.',
    '- Do NOT send a message or email, post or publish anything, merge, deploy, push to a default branch, spend money, delete anything, or change settings. If the task needs one of those, prepare it and say exactly what is waiting for approval.',
    '- Never state pay, salary or compensation figures.',
    '- Work in under four minutes. If the task is larger, do the most useful part and say what is left.',
    '',
    'Your reply is read back in the meeting. Format it exactly like this:',
    'SPOKEN: one or two plain sentences with the outcome, written to be said out loud (no markdown, no paths, no ids).',
    'Then a blank line, then the details: what you found or drafted, where a draft is saved, and what is waiting for approval.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

/** The line to say and the text to post, from a run's final message. */
export function splitDelegateResult(result: string): { spoken: string; details: string } {
  const text = result.trim();
  const match = /^\s*SPOKEN:\s*(.+?)(?:\n\s*\n|\n|$)/s.exec(text);
  if (match) {
    return { spoken: match[1]!.replace(/\s+/g, ' ').trim().slice(0, 500), details: text.slice(match[0].length).trim() };
  }
  // No marker: say the first two sentences.
  const plain = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  return { spoken: sentences.slice(0, 2).map((sentence) => sentence.trim()).join(' ').slice(0, 500), details: text };
}

/**
 * Run one task. Never throws. The child gets a minimal environment: none of this
 * service's API keys are passed to it.
 */
export function runClaudeCode(prompt: string, options: ClaudeCodeOptions): Promise<ClaudeCodeResult> {
  const started = Date.now();
  const start = options.spawnProcess ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Omit<ClaudeCodeResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, durationMs: Date.now() - started });
    };
    const home = process.env['HOME'] ?? '';
    let child: ReturnType<typeof spawn>;
    try {
      child = start(
        options.bin,
        [
          '-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk', '--max-budget-usd', String(options.maxBudgetUsd),
          // Last: the flag takes every argument after it. Deny rules win over allow rules.
          ...(options.disallowedTools.length > 0 ? ['--disallowedTools', ...options.disallowedTools] : []),
        ],
        {
          cwd: options.cwd,
          // stdin is closed: with an open pipe `claude -p` waits for input that never comes.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: `/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:/usr/bin:/bin`,
            HOME: home,
            USER: process.env['USER'] ?? '',
            LANG: 'en_US.UTF-8',
            ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
          },
        },
      );
    } catch {
      finish({ ok: false, result: '', error: 'SPAWN', costUsd: null, deniedTools: 0 });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      finish({ ok: false, result: '', error: 'TIMEOUT', costUsd: null, deniedTools: 0 });
    }, options.timeoutMs);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish({ ok: false, result: '', error: 'SPAWN', costUsd: null, deniedTools: 0 }));
    child.on('close', () => {
      const brace = stdout.indexOf('{');
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = brace >= 0 ? (JSON.parse(stdout.slice(brace)) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      if (!parsed) {
        finish({ ok: false, result: '', error: 'OUTPUT', costUsd: null, deniedTools: 0 });
        return;
      }
      const result = typeof parsed['result'] === 'string' ? parsed['result'] : '';
      const costUsd = typeof parsed['total_cost_usd'] === 'number' ? parsed['total_cost_usd'] : null;
      const denials = Array.isArray(parsed['permission_denials']) ? parsed['permission_denials'].length : 0;
      const failed = parsed['is_error'] === true || result.trim() === '';
      finish({ ok: !failed, result: failed ? '' : result, ...(failed ? { error: 'EXIT' as const } : {}), costUsd, deniedTools: denials });
    });
  });
}
