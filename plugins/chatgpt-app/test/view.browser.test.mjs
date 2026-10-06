/* End-to-end: a Playwright page plays ChatGPT with the SDK's own AppBridge, the built widget runs
   in a sandboxed cross-origin iframe, and every tools/call the widget makes is forwarded to the
   REAL built server over Streamable HTTP. Covers: open an attached file (openai/fileParams shape),
   export → downloadable link + model-context preview, Download (host download and open-link
   fallback), Send to ChatGPT, fullscreen, chat width, errors. Screenshots land in test/screenshots/. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer, startImageHost } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'screenshots');
const URI = 'ui://canvasmith/editor-v1.html';

const HOST_JS = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
window.startHost = async ({ args, mode = 'dark', download = true }) => {
  const iframe = document.getElementById('view');
  const caps = { serverTools: {}, openLinks: {}, updateModelContext: { text: {}, image: {} }, message: { text: {} } };
  if (download) caps.downloadFile = {};
  const bridge = new AppBridge(null, { name: 'chatgpt-test-host', version: '1' }, caps,
    { hostContext: { theme: mode, displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web' } });
  bridge.oncalltool = (p) => window.mcpCallTool(p.name, p.arguments || {});
  bridge.onupdatemodelcontext = async (p) => { window.hostEvent('context', p); return {}; };
  bridge.onmessage = async (p) => { window.hostEvent('message', p); return {}; };
  bridge.ondownloadfile = async (p) => { window.hostEvent('download', p); return {}; };
  bridge.onopenlink = async (p) => { window.hostEvent('openlink', p); return {}; };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    iframe.style.height = mode === 'fullscreen' ? '100vh' : '720px';
    bridge.sendHostContextChange({ displayMode: mode });
    return { mode };
  };
  bridge.onsizechange = (p) => { if (p.height && iframe.style.height !== '100vh') iframe.style.height = p.height + 'px'; };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(await window.mcpCallTool('open_canvasmith', args));
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.src = 'http://view.test/view.html';
};`;

let srv, img, client, browser, hostBundle, viewHtml;
let events = [];

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  img = await startImageHost();
  srv = await startServer({ CANVASMITH_ALLOW_PRIVATE: '1' });
  client = new Client({ name: 'chatgpt-test-host', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));
  viewHtml = (await client.readResource({ uri: URI })).contents[0].text;
  hostBundle = (await build({ stdin: { contents: HOST_JS, resolveDir: here, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
});
after(async () => { await browser?.close(); await client?.close(); srv?.proc.kill(); img?.server.close(); srv && rmSync(srv.dir, { recursive: true, force: true }); });

async function openHost(args, { mode, width = 1280, download } = {}) {
  events = [];
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://host.test/**', r => r.fulfill({ contentType: 'text/html',
    body: `<!doctype html><body style="margin:0;background:#212121"><iframe id="view" sandbox="allow-scripts" style="width:100%;height:720px;border:0;display:block"></iframe><script>${hostBundle}</script>` }));
  await page.route('http://view.test/**', r => r.fulfill({ contentType: 'text/html', body: viewHtml }));
  await page.exposeFunction('mcpCallTool', (name, a) => client.callTool({ name, arguments: a }));
  await page.exposeFunction('hostEvent', (type, p) => { events.push({ type, p }); });
  await page.goto('http://host.test/');
  await page.evaluate((o) => window.startHost(o), { args, mode, download });
  return { page, view: page.frameLocator('#view'), errors };
}

const attached = () => ({ file: { download_url: `${img.url}/sample.png`, file_id: 'file_abc', mime_type: 'image/png', file_name: 'product.png' } });

async function exportAs(view, kind) {
  await view.locator('.cm-export-btn').click();
  await view.locator('.cm-export-menu-item', { hasText: kind }).click();
  await view.locator('#toast', { hasText: 'Export ready' }).waitFor({ timeout: 15000 });
}

test('opens an attached file, exports to a download link and shares a preview with the model', async () => {
  const { page, view, errors } = await openHost(attached());
  await view.locator('#toast', { hasText: 'Opened product.png' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '1-opened.png') });

  await exportAs(view, 'PNG');
  await page.screenshot({ path: path.join(SHOTS, '2-exported.png') });
  const ctx = events.find(e => e.type === 'context');
  assert.ok(ctx, 'view pushed ui/update-model-context');
  const link = /(http:\/\/\S+\/exports\/[0-9a-f]{32}\/canvasmith\.png)/.exec(ctx.p.content[0].text)?.[1];
  assert.ok(link, `download link in model context: ${ctx.p.content[0].text}`);
  assert.equal(ctx.p.content[1].type, 'image');
  const res = await fetch(link);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok((await res.arrayBuffer()).byteLength > 1000);

  await view.locator('#download').click();
  await page.waitForTimeout(200);
  const dl = events.find(e => e.type === 'download');
  assert.equal(dl?.p.contents[0].type, 'resource_link');
  assert.equal(dl.p.contents[0].uri, link);

  await view.locator('#send').click();
  await view.locator('#toast', { hasText: 'Sent to ChatGPT' }).waitFor();
  const msg = events.find(e => e.type === 'message');
  assert.equal(msg.p.role, 'user');
  assert.match(msg.p.content[0].text, new RegExp(link));
  assert.equal(msg.p.content.length, 1, 'no image part when the host only takes text messages');

  await view.locator('#full').click();
  await view.locator('#full', { hasText: 'Exit full screen' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '3-fullscreen.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Download falls back to ui/open-link when the host has no download support', async () => {
  const { page, view, errors } = await openHost({ image: `${img.url}/sample.png` }, { download: false });
  await view.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await exportAs(view, 'SVG');
  await view.locator('#download').click();
  await page.waitForTimeout(200);
  const ol = events.find(e => e.type === 'openlink');
  assert.match(ol?.p.url || '', /\/exports\/[0-9a-f]{32}\/canvasmith\.svg$/);
  const res = await fetch(ol.p.url);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(!events.some(e => e.type === 'download'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('blank canvas at the requested size, light theme', async () => {
  const { page, view, errors } = await openHost({ width: 1200, height: 628 }, { mode: 'light' });
  await view.locator('.cm-export-btn').waitFor({ timeout: 15000 });
  await view.locator('.cm-export-btn').click();
  await view.locator('.cm-export-dims', { hasText: '1200 × 628' }).waitFor();
  await view.locator('.cm-export-btn').click();
  assert.equal(await view.locator('.cm-root').getAttribute('data-cm-mode'), 'light');
  await page.screenshot({ path: path.join(SHOTS, '4-blank-light.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('fits a chat-width inline frame', async () => {
  const { page, view, errors } = await openHost(attached(), { width: 760 });
  await view.locator('#toast', { hasText: 'Opened product.png' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '5-chat-width.png') });
  const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a dead image link surfaces the error inside the view instead of a blank frame', async () => {
  const { page, view } = await openHost({ image: `${img.url}/gone.png` });
  await view.locator('#toast[data-kind=err]').waitFor({ timeout: 15000 });
  assert.match(await view.locator('#toast').textContent(), /HTTP 404/);
  await page.close();
});
