# Canvasmith for Claude

The full Canvasmith editor, rendered **inside your Claude conversation**. It's an
[MCP App](https://github.com/modelcontextprotocol/ext-apps) shipped as a Claude Desktop Extension
(`.mcpb`).

> "Open ~/Desktop/product.jpg in Canvasmith and I'll crop it for the banner"
> "Start a blank 1200×628 canvas"
> "Edit this image: https://example.com/photo.png"

Claude calls `open_canvasmith`, and the editor appears in the chat, with layers, brush, wand and
lasso selections, crop, text, shapes, gradients, filters and adjustment layers. When you export
(**Export image → PNG/JPG/SVG**), the file is saved to your export folder
(`~/Pictures/Canvasmith` by default). A preview is also added to Claude's context, so you can
follow up with "now write alt text for that". **Send to Claude** posts the edited image into the
chat as a message. **Full screen** gives you the whole window.

## Install

1. Download `canvasmith-<version>.mcpb` (or build it yourself: see below).
2. Double-click it, or go to Claude Desktop → **Settings → Extensions** and drag the file in.
3. Optional: pick a different export folder in the extension's settings.

## Tools

| Tool | Called by | What it does |
|---|---|---|
| `open_canvasmith` | Claude | Opens the editor on an absolute path / `~/` path / `file://` / `http(s)` image, or a blank `width`×`height` canvas |
| `load_image` | the editor view only | Reads the image and returns it to the sandboxed view (validated by magic bytes, 40 MB cap) |
| `save_image` | the editor view only | Writes an export to the export folder. It never overwrites a file, and names are sanitised |

Image bytes only move through the view-only tools, so a multi-megabyte image never fills
Claude's context window. Claude sees paths, dimensions and a preview of at most 1024 px.

## Privacy

Everything runs on your machine. Images are read from your disk (or the URL you give), and exports
are written to your disk. Nothing is sent to a Canvasmith server. AI provider features inside the
editor are turned off in this build. The one network request the view makes is for OpenCV
(smart selection), loaded from `cdn.jsdelivr.net` the first time you use it. If that is blocked,
the wand and lasso fall back to their built-in versions.

## Develop

```bash
cd plugins/claude-extension
npm install
npm test            # builds, then runs the server + view tests
npm run pack        # → dist/canvasmith-<version>.mcpb (validated with the mcpb CLI)
```

The view bundles `packages/react/src` and `packages/core/src` straight from this repo, so run the
root `npm install` first (for React and fabric). To try the unpacked server in Claude Desktop
without packing, add it to `claude_desktop_config.json`:

```json
{ "mcpServers": { "canvasmith": { "command": "node", "args": ["/abs/path/plugins/claude-extension/dist/bundle/server/index.mjs"] } } }
```

## Publishing

- **Claude Desktop extension directory**: submit the `.mcpb` through Anthropic's desktop
  extension submission form (linked from the [MCPB repo](https://github.com/anthropics/mcpb)).
  Signing it first (`npx mcpb sign dist/canvasmith-<version>.mcpb`) is recommended.
- **claude.ai web / mobile (later)**: `src/server.js` exports a transport-agnostic
  `createServer()`. Serve it over Streamable HTTP (e.g. a Netlify function next to the demo) and
  submit it as a remote connector. The view doesn't change.
