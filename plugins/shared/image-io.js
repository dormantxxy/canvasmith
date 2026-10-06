/* Image I/O shared by the Claude (MCP App) and Gemini CLI plugins. Node builtins only, so each
   plugin's esbuild bundle inlines it without dragging in anything else. */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

/* Sniffed from the bytes, not the extension — a renamed .png that's really a PDF is refused. */
export function sniffImageMime(buf) {
  const b = buf.subarray(0, 16);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(b.toString('ascii', 8, 12))) return 'image/avif';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/* Accepts an absolute path, ~/path, file:// URL, or http(s) URL. */
export function classifySource(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  if (/^file:\/\//i.test(s)) return { kind: 'file', value: fileURLToPath(s) };
  if (s.startsWith('~')) return { kind: 'file', value: path.join(os.homedir(), s.slice(1)) };
  if (path.isAbsolute(s)) return { kind: 'file', value: s };
  return null;
}

export async function readImage(src) {
  const c = classifySource(src);
  if (!c) throw new Error(`Unsupported image source "${src}". Use an absolute file path or an http(s) URL.`);
  let buf, name;
  if (c.kind === 'file') {
    const st = await stat(c.value).catch(() => null);
    if (!st || !st.isFile()) throw new Error(`File not found: ${c.value}`);
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${Math.round(st.size / 1048576)} MB, limit 40 MB).`);
    buf = await readFile(c.value);
    name = path.basename(c.value);
  } else {
    const res = await fetch(c.value, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) throw new Error(`Fetching image failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE_BYTES) throw new Error('Image is too large (limit 40 MB).');
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image is too large (limit 40 MB).');
    name = decodeURIComponent(new URL(c.value).pathname.split('/').pop() || 'image');
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error(`"${name}" is not a supported image (PNG, JPEG, GIF, WebP, BMP, AVIF or SVG).`);
  return { dataURL: `data:${mime};base64,${buf.toString('base64')}`, name, mime, bytes: buf.length };
}

/* canvasmith.png → canvasmith-2.png … never overwrites something already in the folder. */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

export async function saveDataURL(outputDir, dataURL, filename) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(dataURL || '');
  if (!m || !EXT[m[1].toLowerCase()]) throw new Error('save_image expects a PNG, JPEG, WebP or SVG data URL.');
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  // strip any directory part and unsafe characters: the view names files, it doesn't pick folders
  const raw = path.basename(String(filename || 'canvasmith')).replace(/\.[a-z0-9]+$/i, '');
  const base = raw.replace(/[^\w.@ -]+/g, '_').slice(0, 80) || 'canvasmith';
  await mkdir(outputDir, { recursive: true });
  const file = uniquePath(outputDir, base, EXT[mime]);
  await writeFile(file, buf);
  return { path: file, bytes: buf.length, mime };
}
