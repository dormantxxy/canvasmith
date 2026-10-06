/* Builds the Claude Desktop Extension into dist/bundle/ (the .mcpb contents):

     server/index.mjs   the MCP server, every dependency inlined (no node_modules in the bundle)
     server/view.html  the MCP App view: fabric + the Canvasmith React shell + the ext-apps
                       client, all inlined into one self-contained HTML document
     manifest.json, icon.png, README.md, LICENSE

   `node build.mjs --pack` then validates the manifest and zips dist/canvasmith.mcpb. */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const repo = (p) => here(`../../${p}`);
const OUT = here('dist/bundle/');
const manifest = JSON.parse(readFileSync(here('manifest.json'), 'utf8'));
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
  define: { __VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"' },
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

writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(here('icon.png'), `${OUT}icon.png`);
copyFileSync(here('README.md'), `${OUT}README.md`);
if (existsSync(repo('LICENSE'))) copyFileSync(repo('LICENSE'), `${OUT}LICENSE`);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`built dist/bundle (view.html ${kb(html)})`);

if (process.argv.includes('--pack')) {
  const mcpb = here('node_modules/.bin/mcpb');
  execFileSync(mcpb, ['validate', `${OUT}manifest.json`], { stdio: 'inherit' });
  execFileSync(mcpb, ['pack', OUT, here(`dist/canvasmith-${version}.mcpb`)], { stdio: 'inherit' });
}
