// Shared check-runner for `jarvis-meeting doctor`.
//
// A "check" is a named, never-throwing async probe that yields a CheckResult
// (PASS / WARN / FAIL + a human message). The runner gives uniform output, and
// the process-exit decision is a PURE function of the results (exitCodeFor) so
// it can be unit-tested without spawning a process.

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface Check {
  name: string;
  /** Never throws — a thrown error is caught by runChecks and recorded as FAIL. */
  run: () => Promise<Omit<CheckResult, 'name'>>;
}

/** Run all checks in order, catching any throw as a FAIL so the runner is total. */
export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks) {
    try {
      const r = await c.run();
      out.push({ name: c.name, status: r.status, message: r.message });
    } catch (err) {
      out.push({
        name: c.name,
        status: 'FAIL',
        message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

/**
 * Pure exit-code decision: any FAIL => 1, otherwise 0. WARN never fails the run.
 * Kept separate from runChecks so the policy is independently testable.
 */
export function exitCodeFor(results: CheckResult[]): number {
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

const ICON: Record<CheckStatus, string> = { PASS: '[PASS]', WARN: '[WARN]', FAIL: '[FAIL]' };

/** Format the report as plain lines (ASCII only). */
export function formatReport(results: CheckResult[]): string {
  const lines = results.map((r) => `${ICON[r.status]} ${r.name}: ${r.message}`);
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  lines.push('');
  lines.push(`Summary: ${results.length} checks, ${fails} failed, ${warns} warning(s).`);
  return lines.join('\n');
}
