// Bundle the browser pages into single ESM files under public/, served by the routes:
//   web/agent-frame/main.tsx -> public/agent-frame.js  (src/routes/agent-frame.ts)
//   web/panel/main.tsx       -> public/panel.js        (src/routes/panel.ts)
//   web/meeting-page/main.tsx -> public/meeting-page.js (src/routes/meeting-page.ts)
//   web/artifact/main.tsx    -> public/artifact/*      (src/routes/artifacts.ts; split into
//                               chunks so the large whiteboard code loads only when needed)
// React and react-dom (and wavtools for the agent-frame) are bundled in so the
// pages need no module CDN.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const common = {
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(root, 'web/agent-frame/main.tsx')],
  outfile: resolve(root, 'public/agent-frame.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'web/panel/main.tsx')],
  outfile: resolve(root, 'public/panel.js'),
  // The panel is opened over a public tunnel, often on a phone: ship it minified.
  minify: true,
});

await build({
  ...common,
  entryPoints: [resolve(root, 'web/meeting-page/main.tsx')],
  outfile: resolve(root, 'public/meeting-page.js'),
  minify: true,
});

await build({
  ...common,
  entryPoints: [resolve(root, 'web/artifact/main.tsx')],
  outdir: resolve(root, 'public/artifact'),
  splitting: true,
  // @excalidraw/excalidraw publishes its code and CSS under development/production conditions.
  conditions: ['production'],
  chunkNames: 'chunk-[hash]',
  assetNames: 'asset-[hash]',
  loader: { ...common.loader, '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  minify: true,
});
