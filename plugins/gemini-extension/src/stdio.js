/* Entry point Gemini CLI launches (gemini-extension.json → mcpServers.canvasmith). Bundled by
   build.mjs into server/index.mjs with every dependency inlined: `gemini extensions install`
   copies the folder as-is and never runs npm install, so the extension ships no node_modules. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(here, 'view.html');

// set from the extension's "Export folder" setting; empty when the user skipped it
const configured = (process.env.CANVASMITH_OUTPUT_DIR || '').trim();
const outputDir = configured && !configured.includes('${')
  ? path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
  : path.join(os.homedir(), 'Pictures', 'Canvasmith');

let cached = null;
const viewHtml = () => (cached ??= readFileSync(viewPath, 'utf8'));

// CANVASMITH_NO_OPEN=1: tests and headless machines get the URL without a browser popping up
const launch = process.env.CANVASMITH_NO_OPEN ? () => {} : undefined;
const { server } = createServer({ viewHtml, outputDir, version: process.env.CANVASMITH_VERSION || '0.1.0', launch });
await server.connect(new StdioServerTransport());
console.error(`[canvasmith] MCP server ready (exports → ${outputDir})`);
