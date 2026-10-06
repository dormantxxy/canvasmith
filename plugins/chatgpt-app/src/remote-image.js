/* Image fetching for a server that runs on the public internet. Unlike the desktop plugins this
   one never reads the local disk, and it refuses URLs that resolve to loopback, link-local or
   private addresses — otherwise any ChatGPT user could make it fetch the host's cloud metadata
   endpoint or internal services. Every redirect hop is re-checked. */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sniffImageMime } from '../../shared/image-io.js';

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||      // CGNAT
    (a === 169 && b === 254) ||                 // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19));      // benchmarking
}

export function isPrivateAddress(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(s) === 4) return v4Private(s);
  if (isIP(s) !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Private(mapped[1]);
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
}

async function assertPublic(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Can't resolve ${url.hostname}.`);
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error(`Refusing to fetch ${url.hostname}: it points at a private network address.`);
}

export async function fetchImage(src, { allowPrivate = false, name: givenName } = {}) {
  let url;
  try { url = new URL(String(src || '').trim()); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`Unsupported image source "${src}". Pass an http(s) URL or attach the image in the chat.`);

  let res;
  for (let hop = 0; ; hop++) {
    if (!allowPrivate) await assertPublic(url);
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
    if (res.status < 300 || res.status > 399) break;
    const next = res.headers.get('location');
    if (!next || hop >= MAX_REDIRECTS) throw new Error('Fetching image failed: too many redirects.');
    url = new URL(next, url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Fetching image failed: redirected to a non-http URL.');
  }
  if (!res.ok) throw new Error(`Fetching image failed: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('Image is too large (limit 40 MB).');

  // stream with a running cap, so a lying or missing content-length can't exhaust memory
  const chunks = []; let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) throw new Error('Image is too large (limit 40 MB).');
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const name = givenName || decodeURIComponent(url.pathname.split('/').pop() || '') || 'image';
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error(`"${name}" is not a supported image (PNG, JPEG, GIF, WebP, BMP, AVIF or SVG).`);
  return { dataURL: `data:${mime};base64,${buf.toString('base64')}`, name, mime, bytes: buf.length };
}
