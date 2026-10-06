/* Drives the BUILT server (dist/extension/server/index.mjs — what Gemini installs) over real
   stdio, from a copy outside this package: installed, there's no package.json around it. The
   localhost bridge is exercised with plain fetch, standing in for the editor tab. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '../../../apps/demo/sample.png');
const PNG = 'data:image/png;base64,' + readFileSync(SAMPLE).toString('base64');
let client, out, installed;

before(async () => {
  out = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
  installed = mkdtempSync(path.join(tmpdir(), 'cm-gemini-'));
  cpSync(path.join(here, '../dist/extension'), installed, { recursive: true });
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(installed, 'server/index.mjs')],
    env: { ...process.env, CANVASMITH_OUTPUT_DIR: out, CANVASMITH_NO_OPEN: '1' }, stderr: 'ignore' }));
});
after(async () => { await client?.close(); rmSync(out, { recursive: true, force: true }); rmSync(installed, { recursive: true, force: true }); });

const open = (args) => client.callTool({ name: 'open_canvasmith', arguments: args });
const post = (url, body, headers = { 'content-type': 'application/json' }) =>
  fetch(url + 'export', { method: 'POST', headers, body: JSON.stringify(body) });

test('manifest points at the bundled server and ships its commands', () => {
  const m = JSON.parse(readFileSync(path.join(installed, 'gemini-extension.json'), 'utf8'));
  assert.equal(m.name, 'canvasmith');
  assert.deepEqual(m.mcpServers.canvasmith.args, ['${extensionPath}${/}server${/}index.mjs']);
  assert.equal(m.settings[0].envVar, 'CANVASMITH_OUTPUT_DIR');
  for (const f of ['GEMINI.md', 'commands/canvasmith.toml', 'commands/canvasmith/blank.toml', 'server/view.html'])
    assert.ok(readdirSync(path.join(installed, path.dirname(f))).includes(path.basename(f)), f);
});

test('exposes exactly the two model tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['open_canvasmith', 'wait_for_export']);
});

test('open_canvasmith serves a self-contained page and validates the source', async () => {
  const r = await open({ image: SAMPLE });
  assert.ok(!r.isError);
  const { url, session_id } = r.structuredContent;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/[0-9a-f]{12}\/$/);
  assert.match(r.content[0].text, new RegExp(session_id));
  const page = await (await fetch(url)).text();
  assert.match(page, /fabric/);
  assert.doesNotMatch(page, /<script[^>]+src=/, 'every script must be inlined');
  const s = await (await fetch(url + 'session')).json();
  assert.equal(s.hasImage, true);
  assert.equal(s.outputDir, out);
  const img = await (await fetch(url + 'image')).json();
  assert.match(img.dataURL, /^data:image\/png;base64,/);
  assert.equal(img.name, 'sample.png');

  assert.ok((await open({ image: '/nope/missing.png' })).isError);
  assert.ok((await open({ image: 'relative.png' })).isError);
  const blank = await open({ width: 1200, height: 628 });
  assert.match(blank.content[0].text, /1200×628/);
  const bs = await (await fetch(blank.structuredContent.url + 'session')).json();
  assert.deepEqual([bs.width, bs.height, bs.hasImage], [1200, 628, false]);
});

test('the bridge refuses a wrong token, a foreign Host and non-JSON posts', async () => {
  const { url } = (await open({})).structuredContent;
  const wrongToken = url.replace(/\/[0-9a-f]{32}\//, '/' + '0'.repeat(32) + '/');
  assert.equal((await fetch(wrongToken)).status, 404);
  const port = new URL(url).port;
  const http = await import('node:http');
  const status = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: new URL(url).pathname, headers: { host: `evil.test:${port}` } }, (r) => { r.resume(); res(r.statusCode); }));
  assert.equal(status, 421);
  assert.equal((await post(url, { dataURL: PNG }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(url, { dataURL: 'data:text/html;base64,PGgxPg==' })).status, 400);
});

test('wait_for_export hands over the export as path + preview image, once', async () => {
  const { url, session_id } = (await open({ image: SAMPLE })).structuredContent;
  const waiting = client.callTool({ name: 'wait_for_export', arguments: { session_id, timeout_seconds: 30 } });
  await new Promise(r => setTimeout(r, 200));
  const preview = { data: PNG.split(',')[1], mimeType: 'image/png', width: 64, height: 64 };
  const saved = await (await post(url, { dataURL: PNG, filename: '../../etc/x.png', preview })).json();
  assert.equal(saved.delivered, true);
  assert.equal(path.dirname(saved.path), out, 'path tricks are stripped');

  const r = await waiting;
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.path, saved.path);
  assert.match(r.content[0].text, /64×64/);
  assert.equal(r.content[1].type, 'image');

  // already delivered → the next call waits (and here times out) instead of repeating it
  const again = await client.callTool({ name: 'wait_for_export', arguments: { session_id, timeout_seconds: 5 } });
  assert.equal(again.structuredContent.exported, false);
  assert.match(again.content[0].text, /still open/);
});

test('an export made before the wait is returned immediately; the newest wins', async () => {
  const { url } = (await open({})).structuredContent;
  const a = await (await post(url, { dataURL: PNG, filename: 'first.png' })).json();
  const b = await (await post(url, { dataURL: PNG, filename: 'second.png' })).json();
  assert.equal(a.delivered, false);
  const t0 = Date.now();
  const r = await client.callTool({ name: 'wait_for_export', arguments: {} });   // defaults to latest session
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.structuredContent.path, b.path);
  assert.equal(r.content.length, 1, 'no preview sent → text only');
});

test('wait_for_export with an unknown session is a tool error', async () => {
  const r = await client.callTool({ name: 'wait_for_export', arguments: { session_id: 'nope' } });
  assert.ok(r.isError);
});
