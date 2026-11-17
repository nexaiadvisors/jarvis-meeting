import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __clearAgentUtterances,
  appendAgentUtterance,
  readMergedTranscript,
  renderTranscriptText,
} from './transcript.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'transcript-'));
  __clearAgentUtterances();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: unknown[]): void {
  writeFileSync(join(dataDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const human = (timestamp: string, text: string, speaker = 'David') => ({ speaker, text, timestamp });

describe('readMergedTranscript', () => {
  it('interleaves the webhook lines and the agent lines by timestamp', () => {
    writeJsonl('bot-1.jsonl', [
      human('2026-10-16T10:00:00.000Z', 'Jarvis, what shipped this week?'),
      human('2026-10-16T10:00:20.000Z', 'Thanks.'),
    ]);
    writeJsonl('m-1.agent.jsonl', [human('2026-10-16T10:00:10.000Z', 'We shipped the panel.', 'Sidekick')]);

    const out = readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.text)).toEqual(['Jarvis, what shipped this week?', 'We shipped the panel.', 'Thanks.']);
  });

  it('labels agent lines with the bot display name, whatever speaker the page posted', () => {
    writeJsonl('bot-1.jsonl', [human('2026-10-16T10:00:00.000Z', 'hi')]);
    writeJsonl('m-1.agent.jsonl', [
      human('2026-10-16T10:00:05.000Z', 'Hello.', 'agent'),
      human('2026-10-16T10:00:06.000Z', 'Say this line.', 'Agent'),
    ]);

    const out = readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.speaker)).toEqual(['David', 'Jarvis', 'Jarvis']);
  });

  it('includes in-memory agent lines that are not on disk yet', () => {
    writeJsonl('bot-1.jsonl', [human('2026-10-16T10:00:00.000Z', 'hi')]);
    // Nothing in m-1.agent.jsonl: the disk write fails (the "directory" is a plain file).
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blocked = join(dataDir, 'blocked');
    writeFileSync(blocked, 'x', 'utf8');
    appendAgentUtterance('m-1', human('2026-10-16T10:00:05.000Z', 'In memory only.', 'Agent'), blocked);

    const out = readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.text)).toEqual(['hi', 'In memory only.']);
  });

  it('does not duplicate a line that is both on disk and in memory, but keeps genuine repeats', () => {
    const line = human('2026-10-16T10:00:05.000Z', 'Okay.', 'Agent');
    appendAgentUtterance('m-1', line, dataDir); // file + memory
    appendAgentUtterance('m-1', line, dataDir); // a real second, identical line

    const out = readMergedTranscript({ meetingId: 'm-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.text)).toEqual(['Okay.', 'Okay.']);
  });

  it('after a restart (empty memory) the agent file alone gives the same lines', () => {
    appendAgentUtterance('m-1', human('2026-10-16T10:00:05.000Z', 'Before restart.', 'Agent'), dataDir);
    __clearAgentUtterances();

    const out = readMergedTranscript({ meetingId: 'm-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.text)).toEqual(['Before restart.']);
  });

  it('keys the webhook file by botId, falling back to meetingId when there is no bot yet', () => {
    writeJsonl('bot-1.jsonl', [human('2026-10-16T10:00:00.000Z', 'by bot id')]);
    writeJsonl('m-2.jsonl', [human('2026-10-16T10:00:00.000Z', 'by meeting id')]);

    expect(readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir).map((e) => e.text)).toEqual(['by bot id']);
    expect(readMergedTranscript({ meetingId: 'm-2' }, 'Jarvis', dataDir).map((e) => e.text)).toEqual(['by meeting id']);
  });

  it('on an equal timestamp the spoken line comes before the agent line, and source order is kept', () => {
    const t = '2026-10-16T10:00:00.000Z';
    writeJsonl('bot-1.jsonl', [human(t, 'first'), human(t, 'second')]);
    writeJsonl('m-1.agent.jsonl', [human(t, 'agent reply')]);

    const out = readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir);

    expect(out.map((e) => e.text)).toEqual(['first', 'second', 'agent reply']);
  });

  it('skips malformed lines and tolerates missing files', () => {
    appendFileSync(join(dataDir, 'bot-1.jsonl'), 'not json\n' + JSON.stringify(human('2026-10-16T10:00:00.000Z', 'ok')) + '\n');

    expect(readMergedTranscript({ meetingId: 'm-1', botId: 'bot-1' }, 'Jarvis', dataDir).map((e) => e.text)).toEqual(['ok']);
    expect(readMergedTranscript({ meetingId: 'nothing', botId: 'nothing-bot' }, 'Jarvis', dataDir)).toEqual([]);
  });

  it('refuses a key that is not a plain file name', () => {
    writeJsonl('secret.jsonl', [human('2026-10-16T10:00:00.000Z', 'should not be read')]);

    expect(readMergedTranscript({ meetingId: 'm-1', botId: '../secret' }, 'Jarvis', join(dataDir, 'sub'))).toEqual([]);
    expect(readMergedTranscript({ meetingId: '../secret' }, 'Jarvis', join(dataDir, 'sub'))).toEqual([]);
  });
});

describe('renderTranscriptText', () => {
  it('renders one "[timestamp] speaker: text" line per entry, in order', () => {
    expect(
      renderTranscriptText([
        human('2026-10-16T10:00:00.000Z', 'hi'),
        human('2026-10-16T10:00:05.000Z', 'hello', 'Jarvis'),
      ]),
    ).toBe('[2026-10-16T10:00:00.000Z] David: hi\n[2026-10-16T10:00:05.000Z] Jarvis: hello');
  });

  it('is the empty string for no entries', () => {
    expect(renderTranscriptText([])).toBe('');
  });
});
