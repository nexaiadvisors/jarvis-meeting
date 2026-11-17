import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../web/artifact/markdown.js';
import { artifactApiUrl, onPoll, parseArtifactLocation, parseScene, POLL_MS } from '../web/artifact/sync.js';

describe('markdown parser (doc preview)', () => {
  it('parses headings, paragraphs, lists, tasks, quotes, code, rules and tables', () => {
    const blocks = parseMarkdown(
      [
        '# Plan',
        '',
        'Ship on **Friday**.',
        'Second line.',
        '',
        '- one',
        '- [x] done',
        '- [ ] open',
        '',
        '1. first',
        '2. second',
        '',
        '> decided',
        '',
        '```',
        'const a = 1',
        '```',
        '',
        '---',
        '',
        '| Task | Owner |',
        '| --- | --- |',
        '| Deck | Nick |',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'rule', 'table']);
    expect(blocks[0]).toMatchObject({ level: 1, children: [{ t: 'text', text: 'Plan' }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [{}, { checked: true }, { checked: false }] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[5]).toEqual({ t: 'code', text: 'const a = 1' });
    expect(blocks[7]).toMatchObject({ header: [[{ text: 'Task' }], [{ text: 'Owner' }]], rows: [[[{ text: 'Deck' }], [{ text: 'Nick' }]]] });
  });

  it('parses inline bold, italic, code and safe links', () => {
    expect(parseInline('a **b** *c* `d` [e](https://x.test)')).toEqual([
      { t: 'text', text: 'a ' },
      { t: 'bold', children: [{ t: 'text', text: 'b' }] },
      { t: 'text', text: ' ' },
      { t: 'italic', children: [{ t: 'text', text: 'c' }] },
      { t: 'text', text: ' ' },
      { t: 'code', text: 'd' },
      { t: 'text', text: ' ' },
      { t: 'link', href: 'https://x.test', children: [{ t: 'text', text: 'e' }] },
    ]);
  });

  it('never produces a link for a javascript: or data: address, and keeps HTML as plain text', () => {
    const spans = parseInline('[x](javascript:alert(1)) [y](data:text/html,hi) <img src=x onerror=alert(1)>');
    expect(spans.some((s) => s.t === 'link')).toBe(false);
    const html = parseMarkdown('<script>alert(1)</script>');
    expect(html).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: '<script>alert(1)</script>' }] }]);
  });

  it('terminates on unbalanced markers and empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseInline('a ** b ` c [x](')).toEqual([{ t: 'text', text: 'a ** b ` c [x](' }]);
    expect(parseMarkdown('```\nunclosed fence')).toEqual([{ t: 'code', text: 'unclosed fence' }]);
  });
});

describe('artifact page sync rules', () => {
  it('polls often enough to show another person’s save within 5 seconds', () => {
    expect(POLL_MS).toBeLessThan(5000);
  });

  it('onPoll: nothing new, replace when clean, warn when the person has unsaved edits', () => {
    expect(onPoll({ baseVersion: 3, dirty: false }, 3)).toBe('none');
    expect(onPoll({ baseVersion: 3, dirty: true }, 2)).toBe('none');
    expect(onPoll({ baseVersion: 3, dirty: false }, 4)).toBe('replace');
    expect(onPoll({ baseVersion: 3, dirty: true }, 4)).toBe('warn');
  });

  it('reads the meeting, artifact and token from the page address', () => {
    const loc = parseArtifactLocation('/a/m-1/abc123', '?t=tok_en-1');
    expect(loc).toEqual({ meetingId: 'm-1', artifactId: 'abc123', token: 'tok_en-1' });
    expect(artifactApiUrl(loc!)).toBe('/api/artifacts/m-1/abc123?t=tok_en-1');
    expect(parseArtifactLocation('/a/m-1/abc123', '')).toBeNull();
    expect(parseArtifactLocation('/panel', '?t=x')).toBeNull();
  });

  it('parseScene tells stored Excalidraw shapes from Mermaid text', () => {
    expect(parseScene('flowchart TD\n A-->B')).toBeNull();
    expect(parseScene('{"type":"other"}')).toBeNull();
    expect(parseScene('{"type":"excalidraw","elements":[{"id":"a"}]}')).toEqual({ type: 'excalidraw', elements: [{ id: 'a' }] });
  });
});
