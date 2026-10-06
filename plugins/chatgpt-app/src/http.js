/* The process ChatGPT talks to: a plain node:http server (bundled by build.mjs into
   dist/server/index.mjs, every dependency inlined) that serves

     POST /mcp                        Streamable HTTP MCP endpoint (stateless: one McpServer per request)
     GET  /exports/<id>/<filename>    exported images, from the in-memory export store
     GET  /healthz                    liveness probe

   Env: PORT (default 8787), HOST (default 0.0.0.0), PUBLIC_URL (the https origin ChatGPT reaches
   this at — derived from Host / X-Forwarded-* when unset), CANVASMITH_WIDGET_DOMAIN,
   CANVASMITH_EXPORT_TTL_HOURS (default 24), CANVASMITH_ALLOW_PRIVATE=1 (tests/self-hosting only). */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server.js';
import { createExportStore } from './export-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const version = process.env.CANVASMITH_VERSION || '0.1.0';
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const widgetDomain = process.env.CANVASMITH_WIDGET_DOMAIN || publicUrl || undefined;
const allowPrivate = process.env.CANVASMITH_ALLOW_PRIVATE === '1';
const MAX_BODY = 64 * 1024 * 1024;   // save_image carries a full-resolution export as a dataURL

let cached = null;
const viewHtml = () => (cached ??= readFileSync(path.join(here, 'view.html'), 'utf8'));
const store = createExportStore({ ttlMs: Number(process.env.CANVASMITH_EXPORT_TTL_HOURS || 24) * 3600e3 });

function originOf(req) {
  if (publicUrl) return publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const h = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`).split(',')[0].trim();
  return `${proto}://${h}`;
}

const mcp = createMcpHandler(
  ({ requestInfo }) => createServer({
    viewHtml, store, widgetDomain, allowPrivate, version,
    baseUrl: requestInfo?.headers.get('x-canvasmith-origin') || publicUrl,
  }),
  { maxRequestBodySize: MAX_BODY, onerror: (e) => console.error('[canvasmith] mcp:', e.message) },
);

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

/* node:http ⇄ web Request/Response, streaming the response so SSE works. */
async function serveMcp(req, res) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('x-canvasmith-origin', originOf(req));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const response = await mcp.fetch(new Request(new URL(req.url, 'http://local'), { method: req.method, headers, body, signal: ac.signal }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  try { for await (const chunk of response.body) res.write(chunk); } catch { /* client went away */ }
  res.end();
}

function serveExport(req, res, id) {
  const it = store.get(id);
  if (!it) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('This export has expired or never existed.'); }
  const inline = new URL(req.url, 'http://local').searchParams.has('inline');
  res.writeHead(200, {
    'content-type': it.mime,
    'content-length': it.buf.length,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${it.filename}"`,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // an exported SVG must never run script when opened from this origin
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : it.buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://local');
    if (pathname === '/mcp' || pathname === '/mcp/') return await serveMcp(req, res);
    const ex = /^\/exports\/([0-9a-f]{32})(?:\/[^/]*)?$/.exec(pathname);
    if (ex && (req.method === 'GET' || req.method === 'HEAD')) return serveExport(req, res, ex[1]);
    if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version, exports: store.size })); }
    if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`Canvasmith MCP server ${version}. Add ${originOf(req)}/mcp as a connector in ChatGPT.\n`); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    console.error('[canvasmith]', e);
    if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain' });
    res.end(e.status ? e.message : 'Internal error');
  }
});

server.listen(port, host, () => {
  const { port: p } = server.address();
  console.error(`[canvasmith] MCP server ready on http://${host}:${p}/mcp${publicUrl ? ` (public: ${publicUrl}/mcp)` : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); mcp.close().finally(() => process.exit(0)); });
