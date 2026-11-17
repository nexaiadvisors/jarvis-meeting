import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The replay script talks to the real webhook route. Mock only the pipeline so no
// Azure / Anthropic / OpenBrain call can happen here.
const mockKickoffPipeline = vi.fn();
vi.mock('../src/postmeeting/pipeline.js', () => ({
  kickoffPipeline: mockKickoffPipeline,
}));

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { registerMeeting, __clearRegistry } = await import('../src/meeting/registry.js');
const { transcriptEvent, botDoneEvent, headingsOf, missingHeadings, summaryStatus, REQUIRED_HEADINGS } = await import(
  '../scripts/replay-meeting.js'
);

const SECRET = 'replay-test-webhook-secret';
const BOT_ID = 'replay-test-bot-0001';
const MEETING_ID = 'replay-test-meeting-0001';
const DATA_DIR = join(process.cwd(), '.data');

function cleanup(): void {
  for (const suffix of ['.jsonl', '.done', '.notes.jsonl']) {
    rmSync(join(DATA_DIR, `${BOT_ID}${suffix}`), { force: true });
  }
}

beforeEach(() => {
  vi.stubEnv('RECALL_API_KEY', 'rk-test');
  vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
  vi.stubEnv('WEBHOOK_SECRET', SECRET);
  vi.stubEnv('DEFAULT_TEAMMATE', 'david');
  mockKickoffPipeline.mockClear();
  __clearRegistry();
  cleanup();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function send(path: string, body: unknown): Promise<Response> {
  const app = createApp(loadConfig());
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('replay-meeting payloads match the webhook route', () => {
  it('transcript.data from the script is stored with its speaker and joined words', async () => {
    registerMeeting({ meetingId: MEETING_ID, botId: BOT_ID, teammate: 'david', persona: 'first_person', title: 't' });
    const res = await send(
      `/webhooks/recall?s=${SECRET}`,
      transcriptEvent(BOT_ID, 'David', 'Ship the replay script today'),
    );
    expect(res.status).toBe(200);
    const file = join(DATA_DIR, `${BOT_ID}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const entry = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0] ?? '{}') as {
      speaker?: string;
      text?: string;
    };
    expect(entry.speaker).toBe('David');
    expect(entry.text).toBe('Ship the replay script today');
  });

  it('a webhook without the secret is refused (the script reports this status)', async () => {
    const res = await send('/webhooks/recall', transcriptEvent(BOT_ID, 'Nobody', 'no secret'));
    expect(res.status).toBe(401);
    expect(existsSync(join(DATA_DIR, `${BOT_ID}.jsonl`))).toBe(false);
  });

  it('bot.done from the script starts the pipeline for the registered meeting and teammate', async () => {
    registerMeeting({
      meetingId: MEETING_ID,
      botId: BOT_ID,
      teammate: 'david',
      persona: 'first_person',
      title: 'jarvis-meeting replay test 2026-10-16',
    });
    const res = await send(`/webhooks/recall?s=${SECRET}`, botDoneEvent(BOT_ID, MEETING_ID, 'david'));
    expect(res.status).toBe(200);
    expect(mockKickoffPipeline).toHaveBeenCalledTimes(1);
    expect(mockKickoffPipeline.mock.calls[0]?.[1]).toMatchObject({
      botId: BOT_ID,
      meetingId: MEETING_ID,
      teammate: 'david',
      meetingTitle: 'jarvis-meeting replay test 2026-10-16',
    });
  });
});

describe('replay-meeting section check', () => {
  it('lists headings in order and reports exactly the missing required ones', () => {
    const doc = ['# Title', '', 'Date: x', '', '## BLUF', 'text', '', '## Transcript', 'lines'].join('\n');
    expect(headingsOf(doc)).toEqual(['# Title', '## BLUF', '## Transcript']);
    expect(missingHeadings(doc)).toEqual(['## Noted']);
    expect(missingHeadings(`## BLUF\n## Noted\n## Transcript\n`)).toEqual([]);
    expect(REQUIRED_HEADINGS).toEqual(['## BLUF', '## Noted', '## Transcript']);
  });

  it('does not count a heading that is only mentioned inside a line', () => {
    expect(missingHeadings('See ## BLUF and ## Noted and ## Transcript here')).toEqual([
      '## BLUF',
      '## Noted',
      '## Transcript',
    ]);
  });
});

describe('replay-meeting summary status', () => {
  it('reports a generated summary only when the pipeline logged one', () => {
    expect(summaryStatus([{ level: 'info', msg: 'pipeline: start' }, { level: 'info', msg: 'summary: generated' }])).toBe(
      'generated',
    );
  });

  it('reports not-generated when the summary step failed or never ran', () => {
    expect(
      summaryStatus([
        { level: 'info', msg: 'pipeline: start' },
        { level: 'error', msg: 'summary: Anthropic returned no text block' },
        { level: 'warn', msg: 'pipeline: no summary generated, skipping email and continuing non-email lanes' },
      ]),
    ).toBe('not-generated');
    expect(summaryStatus([])).toBe('not-generated');
  });
});
