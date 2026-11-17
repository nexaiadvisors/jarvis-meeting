import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestToBrain } from '../src/postmeeting/ingest.js';
import type { Soul } from '../src/soul/schema.js';

function makeSoul(overrides: Partial<Soul>): Soul {
  return {
    owner: 'david',
    name: 'David Delegate',
    wakeWord: 'David',
    personaMode: 'first_person',
    voice: 'marin',
    language: 'en',
    knowledgeBackend: { type: 'openbrain', endpoint: 'http://localhost:3031/search', route: 'delegate' },
    delivery: ['ob'],
    ingest: true,
    deniedTopics: [],
    aiDisclosure: '',
    prose: '',
    ...overrides,
  };
}

const INPUT = {
  meetingId: 'mtg-123',
  title: 'Q2 Planning',
  summary: { bluf: 'Ship Friday.', decisions: ['Ship on Friday'], actionItems: [{ owner: 'David', task: 'merge PR' }] },
  transcriptText: '[t] David: hello',
  date: '2026-06-24T00:00:00.000Z',
};
const TIMEOUT_MS = 120000;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ingestToBrain', () => {
  it('skips when SOUL ingest is disabled', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await ingestToBrain(makeSoul({ ingest: false }), INPUT, TIMEOUT_MS);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('ingest disabled in SOUL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the derived /store URL with the correct body when enabled', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await ingestToBrain(makeSoul({ ingest: true }), INPUT, TIMEOUT_MS);

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://localhost:3031/store');
    expect(capturedBody['namespace']).toBe('second-brain');
    expect(capturedBody['doc_type']).toBe('meeting-transcript');
    expect(capturedBody['entity_key']).toBe('meeting-mtg-123');
    expect(typeof capturedBody['content']).toBe('string');
    const content = capturedBody['content'] as string;
    expect(content).toContain('Q2 Planning');
    expect(content).toContain('Ship Friday.');
    expect(content).toContain('[t] David: hello');
  });

  it('ingestToBrain sends the bearer header to /store', async () => {
    let capturedAuth: string | null = 'unset';
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await ingestToBrain(makeSoul({ ingest: true }), INPUT, TIMEOUT_MS, 'kb-secret');

    expect(result.ok).toBe(true);
    expect(capturedAuth).toBe('Bearer kb-secret');
  });

  it('sends no Authorization header to /store when no token is given', async () => {
    let capturedAuth: string | null = 'unset';
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await ingestToBrain(makeSoul({ ingest: true }), INPUT, TIMEOUT_MS);

    expect(capturedAuth).toBeNull();
  });

  it('appends /store when endpoint does not end in /search', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await ingestToBrain(
      makeSoul({ ingest: true, knowledgeBackend: { type: 'openbrain', endpoint: 'http://host:9000', route: 'delegate' } }),
      INPUT,
      TIMEOUT_MS,
    );
    expect(capturedUrl).toBe('http://host:9000/store');
  });

  it('returns { ok:false } on non-2xx without throwing', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const result = await ingestToBrain(makeSoul({ ingest: true }), INPUT, TIMEOUT_MS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });

  it('returns { ok:false } on network error without throwing', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await ingestToBrain(makeSoul({ ingest: true }), INPUT, TIMEOUT_MS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns { ok:false } when ingest enabled but no endpoint configured', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await ingestToBrain(
      makeSoul({ ingest: true, knowledgeBackend: { type: 'openbrain', endpoint: '', route: 'delegate' } }),
      INPUT,
      TIMEOUT_MS,
    );

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts a hanging store request at the configured deadline', async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      ) as unknown as typeof fetch;

      const pending = ingestToBrain(makeSoul({ ingest: true }), INPUT, 1234);
      await vi.advanceTimersByTimeAsync(1234);

      await expect(pending).resolves.toEqual({ ok: false, error: 'store request timed out' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renderContent notes sections (through the /store body)', () => {
  const NOTE = { kind: 'note', text: 'Ship on Friday', at: '2026-10-16T10:00:00.000Z', by: 'agent' } as const;
  const NOTE_2 = { kind: 'note', text: 'Budget approved', at: '2026-10-16T10:02:00.000Z', by: 'agent' } as const;
  const FLAG = {
    kind: 'flag',
    text: '[FLAG FOR DAVID] vendor contract\n\nReason: legal has not reviewed it',
    at: '2026-10-16T10:01:00.000Z',
    by: 'agent',
  } as const;

  async function storedContent(notes?: readonly (typeof NOTE | typeof NOTE_2 | typeof FLAG)[]): Promise<string> {
    let content = '';
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      content = (JSON.parse(String(init?.body)) as { content: string }).content;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await ingestToBrain(
      makeSoul({ ingest: true }),
      { ...INPUT, ...(notes !== undefined ? { notes: [...notes] } : {}) },
      TIMEOUT_MS,
    );
    expect(result.ok).toBe(true);
    return content;
  }

  it('renderContent puts Noted and Flagged for David before Transcript', async () => {
    const content = await storedContent([NOTE, FLAG, NOTE_2]);

    const noted = content.indexOf('## Noted');
    const flagged = content.indexOf('## Flagged for David');
    const transcript = content.indexOf('## Transcript');
    expect(noted).toBeGreaterThan(-1);
    expect(flagged).toBeGreaterThan(noted);
    expect(transcript).toBeGreaterThan(flagged);
    expect(content.indexOf('## Action items')).toBeLessThan(noted);

    const notedSection = content.slice(noted, flagged);
    expect(notedSection).toContain('- Ship on Friday\n');
    expect(notedSection).toContain('- Budget approved\n');
    expect(notedSection).not.toContain('vendor contract');
    expect(content.slice(flagged, transcript)).toContain('- [FLAG FOR DAVID] vendor contract');
    expect(content.slice(flagged, transcript)).not.toContain('Ship on Friday');
  });

  it('omits both sections when there are no notes, and each section when it has no items', async () => {
    for (const none of [undefined, []] as const) {
      const content = await storedContent(none);
      expect(content).not.toContain('## Noted');
      expect(content).not.toContain('## Flagged for David');
      expect(content).toContain('## Transcript');
    }

    const onlyNotes = await storedContent([NOTE]);
    expect(onlyNotes).toContain('## Noted');
    expect(onlyNotes).not.toContain('## Flagged for David');

    const onlyFlags = await storedContent([FLAG]);
    expect(onlyFlags).not.toContain('## Noted');
    expect(onlyFlags).toContain('## Flagged for David');
  });

  it('keeps a multi-line item inside its bullet so it cannot forge a section heading', async () => {
    const forged = { kind: 'note', text: 'first line\n## Transcript\n- fake item', at: NOTE.at, by: 'agent' } as const;
    const content = await storedContent([forged, FLAG]);

    expect(content).toContain('- first line\n  ## Transcript\n  - fake item');
    expect(content).toContain('- [FLAG FOR DAVID] vendor contract\n\n  Reason: legal has not reviewed it');
    const headings = content.split('\n').filter((line) => line.startsWith('## '));
    expect(headings.filter((h) => h === '## Transcript')).toHaveLength(1);
    expect(headings).toEqual(['## BLUF', '## Decisions', '## Action items', '## Noted', '## Flagged for David', '## Transcript']);
  });
});

