import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMeetingPageRoutes, meetingPageUrl } from './meeting-page.js';
import { createArtifact } from '../meeting/artifacts.js';
import { appendNote } from '../meeting/notes.js';
import { __clearAgentUtterances, appendAgentUtterance } from '../meeting/transcript.js';
import { __clearRegistry, registerMeeting, setAttendees, setStatus, shareTokenFor } from '../meeting/registry.js';
import { writeSummary } from '../postmeeting/summary-store.js';
import { OWNER, makeConfig } from '../../tests/helpers/mcp.js';
import { nextPollMs, parseMeetingLocation, artifactLink, statusLabel, type PageData } from '../../web/meeting-page/view.js';

let dir: string;
let app: Hono;
let token: string;
const config = makeConfig();

beforeEach(() => {
  __clearRegistry();
  __clearAgentUtterances();
  dir = mkdtempSync(join(tmpdir(), 'jm-mpage-'));
  app = createMeetingPageRoutes(config, { dataDir: dir });
  registerMeeting({ meetingId: 'm1', botId: 'bot-secret-1', teammate: 'david', persona: 'ai', title: 'Launch planning' });
  registerMeeting({ meetingId: 'm2', botId: 'b2', teammate: 'david', persona: 'ai', title: 'Other' });
  token = shareTokenFor('m1')!;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => app.fetch(new Request(`http://x${path}`));
const page = async () => (await (await get(`/api/meeting-page/m1?t=${token}`)).json()) as PageData;

describe('meeting page', () => {
  it('shows notes, transcript and artifacts live during the call', async () => {
    writeFileSync(join(dir, 'bot-secret-1.jsonl'), JSON.stringify({ speaker: 'Nick', text: 'Budget is forty thousand', timestamp: '2026-11-13T10:00:00.000Z' }) + '\n');
    appendAgentUtterance('m1', { speaker: 'agent', text: 'Doc: Plan', timestamp: '2026-11-13T10:00:05.000Z', kind: 'chat' }, dir);
    appendNote('bot-secret-1', { kind: 'note', text: 'Send the deck', at: '2026-11-13T10:01:00.000Z', by: 'agent' }, dir);
    appendNote('bot-secret-1', { kind: 'flag', text: '[FLAG FOR DAVID] pricing pushback', at: '2026-11-13T10:02:00.000Z', by: 'agent' }, dir);
    const doc = createArtifact('m1', { kind: 'doc', title: 'Launch plan', content: '# secret body' }, dir);

    const data = await page();
    expect(data.meeting).toMatchObject({ id: 'm1', title: 'Launch planning', status: 'live' });
    expect(data.summary).toBeNull();
    // The private flag for the owner is not shown to link holders.
    expect(data.notes).toEqual([{ kind: 'note', text: 'Send the deck', at: '2026-11-13T10:01:00.000Z' }]);
    expect(data.transcript).toEqual([
      { speaker: 'Nick', text: 'Budget is forty thousand', timestamp: '2026-11-13T10:00:00.000Z' },
      { speaker: 'Jarvis', text: 'Doc: Plan', timestamp: '2026-11-13T10:00:05.000Z', kind: 'chat' },
    ]);
    expect(data.artifacts).toEqual([expect.objectContaining({ id: doc.id, kind: 'doc', title: 'Launch plan' })]);
  });

  it('shows the summary and action items once the meeting has ended', async () => {
    setStatus('m1', 'completed');
    writeSummary('bot-secret-1', { bluf: 'Ship Friday.', decisions: ['Budget stays'], actionItems: [{ owner: 'Nick', task: 'Send the deck', due: '2026-11-20' }] }, true, dir);
    const data = await page();
    expect(data.meeting.status).toBe('completed');
    expect(data.summary).toEqual({ bluf: 'Ship Friday.', decisions: ['Budget stays'], actionItems: [{ owner: 'Nick', task: 'Send the deck', due: '2026-11-20' }], generated: true });
  });

  it('serves the page shell only with the share token, with a locked-down policy', async () => {
    const res = await get(`/m/m1?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toContain('/meeting-page.js');
  });

  it('answers 404 without the token, with a wrong or another meeting’s token, and for an unknown meeting', async () => {
    const other = shareTokenFor('m2')!;
    for (const path of ['/m/m1', `/m/m1?t=wrong`, `/m/m1?t=${other}`, `/m/m1?t=${OWNER}`, `/m/nope?t=${token}`]) {
      expect((await get(path)).status).toBe(404);
      expect((await get(path.replace('/m/', '/api/meeting-page/'))).status).toBe(404);
    }
  });

  it('never exposes the share token, the owner token, the bot id, artifact bodies or an audio url', async () => {
    createArtifact('m1', { kind: 'doc', title: 'Launch plan', content: '# secret body' }, dir);
    setAttendees('m1', ['invitee@client.test']);
    const body = await (await get(`/api/meeting-page/m1?t=${token}`)).text();
    for (const secret of [token, OWNER, 'bot-secret-1', 'secret body', 'invitee@client.test']) expect(body).not.toContain(secret);
    expect(body).not.toMatch(/audio|sas|blob\.core/i);
  });

  it('meetingPageUrl builds the link with the share token', () => {
    expect(meetingPageUrl(config, 'm1')).toBe(`https://jarvis.example.com/m/m1?t=${token}`);
    expect(meetingPageUrl(config, 'nope')).toBeUndefined();
  });
});

describe('meeting page view helpers', () => {
  const base: PageData = {
    meeting: { id: 'm1', title: 'T', status: 'live', startedAt: '2026-11-13T10:00:00.000Z' },
    botName: 'Jarvis',
    notes: [],
    summary: null,
    transcript: [],
    artifacts: [],
  };
  const summary = { bluf: 'x', decisions: [], actionItems: [], generated: true };

  it('polls fast while live, slowly while the summary is pending, and stops when final', () => {
    expect(nextPollMs(base, 0)).toBe(4000);
    const justAfter = Date.parse(base.meeting.startedAt) + 60 * 60 * 1000;
    expect(nextPollMs({ ...base, meeting: { ...base.meeting, status: 'completed' } }, justAfter)).toBe(15000);
    expect(nextPollMs({ ...base, meeting: { ...base.meeting, status: 'completed' } }, justAfter + 3 * 60 * 60 * 1000)).toBeNull();
    expect(nextPollMs({ ...base, meeting: { ...base.meeting, status: 'failed' } }, justAfter)).toBeNull();
    expect(nextPollMs({ ...base, meeting: { ...base.meeting, status: 'completed' }, summary })).toBeNull();
    expect(nextPollMs(null)).toBe(5000);
  });

  it('labels the status and builds links', () => {
    expect(statusLabel(base)).toBe('Live now');
    expect(statusLabel({ ...base, meeting: { ...base.meeting, status: 'completed' }, summary })).toBe('Ended');
    expect(parseMeetingLocation('/m/m-1', '?t=abc')).toEqual({ meetingId: 'm-1', token: 'abc' });
    expect(parseMeetingLocation('/m/m-1', '')).toBeNull();
    expect(artifactLink({ meetingId: 'm-1', token: 'abc' }, 'a1')).toBe('/a/m-1/a1?t=abc');
  });
});
