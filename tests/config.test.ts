import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

function setRequiredConfig(): void {
  vi.stubEnv('RECALL_API_KEY', 'rk-test');
  vi.stubEnv('PUBLIC_BASE_URL', 'https://example.test');
  // A non-localhost PUBLIC_BASE_URL requires both secrets (fail-closed startup check).
  vi.stubEnv('OWNER_TOKEN', 'owner-test-token');
  vi.stubEnv('WEBHOOK_SECRET', 'webhook-test-secret');
  vi.stubEnv('MEETING_SUMMARY_MAX_TOKENS', '');
  vi.stubEnv('MEETING_SUMMARY_INPUT_CHAR_CAP', '');
  vi.stubEnv('MEETING_INGEST_TIMEOUT_MS', '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('post-meeting runtime configuration', () => {
  it('uses bounded marathon-safe defaults', () => {
    setRequiredConfig();

    const config = loadConfig();

    expect(config.meetingSummaryMaxTokens).toBe(4096);
    expect(config.meetingSummaryInputCharCap).toBe(400000);
    expect(config.meetingIngestTimeoutMs).toBe(120000);
  });

  it('honors explicit summary and ingest overrides', () => {
    setRequiredConfig();
    vi.stubEnv('MEETING_SUMMARY_MAX_TOKENS', '777');
    vi.stubEnv('MEETING_SUMMARY_INPUT_CHAR_CAP', '12345');
    vi.stubEnv('MEETING_INGEST_TIMEOUT_MS', '4567');

    const config = loadConfig();

    expect(config.meetingSummaryMaxTokens).toBe(777);
    expect(config.meetingSummaryInputCharCap).toBe(12345);
    expect(config.meetingIngestTimeoutMs).toBe(4567);
  });
});

/** Clear every env var the companion fields read, so the shell environment cannot leak in. */
function clearCompanionEnv(): void {
  for (const name of [
    'PORT',
    'ANTHROPIC_MODEL',
    'WORK_SCOPE_NAMESPACES',
    'PERSONAL_DENY_TERMS',
    'ANTHROPIC_FALLBACK_MODEL',
    'KB_BACKEND_TOKEN',
    'DEFAULT_TEAMMATE',
    'JARVIS_TOKENS',
    'JARVIS_API_TOKEN',
    'OWNER_TOKEN',
    'WEBHOOK_SECRET',
  ]) {
    vi.stubEnv(name, '');
  }
}

describe('companion public-safety check', () => {
  it('throws for a public base URL without OWNER_TOKEN', () => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://x.ngrok-free.dev');
    vi.stubEnv('WEBHOOK_SECRET', 's');
    vi.stubEnv('OWNER_TOKEN', '');

    expect(() => loadConfig()).toThrow(/OWNER_TOKEN/);
  });

  it('throws for a public base URL without WEBHOOK_SECRET', () => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://x.ngrok-free.dev');
    vi.stubEnv('OWNER_TOKEN', 'o');
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect(() => loadConfig()).toThrow(/WEBHOOK_SECRET/);
  });

  it('never puts a secret value in the error message', () => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://x.ngrok-free.dev');
    vi.stubEnv('OWNER_TOKEN', 'super-secret-owner-value');
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect(() => loadConfig()).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig()).not.toThrow(/super-secret-owner-value/);
  });

  it('allows a public base URL when both secrets are set', () => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://x.ngrok-free.dev');

    expect(() => loadConfig()).not.toThrow();
  });

  it('allows localhost without OWNER_TOKEN', () => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('OWNER_TOKEN', '');
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect(() => loadConfig()).not.toThrow();
  });

  it.each(['http://127.0.0.1:8790', 'http://[::1]:8790'])(
    'allows loopback address %s without secrets',
    (url) => {
      setRequiredConfig();
      vi.stubEnv('PUBLIC_BASE_URL', url);
      vi.stubEnv('OWNER_TOKEN', '');
      vi.stubEnv('WEBHOOK_SECRET', '');

      expect(() => loadConfig()).not.toThrow();
    },
  );

  it.each([
    'https://localhost.evil.example',
    'https://evil.example/localhost',
    'https://127.0.0.1.evil.example',
    'not a url',
  ])('treats %s as public and requires the secrets', (url) => {
    setRequiredConfig();
    vi.stubEnv('PUBLIC_BASE_URL', url);
    vi.stubEnv('OWNER_TOKEN', '');
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect(() => loadConfig()).toThrow(/OWNER_TOKEN/);
  });
});

