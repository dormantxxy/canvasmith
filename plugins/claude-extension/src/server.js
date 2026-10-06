/* Canvasmith MCP server — one model-facing tool that renders the editor inline (an MCP App),
   plus two app-only tools the editor iframe calls back into:

     open_canvasmith   model → opens the editor, optionally on a local file or an http(s) image
     load_image        app   → reads that image into a dataURL (the sandboxed iframe can't read
                              local files, and its CSP can't reach arbitrary image hosts)
     save_image        app   → writes an export to the user's output folder

   Image bytes only ever travel through the app-only tools, so a multi-MB dataURL never lands in
   the model's context — the model sees paths and dimensions, plus the downscaled preview the
   view pushes via ui/update-model-context after an export. */

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import { classifySource, readImage, saveDataURL } from '../../shared/image-io.js';

export { sniffImageMime, classifySource, saveDataURL } from '../../shared/image-io.js';

export const VIEW_URI = 'ui://canvasmith/editor.html';

const text = (t) => ({ type: 'text', text: t });
const fail = (e) => ({ isError: true, content: [text(e instanceof Error ? e.message : String(e))] });

export function createServer({ viewHtml, outputDir, version = '0.1.0' }) {
  const server = new McpServer(
    { name: 'canvasmith', version },
    {
      instructions:
        'Canvasmith is a full image editor (layers, brush, selections, crop, text, shapes, filters) ' +
        'that renders inside the conversation. Call open_canvasmith when the user wants to edit, ' +
        'annotate, crop, retouch or design an image, or start a blank canvas. Pass `image` as an ' +
        'absolute local path or an http(s) URL. The user edits interactively; when they export, the ' +
        `file is saved under ${outputDir} and a preview is shared back to you.`,
    },
  );

  registerAppResource(server, 'Canvasmith editor', VIEW_URI,
    { description: 'Interactive Canvasmith image editor', mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{
        uri: VIEW_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: viewHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            // OpenCV (smart selection) is lazy-loaded from jsDelivr on first use; everything else
            // is inlined. If the host blocks it, the editor's non-CV selection fallbacks take over.
            csp: { resourceDomains: ['https://cdn.jsdelivr.net'], connectDomains: ['https://cdn.jsdelivr.net'] },
          },
        },
      }],
    }),
  );

  registerAppTool(server, 'open_canvasmith', {
    title: 'Open Canvasmith editor',
    description:
      'Open the Canvasmith image editor inline so the user can edit an image or design from a blank ' +
      'canvas. Optionally load an image from an absolute local file path (e.g. /Users/me/photo.jpg, ' +
      '~/Desktop/shot.png) or an http(s) URL. Without an image, opens a blank canvas of width×height.',
    inputSchema: z.object({
      image: z.string().optional().describe('Absolute file path, ~/ path, file:// URL or http(s) URL of the image to edit'),
      width: z.number().int().min(16).max(8192).optional().describe('Blank canvas width in px (default 1080; ignored when an image is given — the canvas fits the image)'),
      height: z.number().int().min(16).max(8192).optional().describe('Blank canvas height in px (default 1080)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async ({ image, width, height }) => {
    const w = width || 1080, h = height || 1080;
    if (image) {
      const c = classifySource(image);
      if (!c) return fail(`Unsupported image source "${image}". Use an absolute file path or an http(s) URL.`);
      if (c.kind === 'file' && !existsSync(c.value)) return fail(`File not found: ${c.value}`);
    }
    return {
      content: [text(image
        ? `Opened ${image} in Canvasmith. The user is editing it now; exports are saved to ${outputDir}.`
        : `Opened a blank ${w}×${h} Canvasmith canvas. The user is editing it now; exports are saved to ${outputDir}.`)],
      structuredContent: { image: image || null, width: w, height: h, outputDir },
    };
  });

  registerAppTool(server, 'load_image', {
    title: 'Load image (editor)',
    description: 'Used by the Canvasmith editor view to read an image into the canvas.',
    inputSchema: z.object({ source: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ['app'] } },
  }, async ({ source }) => {
    try {
      const img = await readImage(source);
      return { content: [text(`Loaded ${img.name} (${img.mime}, ${img.bytes} bytes)`)], structuredContent: img };
    } catch (e) { return fail(e); }
  });

  registerAppTool(server, 'save_image', {
    title: 'Save export (editor)',
    description: 'Used by the Canvasmith editor view to save an exported image to the output folder.',
    inputSchema: z.object({ dataURL: z.string(), filename: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ['app'] } },
  }, async ({ dataURL, filename }) => {
    try {
      const r = await saveDataURL(outputDir, dataURL, filename);
      return { content: [text(`Saved ${r.path}`)], structuredContent: r };
    } catch (e) { return fail(e); }
  });

  return server;
}
