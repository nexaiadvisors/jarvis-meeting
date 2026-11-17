import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgentFrameRoute } from '../src/routes/agent-frame.js';
import type { Config } from '../src/config.js';

// Minimal config — the route only needs to be constructed; it reads the page
// HTML + bundle from disk (web/agent-frame/index.html, public/agent-frame.js).
const config = { publicBaseUrl: 'https://ngrok.example.com' } as Config;

// The JS bundle is a build artifact (public/, gitignored). Its serving test is
// build-dependent: skip it when `npm run build` has not run, so `npm test`
// passes on a clean checkout. CI runs build before test, so it asserts there.
const bundleBuilt = existsSync(resolve(process.cwd(), 'public/agent-frame.js'));

describe('agent-frame route', () => {
  it('serves the agent-frame HTML page that references the bundle', async () => {
    const app = createAgentFrameRoute(config);
    const res = await app.request('/meetings/agent-frame/test-id');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/agent-frame.js"');
  });

  it.skipIf(!bundleBuilt)('serves the built bundle as JavaScript (requires npm run build)', async () => {
    const app = createAgentFrameRoute(config);
    const res = await app.request('/agent-frame.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
