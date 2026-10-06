/* Builds the ChatGPT app server into dist/server/ — the whole deployable, no node_modules:

     index.mjs   the HTTP MCP server, every dependency inlined
     view.html   the widget: fabric + the Canvasmith React shell + the ext-apps client, all
                 inlined into one self-contained HTML document */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const repo = (p) => here(`../../${p}`);
const OUT = here('dist/server/');
const { version } = JSON.parse(readFileSync(here('package.json'), 'utf8'));

rmSync(here('dist'), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Inline scripts must not contain a literal "</script" or the HTML parser ends the tag early.
const inlineScript = (js) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;

const view = await build({
  entryPoints: [here('src/view/main.js')],
  bundle: true, write: false, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
  loader: { '.jsx': 'jsx' }, jsx: 'automatic',
  alias: { '@canvasmith/core': repo('packages/core/src/index.js') },
  define: { __VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const fabricJs = readFileSync(repo('node_modules/fabric/dist/fabric.min.js'), 'utf8');
const html = readFileSync(here('src/view/index.html'), 'utf8')
  .replace('<!--FABRIC-->', () => inlineScript(fabricJs))
  .replace('<!--APP-->', () => inlineScript(view.outputFiles[0].text));
writeFileSync(`${OUT}view.html`, html);

await build({
  entryPoints: [here('src/http.js')],
  outfile: `${OUT}index.mjs`,
  bundle: true, minify: false, format: 'esm', platform: 'node', target: 'node20',
  // CJS deps bundled into ESM still call require() for node builtins
  banner: { js: "import { createRequire as __cmReq } from 'node:module'; const require = __cmReq(import.meta.url);" },
  define: { 'process.env.CANVASMITH_VERSION': JSON.stringify(version) },
  logLevel: 'warning',
});

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`built dist/server (view.html ${kb(html)})`);
