/* Launches the BUILT server (dist/server/index.mjs — what gets deployed) from a copy outside this
   package on a random port, and a local static server standing in for image hosts / ChatGPT's
   file download URLs. */
import { mkdtempSync, readFileSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE = readFileSync(path.join(here, '../../../apps/demo/sample.png'));

export async function startServer(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-gpt-'));
  cpSync(path.join(here, '../dist/server'), dir, { recursive: true });
  const proc = spawn(process.execPath, [path.join(dir, 'index.mjs')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  const base = await new Promise((res, rej) => {
    let log = '';
    proc.stderr.on('data', (d) => { log += d; const m = /ready on (http:\/\/[\d.]+:\d+)/.exec(log); if (m) res(m[1]); });
    proc.on('exit', (c) => rej(new Error(`server exited ${c}: ${log}`)));
  });
  return { proc, base, dir };
}

export async function startImageHost() {
  const server = http.createServer((req, res) => {
    if (req.url === '/sample.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(SAMPLE); }
    if (req.url === '/hop') { res.writeHead(302, { location: '/sample.png' }); return res.end(); }
    if (req.url === '/fake.png') { res.writeHead(200); return res.end('%PDF-1.7 not an image'); }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
