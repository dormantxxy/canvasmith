/* End-to-end: the REAL bundled server over stdio plays Gemini CLI's side, Playwright plays the
   user's browser tab. Covers: open-on-image, export → file on disk + wait_for_export returning
   the preview, SVG export, blank canvas + light theme, and a bad path surfacing in the tab.
   Screenshots land in test/screenshots/ for eyeballing. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '../dist/extension/server/index.mjs');
const SAMPLE = path.join(here, '../../../apps/demo/sample.png');
const SHOTS = path.join(here, 'screenshots');
let client, out, browser;

before(async () => {
  out = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
  mkdirSync(SHOTS, { recursive: true });
  client = new Client({ name: 'gemini-cli-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER],
    env: { ...process.env, CANVASMITH_OUTPUT_DIR: out, CANVASMITH_NO_OPEN: '1' }, stderr: 'ignore' }));
  // bundled Chromium when it's downloaded, else the installed Chrome (no `npx playwright install` needed)
  browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
});
after(async () => { await browser?.close(); await client?.close(); rmSync(out, { recursive: true, force: true }); });

async function openTab(args, { colorScheme = 'dark', width = 1440 } = {}) {
  const r = await client.callTool({ name: 'open_canvasmith', arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(r.structuredContent.url);
  return { page, errors, session_id: r.structuredContent.session_id };
}

async function exportAs(page, kind) {
  await page.locator('.cm-export-btn').click();
  await page.locator('.cm-export-menu-item', { hasText: kind }).click();
  await page.locator('#toast', { hasText: 'Saved to' }).waitFor({ timeout: 15000 });
}

test('opens a local image, and an export reaches the waiting model with a preview', async () => {
  const { page, errors, session_id } = await openTab({ image: SAMPLE });
  await page.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '1-opened.png') });

  const waiting = client.callTool({ name: 'wait_for_export', arguments: { session_id, timeout_seconds: 60 } });
  await exportAs(page, 'PNG');
  await page.locator('#toast', { hasText: 'sent to Gemini' }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, '2-exported.png') });

  const r = await waiting;
  const files = readdirSync(out);
  assert.equal(files.length, 1, `one export on disk, got ${files}`);
  assert.ok(statSync(path.join(out, files[0])).size > 1000);
  assert.equal(r.structuredContent.path, path.join(out, files[0]));
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/jpeg');
  assert.match(await page.locator('#where').textContent(), new RegExp(files[0]));
  assert.deepEqual(errors, []);
  await page.close();
});

test('SVG export lands on disk and comes back as text only', async () => {
  const before = readdirSync(out).length;
  const { page, errors, session_id } = await openTab({ image: SAMPLE });
  await page.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await exportAs(page, 'SVG');
  assert.equal(readdirSync(out).length, before + 1);
  const r = await client.callTool({ name: 'wait_for_export', arguments: { session_id } });
  assert.match(r.structuredContent.path, /\.svg$/);
  assert.equal(r.content.length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('blank canvas at the requested size follows a light system theme', async () => {
  const { page, errors } = await openTab({ width: 1200, height: 628 }, { colorScheme: 'light' });
  await page.locator('.cm-export-btn').waitFor({ timeout: 15000 });
  await page.locator('.cm-export-btn').click();
  await page.locator('.cm-export-dims', { hasText: '1200 × 628' }).waitFor();
  await page.locator('.cm-export-btn').click();
  assert.equal(await page.locator('.cm-root').getAttribute('data-cm-mode'), 'light');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '3-blank-light.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('a laptop-width tab has no horizontal scroll', async () => {
  const { page, errors } = await openTab({ image: SAMPLE }, { width: 1024 });
  await page.locator('#toast', { hasText: 'Opened sample.png' }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, '4-laptop.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a file that disappears after opening surfaces the error in the tab', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cm-gone-'));
  const gone = path.join(tmp, 'gone.png');
  const { cpSync } = await import('node:fs');
  cpSync(SAMPLE, gone);
  const r = await client.callTool({ name: 'open_canvasmith', arguments: { image: gone } });
  rmSync(tmp, { recursive: true, force: true });
  const page = await browser.newPage();
  await page.goto(r.structuredContent.url);
  await page.locator('#toast[data-kind=err]').waitFor({ timeout: 15000 });
  assert.match(await page.locator('#toast').textContent(), /not found/i);
  await page.close();
});
