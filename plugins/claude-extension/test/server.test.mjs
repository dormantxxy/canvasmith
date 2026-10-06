/* Drives the BUILT server (dist/bundle/server/index.mjs — what the .mcpb ships) over real stdio,
   from a copy outside this package: unpacked by Claude Desktop there's no package.json around it. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '../../../apps/demo/sample.png');
let client, out, unpacked;

before(async () => {
  out = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
  unpacked = mkdtempSync(path.join(tmpdir(), 'cm-mcpb-'));
  cpSync(path.join(here, '../dist/bundle'), unpacked, { recursive: true });
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(unpacked, 'server/index.mjs')], env: { ...process.env, CANVASMITH_OUTPUT_DIR: out }, stderr: 'ignore' }));
});
after(async () => { await client?.close(); rmSync(out, { recursive: true, force: true }); rmSync(unpacked, { recursive: true, force: true }); });

test('lists the model tool and hides the view-only tools from the model', async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.deepEqual(Object.keys(by).sort(), ['load_image', 'open_canvasmith', 'save_image']);
  assert.equal(by.open_canvasmith._meta.ui.resourceUri, 'ui://canvasmith/editor.html');
  assert.deepEqual(by.load_image._meta.ui.visibility, ['app']);
  assert.deepEqual(by.save_image._meta.ui.visibility, ['app']);
});

test('serves a self-contained MCP App view', async () => {
  const r = await client.readResource({ uri: 'ui://canvasmith/editor.html' });
  const c = r.contents[0];
  assert.equal(c.mimeType, 'text/html;profile=mcp-app');
  assert.match(c.text, /fabric/);
  assert.doesNotMatch(c.text, /<script[^>]+src=/, 'every script must be inlined');
  assert.deepEqual(c._meta.ui.csp.resourceDomains, ['https://cdn.jsdelivr.net']);
});

test('open_canvasmith echoes args and reports missing files as a tool error', async () => {
  const ok = await client.callTool({ name: 'open_canvasmith', arguments: { image: SAMPLE } });
  assert.ok(!ok.isError);
  assert.equal(ok.structuredContent.image, SAMPLE);
  assert.equal(ok.structuredContent.outputDir, out);
  const blank = await client.callTool({ name: 'open_canvasmith', arguments: { width: 1200, height: 628 } });
  assert.match(blank.content[0].text, /1200×628/);
  const bad = await client.callTool({ name: 'open_canvasmith', arguments: { image: '/nope/missing.png' } });
  assert.ok(bad.isError);
  const rel = await client.callTool({ name: 'open_canvasmith', arguments: { image: 'relative.png' } });
  assert.ok(rel.isError);
});

test('load_image returns a sniffed data URL and rejects non-images', async () => {
  const r = await client.callTool({ name: 'load_image', arguments: { source: SAMPLE } });
  assert.ok(!r.isError);
  assert.match(r.structuredContent.dataURL, /^data:image\/png;base64,/);
  assert.equal(r.structuredContent.name, 'sample.png');
  const fake = path.join(out, 'fake.png');
  writeFileSync(fake, '%PDF-1.7 not an image');
  const bad = await client.callTool({ name: 'load_image', arguments: { source: fake } });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /not a supported image/);
});

test('save_image writes into the output dir, never overwrites, and strips path tricks', async () => {
  const png = 'data:image/png;base64,' + readFileSync(SAMPLE).toString('base64');
  const a = await client.callTool({ name: 'save_image', arguments: { dataURL: png, filename: 'canvasmith.png' } });
  const b = await client.callTool({ name: 'save_image', arguments: { dataURL: png, filename: 'canvasmith.png' } });
  const evil = await client.callTool({ name: 'save_image', arguments: { dataURL: png, filename: '../../etc/x.png' } });
  assert.equal(path.dirname(a.structuredContent.path), out);
  assert.notEqual(a.structuredContent.path, b.structuredContent.path);
  assert.equal(path.dirname(evil.structuredContent.path), out);
  assert.ok(readdirSync(out).includes('canvasmith-2.png'));
  const txt = await client.callTool({ name: 'save_image', arguments: { dataURL: 'data:text/html;base64,PGgxPg==' } });
  assert.ok(txt.isError);
});