describe('companion config fields', () => {
  it('defaults port 8790, empty workScopeNamespaces, sonnet 5.5 and no tokens', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');

    const config = loadConfig();

    expect(config.port).toBe(8790);
    expect(config.workScopeNamespaces).toEqual([]);
    expect(config.anthropicModel).toBe('claude-sonnet-5-5');
    expect(config.ownerToken).toBeUndefined();
    expect(config.kbBackendToken).toBeUndefined();
    expect(config.tokenRegistry.size).toBe(0);
  });

  it('defaults personalDenyTerms to the built-in personal-life stems and the fallback model to opus 5.5', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');

    const config = loadConfig();

    expect(config.personalDenyTerms).toEqual(['pediatric', 'nann', 'preschool', 'babysit', 'mortgage']);
    expect(config.anthropicFallbackModel).toBe('claude-opus-5-5');
  });

  it('PERSONAL_DENY_TERMS ADDS to the defaults (trimmed, blanks dropped), never replaces them', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('PERSONAL_DENY_TERMS', ' alpha , Beta ,, ');

    const terms = loadConfig().personalDenyTerms;

    expect(terms.slice(0, 5)).toEqual(['pediatric', 'nann', 'preschool', 'babysit', 'mortgage']);
    expect(terms.slice(5)).toEqual(['alpha', 'Beta']);
  });

  it('a configured term that repeats a default is not duplicated (case-insensitive)', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('PERSONAL_DENY_TERMS', 'NANN,foo');

    const terms = loadConfig().personalDenyTerms;

    expect(terms.filter((t) => t.toLowerCase() === 'nann')).toHaveLength(1);
    expect(terms).toContain('foo');
  });

  it('a blank PERSONAL_DENY_TERMS keeps the default list rather than disabling the deny', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('PERSONAL_DENY_TERMS', '  ');

    expect(loadConfig().personalDenyTerms).toContain('nann');
  });

  it('ANTHROPIC_FALLBACK_MODEL overrides the fallback model', () => {
    setRequiredConfig();
    clearCompanionEnv();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:8790');
    vi.stubEnv('ANTHROPIC_FALLBACK_MODEL', 'claude-opus-5');

    expect(loadConfig().anthropicFallbackModel).toBe('claude-opus-5');
  });

  it('reads OWNER_TOKEN, KB_BACKEND_TOKEN and a trimmed WORK_SCOPE_NAMESPACES list', () => {
    setRequiredConfig();
    vi.stubEnv('OWNER_TOKEN', 'owner-abc');
    vi.stubEnv('KB_BACKEND_TOKEN', 'kb-abc');
    vi.stubEnv('WORK_SCOPE_NAMESPACES', ' initech , wiki ,, ');

    const config = loadConfig();

    expect(config.ownerToken).toBe('owner-abc');
    expect(config.kbBackendToken).toBe('kb-abc');
    expect(config.workScopeNamespaces).toEqual(['initech', 'wiki']);
  });

  it('maps OWNER_TOKEN to DEFAULT_TEAMMATE in tokenRegistry', () => {
    setRequiredConfig();
    vi.stubEnv('OWNER_TOKEN', 'owner-abc');
    vi.stubEnv('DEFAULT_TEAMMATE', 'david');

    const config = loadConfig();

    expect(config.tokenRegistry.get('owner-abc')).toBe('david');
  });

  it('keeps an explicit JARVIS_TOKENS mapping for the owner token', () => {
    setRequiredConfig();
    vi.stubEnv('OWNER_TOKEN', 'owner-abc');
    vi.stubEnv('DEFAULT_TEAMMATE', 'david');
    vi.stubEnv('JARVIS_TOKENS', 'owner-abc:alice,tok-bob:bob');

    const config = loadConfig();

    expect(config.tokenRegistry.get('owner-abc')).toBe('alice');
    expect(config.tokenRegistry.get('tok-bob')).toBe('bob');
  });
});
