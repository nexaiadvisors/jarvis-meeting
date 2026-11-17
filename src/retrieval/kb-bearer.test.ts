import { describe, expect, it } from 'vitest';
import { kbBearerFor } from './kb-bearer.js';

const cfg = (kbBackendToken: string | undefined, kbBackendHealthUrl: string | undefined) => ({
  kbBackendToken,
  kbBackendHealthUrl,
});

describe('kbBearerFor — the kb-server bearer goes only to the kb-server origin', () => {
  const HEALTH = 'http://127.0.0.1:7402/healthz';

  it('returns the token for a URL on the origin of KB_BACKEND_HEALTH_URL, whatever the path', () => {
    expect(kbBearerFor(cfg('kb-secret', HEALTH), 'http://127.0.0.1:7402/search')).toBe('kb-secret');
    expect(kbBearerFor(cfg('kb-secret', HEALTH), 'http://127.0.0.1:7402')).toBe('kb-secret');
    expect(kbBearerFor(cfg('kb-secret', HEALTH), 'http://127.0.0.1:7402/document')).toBe('kb-secret');
  });

  it('treats the default port as the same origin', () => {
    expect(kbBearerFor(cfg('kb-secret', 'https://kb.example.test/healthz'), 'https://kb.example.test:443/store')).toBe(
      'kb-secret',
    );
  });

  it.each([
    ['another port', 'http://127.0.0.1:7499/search'],
    ['another host', 'http://10.0.0.5:7402/search'],
    ['localhost instead of 127.0.0.1', 'http://localhost:7402/search'],
    ['another scheme', 'https://127.0.0.1:7402/search'],
    ['a userinfo lookalike', 'http://127.0.0.1:7402@evil.example/search'],
  ])('returns undefined for %s', (_label, target) => {
    expect(kbBearerFor(cfg('kb-secret', HEALTH), target)).toBeUndefined();
  });

  it('returns undefined when KB_BACKEND_HEALTH_URL is unset or unparseable', () => {
    expect(kbBearerFor(cfg('kb-secret', undefined), 'http://127.0.0.1:7402/search')).toBeUndefined();
    expect(kbBearerFor(cfg('kb-secret', ''), 'http://127.0.0.1:7402/search')).toBeUndefined();
    expect(kbBearerFor(cfg('kb-secret', 'not a url'), 'http://127.0.0.1:7402/search')).toBeUndefined();
  });

  it('returns undefined when there is no token', () => {
    expect(kbBearerFor(cfg(undefined, HEALTH), 'http://127.0.0.1:7402/search')).toBeUndefined();
    expect(kbBearerFor(cfg('', HEALTH), 'http://127.0.0.1:7402/search')).toBeUndefined();
  });

  it('returns undefined when the target is empty, relative or unparseable', () => {
    for (const target of ['', '/search', 'not a url']) {
      expect(kbBearerFor(cfg('kb-secret', HEALTH), target)).toBeUndefined();
    }
  });

  it('never matches two opaque ("null") origins', () => {
    expect(kbBearerFor(cfg('kb-secret', 'file:///tmp/a'), 'file:///tmp/b')).toBeUndefined();
  });
});
