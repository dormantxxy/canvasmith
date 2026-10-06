/* Where exports go when there's no user disk to write to: an in-memory store behind unguessable
   URLs (128-bit ids), expiring after a TTL and capped in total size, oldest evicted first.
   Single-process by design — run one instance, or swap this for object storage (same interface). */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export function createExportStore({ ttlMs = 24 * 3600e3, maxBytes = 512 * 1024 * 1024, now = Date.now } = {}) {
  const items = new Map();   // insertion order = age order
  let total = 0;

  const drop = (id) => { const it = items.get(id); if (it) { total -= it.buf.length; items.delete(id); } };
  const sweep = () => { const t = now(); for (const [id, it] of items) if (it.expiresAt <= t) drop(id); };

  return {
    /** dataURL → { id, filename, mime, bytes, expiresAt } */
    put(dataURL, filename) {
      const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(dataURL || '');
      const mime = m && m[1].toLowerCase();
      if (!m || !EXT[mime]) throw new Error('save_image expects a PNG, JPEG, WebP or SVG data URL.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > maxBytes) throw new Error('Export is too large to store.');
      sweep();
      while (total + buf.length > maxBytes && items.size) drop(items.keys().next().value);
      // the view names files, it doesn't pick paths: strip directories and unsafe characters
      const raw = path.basename(String(filename || 'canvasmith')).replace(/\.[a-z0-9]+$/i, '');
      const base = raw.replace(/[^\w.@ -]+/g, '_').replace(/ /g, '-').slice(0, 80) || 'canvasmith';
      const id = randomBytes(16).toString('hex');
      const it = { buf, mime, filename: `${base}.${EXT[mime]}`, expiresAt: now() + ttlMs };
      items.set(id, it); total += buf.length;
      return { id, filename: it.filename, mime, bytes: buf.length, expiresAt: new Date(it.expiresAt).toISOString() };
    },
    get(id) {
      const it = items.get(id);
      if (!it) return null;
      if (it.expiresAt <= now()) { drop(id); return null; }
      return it;
    },
    get size() { return items.size; },
    get bytes() { return total; },
  };
}
