/* Builds the Gemini CLI extension into dist/extension/ (what `gemini extensions install` copies):

     gemini-extension.json, GEMINI.md, commands/   the extension itself
     server/index.mjs   the MCP server, every dependency inlined (no node_modules to install)
     server/view.html   the browser-tab editor: fabric + the Canvasmith React shell, one file
     README.md, LICENSE

   `node build.mjs --pack` also writes dist/canvasmith-gemini-<version>.tar.gz, the archive to
   attach to a GitHub release (gemini-extension.json at its root). */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const repo = (p) => here(`../../${p}`);
const OUT = here('dist/extension/');
const manifest = JSON.parse(readFileSync(here('gemini-extension.json'), 'utf8'));
const version = manifest.version;

rmSync(here('dist'), { recursive: true, force: true });
mkdirSync(`${OUT}server`, { recursive: true });

// Inline scripts must not contain a literal "</script" or the HTML parser ends the tag early.
const inlineScript = (js) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;

const view = await build({
  entryPoints: [here('src/view/main.js')],
  bundle: true, write: false, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
  loader: { '.jsx': 'jsx' }, jsx: 'automatic',
  alias: { '@canvasmith/core': repo('packages/core/src/index.js') },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const fabricJs = readFileSync(repo('node_modules/fabric/dist/fabric.min.js'), 'utf8');
const html = readFileSync(here('src/view/index.html'), 'utf8')
  .replace('<!--FABRIC-->', () => inlineScript(fabricJs))
  .replace('<!--APP-->', () => inlineScript(view.outputFiles[0].text));
writeFileSync(`${OUT}server/view.html`, html);

await build({
  entryPoints: [here('src/stdio.js')],
  outfile: `${OUT}server/index.mjs`,
  bundle: true, minify: false, format: 'esm', platform: 'node', target: 'node20',
  // CJS deps bundled into ESM still call require() for node builtins
  banner: { js: "import { createRequire as __cmReq } from 'node:module'; const require = __cmReq(import.meta.url);" },
  define: { 'process.env.CANVASMITH_VERSION': JSON.stringify(version) },
  logLevel: 'warning',
});

writeFileSync(`${OUT}gemini-extension.json`, JSON.stringify(manifest, null, 2) + '\n');
for (const f of ['GEMINI.md', 'README.md']) copyFileSync(here(f), OUT + f);
cpSync(here('commands'), `${OUT}commands`, { recursive: true });
if (existsSync(repo('LICENSE'))) copyFileSync(repo('LICENSE'), `${OUT}LICENSE`);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`built dist/extension (view.html ${kb(html)})`);

if (process.argv.includes('--pack')) {
  const archive = here(`dist/canvasmith-gemini-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', OUT, '.'], { stdio: 'inherit' });
  console.log(`packed ${archive}`);
}
