// Read-only GitHub lookups for the researcher, through the `gh` CLI that is already
// signed in on this machine.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GhJson = (args: string[]) => Promise<unknown>;

export function ghRunner(bin: string): GhJson {
  return async (args) => {
    const home = process.env['HOME'] ?? '';
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:/usr/bin:/bin` },
    });
    return JSON.parse(stdout) as unknown;
  };
}

/** Pull requests the signed-in user wrote, newest first, optionally narrowed by words. */
export async function searchPullRequests(run: GhJson, input: { query?: string; state?: string; limit: number }): Promise<unknown> {
  const args = ['search', 'prs', ...(input.query ? [input.query] : []), '--author', '@me', '--sort', 'updated', '--limit', String(input.limit), '--json', 'title,repository,state,updatedAt,url,number,isDraft'];
  if (input.state === 'open' || input.state === 'closed') args.push('--state', input.state);
  const rows = (await run(args)) as Array<Record<string, unknown>>;
  return {
    pull_requests: (Array.isArray(rows) ? rows : []).map((row) => ({
      repo: (row['repository'] as { nameWithOwner?: string } | undefined)?.nameWithOwner ?? '',
      number: row['number'],
      title: row['title'],
      state: row['isDraft'] === true && row['state'] === 'open' ? 'draft' : row['state'],
      updated: row['updatedAt'],
    })),
  };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** One pull request: state, checks and where it stands. */
export async function pullRequestStatus(run: GhJson, input: { repo: string; number: number }): Promise<unknown> {
  if (!REPO_RE.test(input.repo) || !Number.isInteger(input.number) || input.number <= 0) throw new Error('repo must be owner/name and number a positive integer');
  const pr = (await run(['pr', 'view', String(input.number), '--repo', input.repo, '--json', 'title,state,isDraft,mergedAt,updatedAt,mergeable,reviewDecision,statusCheckRollup'])) as Record<string, unknown>;
  const checks = Array.isArray(pr['statusCheckRollup']) ? (pr['statusCheckRollup'] as Array<Record<string, unknown>>) : [];
  return {
    repo: input.repo,
    number: input.number,
    title: pr['title'],
    state: pr['isDraft'] === true && pr['state'] === 'OPEN' ? 'DRAFT' : pr['state'],
    merged_at: pr['mergedAt'] ?? null,
    updated: pr['updatedAt'],
    mergeable: pr['mergeable'],
    review: pr['reviewDecision'] || null,
    checks: checks.map((check) => ({ name: check['name'] ?? check['context'], result: check['conclusion'] ?? check['state'] ?? check['status'] })).slice(0, 20),
  };
}
