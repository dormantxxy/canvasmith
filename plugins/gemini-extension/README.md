# Canvasmith for Gemini CLI

The full Canvasmith editor, driven from [Gemini CLI](https://github.com/google-gemini/gemini-cli).
Gemini opens it in a **browser tab** on your machine (a terminal can't show an image editor), you
edit, and when you export, the result comes straight back into the Gemini conversation.

> "Open ./product.jpg in Canvasmith, I want to crop it for the banner"
> `/canvasmith ~/Desktop/shot.png`
> `/canvasmith:blank 1200x628`

Gemini calls `open_canvasmith` and the editor opens with layers, brush, wand and lasso
selections, crop, text, shapes, gradients, filters and adjustment layers. Gemini then calls
`wait_for_export`. When you click **Export image → PNG/JPG/SVG**, the file is saved to your
export folder (`~/Pictures/Canvasmith` by default) and Gemini receives the path and a preview, so
you can follow up with "now write alt text for that".

## Install

From a release archive or a local build:

```bash
gemini extensions install https://github.com/<owner>/<repo>   # a repo or release with gemini-extension.json at its root
# or, from this repo
cd plugins/gemini-extension && npm install && npm run build
gemini extensions install ./dist/extension
```

During install Gemini asks for the **Export folder** setting. Leave it empty to use
`~/Pictures/Canvasmith`. To change it later, run `gemini extensions config canvasmith`. Node 20 or
newer must be on your PATH.

## Tools and commands

| | What it does |
|---|---|
| `open_canvasmith` | Opens the editor on an absolute path / `~/` path / `file://` / `http(s)` image, or a blank `width`×`height` canvas. It returns the tab URL and a `session_id` |
| `wait_for_export` | Waits for your next export (5 min by default, up to 9), then returns the saved path plus a preview of at most 1024 px. It returns right away if you already exported |
| `/canvasmith [image or size]` | Opens the editor and waits for the export |
| `/canvasmith:blank [size]` | Opens a blank canvas ("1200x628", "instagram story" and so on) |

If a wait times out, the tab stays open. Tell Gemini you're done and it checks again.

## How it works and privacy

The MCP server starts a small web server on `127.0.0.1` (random port) that serves the editor
and receives exports. Every URL carries a random per-run token, and requests under any host name
other than `127.0.0.1` or `localhost` are refused. The tab can only read the one image Gemini
opened it on. Image bytes stay between the tab and the local server, so Gemini's context gets
only paths, dimensions and the downscaled preview.

Nothing is uploaded to a Canvasmith server. AI provider features inside the editor are turned off
in this build. The one outside request the page makes is for OpenCV (smart selection), which it
loads from `cdn.jsdelivr.net` the first time you use it.

## Develop

```bash
cd plugins/gemini-extension
npm install
npm test            # builds, then runs the server + browser tests
npm run pack        # → dist/canvasmith-gemini-<version>.tar.gz
gemini extensions link ./dist/extension   # try the build live; rebuild, then restart gemini
```

The page bundles `packages/react/src` and `packages/core/src` straight from this repo, so run the
root `npm install` first (for React and fabric). Image reading and saving is shared with the
Claude extension (`plugins/shared/image-io.js`).

## Publishing

Gemini installs straight from GitHub. It clones a repo, or downloads a release archive, and
never runs `npm install`, so publish the **built** `dist/extension/` contents:

- **Release archive**: run `npm run pack` and attach the `.tar.gz` to a GitHub release. The
  `gemini-extension.json` is already at the archive root.
- **Gallery** ([geminicli.com/extensions](https://geminicli.com/extensions)): push
  `dist/extension/` as the root of a public repo (for example `canvasmith-gemini`) and add the
  `gemini-cli-extension` topic. The gallery crawls those daily.
