import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  envChecklist,
  brainProbeVerdict,
  buildSoulDoc,
  envPatchForAnswers,
  upsertEnv,
  writeOnboard,
  onboardNonInteractive,
  type OnboardAnswers,
} from './onboard.js';

describe('envChecklist', () => {
  it('flags required + realtime missing on an empty env', () => {
    const items = envChecklist({});
    const byTier = (t: string) => items.filter((i) => i.tier === t);
    expect(byTier('required')[0]?.status).toBe('missing'); // RECALL_API_KEY
    expect(byTier('realtime')[0]?.status).toBe('missing');
    expect(byTier('feature').every((i) => i.status === 'missing')).toBe(true);
  });

  it('realtime is satisfied by an OpenAI key only (Azure vars are ignored)', () => {
    const azure = envChecklist({
      AZURE_OPENAI_ENDPOINT: 'https://x', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_REALTIME_DEPLOYMENT: 'gpt-realtime-mini',
    });
    expect(azure.find((i) => i.tier === 'realtime')?.status).toBe('missing');

    const openai = envChecklist({ OPENAI_API_KEY: 'sk-x' });
    expect(openai.find((i) => i.tier === 'realtime')?.status).toBe('set');
  });

  it('slack feature needs BOTH token and channel', () => {
    const onlyToken = envChecklist({ SLACK_BOT_TOKEN: 'xoxp' });
    expect(onlyToken.find((i) => i.key.startsWith('SLACK_BOT_TOKEN'))?.status).toBe('missing');
    const both = envChecklist({ SLACK_BOT_TOKEN: 'xoxp', MEETING_SLACK_CHANNEL: 'U1' });
    expect(both.find((i) => i.key.startsWith('SLACK_BOT_TOKEN'))?.status).toBe('set');
  });
});

describe('brainProbeVerdict', () => {
  it('classifies none / reachable / unreachable', () => {
    expect(brainProbeVerdict('', undefined).status).toBe('none');
    expect(brainProbeVerdict('http://x:7411', true).status).toBe('reachable');
    expect(brainProbeVerdict('http://x:7411', false).status).toBe('unreachable');
  });
});

describe('buildSoulDoc', () => {
  it('ai persona: name=wake_word=botName, third-person prose, ai_disclosure set', () => {
    const a: OnboardAnswers = { botName: 'Nova', owner: 'riley', persona: 'ai', role: 'data platform', goals: 'sprint planning' };
    const { frontMatter, prose } = buildSoulDoc(a);
    expect(frontMatter['name']).toBe('Nova');
    expect(frontMatter['wake_word']).toBe('Nova');
    expect(frontMatter['persona_mode']).toBe('ai');
    expect(frontMatter['ai_disclosure']).toBe('Nova - AI meeting assistant');
    expect(prose).toMatch(/generic AI meeting assistant/);
    expect(prose).toMatch(/third person/);
    expect(prose).toMatch(/data platform/);
  });

  it('first_person persona: first-person prose, no ai_disclosure', () => {
    const a: OnboardAnswers = { botName: 'Morgan', owner: 'morgan', persona: 'first_person', role: 'CTO' };
    const { frontMatter, prose } = buildSoulDoc(a);
    expect(frontMatter['persona_mode']).toBe('first_person');
    expect(frontMatter['ai_disclosure']).toBe('');
    expect(prose).toMatch(/speaking as morgan/i);
  });

  it('delivery includes slack only when requested; ingest defaults true', () => {
    expect((buildSoulDoc({ botName: 'A', owner: 'a', persona: 'ai', slack: true }).frontMatter['delivery'] as string[])).toContain('slack');
    expect((buildSoulDoc({ botName: 'A', owner: 'a', persona: 'ai' }).frontMatter['delivery'] as string[])).not.toContain('slack');
    expect(buildSoulDoc({ botName: 'A', owner: 'a', persona: 'ai' }).frontMatter['ingest']).toBe(true);
  });
});

describe('envPatchForAnswers', () => {
  it('always sets JARVIS_BOT_NAME (per-person wake/display) + DEFAULT_TEAMMATE', () => {
    const p = envPatchForAnswers({ botName: 'Nova', owner: 'riley', persona: 'ai' });
    expect(p['JARVIS_BOT_NAME']).toBe('Nova');
    expect(p['DEFAULT_TEAMMATE']).toBe('riley');
  });

  it('ai persona wires TEAM_KB_RETRIEVAL_URL; first_person does not', () => {
    const ai = envPatchForAnswers({ botName: 'Nova', owner: 'riley', persona: 'ai', knowledgeEndpoint: 'http://127.0.0.1:7412/' });
    expect(ai['TEAM_KB_RETRIEVAL_URL']).toBe('http://127.0.0.1:7412');
    const fp = envPatchForAnswers({ botName: 'R', owner: 'r', persona: 'first_person', knowledgeEndpoint: 'http://127.0.0.1:7411' });
    expect(fp['TEAM_KB_RETRIEVAL_URL']).toBeUndefined();
  });

  it('slack keys only when slack=true with a token', () => {
    const on = envPatchForAnswers({ botName: 'N', owner: 'n', persona: 'ai', slack: true }, 'xoxp-1', 'U123');
    expect(on['SLACK_BOT_TOKEN']).toBe('xoxp-1');
    expect(on['MEETING_SLACK_CHANNEL']).toBe('U123');
    const off = envPatchForAnswers({ botName: 'N', owner: 'n', persona: 'ai', slack: false }, 'xoxp-1', 'U123');
    expect(off['SLACK_BOT_TOKEN']).toBeUndefined();
  });

  it('folder backend sets CONNECTOR_PORT from the endpoint (so up probes the right port)', () => {
    const p = envPatchForAnswers({ botName: 'N', owner: 'n', persona: 'ai', backendType: 'folder', knowledgeEndpoint: 'http://127.0.0.1:7412' });
    expect(p['CONNECTOR_PORT']).toBe('7412');
    const ob = envPatchForAnswers({ botName: 'N', owner: 'n', persona: 'ai', backendType: 'openbrain', knowledgeEndpoint: 'http://127.0.0.1:7411' });
    expect(ob['CONNECTOR_PORT']).toBeUndefined();
  });
});

