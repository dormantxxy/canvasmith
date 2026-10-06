# Canvasmith for ChatGPT

The full Canvasmith editor, rendered **inside your ChatGPT conversation**. It's a ChatGPT app built
on the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard, which ChatGPT
implements. It's the same widget as the Claude extension, served from a remote MCP server.

> *(attach a photo)* "Open this in Canvasmith so I can crop it for the banner"
> "Start a blank 1200×628 canvas"
> "Edit this image: https://example.com/photo.png"

ChatGPT calls `open_canvasmith`, and the editor appears in the chat. When you export
(**Export image → PNG/JPG/SVG**), the server keeps the file behind a private link and a preview is
added to ChatGPT's context, so you can follow up with "now write alt text for that".
**Download** saves the file. **Send to ChatGPT** posts the link into the chat. **Full screen**
gives you the whole window.

## How it differs from the desktop plugins

ChatGPT only talks to **remote HTTPS** MCP servers and has no access to your disk. So:

| | Claude / Gemini plugins | ChatGPT app |
|---|---|---|
| Transport | stdio, on your machine | Streamable HTTP at `/mcp`, on a server |
| Input image | local path or URL | an image **attached in the chat** (`openai/fileParams`) or a public URL. Never a server path |
| Export | written to a folder on your disk | kept in memory behind a `/exports/<128-bit id>/<name>` link, expiring after 24 h |
| URL fetching | anything you point it at | **public addresses only**: loopback, private, link-local and metadata IPs are refused on every redirect hop |

## Tools

| Tool | Called by | What it does |
|---|---|---|
| `open_canvasmith` | ChatGPT | Opens the editor on an attached `file`, an http(s) `image`, or a blank `width`×`height` canvas |
| `load_image` | the widget only | Fetches the image and returns it to the sandboxed widget (checked by magic bytes, 40 MB cap) |
| `save_image` | the widget only | Stores an export and returns its download URL |

The tool and resource metadata set both the MCP Apps keys (`ui.resourceUri`, `ui.visibility`,
`ui.csp`) and ChatGPT's aliases (`openai/outputTemplate`, `openai/widgetAccessible`,
`openai/widgetCSP`), so current and older ChatGPT clients both render it, and so does any other MCP
Apps host.

## Run it

```bash
npm install                 # at the repo root first (React + fabric for the widget)
cd plugins/chatgpt-app
npm install
npm test                    # builds, then runs the server + end-to-end widget tests
npm run build && npm start  # → http://0.0.0.0:8787/mcp
```

`dist/server/` is the whole deployable. It is two files with every dependency inlined, so there is
no `node_modules` to ship. The `Dockerfile` copies just that folder.

| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `PUBLIC_URL` | derived from `Host` / `X-Forwarded-*` | The https origin ChatGPT reaches you at. Set it in production |
| `CANVASMITH_WIDGET_DOMAIN` | `PUBLIC_URL` | Unique widget origin (`_meta.ui.domain`). OpenAI requires it for submission |
| `CANVASMITH_EXPORT_TTL_HOURS` | `24` | How long export links stay valid |
| `CANVASMITH_ALLOW_PRIVATE` | off | `1` lets `load_image` reach private addresses. Use it for tests or a LAN-only install, never on a public server |

Exports live in process memory (capped at 512 MB, oldest evicted first). Run a **single
instance**, or replace `src/export-store.js` with object storage that has the same
`put` / `get` interface.

## Try it in ChatGPT (developer mode)

1. Expose the local server over HTTPS, for example
   `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`.
2. In ChatGPT, go to **Settings → Apps & Connectors → Advanced**, then turn on **Developer mode**.
3. **Create** a connector with URL `https://<your-tunnel>/mcp` and authentication **None**.
4. In a new chat, enable it from the **+** menu, attach an image and ask to edit it in Canvasmith.

## Publishing

1. Deploy `dist/server/` to a stable HTTPS host (any Node 20+ host or container platform), with
   `PUBLIC_URL` and `CANVASMITH_WIDGET_DOMAIN` set.
2. Submit through the OpenAI Apps SDK submission flow: app name, icon (`icon.png`), description,
   privacy policy URL, test prompts, and the MCP URL.
3. The server has no auth: every tool is anonymous, and exports are only reachable by their random
   link. Put rate limiting in front of it (at the reverse proxy) before you open it to the public.

## Privacy

Images are fetched from the URL or ChatGPT file link you give. They go to the widget in your
browser, and the only thing kept on the server is an export you explicitly make, until its link
expires. Nothing is written to disk. AI provider features inside the editor are turned off in this
build. The widget's one outside request is for OpenCV (smart selection), loaded from
`cdn.jsdelivr.net` the first time you use it.
