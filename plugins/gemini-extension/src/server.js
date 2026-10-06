/* Canvasmith MCP server for Gemini CLI — two model-facing tools:

     open_canvasmith   opens the editor in the user's browser, optionally on a local file or an
                       http(s) image, and returns the tab's URL
     wait_for_export   waits for the user to export from that tab, then returns the saved path
                       plus a ≤1024px preview image so Gemini can see the result

   The editor and its image bytes live in the browser tab and the localhost bridge (bridge.js).
   The model only ever gets paths, dimensions and the downscaled preview. */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { classifySource } from '../../shared/image-io.js';
import { createBridge } from './bridge.js';

const DEFAULT_WAIT_S = 300;
const MAX_WAIT_S = 540;     // under Gemini CLI's 10-minute MCP request timeout

const text = (t) => ({ type: 'text', text: t });
const fail = (e) => ({ isError: true, content: [text(e instanceof Error ? e.message : String(e))] });

/* Gemini CLI doesn't pass the user's shell environment to extensions, so PATH may be empty:
   use absolute launchers where the OS has a fixed one. Best-effort — the URL is in the tool
   result either way, and the terminal makes it clickable. */
export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['/usr/bin/open', [url]]
    : process.platform === 'win32' ? [process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' } })
      .on('error', () => {}).unref();
  } catch { /* no launcher: the user clicks the link instead */ }
}

export function createServer({ viewHtml, outputDir, version = '0.1.0', launch = openInBrowser }) {
  const bridge = createBridge({ viewHtml, outputDir });
  const server = new McpServer(
    { name: 'canvasmith', version },
    {
      instructions:
        'Canvasmith is a full image editor (layers, brush, selections, crop, text, shapes, filters) ' +
        'that opens in the user\'s browser. Call open_canvasmith when the user wants to edit, annotate, ' +
        'crop, retouch or design an image, or start a blank canvas, then wait_for_export to get the result. ' +
        `Exports are saved under ${outputDir}.`,
    },
  );

  server.registerTool('open_canvasmith', {
    title: 'Open Canvasmith editor',
    description:
      'Open the Canvasmith image editor in the user\'s web browser so they can edit an image or design ' +
      'from a blank canvas. Optionally load an image from an absolute local file path (e.g. ' +
      '/Users/me/photo.jpg, ~/Desktop/shot.png) or an http(s) URL. Without an image, opens a blank ' +
      'canvas of width×height. Returns the editor URL and a session_id; call wait_for_export next to ' +
      'receive what the user exports.',
    inputSchema: z.object({
      image: z.string().optional().describe('Absolute file path, ~/ path, file:// URL or http(s) URL of the image to edit'),
      width: z.number().int().min(16).max(8192).optional().describe('Blank canvas width in px (default 1080; ignored when an image is given — the canvas fits the image)'),
      height: z.number().int().min(16).max(8192).optional().describe('Blank canvas height in px (default 1080)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ image, width, height }) => {
    const w = width || 1080, h = height || 1080;
    if (image) {
      const c = classifySource(image);
      if (!c) return fail(`Unsupported image source "${image}". Use an absolute file path or an http(s) URL.`);
      if (c.kind === 'file' && !existsSync(c.value)) return fail(`File not found: ${c.value}`);
    }
    try {
      const { id, url } = await bridge.open({ image: image || null, width: w, height: h });
      launch(url);
      const what = image ? `Opened ${image}` : `Opened a blank ${w}×${h} canvas`;
      return {
        content: [text(`${what} in Canvasmith, in the user's browser: ${url}\n` +
          `If no tab appeared, the user can open that link. Session: ${id}. Exports save to ${outputDir}. ` +
          'Call wait_for_export to receive the image once the user exports it.')],
        structuredContent: { session_id: id, url, image: image || null, width: w, height: h, outputDir },
      };
    } catch (e) { return fail(e); }
  });

  server.registerTool('wait_for_export', {
    title: 'Wait for Canvasmith export',
    description:
      'Wait for the user to export an image from the open Canvasmith editor (Export image → PNG/JPG/SVG ' +
      'in the browser tab). Returns the saved file path and a preview of the image. Returns immediately ' +
      'if the user already exported something you have not seen yet. If it times out, the editor is still ' +
      'open; ask the user or call again.',
    inputSchema: z.object({
      session_id: z.string().optional().describe('From open_canvasmith; defaults to the most recently opened editor'),
      timeout_seconds: z.number().int().min(5).max(MAX_WAIT_S).optional().describe(`How long to wait (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S})`),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ session_id, timeout_seconds }, ctx) => {
    const id = session_id || bridge.latestId;
    try {
      const exp = await bridge.nextExport(id, (timeout_seconds || DEFAULT_WAIT_S) * 1000, ctx?.mcpReq?.signal);
      if (!exp) {
        return { content: [text(`No export yet. The editor is still open at ${bridge.urlOf(id)}. ` +
          'Ask the user to click Export image in the tab, then call wait_for_export again.')],
          structuredContent: { session_id: id, exported: false } };
      }
      const dims = exp.width ? ` (${exp.width}×${exp.height})` : '';
      const content = [text(`The user exported an image from Canvasmith, saved at ${exp.path}${dims}.` +
        (exp.preview ? ' A downscaled preview follows.' : ''))];
      if (exp.preview) content.push({ type: 'image', data: exp.preview.data, mimeType: exp.preview.mimeType });
      return { content, structuredContent: { session_id: id, exported: true, path: exp.path, mime: exp.mime, bytes: exp.bytes, width: exp.width, height: exp.height } };
    } catch (e) { return fail(e); }
  });

  return { server, bridge };
}
