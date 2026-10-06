/* Canvasmith MCP server for ChatGPT — the same MCP App as the Claude extension (one model tool
   that renders the editor inline, two app-only tools the editor calls back into), reshaped for a
   remote server with no user disk:

     open_canvasmith   model → opens the editor on an http(s) image, a file the user attached in
                              the chat (openai/fileParams), or a blank canvas
     load_image        app   → fetches that image into a dataURL (the widget's CSP can't reach
                              arbitrary image hosts); public addresses only
     save_image        app   → keeps an export in the export store and returns its download URL

   Metadata is written twice where ChatGPT has its own alias (openai/outputTemplate next to
   ui.resourceUri, openai/widgetAccessible next to ui.visibility) so older ChatGPT clients and
   any other MCP Apps host both render it. */

import { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import { fetchImage } from './remote-image.js';

export const VIEW_URI = 'ui://canvasmith/editor-v1.html';

const text = (t) => ({ type: 'text', text: t });
const fail = (e) => ({ isError: true, content: [text(e instanceof Error ? e.message : String(e))] });

const APP_ONLY = { ui: { resourceUri: VIEW_URI, visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' };

/**
 * @param {object} o
 * @param {() => string} o.viewHtml       the built, self-contained view document
 * @param {ReturnType<import('./export-store.js').createExportStore>} o.store
 * @param {string} o.baseUrl              public origin exports are served from (no trailing slash)
 * @param {string} [o.widgetDomain]       unique widget origin; required by OpenAI for submission
 * @param {boolean} [o.allowPrivate]      let load_image reach private addresses (tests / self-hosting only)
 */
export function createServer({ viewHtml, store, baseUrl, widgetDomain, allowPrivate = false, version = '0.1.0' }) {
  const server = new McpServer(
    { name: 'canvasmith', version },
    {
      instructions:
        'Canvasmith is a full image editor (layers, brush, selections, crop, text, shapes, filters) ' +
        'that renders inside the conversation. Call open_canvasmith when the user wants to edit, ' +
        'annotate, crop, retouch or design an image, or start a blank canvas. Pass an image the user ' +
        'attached as `file`, or a public http(s) URL as `image`. The user edits interactively; when ' +
        'they export, a preview and a download link are shared back to you.',
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
            ...(widgetDomain ? { domain: widgetDomain } : {}),
            // OpenCV (smart selection) is lazy-loaded from jsDelivr on first use; everything else
            // is inlined. If the host blocks it, the editor's non-CV selection fallbacks take over.
            csp: { resourceDomains: ['https://cdn.jsdelivr.net'], connectDomains: ['https://cdn.jsdelivr.net'] },
          },
          'openai/widgetDescription': 'An interactive image editor is open. The user edits in it and exports when done; don\'t describe the UI.',
          'openai/widgetPrefersBorder': false,
          // openExternal() targets for the Download button
          'openai/widgetCSP': { resource_domains: ['https://cdn.jsdelivr.net'], connect_domains: ['https://cdn.jsdelivr.net'], redirect_domains: [baseUrl] },
        },
      }],
    }),
  );

  registerAppTool(server, 'open_canvasmith', {
    title: 'Open Canvasmith editor',
    description:
      'Open the Canvasmith image editor inline so the user can edit an image or design from a blank ' +
      'canvas. To edit an image the user attached in this chat, pass it as `file`. To edit an image ' +
      'on the web, pass its http(s) URL as `image`. With neither, opens a blank width×height canvas.',
    inputSchema: z.object({
      file: z.object({
        download_url: z.string(),
        file_id: z.string(),
        mime_type: z.string().optional(),
        file_name: z.string().optional(),
      }).optional().describe('An image the user attached in the conversation'),
      image: z.string().optional().describe('Public http(s) URL of an image to edit'),
      width: z.number().int().min(16).max(8192).optional().describe('Blank canvas width in px (default 1080; ignored when an image is given — the canvas fits the image)'),
      height: z.number().int().min(16).max(8192).optional().describe('Blank canvas height in px (default 1080)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    _meta: {
      ui: { resourceUri: VIEW_URI },
      'openai/outputTemplate': VIEW_URI,
      'openai/fileParams': ['file'],
      'openai/toolInvocation/invoking': 'Opening Canvasmith…',
      'openai/toolInvocation/invoked': 'Canvasmith is open',
    },
  }, async ({ file, image, width, height }) => {
    const w = width || 1080, h = height || 1080;
    if (!file && image && !/^https?:\/\//i.test(image.trim()))
      return fail(`Unsupported image source "${image}". Pass a public http(s) URL, or ask the user to attach the image in the chat.`);
    const label = file ? (file.file_name || 'the attached image') : image;
    return {
      content: [text(label
        ? `Opened ${label} in Canvasmith. The user is editing it now; when they export you'll get a preview and a download link.`
        : `Opened a blank ${w}×${h} Canvasmith canvas. The user is editing it now; when they export you'll get a preview and a download link.`)],
      structuredContent: { image: file ? null : (image || null), fileName: file?.file_name || null, width: w, height: h },
    };
  });

  registerAppTool(server, 'load_image', {
    title: 'Load image (editor)',
    description: 'Used by the Canvasmith editor view to read an image into the canvas.',
    inputSchema: z.object({ source: z.string(), name: z.string().optional() }),
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    _meta: APP_ONLY,
  }, async ({ source, name }) => {
    try {
      const img = await fetchImage(source, { allowPrivate, name });
      return { content: [text(`Loaded ${img.name} (${img.mime}, ${img.bytes} bytes)`)], structuredContent: img };
    } catch (e) { return fail(e); }
  });

  registerAppTool(server, 'save_image', {
    title: 'Save export (editor)',
    description: 'Used by the Canvasmith editor view to store an exported image and get its download link.',
    inputSchema: z.object({ dataURL: z.string(), filename: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_ONLY,
  }, async ({ dataURL, filename }) => {
    try {
      const r = store.put(dataURL, filename);
      const url = `${baseUrl}/exports/${r.id}/${encodeURIComponent(r.filename)}`;
      return { content: [text(`Stored ${r.filename}: ${url}`)], structuredContent: { ...r, url } };
    } catch (e) { return fail(e); }
  });

  return server;
}
