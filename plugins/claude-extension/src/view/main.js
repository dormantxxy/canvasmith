/* The MCP App view: the full Canvasmith React shell, mounted inside the host's sandboxed iframe.

   Host → view:  tool-input (image / width / height) decides what to open; host context gives the
                 theme and which display modes (fullscreen) exist.
   View → host:  load_image / save_image server tools (the iframe can't touch the filesystem),
                 ui/update-model-context after each export so Claude sees the result on the next
                 turn, ui/message for the explicit "Send to Claude" button. */

import { App } from '@modelcontextprotocol/ext-apps';
import { mount } from '../../../../packages/react/src/mount.js';

const $ = (s) => document.querySelector(s);
const app = new App({ name: 'Canvasmith', version: __VERSION__ }, {}, { autoResize: true });

let handle = null;          // mount() handle once the editor exists
let lastSaved = null;       // { path, preview } of the most recent export, for "Send to Claude"
let toastTimer = null;

function toast(msg, kind = 'info', ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.dataset.kind = kind; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const ed = () => handle && handle.editor();
const whenEditor = () => new Promise((res) => { const tick = () => (ed() ? res(ed()) : setTimeout(tick, 30)); tick(); });

/* A blob: URL (SVG export) → dataURL, so it can cross the postMessage boundary to the server. */
async function toDataURL(url) {
  if (url.startsWith('data:')) return url;
  const blob = await (await fetch(url)).blob();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

/* ≤1024px JPEG preview for the model — the full-res file is on disk, the model only needs to see it. */
async function previewOf(dataURL) {
  if (!/^data:image\/(png|jpeg|webp)/.test(dataURL)) return null;
  const img = new Image();
  img.src = dataURL;
  await img.decode();
  const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // JPEG has no alpha: flatten onto white
  g.drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], mimeType: 'image/jpeg', width: img.naturalWidth, height: img.naturalHeight };
}

function hostTakes(kind, modality) {
  const caps = app.getHostCapabilities() || {};
  return !!(caps[kind] && caps[kind][modality]);
}

async function onExport(url) {
  toast('Saving…', 'info', 0);
  try {
    const dataURL = await toDataURL(url);
    const ext = (/^data:image\/(\w+)/.exec(dataURL) || [])[1] || 'png';
    const r = await app.callServerTool({ name: 'save_image', arguments: { dataURL, filename: `canvasmith.${ext}` } });
    if (r.isError) throw new Error((r.content?.[0]?.text) || 'Save failed');
    const saved = r.structuredContent;
    const preview = await previewOf(dataURL).catch(() => null);
    lastSaved = { path: saved.path, preview };
    $('#send').disabled = false;
    $('#where').textContent = `Last export: ${saved.path}`;
    $('#where').title = saved.path;
    toast(`Saved to ${saved.path}`, 'ok');

    const note = `The user exported an image from Canvasmith, saved at ${saved.path}` +
      (preview ? ` (${preview.width}×${preview.height}).` : '.');
    const content = [{ type: 'text', text: note }];
    if (preview && hostTakes('updateModelContext', 'image')) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
    app.updateModelContext({ content }).catch(() => { /* host without model-context support: file is saved regardless */ });
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, 'err', 8000);
  }
}

async function sendToClaude() {
  if (!lastSaved) return;
  const content = [{ type: 'text', text: `Here's my edited image from Canvasmith (saved at ${lastSaved.path}).` }];
  if (lastSaved.preview && hostTakes('message', 'image')) content.push({ type: 'image', data: lastSaved.preview.data, mimeType: lastSaved.preview.mimeType });
  try { await app.sendMessage({ role: 'user', content }); toast('Sent to Claude', 'ok'); }
  catch (e) { toast(`Couldn't send: ${e.message}`, 'err'); }
}

