/* End-to-end: a Playwright page plays the MCP host with the SDK's own AppBridge, the built
   view.html runs in a sandboxed cross-origin iframe (as in Claude), and every tools/call the view
   makes is forwarded to the REAL bundled server over stdio. Covers: open-on-image, export →
   file on disk + model-context preview, Send to Claude, and fullscreen. Screenshots land in
   test/screenshots/ for eyeballing. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '../dist/bundle/server/index.mjs');
const SAMPLE = path.join(here, '../../../apps/demo/sample.png');
const SHOTS = path.join(here, 'screenshots');

const HOST_JS = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
window.startHost = async ({ args, mode = 'dark' }) => {
  const iframe = document.getElementById('view');
  const bridge = new AppBridge(null, { name: 'test-host', version: '1' },
    { serverTools: {}, updateModelContext: { text: {}, image: {} }, message: { text: {}, image: {} } },
    { hostContext: { theme: mode, displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'desktop' } });
  bridge.oncalltool = (p) => window.mcpCallTool(p.name, p.arguments || {});
  bridge.onupdatemodelcontext = async (p) => { window.hostEvent('context', p); return {}; };
  bridge.onmessage = async (p) => { window.hostEvent('message', p); return {}; };
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

let client, out, browser, hostBundle, viewHtml;
const events = [];

before(async () => {
  out = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
  mkdirSync(SHOTS, { recursive: true });
  client = new Client({ name: 'test-host', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, CANVASMITH_OUTPUT_DIR: out }, stderr: 'ignore' }));
  viewHtml = (await client.readResource({ uri: 'ui://canvasmith/editor.html' })).contents[0].text;
  hostBundle = (await build({ stdin: { contents: HOST_JS, resolveDir: here, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
});
after(async () => { await browser?.close(); await client?.close(); rmSync(out, { recursive: true, force: true }); });

async function openHost(args, { mode, width = 1280 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://host.test/**', r => r.fulfill({ contentType: 'text/html',
    body: `<!doctype html><body style="margin:0;background:#262624"><iframe id="view" sandbox="allow-scripts" style="width:100%;height:720px;border:0;display:block"></iframe><script>${hostBundle}</script>` }));
  await page.route('http://view.test/**', r => r.fulfill({ contentType: 'text/html', body: viewHtml }));
  await page.exposeFunction('mcpCallTool', (name, a) => client.callTool({ name, arguments: a }));
  await page.exposeFunction('hostEvent', (type, p) => { events.push({ type, p }); });
  await page.goto('http://host.test/');
  await page.evaluate((o) => window.startHost(o), { args, mode });
  const view = page.frameLocator('#view');
  return { page, view, errors };
}

test('opens a local image, exports it to disk and shares a preview with the model', async () => {
  const { page, view, errors } = await openHost({ image: SAMPLE });
  await view.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '1-opened.png') });

  await view.locator('.cm-export-btn').click();
  await view.locator('.cm-export-menu-item', { hasText: 'PNG' }).click();
  await view.locator('#toast', { hasText: 'Saved to' }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, '2-exported.png') });

  const files = readdirSync(out);
  assert.equal(files.length, 1, `one export on disk, got ${files}`);
  assert.ok(statSync(path.join(out, files[0])).size > 1000);
  const ctx = events.find(e => e.type === 'context');
  assert.ok(ctx, 'view pushed ui/update-model-context');
  assert.match(ctx.p.content[0].text, new RegExp(files[0]));
  assert.equal(ctx.p.content[1].type, 'image');

  await view.locator('#send').click();
  await view.locator('#toast', { hasText: 'Sent to Claude' }).waitFor();
  const msg = events.find(e => e.type === 'message');
  assert.equal(msg.p.role, 'user');
  assert.equal(msg.p.content[1].type, 'image');

  await view.locator('#full').click();
  await view.locator('#full', { hasText: 'Exit full screen' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '3-fullscreen.png') });
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

test('SVG export survives the blob hand-off and lands on disk', async () => {
  const before = readdirSync(out).length;
  const { page, view, errors } = await openHost({ image: SAMPLE });
  await view.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await view.locator('.cm-export-btn').click();
  await view.locator('.cm-export-menu-item', { hasText: 'SVG' }).click();
  await view.locator('#toast', { hasText: 'Saved to' }).waitFor({ timeout: 15000 });
  assert.ok(readdirSync(out).some(f => f.endsWith('.svg')));
  assert.equal(readdirSync(out).length, before + 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('fits a chat-width inline frame', async () => {
  const { page, view, errors } = await openHost({ image: SAMPLE }, { width: 760 });
  await view.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '5-chat-width.png') });
  const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a bad path surfaces the error inside the view instead of a blank frame', async () => {
  const { page, view } = await openHost({ image: '/definitely/not/here.png' });
  await view.locator('#toast[data-kind=err]').waitFor({ timeout: 15000 });
  assert.match(await view.locator('#toast').textContent(), /not found/i);
  await page.close();
});
