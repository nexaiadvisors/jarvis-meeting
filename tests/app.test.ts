import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { __clearRegistry, registerMeeting } from '../src/meeting/registry.js';
import { sessionHeader } from './helpers/session.js';

const OWNER = 'owner-token-for-tests';
let soulDir: string;

function makeConfig(): Config {
  return {
    port: 8790,
    publicBaseUrl: 'https://ngrok.example.com',
    jarvisBotName: 'Jarvis',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: 7_200_000,
    maxConcurrentPerTeammate: 2,
    soulDir,
    tokenRegistry: new Map([[OWNER, 'david']]),
    workScopeNamespaces: [],
  } as unknown as Config;
}

beforeEach(() => {
  __clearRegistry();
  soulDir = mkdtempSync(join(tmpdir(), 'app-soul-'));
  writeFileSync(join(soulDir, 'david.md'), '---\nname: David Delegate\nowner: david\npersona_mode: first_person\n---\nprose\n');
});

afterEach(() => {
  rmSync(soulDir, { recursive: true, force: true });
  __clearRegistry();
});

describe('GET /healthz', () => {
  it('returns {ok, liveCount} with no liveMeetings key and no meeting ids', async () => {
    registerMeeting({ meetingId: 'secret-meeting-id-123', teammate: 'david', persona: 'first_person', title: 'T' });
    const res = await createApp(makeConfig()).request('/healthz');

    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, liveCount: 1 });
    expect(body).not.toHaveProperty('liveMeetings');
    expect(text).not.toContain('secret-meeting-id-123');
  });

  it('reports liveCount 0 when nothing is live', async () => {
    const res = await createApp(makeConfig()).request('/healthz');
    expect(await res.json()).toEqual({ ok: true, liveCount: 0 });
  });
});

describe('createApp mounts every route group', () => {
  it('mounts the owner panel login (Task 1) alongside the meeting routes', async () => {
    const res = await createApp(makeConfig()).request('/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain('jm_owner=');
  });
});

describe('every /api/meetings/:id/*, /api/voice/* and /api/owner/* route requires a credential', () => {
  it('rejects an unauthenticated request on each registered route, and admits a valid session on the cheap ones', async () => {
    const config = makeConfig();
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'david', persona: 'first_person', title: 'M1' });
    const app = createApp(config);

    const guarded = app.routes.filter(
      (r) => (r.method === 'GET' || r.method === 'POST') && /^\/api\/(meetings\/:id|voice|owner)(\/|$)/.test(r.path),
    );
    const labels = guarded.map((r) => `${r.method} ${r.path}`).sort();

    // The known surface. A new route under these prefixes appears in `guarded`
    // automatically and must pass the unauthenticated check below.
    expect(labels).toEqual(
      expect.arrayContaining([
        'GET /api/owner/kb-health',
        'GET /api/owner/meetings',
        'POST /api/owner/meetings/:id/leave',
        'GET /api/meetings/:id',
        'GET /api/meetings/:id/commands',
        'POST /api/meetings/:id/agent-utterance',
        'POST /api/meetings/:id/client-log',
        'POST /api/meetings/:id/commands',
        'POST /api/meetings/:id/context-refresh',
        'POST /api/meetings/:id/realtime-session',
        'POST /api/meetings/:id/retrieval-log',
        'POST /api/meetings/:id/transcript-search',
        'POST /api/voice/ob-context',
        'POST /api/voice/ob-search',
        'POST /api/voice/team-kb-answer',
      ]),
    );

    for (const route of guarded) {
      const url = `http://x${route.path.replace(':id', 'm1')}`;
      const init: RequestInit =
        route.method === 'GET'
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ meetingId: 'm1', query: 'q', question: 'q', speaker: 's', text: 't' }),
            };
      const res = await app.fetch(new Request(url, init));
      expect(res.status, `${route.method} ${route.path} without a token`).toBe(401);
    }

    // Control: the same app is not simply 401-ing everything.
    const ok = await app.fetch(
      new Request('http://x/api/meetings/m1', { headers: sessionHeader(config, 'm1', 'david') }),
    );
    expect(ok.status).toBe(200);
  });

  it('keeps the owner API owner-only: a meeting session token is not the owner', async () => {
    const config = makeConfig();
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'david', persona: 'first_person', title: 'M1' });
    const app = createApp(config);

    const res = await app.fetch(
      new Request('http://x/api/owner/meetings', { headers: sessionHeader(config, 'm1', 'david') }),
    );
    expect(res.status).toBe(401);
  });
});
