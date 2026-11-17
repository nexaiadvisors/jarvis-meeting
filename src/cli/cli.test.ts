import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { scaffoldSoul } from './setup.js';
import { runChecks, exitCodeFor, type Check, type CheckResult } from './checks.js';
import { buildDoctorChecks, type DoctorEnv } from './doctor.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setup --non-interactive scaffolds a SOUL', () => {
  it('writes front-matter with the expected fields and a starter prose body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-setup-'));
    try {
      const result = scaffoldSoul({
        teammate: 'casey',
        name: 'Casey Delegate',
        persona: 'first_person',
        endpoint: 'http://casey.local:3031',
        soulDir: dir,
        projectDir: dir,
        force: false,
      });

      expect(result.soulWritten).toBe(true);
      const raw = readFileSync(result.soulFile, 'utf8');
      const fm = yaml.load(raw.split('---')[1] as string) as Record<string, unknown>;

      expect(fm['owner']).toBe('casey');
      expect(fm['name']).toBe('Casey Delegate');
      expect(fm['persona_mode']).toBe('first_person');
      // endpoint flag routes through a folder backend.
      expect(fm['knowledge_backend']).toMatchObject({ type: 'folder', endpoint: 'http://casey.local:3031' });
      // schema-default fields are present (not duplicated by setup).
      expect(fm).toHaveProperty('voice');
      expect(fm).toHaveProperty('delivery');
      expect(fm).toHaveProperty('ingest');
      // env template written because none existed.
      expect(result.envWritten).toBe(true);
      expect(existsSync(result.envFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing SOUL without --force, and overwrites with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-setup-force-'));
    try {
      writeFileSync(join(dir, 'dup.md'), '---\nname: Existing\n---\nbody\n', 'utf8');

      expect(() =>
        scaffoldSoul({ teammate: 'dup', soulDir: dir, projectDir: dir, force: false }),
      ).toThrow(/already exists/);

      // With --force it succeeds.
      const result = scaffoldSoul({ teammate: 'dup', name: 'Replaced', soulDir: dir, projectDir: dir, force: true });
      const raw = readFileSync(result.soulFile, 'utf8');
      expect(raw).toContain('name: Replaced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor check-runner', () => {
  it('exitCodeFor is a pure function: any FAIL -> nonzero, else zero', () => {
    const pass: CheckResult[] = [{ name: 'a', status: 'PASS', message: '' }];
    const warn: CheckResult[] = [{ name: 'a', status: 'WARN', message: '' }];
    const withFail: CheckResult[] = [
      { name: 'a', status: 'PASS', message: '' },
      { name: 'b', status: 'WARN', message: '' },
      { name: 'c', status: 'FAIL', message: '' },
    ];
    expect(exitCodeFor(pass)).toBe(0);
    expect(exitCodeFor(warn)).toBe(0); // WARN never fails the run
    expect(exitCodeFor(withFail)).toBe(1);
    expect(exitCodeFor([])).toBe(0);
  });

  it('runChecks aggregates results and records a thrown check as FAIL', async () => {
    const checks: Check[] = [
      { name: 'ok', run: async () => ({ status: 'PASS', message: 'fine' }) },
      { name: 'warns', run: async () => ({ status: 'WARN', message: 'meh' }) },
      {
        name: 'boom',
        run: async () => {
          throw new Error('kaboom');
        },
      },
    ];
    const results = await runChecks(checks);
    expect(results.map((r) => r.status)).toEqual(['PASS', 'WARN', 'FAIL']);
    expect(results[2]?.message).toContain('kaboom');
    expect(exitCodeFor(results)).toBe(1);
  });
});

describe('doctor with a minimal env (mocked fetch)', () => {
  function minimalEnv(soulDir: string, overrides: Partial<DoctorEnv> = {}): DoctorEnv {
    return {
      recallApiKey: 'rk',
      recallApiBase: 'https://us-east-1.recall.ai/api/v1',
      publicBaseUrl: 'https://ngrok.example.com',
      openAiKey: 'sk-test',
      webhookSecret: undefined,
      jarvisBotName: undefined,
      anthropicApiKey: undefined,
      slackBotToken: undefined,
      meetingSlackChannel: undefined,
      soulDir,
      ...overrides,
    };
  }

  it('returns the expected per-check statuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-doctor-'));
    writeFileSync(
      join(dir, 'demo.md'),
      '---\nname: Demo\nowner: demo\npersona_mode: ai\n---\nprose\n',
      'utf8',
    );

    // Recall /bot probe -> 200 (key valid); /search probe also -> 200.
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;

    try {
      const results = await runChecks(buildDoctorChecks(minimalEnv(dir), 'demo'));
      const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));

      expect(byName['required-env']).toBe('PASS'); // both required vars present
      expect(byName['realtime-provider']).toBe('PASS'); // OPENAI_API_KEY set
      expect(byName['soul:demo']).toBe('PASS'); // SOUL loads
      expect(byName['recall-key']).toBe('PASS'); // mocked 200
      expect(byName['webhook-secret']).toBe('WARN'); // not set (dev only)
      // knowledge-backend: SOUL has empty endpoint -> WARN (skipped probe)
      expect(byName['knowledge-backend']).toBe('WARN');
      expect(exitCodeFor(results)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FAILs required-env, realtime-provider, soul, and recall-key when env is empty / key rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-doctor-fail-'));
    // No SOUL file written -> soul check FAILs.
    // Recall probe -> 401 -> recall-key FAIL.
    global.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as typeof fetch;

    try {
      const env = minimalEnv(dir, {
        recallApiKey: undefined,
        publicBaseUrl: undefined,
        openAiKey: undefined,
      });
      const results = await runChecks(buildDoctorChecks(env, 'ghost'));
      const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));

      expect(byName['required-env']).toBe('FAIL');
      expect(byName['realtime-provider']).toBe('FAIL');
      expect(byName['soul:ghost']).toBe('FAIL');
      expect(byName['recall-key']).toBe('FAIL'); // RECALL_API_KEY missing -> FAIL before fetch
      expect(exitCodeFor(results)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor onboarding checks (realtime, bot-name, ingest, slack)', () => {
  function envWith(soulDir: string, overrides: Partial<DoctorEnv>): DoctorEnv {
    return {
      recallApiKey: 'rk', recallApiBase: 'https://us-west-2.recall.ai/api/v1', publicBaseUrl: 'https://ngrok.example',
      openAiKey: undefined,
      webhookSecret: 'ws', jarvisBotName: undefined, anthropicApiKey: undefined, slackBotToken: undefined,
      meetingSlackChannel: undefined, soulDir, ...overrides,
    };
  }
  function writeSoul(dir: string, slug: string, fm: string): void {
    writeFileSync(join(dir, `${slug}.md`), `---\nname: ${slug}\nowner: ${slug}\n${fm}\n---\nprose\n`, 'utf8');
  }

  it('realtime-provider PASSes only with OPENAI_API_KEY (Azure is no longer a provider)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rt-'));
    try {
      writeSoul(dir, 'x', 'persona_mode: ai');
      global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
      const none = await runChecks(buildDoctorChecks(envWith(dir, {}), 'x'));
      const n = none.find((r) => r.name === 'realtime-provider');
      expect(n?.status).toBe('FAIL');
      expect(n?.message).toMatch(/OPENAI_API_KEY/);
      expect(n?.message).not.toMatch(/AZURE/);

      const openai = await runChecks(buildDoctorChecks(envWith(dir, { openAiKey: 'sk-test' }), 'x'));
      expect(openai.find((r) => r.name === 'realtime-provider')?.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bot-name WARNs when unset or "Jarvis", PASSes for a unique name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-bn-'));
    try {
      writeSoul(dir, 'x', 'persona_mode: ai');
      global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
      const unset = await runChecks(buildDoctorChecks(envWith(dir, {}), 'x'));
      expect(unset.find((r) => r.name === 'bot-name')?.status).toBe('WARN');
      const jarvis = await runChecks(buildDoctorChecks(envWith(dir, { jarvisBotName: 'Jarvis' }), 'x'));
      expect(jarvis.find((r) => r.name === 'bot-name')?.status).toBe('WARN');
      const nova = await runChecks(buildDoctorChecks(envWith(dir, { jarvisBotName: 'Nova' }), 'x'));
      expect(nova.find((r) => r.name === 'bot-name')?.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ingest-readiness WARNs when SOUL ingest is on but ANTHROPIC_API_KEY is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-ing-'));
    try {
      writeSoul(dir, 'x', 'persona_mode: ai\ningest: true');
      global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
      const noKey = await runChecks(buildDoctorChecks(envWith(dir, {}), 'x'));
      expect(noKey.find((r) => r.name === 'ingest-readiness')?.status).toBe('WARN');
      const withKey = await runChecks(buildDoctorChecks(envWith(dir, { anthropicApiKey: 'sk-ant' }), 'x'));
      expect(withKey.find((r) => r.name === 'ingest-readiness')?.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('slack-delivery WARNs when SOUL wants slack but tokens are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-slk-'));
    try {
      writeSoul(dir, 'x', 'persona_mode: ai\ndelivery:\n  - slack');
      global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
      const missing = await runChecks(buildDoctorChecks(envWith(dir, {}), 'x'));
      expect(missing.find((r) => r.name === 'slack-delivery')?.status).toBe('WARN');
      const configured = await runChecks(buildDoctorChecks(envWith(dir, { slackBotToken: 'xoxp', meetingSlackChannel: 'U1' }), 'x'));
      expect(configured.find((r) => r.name === 'slack-delivery')?.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('required-env WARNs (not FAILs) when only PUBLIC_BASE_URL is missing — up resolves it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-pbu-'));
    try {
      writeSoul(dir, 'x', 'persona_mode: ai');
      global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
      const r = await runChecks(buildDoctorChecks(envWith(dir, { publicBaseUrl: undefined }), 'x'));
      expect(r.find((c) => c.name === 'required-env')?.status).toBe('WARN');
      // but a missing RECALL_API_KEY is still a hard FAIL
      const r2 = await runChecks(buildDoctorChecks(envWith(dir, { recallApiKey: undefined }), 'x'));
      expect(r2.find((c) => c.name === 'required-env')?.status).toBe('FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
