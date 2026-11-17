import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session module caches the token in module state, so each test loads a fresh copy.
async function loadSession() {
  vi.resetModules();
  return import('../web/agent-frame/session.js');
}

function stubWindow(href: string) {
  const replaceState = vi.fn();
  const location = { href };
  vi.stubGlobal('window', { location, history: { state: { s: 1 }, replaceState } });
  return { location, replaceState };
}

describe('readSessionTokenOnce', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads session_token from the URL and strips it, keeping the other parameters and hash', async () => {
    const { replaceState } = stubWindow('https://x.example/meetings/agent-frame/m1?session_token=tok.en&a=1#top');
    const { readSessionTokenOnce } = await loadSession();
    expect(readSessionTokenOnce()).toBe('tok.en');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/meetings/agent-frame/m1?a=1#top');
  });

  it('caches the token: later calls return it even though the URL no longer has it', async () => {
    const { location, replaceState } = stubWindow('https://x.example/meetings/agent-frame/m1?session_token=abc');
    const { readSessionTokenOnce } = await loadSession();
    expect(readSessionTokenOnce()).toBe('abc');
    location.href = 'https://x.example/meetings/agent-frame/m1';
    expect(readSessionTokenOnce()).toBe('abc');
    expect(readSessionTokenOnce()).toBe('abc');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('returns null and leaves the URL alone when there is no token', async () => {
    const { replaceState } = stubWindow('https://x.example/meetings/agent-frame/m1?a=1');
    const { readSessionTokenOnce } = await loadSession();
    expect(readSessionTokenOnce()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('authedFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentInit(): RequestInit {
    return fetchMock.mock.calls[0]![1] as RequestInit;
  }

  it('adds the bearer header and keeps the method, body and other headers', async () => {
    stubWindow('https://x.example/meetings/agent-frame/m1?session_token=abc');
    const { authedFetch } = await loadSession();
    await authedFetch('/api/voice/ob-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"q"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/voice/ob-search');
    const init = sentInit();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"query":"q"}');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer abc');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('works with no init at all, and does not mutate the caller init', async () => {
    stubWindow('https://x.example/meetings/agent-frame/m1?session_token=abc');
    const { authedFetch } = await loadSession();
    await authedFetch('/api/meetings/m1');
    expect(new Headers(sentInit().headers).get('Authorization')).toBe('Bearer abc');

    fetchMock.mockClear();
    const callerInit = { method: 'POST', headers: { 'X-Test': '1' } };
    await authedFetch('/api/meetings/m1/context-refresh', callerInit);
    expect(callerInit).toEqual({ method: 'POST', headers: { 'X-Test': '1' } });
  });

  it('keeps using the token after the URL has been scrubbed', async () => {
    const { location } = stubWindow('https://x.example/meetings/agent-frame/m1?session_token=abc');
    const { authedFetch } = await loadSession();
    await authedFetch('/api/meetings/m1');
    location.href = 'https://x.example/meetings/agent-frame/m1';
    fetchMock.mockClear();
    await authedFetch('/api/meetings/m1/commands?after=0');
    expect(new Headers(sentInit().headers).get('Authorization')).toBe('Bearer abc');
  });

  it('sends no Authorization header when the page has no token', async () => {
    stubWindow('https://x.example/meetings/agent-frame/m1');
    const { authedFetch } = await loadSession();
    await authedFetch('/api/meetings/m1');
    expect(new Headers(sentInit().headers).has('Authorization')).toBe(false);
  });
});