function applyDisplayMode(ctx) {
  const mode = ctx?.displayMode || document.documentElement.dataset.display || 'inline';
  document.documentElement.dataset.display = mode;
  const b = $('#full');
  const modes = ctx?.availableDisplayModes ?? app.getHostContext()?.availableDisplayModes ?? [];
  b.hidden = !modes.includes('fullscreen');
  b.textContent = mode === 'fullscreen' ? 'Exit full screen' : 'Full screen';
}

async function toggleFullscreen() {
  const want = document.documentElement.dataset.display === 'fullscreen' ? 'inline' : 'fullscreen';
  try { const r = await app.requestDisplayMode({ mode: want }); applyDisplayMode({ displayMode: r.mode }); }
  catch (e) { toast(`Full screen unavailable: ${e.message}`, 'err'); }
}

function mountEditor({ width = 1080, height = 1080 } = {}) {
  if (handle) return;
  const theme = app.getHostContext()?.theme;
  handle = mount('#editor', {
    fabric: window.fabric,
    width, height,
    mode: theme === 'light' ? 'light' : 'dark',
    ai: null,            // no model keys inside the sandbox; AI buttons report themselves unavailable
    bridge: false,       // the MCP host is the only way in — no ?image=/postMessage import bridge
    autosave: false,     // one document per tool call; don't resurrect the previous one
    openCvUrl: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    onExport,
  });
  // keep the strip above the editor in the editor's theme, including its own light/dark toggle
  const sync = () => { const r = document.querySelector('#editor .cm-root'); if (r) document.documentElement.dataset.mode = r.dataset.cmMode || 'dark'; };
  new MutationObserver(sync).observe($('#editor'), { subtree: true, attributes: true, attributeFilter: ['data-cm-mode'], childList: true });
}

async function openSource(source) {
  toast('Loading image…', 'info', 0);
  try {
    const r = await app.callServerTool({ name: 'load_image', arguments: { source } });
    if (r.isError) throw new Error((r.content?.[0]?.text) || 'Load failed');
    const editor = await whenEditor();
    await editor.openImage(r.structuredContent.dataURL);
    toast(`Opened ${r.structuredContent.name}`, 'ok', 2500);
  } catch (e) {
    toast(e.message, 'err', 0);
  }
}

/* A chat-width inline frame can't fit both side panels AND a usable canvas (52+220+290px of fixed
   columns), so start with Properties folded away; give it back when there's room (full screen). */
let autoCollapsed = false;
const NARROW = 1000;
function fitPanels() {
  const btn = document.querySelector('#editor .cm-collapse');
  if (!btn) return;
  const collapsed = btn.dataset.flip === 'true';
  if (innerWidth < NARROW && !collapsed) { btn.click(); autoCollapsed = true; }
  else if (innerWidth >= NARROW && collapsed && autoCollapsed) { btn.click(); autoCollapsed = false; }
}
addEventListener('resize', () => requestAnimationFrame(fitPanels));

let started = false;
function start(args = {}) {
  if (started) return;
  started = true;
  mountEditor({ width: args.width, height: args.height });
  whenEditor().then(() => requestAnimationFrame(fitPanels));
  if (args.image) openSource(args.image);
}

app.ontoolinput = ({ arguments: args }) => start(args || {});
app.ontoolresult = (r) => {
  if (r.isError) { toast(r.content?.[0]?.text || 'Canvasmith could not open that.', 'err', 0); return; }
  const dir = r.structuredContent?.outputDir;
  if (dir && !lastSaved) { $('#where').textContent = `Exports save to ${dir}`; $('#where').title = dir; }
};
app.onhostcontextchanged = (ctx) => { if ('displayMode' in ctx || 'availableDisplayModes' in ctx) applyDisplayMode(ctx); };
app.onteardown = async () => { try { handle && handle.unmount(); } catch (e) { } return {}; };

$('#full').addEventListener('click', toggleFullscreen);
$('#send').addEventListener('click', sendToClaude);

app.connect()
  .then(() => applyDisplayMode(app.getHostContext()))
  .catch((e) => console.warn('[canvasmith] host connect failed', e));
// tool-input normally arrives right after connect; don't leave a blank frame if it never does
setTimeout(() => start({}), 2500);