describe('buildSoulDoc backend type', () => {
  it('labels the folder fallback as knowledge_backend.type=folder', () => {
    const folder = buildSoulDoc({ botName: 'N', owner: 'n', persona: 'ai', backendType: 'folder', knowledgeEndpoint: 'http://127.0.0.1:7412' });
    expect((folder.frontMatter['knowledge_backend'] as Record<string, unknown>)['type']).toBe('folder');
    const ob = buildSoulDoc({ botName: 'N', owner: 'n', persona: 'first_person' });
    expect((ob.frontMatter['knowledge_backend'] as Record<string, unknown>)['type']).toBe('openbrain');
  });
});

describe('onboardNonInteractive headless folder fallback', () => {
  it('with no --endpoint, wires the folder default brain (endpoint 7412 + TEAM_KB_RETRIEVAL_URL + CONNECTOR_PORT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-headless-'));
    try {
      const flags: Record<string, string> = { 'bot-name': 'Nova', owner: 'riley', persona: 'ai', 'kb-folder': join(dir, 'brain') };
      const code = await onboardNonInteractive(flags, new Set(), join(dir, 'soul'), dir, {});
      expect(code).toBe(0);

      const soulRaw = readFileSync(join(dir, 'soul', 'riley.md'), 'utf8');
      const fm = yaml.load(soulRaw.split('---')[1] as string) as Record<string, unknown>;
      const kb = fm['knowledge_backend'] as Record<string, unknown>;
      expect(kb['type']).toBe('folder');
      expect(kb['endpoint']).toBe('http://127.0.0.1:7412');

      const envOut = readFileSync(join(dir, '.env.local'), 'utf8');
      expect(envOut).toMatch(/TEAM_KB_RETRIEVAL_URL=http:\/\/127\.0\.0\.1:7412/);
      expect(envOut).toMatch(/CONNECTOR_PORT=7412/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not enable slack when JARVIS_SLACK_TOKEN is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-noslack-'));
    try {
      const flags: Record<string, string> = { 'bot-name': 'Nova', owner: 'riley', persona: 'ai', endpoint: 'http://127.0.0.1:7411', 'kb-folder': join(dir, 'b') };
      await onboardNonInteractive(flags, new Set(), join(dir, 'soul'), dir, {}); // empty env -> no token
      const envOut = readFileSync(join(dir, '.env.local'), 'utf8');
      expect(envOut).not.toMatch(/SLACK_BOT_TOKEN=\S/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('upsertEnv', () => {
  it('replaces existing keys in place and appends new ones', () => {
    const existing = '# header\nRECALL_API_KEY=old\nFOO=bar\n';
    const out = upsertEnv(existing, { RECALL_API_KEY: 'new', JARVIS_BOT_NAME: 'Nova' });
    expect(out).toMatch(/RECALL_API_KEY=new/);
    expect(out).not.toMatch(/RECALL_API_KEY=old/);
    expect(out).toMatch(/FOO=bar/); // untouched
    expect(out).toMatch(/JARVIS_BOT_NAME=Nova/); // appended
    expect(out).toMatch(/# header/); // comment preserved
  });

  it('handles empty existing text', () => {
    const out = upsertEnv('', { JARVIS_BOT_NAME: 'Nova' });
    expect(out).toMatch(/JARVIS_BOT_NAME=Nova/);
  });

  it('preserves an inline # comment when replacing a template key', () => {
    const existing = 'MEETING_SLACK_CHANNEL=   # your Slack user ID\n';
    const out = upsertEnv(existing, { MEETING_SLACK_CHANNEL: 'U123' });
    expect(out).toMatch(/MEETING_SLACK_CHANNEL=U123\s+# your Slack user ID/);
  });
});

describe('writeOnboard', () => {
  it('writes a loadable SOUL and patches .env.local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'RECALL_API_KEY=x\n', 'utf8');
      const answers: OnboardAnswers = { botName: 'Nova', owner: 'riley', persona: 'ai', knowledgeEndpoint: 'http://127.0.0.1:7412' };
      const patch = envPatchForAnswers(answers);
      const r = writeOnboard({ answers, soulDir: dir, projectDir: dir, envPatch: patch, force: false });

      const soulRaw = readFileSync(r.soulFile, 'utf8');
      const fm = yaml.load(soulRaw.split('---')[1] as string) as Record<string, unknown>;
      expect(fm['name']).toBe('Nova');
      expect(fm['wake_word']).toBe('Nova');

      const envOut = readFileSync(r.envFile, 'utf8');
      expect(envOut).toMatch(/RECALL_API_KEY=x/);
      expect(envOut).toMatch(/JARVIS_BOT_NAME=Nova/);
      expect(envOut).toMatch(/TEAM_KB_RETRIEVAL_URL=http:\/\/127\.0\.0\.1:7412/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing SOUL without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-force-'));
    try {
      const answers: OnboardAnswers = { botName: 'Nova', owner: 'riley', persona: 'ai' };
      writeOnboard({ answers, soulDir: dir, projectDir: dir, envPatch: {}, force: false });
      expect(() => writeOnboard({ answers, soulDir: dir, projectDir: dir, envPatch: {}, force: false })).toThrow(/already exists/);
      expect(() => writeOnboard({ answers, soulDir: dir, projectDir: dir, envPatch: {}, force: true })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
