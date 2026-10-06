/* Drives the BUILT server over real Streamable HTTP (see helpers.mjs). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isPrivateAddress } from '../src/remote-image.js';
import { createExportStore } from '../src/export-store.js';
import { SAMPLE, startServer, startImageHost } from './helpers.mjs';

const PNG = 'data:image/png;base64,' + SAMPLE.toString('base64');

let proc, base, client, images, imagesUrl, deployed;

before(async () => {
  ({ server: images, url: imagesUrl } = await startImageHost());
  ({ proc, base, dir: deployed } = await startServer({ CANVASMITH_ALLOW_PRIVATE: '1' }));
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});
after(async () => { await client?.close(); proc?.kill(); images?.close(); rmSync(deployed, { recursive: true, force: true }); });

test('lists the model tool with ChatGPT metadata and hides the view-only tools', async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.deepEqual(Object.keys(by).sort(), ['load_image', 'open_canvasmith', 'save_image']);
  const open = by.open_canvasmith;
  assert.equal(open._meta.ui.resourceUri, 'ui://canvasmith/editor-v1.html');
  assert.equal(open._meta['openai/outputTemplate'], 'ui://canvasmith/editor-v1.html');
  assert.deepEqual(open._meta['openai/fileParams'], ['file']);
  // OpenAI requires every file sub-property declared, with download_url + file_id required
  const file = open.inputSchema.properties.file;
  assert.deepEqual(Object.keys(file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(file.required.sort(), ['download_url', 'file_id']);
  for (const t of tools) assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} needs readOnlyHint`);
  assert.deepEqual(by.load_image._meta.ui.visibility, ['app']);
  assert.deepEqual(by.save_image._meta.ui.visibility, ['app']);
});

test('serves a self-contained MCP App widget', async () => {
  const r = await client.readResource({ uri: 'ui://canvasmith/editor-v1.html' });
  const c = r.contents[0];
  assert.equal(c.mimeType, 'text/html;profile=mcp-app');
  assert.match(c.text, /fabric/);
  assert.doesNotMatch(c.text, /<script[^>]+src=/, 'every script must be inlined');
  assert.deepEqual(c._meta.ui.csp.resourceDomains, ['https://cdn.jsdelivr.net']);
  assert.deepEqual(c._meta['openai/widgetCSP'].redirect_domains, [base]);
});

test('open_canvasmith accepts attached files, URLs and blank canvases; rejects local paths', async () => {
  const f = await client.callTool({ name: 'open_canvasmith', arguments: { file: { download_url: `${imagesUrl}/sample.png`, file_id: 'file_1', file_name: 'shot.png' } } });
  assert.ok(!f.isError);
  assert.equal(f.structuredContent.fileName, 'shot.png');
  assert.match(f.content[0].text, /shot\.png/);
  const u = await client.callTool({ name: 'open_canvasmith', arguments: { image: 'https://example.com/a.png' } });
  assert.equal(u.structuredContent.image, 'https://example.com/a.png');
  const blank = await client.callTool({ name: 'open_canvasmith', arguments: { width: 1200, height: 628 } });
  assert.match(blank.content[0].text, /1200×628/);
  for (const image of ['/etc/passwd', '~/x.png', 'file:///etc/hosts']) {
    const bad = await client.callTool({ name: 'open_canvasmith', arguments: { image } });
    assert.ok(bad.isError, image);
  }
});

test('load_image fetches over http (following redirects), sniffs bytes, and never reads disk', async () => {
  const r = await client.callTool({ name: 'load_image', arguments: { source: `${imagesUrl}/hop`, name: 'shot.png' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.match(r.structuredContent.dataURL, /^data:image\/png;base64,/);
  assert.equal(r.structuredContent.name, 'shot.png');
  const fake = await client.callTool({ name: 'load_image', arguments: { source: `${imagesUrl}/fake.png` } });
  assert.match(fake.content[0].text, /not a supported image/);
  const disk = await client.callTool({ name: 'load_image', arguments: { source: '/etc/hosts' } });
  assert.ok(disk.isError);
});

test('save_image stores the export behind an unguessable, downloadable URL', async () => {
  const r = await client.callTool({ name: 'save_image', arguments: { dataURL: PNG, filename: '../../etc/my shot.png' } });
  assert.ok(!r.isError);
  const s = r.structuredContent;
  assert.match(s.url, new RegExp(`^${base}/exports/[0-9a-f]{32}/my-shot\\.png$`));
  const res = await fetch(s.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="my-shot.png"/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), SAMPLE);
  assert.equal((await fetch(`${base}/exports/${'0'.repeat(32)}/x.png`)).status, 404);
  const txt = await client.callTool({ name: 'save_image', arguments: { dataURL: 'data:text/html;base64,PGgxPg==' } });
  assert.ok(txt.isError);
});

test('a default (public) deployment refuses private and loopback image URLs', async () => {
  const pub = await startServer();
  const c = new Client({ name: 'test', version: '1' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${pub.base}/mcp`)));
    for (const source of [`${imagesUrl}/sample.png`, 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x.png', 'http://localhost/x.png']) {
      const r = await c.callTool({ name: 'load_image', arguments: { source } });
      assert.ok(r.isError, source);
      assert.match(r.content[0].text, /private network|resolve/, source);
    }
  } finally { await c.close(); pub.proc.kill(); rmSync(pub.dir, { recursive: true, force: true }); }
});

test('isPrivateAddress covers the reserved ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.ok(!isPrivateAddress(ip), ip);
});

test('export store expires entries and evicts oldest past its size cap', () => {
  let t = 0;
  const s = createExportStore({ ttlMs: 1000, maxBytes: SAMPLE.length * 2 + 10, now: () => t });
  const a = s.put(PNG), b = s.put(PNG), c = s.put(PNG);
  assert.equal(s.get(a.id), null, 'oldest evicted');
  assert.ok(s.get(b.id) && s.get(c.id));
  t = 1001;
  assert.equal(s.get(b.id), null, 'expired');
});
