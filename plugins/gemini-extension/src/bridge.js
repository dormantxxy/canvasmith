/* The localhost bridge between the MCP server and the editor tab.

   Gemini CLI is a terminal, so it can't render the editor inline the way Claude's MCP Apps do.
   Instead open_canvasmith opens a browser tab on this server, and the tab calls back here to
   read its image and hand exports over:

     GET  /<token>/<id>/          the editor page (one self-contained HTML file)
     GET  /<token>/<id>/session   what to open: blank size, or whether a source image exists
     GET  /<token>/<id>/image     that source image as a dataURL (the tab never names the path)
     POST /<token>/<id>/export    { dataURL, preview } → saved to the output folder, and handed
                                   to any wait_for_export call that's waiting on this session

   Bound to 127.0.0.1 only. The random token in every path keeps other local pages and processes
   out, and the Host check stops DNS-rebinding pages from reaching it under another name. */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readImage, saveDataURL } from '../../shared/image-io.js';

const MAX_BODY = 64 * 1024 * 1024;

export function createBridge({ viewHtml, outputDir }) {
  const token = randomBytes(16).toString('hex');
  const sessions = new Map();
  let server = null, port = 0, latestId = null;

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_BODY) { reject(Object.assign(new Error('Export is too large (limit 64 MB).'), { code: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 421, { error: 'Wrong host' });
    const [, tok, id, route = ''] = new URL(req.url, 'http://x').pathname.split('/');
    const s = tok === token && sessions.get(id);
    if (!s) return json(res, 404, { error: 'This Canvasmith session has ended. Ask Gemini to open the editor again.' });

    if (req.method === 'GET' && route === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(viewHtml());
    }
    if (req.method === 'GET' && route === 'session') {
      return json(res, 200, { width: s.width, height: s.height, hasImage: !!s.image, outputDir, exports: s.exports.length });
    }
    if (req.method === 'GET' && route === 'image') {
      if (!s.image) return json(res, 404, { error: 'No image for this session' });
      try { const img = await readImage(s.image); return json(res, 200, { dataURL: img.dataURL, name: img.name }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && route === 'export') {
      // a JSON content type can't come from a plain cross-site form post
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Expected JSON' });
      try {
        const { dataURL, filename, preview } = JSON.parse(await readBody(req));
        const saved = await saveDataURL(outputDir, dataURL, filename);
        const ok = preview && /^image\/(jpeg|png)$/.test(preview.mimeType) && typeof preview.data === 'string';
        const exp = { ...saved, at: Date.now(), preview: ok ? { data: preview.data, mimeType: preview.mimeType } : null,
          width: ok ? preview.width : null, height: ok ? preview.height : null };
        s.exports.push(exp);
        const waiters = s.waiters.splice(0);
        for (const w of waiters) w();
        return json(res, 200, { path: saved.path, delivered: waiters.length > 0 });
      } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.message }); }
    }
    return json(res, 404, { error: 'Not found' });
  }

  async function start() {
    if (server) return;
    server = http.createServer((req, res) => { handle(req, res).catch((e) => json(res, 500, { error: e.message })); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    server.unref();   // never the thing keeping the process alive once stdio closes
  }

  /* One session per open_canvasmith call. The source is fixed here, by the model's arguments. */
  async function open({ image = null, width = 1080, height = 1080 } = {}) {
    await start();
    const id = randomBytes(6).toString('hex');
    sessions.set(id, { id, image, width, height, exports: [], delivered: 0, waiters: [] });
    latestId = id;
    return { id, url: `http://127.0.0.1:${port}/${token}/${id}/` };
  }

  const urlOf = (id) => `http://127.0.0.1:${port}/${token}/${id}/`;

  /* Resolves with the newest export the model hasn't seen yet, or null after `ms`. Earlier
     unseen exports are skipped: the model wants where the user ended up, not every draft. */
  function nextExport(id = latestId, ms = 300000, signal) {
    const s = sessions.get(id);
    if (!s) return Promise.reject(new Error(id ? `Unknown session "${id}".` : 'Canvasmith is not open. Call open_canvasmith first.'));
    const take = () => { s.delivered = s.exports.length; return s.exports[s.exports.length - 1]; };
    if (s.exports.length > s.delivered) return Promise.resolve(take());
    return new Promise((resolve) => {
      let timer;
      const done = (v) => { clearTimeout(timer); s.waiters = s.waiters.filter((w) => w !== wake); signal?.removeEventListener('abort', cancel); resolve(v); };
      const wake = () => done(take());
      const cancel = () => done(null);
      timer = setTimeout(cancel, ms);
      s.waiters.push(wake);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  const close = () => new Promise((r) => (server ? server.close(() => r()) : r()));

  return { open, nextExport, urlOf, close, get latestId() { return latestId; } };
}
