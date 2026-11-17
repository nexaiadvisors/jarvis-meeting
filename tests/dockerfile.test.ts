import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Each page route reads web/<page>/index.html from disk when the app starts. A page whose
// HTML is not copied into the runtime image makes the container exit on boot.
describe('Dockerfile runtime image', () => {
  it('copies the index.html of every web page', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const pages = readdirSync(join(root, 'web')).filter((name) => existsSync(join(root, 'web', name, 'index.html')));
    expect(pages.sort()).toEqual(['agent-frame', 'artifact', 'meeting-page', 'panel']);
    for (const page of pages) {
      expect(dockerfile).toContain(`COPY web/${page}/index.html ./web/${page}/index.html`);
    }
  });
});
