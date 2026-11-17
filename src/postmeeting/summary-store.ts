// The meeting summary on disk: <dataDir>/<botId>.summary.json.
//
// The post-meeting pipeline writes it once the summary step finishes, so the summary
// can be read later (MCP get_summary / get_action_items, the meeting page) without
// asking the model again. `generated` is false when the model produced no summary and
// the pipeline stored its failure text instead.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryResult } from './summary.js';

export interface StoredSummary extends SummaryResult {
  generated: boolean;
  /** ISO-8601 time the summary was stored. */
  at: string;
}

// The key becomes part of a file name, so it must be a plain name.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function defaultDataDir(): string {
  return join(process.cwd(), '.data');
}

/** Store a meeting's summary. Throws on a bad key or a failed write; the caller logs it. */
export function writeSummary(
  botId: string,
  summary: SummaryResult,
  generated: boolean,
  dataDir: string = defaultDataDir(),
): void {
  if (!SAFE_KEY.test(botId)) throw new Error('invalid summary key');
  mkdirSync(dataDir, { recursive: true });
  const stored: StoredSummary = {
    bluf: summary.bluf,
    decisions: summary.decisions,
    actionItems: summary.actionItems,
    generated,
    at: new Date().toISOString(),
  };
  writeFileSync(join(dataDir, `${botId}.summary.json`), JSON.stringify(stored, null, 2), 'utf8');
}

/** Read a stored summary. Undefined when there is none or the file is not a summary. Never throws. */
export function readSummary(botId: string, dataDir: string = defaultDataDir()): StoredSummary | undefined {
  if (!SAFE_KEY.test(botId)) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(dataDir, `${botId}.summary.json`), 'utf8')) as Partial<StoredSummary>;
    if (typeof v.bluf !== 'string' || !Array.isArray(v.decisions) || !Array.isArray(v.actionItems)) return undefined;
    return {
      bluf: v.bluf,
      decisions: v.decisions,
      actionItems: v.actionItems,
      generated: v.generated === true,
      at: typeof v.at === 'string' ? v.at : '',
    };
  } catch {
    return undefined;
  }
}
