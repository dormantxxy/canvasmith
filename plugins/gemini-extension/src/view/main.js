/* The browser-tab view: the full Canvasmith React shell, talking to the localhost bridge
   (bridge.js) through URLs relative to this page — session, image, export. */

import { mount } from '../../../../packages/react/src/mount.js';

const $ = (s) => document.querySelector(s);
let handle = null;
let toastTimer = null;

function toast(msg, kind = 'info', ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.dataset.kind = kind; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function where(msg) { $('#where').textContent = msg; $('#where').title = msg; }

async function api(route, init) {
  const res = await fetch(route, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const ed = () => handle && handle.editor();
const whenEditor = () => new Promise((res) => { const tick = () => (ed() ? res(ed()) : setTimeout(tick, 30)); tick(); });

/* A blob: URL (SVG export) → dataURL, so it can be posted as JSON. */
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

async function onExport(url) {
  toast('Saving…', 'info', 0);
  try {
    const dataURL = await toDataURL(url);
    const ext = (/^data:image\/(\w+)/.exec(dataURL) || [])[1] || 'png';
    const preview = await previewOf(dataURL).catch(() => null);
    const r = await api('export', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataURL, filename: `canvasmith.${ext}`, preview }),
    });
    where(`Last export: ${r.path}`);
    toast(r.delivered ? `Saved to ${r.path} and sent to Gemini` : `Saved to ${r.path}. Gemini gets it on its next check`, 'ok', 6000);
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, 'err', 8000);
  }
}

function mountEditor({ width = 1080, height = 1080 } = {}) {
  handle = mount('#editor', {
    fabric: window.fabric,
    width, height,
    mode: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    ai: null,            // no model keys in this build; AI buttons report themselves unavailable
    bridge: false,       // the MCP server is the only way in — no ?image=/postMessage import bridge
    autosave: false,     // one document per open_canvasmith call; don't resurrect the previous one
    openCvUrl: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    onExport,
  });
  // keep the strip above the editor in the editor's theme, including its own light/dark toggle
  const sync = () => { const r = document.querySelector('#editor .cm-root'); if (r) document.documentElement.dataset.mode = r.dataset.cmMode || 'dark'; };
  new MutationObserver(sync).observe($('#editor'), { subtree: true, attributes: true, attributeFilter: ['data-cm-mode'], childList: true });
}

async function start() {
  let s;
  try { s = await api('session'); }
  catch (e) { where(e.message); toast(e.message, 'err', 0); return; }
  mountEditor({ width: s.width, height: s.height });
  where(`Exports save to ${s.outputDir}`);
  if (!s.hasImage) return;
  toast('Loading image…', 'info', 0);
  try {
    const img = await api('image');
    const editor = await whenEditor();
    await editor.openImage(img.dataURL);
    document.title = `${img.name} · Canvasmith`;
    toast(`Opened ${img.name}`, 'ok', 2500);
  } catch (e) {
    toast(e.message, 'err', 0);
  }
}

start();
