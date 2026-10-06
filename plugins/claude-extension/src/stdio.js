/* Entry point Claude Desktop launches (manifest.json → server.mcp_config). Bundled by build.mjs
   into server/index.mjs (.mjs: the unpacked bundle has no package.json to say "type": "module") with every dependency inlined, so the .mcpb ships no node_modules. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(here, 'view.html');

// Unresolved ${user_config.*} placeholders arrive literally when the user left the field empty.
const configured = (process.env.CANVASMITH_OUTPUT_DIR || '').trim();
const outputDir = configured && !configured.includes('${')
  ? path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
  : path.join(os.homedir(), 'Pictures', 'Canvasmith');

let cached = null;
const viewHtml = () => (cached ??= readFileSync(viewPath, 'utf8'));

const server = createServer({ viewHtml, outputDir, version: process.env.CANVASMITH_VERSION || '0.1.0' });
await server.connect(new StdioServerTransport());
console.error(`[canvasmith] MCP server ready (exports → ${outputDir})`);
