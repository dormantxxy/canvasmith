/* Browser-driven tests for the Editor/PaintEngine paths the pure node:test suite can't reach
   (see core.test.mjs's header comment) — real Fabric, real Canvas2D, driven through an actual
   Chromium instance via Playwright. Each test gets a fresh Editor via test/fixtures/browser-editor.html,
   which exposes window.__ed (already wired to installKeybindings via window.__stopKeys).

   Run with `npm run test:browser` (separately from `npm test`'s fast pure-logic suite — this one
   needs a browser download, so it's opt-in for local dev and a separate CI step). */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' };

let server, browser, baseURL;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(req.url.split('?')[0]);
      const filePath = join(ROOT, path);
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

let page;
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });
  await page.goto(baseURL + '/test/fixtures/browser-editor.html');
  await page.waitForFunction(() => window.__ready === true);
});

afterEach(async () => { if (page) await page.close(); });

/* ── shapes: click-drag sizing ────────────────────────────────────────────────────────── */
test('browser: click-drag creates a shape sized to the drag, Shift constrains to square', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 90, { steps: 4 });
  await page.mouse.up();
  const rect = await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; return { type: o.type, left: o.left, top: o.top, width: o.width, height: o.height }; });
  assert.equal(rect.type, 'rect');
  assert.equal(rect.left, 50); assert.equal(rect.top, 50);
  assert.equal(rect.width, 100); assert.equal(rect.height, 40);

  await page.evaluate(() => window.__ed.setTool('ellipse'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 50);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 90, { steps: 4 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  const ell = await page.evaluate(() => { const objs = window.__ed.fc.getObjects(); const o = objs[objs.length - 1]; return { rx: o.rx, ry: o.ry }; });
  assert.equal(ell.rx, ell.ry);   // Shift forces a 1:1 (circle) constraint
});

/* ── history: undo/redo across a real Fabric scene ────────────────────────────────────── */
test('browser: undo/redo reverts and reapplies a committed transform', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; window.__ed.setNumeric.call(window.__ed, { x: 999 }); });
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 50);
  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
});

/* ── layers: duplicate, reorder, remove ───────────────────────────────────────────────── */
test('browser: duplicateLayer, moveLayer and removeLayer mutate the scene as expected', async () => {
  const id1 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 10, top: 10, width: 30, height: 30, fill: '#ff0000' });
    o.set({ id: 'r1', role: 'shape', name: 'R1' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  const id2 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 50, top: 50, width: 30, height: 30, fill: '#00ff00' });
    o.set({ id: 'r2', role: 'shape', name: 'R2' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);

  const dupId = await page.evaluate((id) => window.__ed.duplicateLayer(id), id1);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 3);
  assert.ok(dupId && dupId !== id1);

  await page.evaluate((id) => window.__ed.removeLayer(id), id2);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);
});

/* ── paint engine: brush stroke actually paints pixels ────────────────────────────────── */
test('browser: brush tool paints non-transparent pixels into the paint layer', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.evaluate(() => window.__ed.setToolOptions({ size: 40, color: '#ff0000', opacity: 1 }));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 6 });
  await page.mouse.up();
  const hasPaint = await page.evaluate(() => {
    const ed = window.__ed;
    const paintLayer = ed.fc.getObjects().find(o => o.role === 'paint');
    if (!paintLayer) return false;
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  assert.equal(hasPaint, true);
});

/* ── selection: marquee drag produces a real pixel selection ──────────────────────────── */
test('browser: marquee drag sets ed.selection and finalizeSelection accepts it', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.__ed.selection);
  assert.equal(sel.kind, 'rect');
  assert.ok(sel.w > 6 && sel.h > 6);
});

test('browser: clicking inside an existing marquee again clears the selection instead of leaving it unchanged', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => !!window.__ed.selection));
  // A plain click on the marquee's own interior (no drag) picks up its move handle first, but with
  // zero net movement it must still deselect — matching the reference editor, where a marquee click
  // always restarts a fresh 0-size selection that gets discarded, rather than silently no-opping.
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);
  assert.equal(await page.evaluate(() => window.__ed.selection), null);
});

/* ── addMode: a sticky "keep adding every click" toggle for wand/objectselect/hoverselect, an
   alternative to holding Shift on every click (matches the reference editor's Add-mode chip).
   Stubs wandPick to record its {add,subtract} args instead of waiting on a real cv round-trip —
   this is purely testing Editor#_down's branching, not the wand algorithm itself. ─────────────── */
test('browser: toolOpts.addMode makes every click add to the selection without holding Shift', async () => {
  await page.evaluate(() => {
    window.__wandCalls = [];
    window.__ed.wandPick = (pt, opts) => { window.__wandCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setTool('wand');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  let calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[0].add, false);   // addMode off, no Shift → plain click

  await page.evaluate(() => window.__ed.setToolOptions({ addMode: true }));
  await page.mouse.click(canvasBox.x + 80, canvasBox.y + 50);
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[1].add, true);   // addMode on → add without Shift

  // objectselect/hoverselect route clicks through the box-aware selectObjectAt (not wandPick) —
  // stub that instead to check the same addMode/Shift branching on its own {add,subtract} options.
  await page.evaluate(() => {
    window.__objCalls = [];
    window.__ed.selectObjectAt = (pt, opts) => { window.__objCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setToolOptions({ addMode: false });
    window.__ed.setTool('objectselect');
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(canvasBox.x + 110, canvasBox.y + 50);
  await page.keyboard.up('Shift');
  const objCalls = await page.evaluate(() => window.__objCalls);
  assert.equal(objCalls[0].add, true);   // Shift still works independent of addMode, on objectselect too
});

/* ── objectselect-bbox: the reference editor's near-stub "wand" (key W) — no pixel analysis at
   all, just the active object's own bounding box, or a fixed center region with nothing active ── */
test('browser: objectselect-bbox selects the active object\'s bounding box, or a center region with nothing active', async () => {
  await page.evaluate(() => window.__ed.setTool('objectselect-bbox'));
  const canvasBox = await page.locator('#cv').boundingBox();
  // Nothing active yet — a plain click falls back to the fixed center-region rect.
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  const centerSel = await page.evaluate(() => window.__ed.selection);
  assert.equal(centerSel.kind, 'rect');
  const W = await page.evaluate(() => window.__ed.W), H = await page.evaluate(() => window.__ed.H);
  assert.equal(centerSel.x, W * 0.18); assert.equal(centerSel.y, H * 0.18);
  assert.equal(centerSel.w, W * 0.64); assert.equal(centerSel.h, H * 0.64);

  // With a shape active, the click selects exactly that object's own getBoundingRect(true) —
  // NOT the raw drag dimensions, since every object here carries a themed selection `padding`
  // (see the Editor constructor's 'object:added' handler) that getBoundingRect(true) includes.
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 120, { steps: 4 });
  await page.mouse.up();   // shape tools auto-return to select with the new object active
  const expectedBox = await page.evaluate(() => {
    const o = window.__ed.fc.getActiveObject(); o.setCoords();
    return o.getBoundingRect(true);
  });
  await page.evaluate(() => window.__ed.setTool('objectselect-bbox'));
  await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200);   // click position is irrelevant — no pt-based logic
  const bboxSel = await page.evaluate(() => window.__ed.selection);
  assert.equal(bboxSel.kind, 'rect');
  assert.equal(bboxSel.x, expectedBox.left); assert.equal(bboxSel.y, expectedBox.top);
  assert.equal(bboxSel.w, expectedBox.width); assert.equal(bboxSel.h, expectedBox.height);
});

/* ── magicwand: the reference editor's real per-click CV wand (key A) — routes through the exact
   same wandPick() the plain-JS 'wand' tool and objectselect/hoverselect already use, just without
   objectselect/hoverselect's pre-populated hover cache. Stubbed the same way the addMode test
   above stubs wandPick, so this only verifies Editor#_down's dispatch, not the cv algorithm. ──── */
test('browser: magicwand tool dispatches clicks through wandPick with no hover cache involved', async () => {
  await page.evaluate(() => {
    window.__wandCalls = [];
    window.__ed.wandPick = (pt, opts) => { window.__wandCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setTool('magicwand');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  let calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].add, false); assert.equal(calls[0].subtract, false);

  await page.keyboard.down('Shift');
  await page.mouse.click(canvasBox.x + 80, canvasBox.y + 50);
  await page.keyboard.up('Shift');
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[1].add, true);   // Shift-click adds, same contract as objectselect/hoverselect

  await page.keyboard.down('Alt');
  await page.mouse.click(canvasBox.x + 110, canvasBox.y + 50);
  await page.keyboard.up('Alt');
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[2].subtract, true);   // Alt-click subtracts

  // No hover cache exists for magicwand (only objectselect/hoverselect populate one in setTool),
  // so every click always falls through to wandPick — never short-circuited by a cached preview.
  assert.equal(await page.evaluate(() => !!window.__ed._hoverCache), false);
});

/* ── aiinsert: click opens the host's prompt popover (via the 'aiinsert' event) instead of
   drawing anything itself — plain click reports region:false, a click inside an active pixel
   selection reports region:true so the host UI can offer "fill this shape" instead ────────── */
test('browser: the aiinsert tool emits {pt, region} on click and does not draw', async () => {
  await page.evaluate(() => {
    window.__aiInsertEvents = [];
    window.__ed.on('aiinsert', (e) => window.__aiInsertEvents.push(e));
    window.__ed.setTool('aiinsert');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 60, canvasBox.y + 40);
  const events = await page.evaluate(() => window.__aiInsertEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0].region, false);
  assert.equal(events[0].pt.x, 60); assert.equal(events[0].pt.y, 40);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().length), 0);   // no drawing side effect
});

test('browser: aiinsert reports region:true for a click inside an active pixel selection', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__aiInsertEvents = [];
    window.__ed.on('aiinsert', (e) => window.__aiInsertEvents.push(e));
    window.__ed.setTool('aiinsert');
  });
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);   // inside the marquee
  const inside = await page.evaluate(() => window.__aiInsertEvents.at(-1));
  assert.equal(inside.region, true);

  await page.mouse.click(canvasBox.x + 350, canvasBox.y + 20);   // outside the marquee, still on-canvas
  const outside = await page.evaluate(() => window.__aiInsertEvents.at(-1));
  assert.equal(outside.region, false);
});

/* ── keybindings: tool-switch, undo/redo, delete, arrow-nudge (installKeybindings) ────── */
test('browser: installKeybindings wires tool-switch letters and arrow-key nudge', async () => {
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');
  await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'select');

  // Reference-editor letter parity for the keys that were remapped off Canvasmith's prior
  // bindings: N=AI insert (was pencil), U=rect (was burn), W=objectselect-bbox (was the color
  // wand), A=magicwand (new), G=bucket (was gradient), K=the plain-JS color wand (moved off G).
  await page.keyboard.press('n'); assert.equal(await page.evaluate(() => window.__ed.tool), 'aiinsert');
  await page.keyboard.press('u'); assert.equal(await page.evaluate(() => window.__ed.tool), 'rect');
  await page.keyboard.press('w'); assert.equal(await page.evaluate(() => window.__ed.tool), 'objectselect-bbox');
  await page.keyboard.press('a'); assert.equal(await page.evaluate(() => window.__ed.tool), 'magicwand');
  await page.keyboard.press('g'); assert.equal(await page.evaluate(() => window.__ed.tool), 'bucket');
  await page.keyboard.press('k'); assert.equal(await page.evaluate(() => window.__ed.tool), 'wand');
  await page.keyboard.press('v'); assert.equal(await page.evaluate(() => window.__ed.tool), 'select');

  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const before = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  const after1 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after1, before + 1);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  const after2 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after2, after1 + 10);
});

test('browser: installKeybindings wires delete/backspace on the active layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 0);
});

test('browser: holding Space pans the canvas with any tool active, without switching tools', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  const vptBefore = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.keyboard.down('Space');
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__ed._spaceDown), true);
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(30);
  const vptAfter = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  assert.notDeepEqual(vptAfter, vptBefore);   // the viewport actually panned
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');   // tool never switched to hand
  assert.equal(await page.evaluate(() => window.__ed._spaceDown), false);
  // brush still works normally once space is released — no lingering pan state
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 80, canvasBox.y + 80, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const hasPaintLayer = await page.evaluate(() => window.__ed.fc.getObjects().some(o => o.role === 'paint'));
  assert.equal(hasPaintLayer, true);
});

test('browser: Cmd/Ctrl+J copies the selected pixels of the active layer into a new layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('ControlOrMeta+j');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);   // new "... copy" layer added
  // duplicateSelectionToLayer is non-destructive — the source rect is untouched
  const rectStillFull = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.type === 'rect').clipPath == null);
  assert.equal(rectStillFull, true);
});

test('browser: Backspace with an active pixel selection cuts (clips) it from the active layer instead of deleting the whole layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  // the layer survives (only clipped), unlike a plain Backspace with no selection which removes it
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  const hasClip = await page.evaluate(() => !!window.__ed.fc.getObjects()[0].clipPath);
  assert.equal(hasClip, true);
});

/* ── auto-detect: detectObjects / selectDetectedBox (cv-only, vendored OpenCV) ────────── */
test('browser: detectObjects resolves ok/error status and selectDetectedBox commits a real selection', async () => {
  // A blank artboard still rasterizes to a flat image via captureFlat() (a white rect, not "no
  // image") — Canny finds no edges in it, so this is the 'no_match' path, not 'no_image'.
  const emptyResult = await page.evaluate(() => window.__ed.detectObjects());
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.reason, 'no_match');

  // With a shape on the canvas, cv.detect() runs (via the vendored opencv.js) and returns a status.
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  const r = await page.evaluate(() => window.__ed.detectObjects(), null, { timeout: 20000 });
  assert.ok(r.status === 'ok' || r.status === 'error');
  if (r.status === 'ok' && r.result.boxes.length) {
    await page.evaluate((box) => window.__ed.selectDetectedBox(box), r.result.boxes[0]);
    const sel = await page.evaluate(() => window.__ed.selection);
    assert.equal(sel.kind, 'rect');
  }
});

/* ── gradient tool: drag paints a live-previewed, multi-stop/radial gradient into the paint layer ── */
test('browser: dragging the gradient tool paints a multi-stop linear gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'linear', gradientStops: [
      { offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' },
    ] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 380, canvasBox.y + 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x) => { const d = ctx.getImageData(x, 150, 1, 1).data; return [d[0], d[1], d[2]]; };
    return { left: at(20), middle: at(200), right: at(370) };
  });
  // left end should read red-dominant, middle green-dominant, right blue-dominant
  assert.ok(colors.left[0] > colors.left[2]);
  assert.ok(colors.middle[1] > colors.middle[0] && colors.middle[1] > colors.middle[2]);
  assert.ok(colors.right[2] > colors.right[0]);
});

test('browser: dragging the gradient tool with gradientType radial paints a radial gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'radial', gradientStops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return d[0]; };
    return { center: at(200, 150), edge: at(200, 5) };
  });
  assert.ok(colors.center > colors.edge);   // white at center, fading to black toward the edge
});

/* ── gradient fill on vector shapes ────────────────────────────────────────────────────────── */
test('browser: setShapeGradient applies a Fabric gradient fill, no-op on an image', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setShapeGradient([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], 'linear', 45));
  const g = await page.evaluate(() => window.__ed.getShapeGradient());
  assert.equal(g.type, 'linear');
  assert.equal(g.stops.length, 2);
  assert.equal(g.stops[0].color, '#ff0000');

  const isFabricGradient = await page.evaluate(() => {
    const o = window.__ed.fc.getObjects()[0];
    return typeof o.fill === 'object' && o.fill.type === 'linear';
  });
  assert.equal(isFabricGradient, true);
});

/* ── gradient tool: object-local mode — dragging onto an active vector object with no pixel
   selection applies the gradient as that object's own Fabric fill instead of painting a raster
   stripe into the paint layer (matches the reference editor's applyCustomGradient exactly). ──── */
test('browser: dragging the gradient tool onto an active shape (no selection) fills it as an object gradient, not a raster paint layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();   // rect is now active (shape tools auto-return to select + activate)

  await page.evaluate(() => window.__ed.setToolOptions({ gradientStops: [
    { offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' },
  ] }));
  await page.evaluate(() => window.__ed.setTool('gradient'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);

  const result = await page.evaluate(() => {
    const objs = window.__ed.fc.getObjects();
    const rect = objs.find(o => o.type === 'rect');
    return {
      objectCount: objs.length,   // must stay 1 — no paint layer was created for this drag
      hasPaintLayer: objs.some(o => o.role === 'paint'),
      fillType: typeof rect.fill === 'object' ? rect.fill.type : null,
      stops: (rect.fill.colorStops || []).map(s => s.color),
    };
  });
  assert.equal(result.objectCount, 1);
  assert.equal(result.hasPaintLayer, false);
  assert.equal(result.fillType, 'linear');
  assert.deepEqual(result.stops, ['#ff0000', '#0000ff']);
});

test('browser: gradient tool falls back to raster paint when there IS a pixel selection, even with an object active', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();

  // Draw a marquee selection — Editor#setTool('marquee') itself doesn't touch the rect's active
  // state, but a fabric selectable=false object can't stay "active" once a non-select tool takes
  // over pointer handling; what matters here is only that ed.selection is truthy at drag time.
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => !!window.__ed.selection));

  await page.evaluate(() => window.__ed.setToolOptions({ gradientStops: [{ offset: 0, color: '#00ff00' }, { offset: 1, color: '#ffff00' }] }));
  await page.evaluate(() => window.__ed.setTool('gradient'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);

  const hasPaintLayer = await page.evaluate(() => window.__ed.fc.getObjects().some(o => o.role === 'paint'));
  assert.equal(hasPaintLayer, true);   // a selection present means raster mode, not object-local mode
});

/* ── typography: setTextProps/getTextProps act only on text objects ──────────────────────── */
/* ── layer masks: paintable, non-destructive, image/paint-role layers only ───────────────────── */
/* ── adjustment layers: non-destructive, affect everything below their z-index ───────────────── */
test('browser: an adjustment layer darkens a shape below it, and no-ops on layers above', async () => {
  // A bright rect below where the adjustment layer will sit
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const beforeAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.deepEqual(beforeAlpha.slice(0, 3), [255, 255, 255]);   // white rect, unmodified

  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));   // darken everything below
  await page.waitForTimeout(50);
  const afterAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.ok(afterAlpha[0] < 255, `expected darkened red channel, got ${afterAlpha[0]}`);

  // A second rect added ABOVE the adjustment layer must render unaffected (still pure white)
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 350, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  await page.waitForTimeout(50);
  const aboveAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(300, 100, 1, 1).data);
  });
  assert.deepEqual(aboveAlpha.slice(0, 3), [255, 255, 255]);   // untouched — it's above the adjustment layer
});

test('browser: setAdjustmentParams updates the effect live, and stacking two adjustment layers composes', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const adjId1 = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 80 }));
  await page.waitForTimeout(50);
  const oneAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);

  await page.evaluate((id) => window.__ed.setAdjustmentParams(id, { brightness: 50 }), adjId1);
  await page.waitForTimeout(50);
  const strongerAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(strongerAlpha < oneAdjAlpha, 'a lower brightness value should darken further');

  // stack a second adjustment layer on top — should darken further still (composes with the first)
  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);
  const twoAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(twoAdjAlpha < strongerAlpha, 'two stacked adjustment layers should darken more than one');
});

test('browser: an adjustment layer survives undo/redo and stays live after reordering', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  const adjId = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);

  const darkenedAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(darkenedAlpha < 255);

  await page.evaluate(() => window.__ed.undo());   // undoes addAdjustmentLayer
  await page.waitForTimeout(150);
  const afterUndoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterUndoAlpha, 255);   // adjustment layer gone, rect is full white again

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterRedoAlpha, darkenedAlpha);   // adjustment layer (and its params) restored exactly

  const params = await page.evaluate((id) => window.__ed.getAdjustmentParams(id), adjId);
  assert.equal(params.brightness, 50);
});

test('browser: addMask creates a blank mask that has no visual effect until painted', async () => {
  // A paint-role layer is the simplest maskable target to set up in this fixture (no image load).
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);

  const beforeAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
  assert.ok(beforeAlpha > 0);   // the brush stroke painted something opaque here

  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  const afterAddAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
  assert.equal(afterAddAlpha, beforeAlpha);   // a fresh mask is fully-visible: no change yet

  const hasMaskCanvas = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, paintId);
  assert.equal(hasMaskCanvas, true);
});

test('browser: painting black into a mask hides the layer under the brush, white reveals it again', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);

  // paint black (hide) over the middle of the stroke
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const hiddenAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
  assert.equal(hiddenAlpha, 0);   // fully masked out at the painted spot

  // paint white (reveal) back over the same spot
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#ffffff' }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const revealedAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
  assert.ok(revealedAlpha > 200);   // back to (near-)fully visible

  await page.evaluate(() => window.__ed.exitMaskEdit());
});

test('browser: setMaskEnabled(false) restores full visibility without discarding the painted mask', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const maskedAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(maskedAlpha, 0);

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, false), paintId);
  const disabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(disabledAlpha > 200);   // disabling shows the full layer again

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, true), paintId);
  const reenabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(reenabledAlpha, 0);   // re-enabling brings back the SAME painted mask, not a blank one
});

test('browser: removeMask restores full visibility and addMask/removeMask no-op on non-maskable layers', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectId = await page.evaluate(() => window.__ed.fc.getObjects()[0].id);
  await page.evaluate((id) => window.__ed.addMask(id), rectId);
  const rectHasMask = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, rectId);
  assert.equal(rectHasMask, false);   // a vector shape (role 'shape') is not maskable in v1

  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 360, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 330, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());
  await page.evaluate((id) => window.__ed.removeMask(id), paintId);
  const afterRemove = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return { hasMaskCanvas: !!o.maskCanvas, alpha: o._element.getContext('2d').getImageData(330, 100, 1, 1).data[3] };
  }, paintId);
  assert.equal(afterRemove.hasMaskCanvas, false);
  assert.ok(afterRemove.alpha > 200);   // removing the mask restores full visibility
});

test('browser: a painted mask survives undo/redo (Fabric filter fromObject round-trip)', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const beforeUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(beforeUndoAlpha, 0);

  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(150);   // restore()/loadFromJSON + the mask filter's own async fromObject
  const afterUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(afterUndoAlpha > 200);   // back to before the mask stroke (mask still present, just unpainted there)

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(afterRedoAlpha, 0);   // the painted-black mask stroke is back
});

test('browser: setTextProps edits a text layer and no-ops on a shape', async () => {
  await page.evaluate(() => window.__ed.setTool('type'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);
  await page.waitForTimeout(50);
  await page.keyboard.type('Hi');
  await page.evaluate(() => window.__ed.fc.getActiveObject().exitEditing());
  await page.evaluate(() => window.__ed.setTool('select'));
  await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(x => x.type === 'i-text'); window.__ed.fc.setActiveObject(o); });

  await page.evaluate(() => window.__ed.setTextProps({ fontFamily: 'Georgia, serif', fontSize: 60, fontWeight: 700, fontStyle: 'italic', textAlign: 'center', underline: true }));
  const props = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(props.fontFamily, 'Georgia, serif');
  assert.equal(props.fontSize, 60);
  assert.equal(props.fontWeight, 700);
  assert.equal(props.fontStyle, 'italic');
  assert.equal(props.textAlign, 'center');
  assert.equal(props.underline, true);

  // no-op on a non-text shape: getTextProps() returns null, setTextProps() does nothing
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 250, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectTextProps = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(rectTextProps, null);
});

/* ── cv vendoring: the OpenCV worker actually boots from the vendored asset, not a CDN ──── */
test('browser: the OpenCV worker boots from the vendored opencv.js (offline-safe)', async () => {
  const ready = await page.evaluate(async () => {
    const booted = await window.__ed.cv._boot();
    return { booted, url: window.__ed.cv._openCvUrl };
  });
  assert.equal(ready.booted, true);
  assert.ok(ready.url.includes('/packages/core/vendor/opencv/opencv.js'));
  assert.ok(ready.url.startsWith('http://'));   // resolved to an absolute URL, not left root-relative
});

/* ── Design-tab fills: fillWithColor / fillWithImage / extendBackgroundToCanvas ──────────── */
test('browser: fillWithColor paints the whole canvas when there is no selection', async () => {
  const px = await page.evaluate(() => {
    window.__ed.fillWithColor('#ff0000');
    const ctx = window.__ed.engine.ctx;
    return [...ctx.getImageData(5, 5, 1, 1).data];
  });
  assert.deepEqual(px, [255, 0, 0, 255]);
});

test('browser: fillWithColor is clipped to the active selection', async () => {
  const px = await page.evaluate(() => {
    window.__ed.selection = { kind: 'rect', x: 0, y: 0, w: 20, h: 20 };
    window.__ed.fillWithColor('#00ff00');
    const ctx = window.__ed.engine.ctx;
    const inside = [...ctx.getImageData(5, 5, 1, 1).data];
    const outside = [...ctx.getImageData(150, 150, 1, 1).data];
    return { inside, outside };
  });
  assert.deepEqual(px.inside, [0, 255, 0, 255]);
  assert.deepEqual(px.outside, [0, 0, 0, 0]);
});

test('browser: fillWithImage stamps a bitmap into the fill region', async () => {
  const px = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const cx = c.getContext('2d'); cx.fillStyle = '#0000ff'; cx.fillRect(0, 0, 10, 10);
    await window.__ed.fillWithImage(c.toDataURL());
    const ctx = window.__ed.engine.ctx;
    return [...ctx.getImageData(100, 100, 1, 1).data];
  });
  assert.deepEqual(px, [0, 0, 255, 255]);
});

/* ── addImageLayer 'contain' fit must scale a smaller-than-artboard image UP as well as a
   larger one down — a stray Math.min(1, ...) clamp previously made it only ever scale down,
   so a small image dropped onto a big artboard stayed tiny in the corner instead of filling
   the frame (reported as "image fit to frame not working"). Matches the reference editor's own
   makeObj, which has no such clamp: scale = Math.min(slotW/imgW, slotH/imgH), full stop. ────── */
test('browser: addImage with the default \'contain\' fit scales a SMALLER-than-artboard image up to fit it', async () => {
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    const img = await window.__ed.addImage(c.toDataURL());
    return { scaleX: img.scaleX, scaleY: img.scaleY, renderedW: img.width * img.scaleX, renderedH: img.height * img.scaleY, W: window.__ed.W, H: window.__ed.H };
  });
  // 400x300 artboard, 20x20 image: scale = min(400/20, 300/20) = min(20, 15) = 15
  assert.equal(result.scaleX, 15);
  assert.equal(result.scaleY, 15);
  assert.equal(result.renderedH, result.H);   // touches the artboard's shorter edge exactly
  assert.ok(result.renderedW <= result.W);
});

test('browser: extendBackgroundToCanvas scales the background image to cover the artboard', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const noImage = ed.extendBackgroundToCanvas();
    const c = document.createElement('canvas'); c.width = 50; c.height = 50;
    const cx = c.getContext('2d'); cx.fillStyle = '#ff00ff'; cx.fillRect(0, 0, 50, 50);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    const ok = ed.extendBackgroundToCanvas();
    const after = ed.fc.getObjects().find(o => o.role === 'bg');
    return { noImage, ok, scaleX: after.scaleX, scaleY: after.scaleY, left: after.left, top: after.top };
  });
  assert.equal(result.noImage, false);
  assert.equal(result.ok, true);
  assert.ok(result.scaleX >= 400 / 50 - 0.001);   // covers the 400x300 test artboard from a 50x50 source
  assert.ok(result.scaleY >= 400 / 50 - 0.001);
});

/* ── ad-copy layers (adtext.js via editor.js's addCTA/addBadge/addPrice/addBrandLockup) ──────── */
test('browser: addCTA builds a pill group sized to its own label, with a readable ink color', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addCTA(null, { text: 'Buy now', size: 20, fill: '#111114' });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { role: o.role, name: o.name, type: o.type, childCount: o._objects.length, width: o.width, height: o.height };
  });
  assert.equal(info.role, 'cta');
  assert.equal(info.name, 'CTA');
  assert.equal(info.type, 'group');
  assert.equal(info.childCount, 3);   // pill rect + label text + arrow glyph
  assert.ok(info.width > 0 && info.height > 0);
});

test('browser: addBadge uppercases its text and omits nothing — role/name/group shape', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addBadge(null, { text: 'sale', size: 16 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    const label = o._objects[1];
    return { role: o.role, name: o.name, childCount: o._objects.length, labelText: label.text };
  });
  assert.equal(info.role, 'badge');
  assert.equal(info.name, 'Badge');
  assert.equal(info.childCount, 2);   // pill rect + label text
  assert.equal(info.labelText, 'SALE');
});

test('browser: addPrice includes the strikethrough original and savings text only when given', async () => {
  const withAll = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addPrice(null, { current: '$40', original: '$60', save: 'Save 33%', size: 24 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { childCount: o._objects.length, linethrough: o._objects[1].linethrough, texts: o._objects.map(c => c.text) };
  });
  assert.equal(withAll.childCount, 3);
  assert.equal(withAll.linethrough, true);
  assert.deepEqual(withAll.texts, ['$40', '$60', 'Save 33%']);

  const currentOnly = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addPrice(null, { current: '$40', size: 24 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return o._objects.length;
  });
  assert.equal(currentOnly, 1);
});

test('browser: addBrandLockup builds a mark + lowercase initial + name, mark fill matches the given color', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addBrandLockup(null, { text: 'Acme', color: '#2f6df0', size: 18 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    const [mark, letter, name] = o._objects;
    return { role: o.role, markFill: mark.fill, letterText: letter.text, nameText: name.text };
  });
  assert.equal(info.role, 'brand');
  assert.equal(info.markFill, '#2f6df0');
  assert.equal(info.letterText, 'a');   // lowercased first letter of "Acme"
  assert.equal(info.nameText, 'Acme');
});

test('browser: layerLabel shows the ad-copy layer\'s own name, not its Fabric Group child count', async () => {
  const label = await page.evaluate(async () => {
    const { layerLabel } = await import('/packages/core/src/index.js');
    const ed = window.__ed;
    const id = ed.addCTA(null, { text: 'Go' });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return layerLabel(o);
  });
  assert.equal(label, 'CTA');   // NOT "3 layers" (the generic Group fallback)
});

/* ── stickers (stickers.js via editor.js's addSticker) — ported ditto reference categories:
   sale bursts, price tags, corner ribbon, extra arrow rotations, and baked-text badge/tag/
   banner/burst variants (kind: 'group', shape + centered IText label). ──────────────────────── */
test('browser: every STICKER_GROUPS key places without error and resolves a real stickerSpec', async () => {
  const result = await page.evaluate(async () => {
    const { STICKER_GROUPS, stickerSpec } = await import('/packages/core/src/index.js');
    const ed = window.__ed;
    const missing = [];
    const failed = [];
    STICKER_GROUPS.forEach(g => g.keys.forEach(key => {
      if (!stickerSpec(key)) { missing.push(key); return; }
      const id = ed.addSticker(key);
      if (!id || !ed.fc.getObjects().find(o => o.id === id)) failed.push(key);
    }));
    return { missing, failed, groupCount: STICKER_GROUPS.length };
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.failed, []);
  assert.ok(result.groupCount >= 6);   // sale bursts, badges&tags, ribbons&banners, price tags, arrows, accents
});

test('browser: a plain (non-text) sticker is a single recolorable shape, not a group', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addSticker('burst12');
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { type: o.type, role: o.role, name: o.name, fill: o.fill };
  });
  assert.notEqual(info.type, 'group');
  assert.equal(info.role, 'shape');
  assert.equal(info.name, 'Sticker');
  assert.ok(info.fill);   // recolorable — has the palette's first fill applied directly
});

test('browser: a baked-text sticker (kind: \'group\') places its named base shape + a centered, auto-contrast IText label', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addSticker('burstText');
    const o = ed.fc.getObjects().find(x => x.id === id);
    const label = o._objects.find(c => c.type === 'i-text');
    const shape = o._objects.find(c => c.type !== 'i-text');
    return { type: o.type, role: o.role, childCount: o._objects.length, labelText: label && label.text, labelFill: label && label.fill, shapeType: shape && shape.type };
  });
  assert.equal(info.type, 'group');
  assert.equal(info.role, 'shape');
  assert.equal(info.childCount, 2);
  assert.equal(info.labelText, 'SALE');
  assert.equal(info.shapeType, 'polygon');   // burst12's own base shape kind
  assert.ok(info.labelFill === '#0c0c0e' || info.labelFill === '#ffffff');   // real contrast pick, not a placeholder
});

test('browser: new ported shapes (burst/tag/swing/corner/arrowCurve/rotated arrows) all resolve valid specs', async () => {
  const kinds = await page.evaluate(async () => {
    const { stickerSpec } = await import('/packages/core/src/index.js');
    return ['burst8', 'burst12', 'burst16', 'tag', 'swing', 'corner', 'arrowCurve', 'arrowUp', 'arrowDown', 'arrowLeft'].map(k => {
      const s = stickerSpec(k); return s ? s.kind : null;
    });
  });
  assert.ok(kinds.every(k => k === 'polygon' || k === 'path'));
});

/* ── promo layout (templates.js via editor.js's applyPromoLayout) ────────────────────────────── */
test('browser: applyPromoLayout replaces the composition with a real hero/sale/centered layer stack', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    await ed.applyPromoLayout({ layout: 'centered', head: 'Big Sale', sub: 'This week only', cta: 'Shop now', brand: 'Acme' });
    const objs = ed.fc.getObjects();
    return {
      count: objs.length,
      roles: objs.map(o => o.role),
      headlineText: objs.find(o => o.role === 'headline').text,
      bgLocked: objs.find(o => o.role === 'bg').locked,
    };
  });
  assert.ok(result.roles.includes('bg'));
  assert.ok(result.roles.includes('brand'));
  assert.ok(result.roles.includes('headline'));
  assert.ok(result.roles.includes('sub'));
  assert.ok(result.roles.includes('cta'));
  assert.ok(result.roles.includes('product'));
  assert.equal(result.headlineText, 'Big Sale');
  assert.equal(result.bgLocked, true);
});

test('browser: applyPromoLayout replacing the composition is a single undoable history step', async () => {
  const depths = await page.evaluate(async () => {
    const ed = window.__ed;
    ed.fc.getObjects().slice().forEach(o => ed.fc.remove(o));
    ed.commit('clear');
    const before = ed.history.depth();
    await ed.applyPromoLayout({ layout: 'sale', head: 'Flash sale' });
    const after = ed.history.depth();
    ed.undo();
    await new Promise(r => setTimeout(r, 50));
    const objRolesAfterUndo = ed.fc.getObjects().map(o => o.role);
    return { before: before.past, after: after.past, objRolesAfterUndo };
  });
  assert.equal(depths.after, depths.before + 1);   // one commit for the whole layout, not one per layer
  assert.deepEqual(depths.objRolesAfterUndo, []);   // undo restores the pre-layout (empty) canvas
});

test('browser: applyPromoLayout auto-fits the headline text to its slot height when maxH is exceeded', async () => {
  const sizes = await page.evaluate(async () => {
    const ed = window.__ed;
    // A tiny artboard forces the hero headline's font size well past what its own maxH slot
    // (derived from W*0.115 in templates.js's hero branch) can hold at the nominal W*0.088 size.
    await ed.applyPromoLayout({ layout: 'hero', head: 'A very long headline that must shrink to fit' }, );
    const headline = ed.fc.getObjects().find(o => o.role === 'headline');
    return { fontSize: headline.fontSize, height: headline.height };
  });
  // No hard assertion on the exact shrunk size (depends on font metrics), just that autoFitText
  // actually ran and produced a renderable, non-degenerate textbox.
  assert.ok(sizes.fontSize >= 9);
  assert.ok(sizes.height > 0);
});

/* ── AI: mask-guided background swap/extend, non-destructive (only the bg layer's pixels swap —
   every other layer in the composition survives, unlike the old whole-scene openImageResult
   contract these two methods used before) ──────────────────────────────────────────────────── */
test('browser: aiBgSwap with no selection asks magicEdit with no mask, and swaps only the bg layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    // a small red bg image + an unrelated shape layer on top, to prove the shape survives
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 40, 40);
    const bg = await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    ed.setTool('rect');
    // place a marker shape via the API directly (avoids a real pointer drag in this test)
    const shape = new ed.fabric.Rect({ left: 10, top: 10, width: 20, height: 20, fill: '#00ff00' });
    shape.set({ id: 'marker', role: 'shape', name: 'Marker' });
    ed.fc.add(shape);
    ed.setTool('select');

    let calls = [];
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      calls.push({ hasImage: !!imageDataURL, instruction, maskDataURL });
      const out = document.createElement('canvas'); out.width = 40; out.height = 40;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, 40, 40);
      return out.toDataURL('image/png');
    } });

    const r = await ed.aiBgSwap('a blue sky');
    const objs = ed.fc.getObjects();
    const newBg = objs.find(o => o.id === bg.id);
    const ctx = newBg._element.getContext ? newBg._element.getContext('2d') : null;
    return {
      status: r.status,
      callCount: calls.length,
      maskDataURL: calls[0] && calls[0].maskDataURL,
      instruction: calls[0] && calls[0].instruction,
      markerSurvived: objs.some(o => o.id === 'marker'),
      objectCount: objs.length,
      bgIdentityKept: newBg.role === 'bg' && newBg.name === 'Background',
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.callCount, 1);
  assert.equal(result.maskDataURL, undefined);   // no selection → magicEdit called with only (image, instruction)
  assert.ok(result.instruction.includes('a blue sky'));
  assert.equal(result.markerSurvived, true);   // the unrelated shape layer was NOT wiped
  assert.equal(result.objectCount, 2);         // bg + marker, nothing added/removed besides the swap
  assert.equal(result.bgIdentityKept, true);   // same role/name — the swap preserved layer identity
});

test('browser: aiBgSwap with an active selection passes a real white=editable/black=protect mask', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 40, 40);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    ed.selection = { kind: 'rect', x: 5, y: 5, w: 10, h: 10 };

    let capturedMask = null;
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      capturedMask = maskDataURL;
      const out = document.createElement('canvas'); out.width = 40; out.height = 40;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, 40, 40);
      return out.toDataURL('image/png');
    } });

    await ed.aiBgSwap('a sunset');
    // decode the captured mask and sample inside vs. outside the selection rect
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = capturedMask; });
    const mc = document.createElement('canvas'); mc.width = 40; mc.height = 40;
    const mctx = mc.getContext('2d'); mctx.drawImage(img, 0, 0);
    const inside = mctx.getImageData(10, 10, 1, 1).data;    // inside the selection rect (5,5,10,10)
    const outside = mctx.getImageData(30, 30, 1, 1).data;   // outside it
    return { hadMask: !!capturedMask, inside: [inside[0], inside[1], inside[2]], outside: [outside[0], outside[1], outside[2]], selectionCleared: !ed.selection };
  });
  assert.equal(result.hadMask, true);
  assert.deepEqual(result.inside, [0, 0, 0]);      // black = protected (selected subject)
  assert.deepEqual(result.outside, [255, 255, 255]); // white = editable background
  assert.equal(result.selectionCleared, true);
});

test('browser: aiExtendBackground reports no_gap without calling the AI when the bg already fills the canvas', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    let called = false;
    ed.ai.register({ async magicEdit() { called = true; return null; } });
    const r = await ed.aiExtendBackground();
    return { status: r.status, reason: r.reason, called };
  });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'no_gap');
  assert.equal(result.called, false);   // the gap check short-circuits before any AI call
});

/* ── region review: commitRegions maps a detected region's type to its committed layer's ROLE
   via REGION_ROLE (text -> headline, sticker -> decorative, others pass through unchanged), and
   stores the original detected type separately on regionType so it survives serialization. ──── */
test('browser: commitRegions maps region types to layer roles via REGION_ROLE, keeping the original type on regionType', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const regions = [
      { type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } },
      { type: 'logo', bbox: { x: 30, y: 5, width: 15, height: 15 } },
      { type: 'text', bbox: { x: 5, y: 30, width: 40, height: 10 }, content: 'Big Sale' },
      { type: 'sticker', bbox: { x: 50, y: 30, width: 10, height: 10 } },
      { type: 'decorative', bbox: { x: 65, y: 30, width: 10, height: 10 } },
    ];
    const r = await ed.commitRegions(flat, regions);
    const byRegionType = (t) => ed.fc.getObjects().find(o => o.regionType === t);
    return {
      status: r.status,
      count: r.result,
      productRole: byRegionType('product') && byRegionType('product').role,
      logoRole: byRegionType('logo') && byRegionType('logo').role,
      textRole: byRegionType('text') && byRegionType('text').role,
      textContent: byRegionType('text') && byRegionType('text').text,
      stickerRole: byRegionType('sticker') && byRegionType('sticker').role,
      decorativeRole: byRegionType('decorative') && byRegionType('decorative').role,
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 5);
  assert.equal(result.productRole, 'product');       // passes through unchanged
  assert.equal(result.logoRole, 'logo');              // passes through unchanged
  assert.equal(result.textRole, 'headline');          // text -> headline
  assert.equal(result.textContent, 'Big Sale');
  assert.equal(result.stickerRole, 'decorative');     // sticker -> decorative
  assert.equal(result.decorativeRole, 'decorative');  // already decorative
});

/* ── commitRegions must apply a text region's `style` (fontSize/color/textAlign/fontWeight) to the
   resulting text layer, and store it back on the layer as `rstyle` so it survives an extract/merge
   round-trip — regression test for style being silently dropped (only a box-height-derived default
   fontSize was ever applied, color/align/weight were always ignored). ──── */
test('browser: commitRegions applies a text region\'s style (fontSize/color/textAlign/fontWeight) to the layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const style = { fontSize: 40, color: '#ff0000', textAlign: 'center', fontWeight: 'bold' };
    const r = await ed.commitRegions(flat, [
      { type: 'text', bbox: { x: 5, y: 5, width: 40, height: 10 }, content: 'Styled', style },
    ]);
    const layer = ed.fc.getObjects().find(o => o.regionType === 'text');
    return {
      status: r.status, W: ed.W,
      fill: layer && layer.fill,
      textAlign: layer && layer.textAlign,
      fontWeight: layer && layer.fontWeight,
      fontSize: layer && layer.fontSize,
      rstyle: layer && layer.rstyle,
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.fill, '#ff0000');
  assert.equal(result.textAlign, 'center');
  assert.equal(result.fontWeight, 700);
  assert.equal(result.fontSize, Math.max(12, Math.round(40 * (result.W / 1080))));
  assert.deepEqual(result.rstyle, { fontSize: 40, color: '#ff0000', textAlign: 'center', fontWeight: 'bold' });
});

/* ── commitRegions must play a staggered "layer reveal" animation afterward (each new layer rises
   + fades in) instead of popping the whole composition in instantly with no feedback tying a layer
   to the region it came from — regression test for the animation being entirely absent. Checking
   the full tween would be timing-flaky, so this only asserts the observable contract right after
   commit: new layers start hidden (opacity 0, animateLayersIn's initial state) rather than already
   at full opacity, and settle back to full opacity once the animation completes. ──── */
test('browser: commitRegions plays a staggered reveal — new layers start hidden then fade back in', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    await ed.commitRegions(flat, [{ type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } }]);
    const layer = ed.fc.getObjects().find(o => o.regionType === 'product');
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    const immediately = { layerOpacity: layer.opacity, bgOpacity: bg.opacity };
    await new Promise(r => setTimeout(r, 2200));   // outlast the reveal's longest tween (~1280ms + delay)
    const settled = { layerOpacity: layer.opacity, bgOpacity: bg.opacity, layerShadow: layer.shadow };
    return { immediately, settled };
  });
  assert.equal(result.immediately.layerOpacity, 0);
  assert.equal(result.settled.layerOpacity, 1);
  assert.equal(result.settled.bgOpacity, 1);
  assert.equal(result.settled.layerShadow, null);
});

/* ── detectObjects must fall back to a local (no-OpenCV) blob detector when the cv worker returns
   nothing, instead of reporting 'no_match' even though there's an obvious foreground shape on the
   canvas — regression test for the missing local-detection fallback. Stubs ed.cv.detect to always
   return null (as if the worker/WASM never loaded) so the fallback path is exercised
   deterministically, then paints an actual high-contrast rect so the blob detector has something
   real to find. ──── */
test('browser: detectObjects falls back to a local blob detector when the cv worker finds nothing', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 220, canvasBox.y + 170, { steps: 4 });
  await page.mouse.up();
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const o = ed.fc.getObjects().find(x => x.type === 'rect');
    if (o) o.set({ fill: '#ff2222' });
    ed.fc.renderAll();
    const realCv = ed.cv;
    ed.cv = { ...realCv, detect: async () => null };
    const r = await ed.detectObjects();
    ed.cv = realCv;
    return r;
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.result.boxes.length > 0);
});

/* ── cutoutRegion's `bgMode` ('auto'/'cheap'/'best') must actually change the working resolution
   passed into the cv worker instead of being a fully inert UI setting — regression test for the
   "Clean background" picker doing nothing regardless of which mode was selected. Stubs
   ed.cv.grabcut to capture the ImageData it's called with instead of running real OpenCV. ──── */
test('browser: cutoutRegion varies working resolution by bgMode (cheap < auto < best)', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const widths = {};
    ed.cv = { grabcut: async (img) => { widths.last = img.width; return [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]; } };
    // Use a source much larger than all three resolution caps (600/900/1200) so downscaling
    // actually differs per mode — the editor's own W/H (400x300 in this fixture) is too small and
    // would clamp every mode to the same 1:1 scale, masking the bug this test guards against.
    const c = document.createElement('canvas'); c.width = 2000; c.height = 1500;
    c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, 2000, 1500);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const box = { x: 10, y: 10, w: 80, h: 80 };
    await ed.cutoutRegion(img, box, 'cheap'); const cheapW = widths.last;
    await ed.cutoutRegion(img, box, 'auto'); const autoW = widths.last;
    await ed.cutoutRegion(img, box, 'best'); const bestW = widths.last;
    ed.cv = realCv;
    return { cheapW, autoW, bestW };
  });
  assert.ok(result.cheapW < result.autoW, `cheap (${result.cheapW}) should be lower-res than auto (${result.autoW})`);
  assert.ok(result.autoW < result.bestW, `auto (${result.autoW}) should be lower-res than best (${result.bestW})`);
});

/* ── commitRegions must NOT wipe layers the user already had on the canvas before running
   convert-to-layers — only the old background and leftover review-box overlays. Regression test
   for the bug where commitRegions removed every object unconditionally, silently destroying any
   hand-placed text/logo/sticker the user added before clicking "Convert to layers". ──── */
test('browser: commitRegions preserves pre-existing non-background layers instead of wiping the whole canvas', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const preExistingId = ed.addCTA({ x: 100, y: 100 });
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const r = await ed.commitRegions(flat, [{ type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } }]);
    return {
      status: r.status,
      preExistingSurvived: !!ed.fc.getObjects().find(o => o.id === preExistingId),
      newRegionPresent: !!ed.fc.getObjects().find(o => o.regionType === 'product'),
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.preExistingSurvived, true);
  assert.equal(result.newRegionPresent, true);
});

/* ── objectPickInImage (the review step's "Object select" tool) must fall back to a box-seeded
   GrabCut when the colour wand finds nothing (e.g. a low-contrast subject), instead of giving up
   immediately — regression test for the missing fallback (wand-only, no grabcut retry). Stubs
   ed.cv.wand/grabcut directly so the test is deterministic and doesn't depend on real image
   content or a live OpenCV worker. ──── */
test('browser: objectPickInImage falls back to box-seeded grabCut when the colour wand finds nothing', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const calls = [];
    const realCv = ed.cv;
    ed.cv = {
      wand: async (img, seed) => { calls.push('wand'); return []; },
      grabcut: async (img, seed, work) => { calls.push('grabcut'); return [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }]; },
    };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const poly = await ed.objectPickInImage(img, { x: ed.W / 2, y: ed.H / 2 }, 32);
    ed.cv = realCv;
    return { calls, polyLen: poly ? poly.length : 0 };
  });
  assert.deepEqual(result.calls, ['wand', 'grabcut']);
  assert.equal(result.polyLen, 3);
});

test('browser: objectPickInImage returns null when both wand and the grabCut fallback fail', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    ed.cv = { wand: async () => [], grabcut: async () => null };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const poly = await ed.objectPickInImage(img, { x: ed.W / 2, y: ed.H / 2 }, 32);
    ed.cv = realCv;
    return { poly };
  });
  assert.equal(result.poly, null);
});

test('browser: commitRegions\' regionType survives an undo/redo round-trip (serialized via io.js EXTRA)', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    await ed.commitRegions(c.toDataURL('image/png'), [{ type: 'sticker', bbox: { x: 10, y: 10, width: 20, height: 20 } }]);
    ed.undo();
    await new Promise(r => setTimeout(r, 50));
    ed.redo();
    await new Promise(r => setTimeout(r, 50));
    const layer = ed.fc.getObjects().find(o => o.regionType === 'sticker');
    return { found: !!layer, role: layer && layer.role };
  });
  assert.equal(result.found, true);
  assert.equal(result.role, 'decorative');
});

/* ── objectselect click accuracy: the reference editor filters detected boxes by point-containment
   (smallest first) and scopes its grabCut refine to that box, instead of flood-filling from the
   exact clicked pixel with no idea what object is under it — that's what made canvasmith's version
   grab the wrong region on a busy/nested image. Stub cv.wand/grabcut/detect so this is deterministic. */
test('browser: selectObjectAt picks the smallest detected box containing the click and scopes grabCut to it', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const workRects = [];
    ed.cv = {
      wand: async () => [],   // force the grabCut fallback so `work` is observable
      grabcut: async (img, seed, work) => { workRects.push(work); return [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]; },
    };
    // A small nested box (the "real" target) inside a big background box — both contain the click.
    ed._objBoxes = [{ x: 0, y: 0, w: ed.W, h: ed.H }, { x: 40, y: 40, w: 20, h: 20 }];
    ed._objRegion = { left: 0, top: 0, width: ed.W, height: ed.H };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    ed._objSrc = c;
    const r = await ed.selectObjectAt({ x: 50, y: 50 });
    ed.cv = realCv;
    return { status: r.status, workRects, sel: ed.selection };
  });
  assert.equal(result.status, 'ok');
  // work rect must be scoped small (the 20x20 nested box), not the full-canvas background box.
  assert.ok(result.workRects[0].w < 40 && result.workRects[0].h < 40);
  assert.equal(result.sel.kind, 'poly');
});

test('browser: re-clicking the same spot on objectselect cycles to the next larger nested candidate', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const works = [];
    ed.cv = {
      wand: async () => [],
      grabcut: async (img, seed, work) => { works.push(work); return [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]; },
    };
    ed._objBoxes = [{ x: 0, y: 0, w: ed.W, h: ed.H }, { x: 40, y: 40, w: 20, h: 20 }];
    ed._objRegion = { left: 0, top: 0, width: ed.W, height: ed.H };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    ed._objSrc = c;
    await ed.selectObjectAt({ x: 50, y: 50 }, { cycle: true });
    await ed.selectObjectAt({ x: 50, y: 50 }, { cycle: true });   // same spot again → cycle to the bigger box
    ed.cv = realCv;
    return { firstSmall: works[0].w < 40, secondBig: works[1].w > 40 };
  });
  assert.equal(result.firstSmall, true);
  assert.equal(result.secondBig, true);
});

test('browser: objectselect Shift-click accumulates a multipoly (no auto-union) and mergeObjectSelection unions it', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const polyA = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
    const polyB = [{ x: 40, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 30 }, { x: 40, y: 30 }];
    await ed._commitObjectPoly(polyA, {});
    const afterFirst = { kind: ed.selection.kind, multiCount: ed.multiCount };
    await ed._commitObjectPoly(polyB, { add: true });
    const afterAdd = { kind: ed.selection.kind, multiCount: ed.multiCount, polyCount: ed.selection.polys.length };
    ed.cv = { union: async (W, H, polys) => [polys[0].concat(polys[1])] };   // stubbed union of the two
    const r = await ed.mergeObjectSelection();
    ed.cv = realCv;
    return { afterFirst, afterAdd, mergeStatus: r.status, afterMerge: { kind: ed.selection.kind, multiCount: ed.multiCount } };
  });
  assert.equal(result.afterFirst.kind, 'poly');
  assert.equal(result.afterFirst.multiCount, 1);
  // Shift-click add must NOT auto-union — stays a multipoly of 2 separate polys until Merge runs.
  assert.equal(result.afterAdd.kind, 'multipoly');
  assert.equal(result.afterAdd.multiCount, 2);
  assert.equal(result.afterAdd.polyCount, 2);
  assert.equal(result.mergeStatus, 'ok');
  assert.equal(result.afterMerge.multiCount, 1);
});

test('browser: aiExtendBackground passes a real white=empty/black=filled gap mask and swaps only the bg layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    // a bg image smaller than the artboard, placed at the origin, so most of the canvas is gap
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    const bg = await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });

    let capturedMask = null;
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      capturedMask = maskDataURL;
      const out = document.createElement('canvas'); out.width = ed.W; out.height = ed.H;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, ed.W, ed.H);
      return out.toDataURL('image/png');
    } });

    const r = await ed.aiExtendBackground();
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = capturedMask; });
    const mc = document.createElement('canvas'); mc.width = ed.W; mc.height = ed.H;
    const mctx = mc.getContext('2d'); mctx.drawImage(img, 0, 0);
    const filled = mctx.getImageData(5, 5, 1, 1).data;     // inside the 20x20 red square = filled
    const empty = mctx.getImageData(300, 200, 1, 1).data;  // well outside it = still empty canvas
    const newBg = ed.fc.getObjects().find(o => o.id === bg.id);
    return { status: r.status, filled: [filled[0], filled[1], filled[2]], empty: [empty[0], empty[1], empty[2]], bgSwapped: newBg.id === bg.id && newBg.type === 'image' };
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.filled, [0, 0, 0]);        // black = real pixels, leave alone
  assert.deepEqual(result.empty, [255, 255, 255]);   // white = empty gap, the model may fill it
  assert.equal(result.bgSwapped, true);
});

/* ── objectselect keybindings: [ / ] tolerance scrub and Escape-to-deselect, matching the
   reference editor's own bindings for this tool (installKeybindings.js already wires both
   generically — these confirm they actually reach objectselect specifically). ──────────────── */
test('browser: [ / ] scrubs tolerance while objectselect is active', async () => {
  await page.evaluate(() => { window.__ed.setTool('objectselect'); window.__ed.setToolOptions({ tolerance: 32 }); });
  await page.keyboard.press(']');
  assert.equal(await page.evaluate(() => window.__ed.toolOpts.tolerance), 36);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  assert.equal(await page.evaluate(() => window.__ed.toolOpts.tolerance), 28);
});

test('browser: Escape clears an objectselect selection', async () => {
  await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    ed.selection = { kind: 'rect', x: 10, y: 10, w: 50, h: 50 };
    ed.multiCount = 1;
    ed._emit('selection', ed.selection);
  });
  assert.ok(await page.evaluate(() => !!window.__ed.selection));
  await page.keyboard.press('Escape');
  const result = await page.evaluate(() => ({ sel: window.__ed.selection, multiCount: window.__ed.multiCount }));
  assert.equal(result.sel, null);
  assert.equal(result.multiCount, 0);   // clearSelection() resets multiCount too — see editor.js
});

/* ── objectselect hover/tool-switch cleanup: leaving the tool must drop hover state so a stale
   in-flight hover RPC can't land after the fact and nothing keeps a preview alive with no tool
   there to clear it (regression: setTool used to only ever ADD hover state, never remove it). ── */
test('browser: switching away from objectselect clears hover point and candidate-cycle state', async () => {
  const result = await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    ed._hoverPt = { x: 10, y: 10 };
    ed._objCycle = { x: 10, y: 10, i: 2 };
    ed.setTool('select');
    return { hoverPt: ed._hoverPt, objCycle: ed._objCycle };
  });
  assert.equal(result.hoverPt, null);
  assert.equal(result.objCycle, null);
});

/* ── regression: a click landing on an already-cached hover-preview mask must still update
   _lastWandSeed (selectSimilar's seed point) — _down used to only set it inside selectObjectAt,
   which a cache-hit skips entirely, leaving Similar searching from a stale earlier click. ──────── */
test('browser: clicking a cached hover-preview mask on objectselect still updates the Similar seed point', async () => {
  const result = await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    const key = ed._hoverCellKey({ x: 120, y: 80 });
    ed._hoverCache.put(key, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]);   // pre-seed the cache
    ed._lastWandSeed = { x: 1, y: 1 };   // a stale earlier click
    return key;
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 120, canvasBox.y + 80);
  const seed = await page.evaluate(() => window.__ed._lastWandSeed);
  assert.equal(seed.x, 120);
  assert.equal(seed.y, 80);
});

/* ── session autosave + reset() ────────────────────────────────────────────────────────────
   The pure-logic half of session.js (quota shedding, corrupt payloads) is covered in
   core.test.mjs; what needs a real browser is the round trip through fabric — that a scene
   serialized out of a live canvas enlivens back into the same objects, and that reset() leaves
   an Editor genuinely blank rather than merely emptied of objects. */

test('browser: an autosaved scene restores into a fresh Editor, photo-sized and all', async () => {
  await page.evaluate(async () => {
    window.__ed.setTool('rect');
    await window.__session.clearSession();
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.resizeCanvas(321, 222));

  // Autosave is debounced; saveNow() is the deterministic equivalent of waiting it out.
  const saved = await page.evaluate(async () => {
    const s = window.__session.installAutosave(window.__ed, { getExtras: () => ({ tray: ['a.png'] }) });
    await s.saveNow();
    const backend = s.backend;
    s.stop();
    return { stored: (await window.__session.readSession()) !== null, backend };
  });
  assert.equal(saved.stored, true);
  // The whole point of the storage layer: a scene with a photo in it cannot live in
  // localStorage (~5MB budget vs. a base64 data URL per image), so IndexedDB must be what
  // actually backs this in a real browser.
  assert.equal(saved.backend, 'idb');

  // A second, independent Editor over a fresh canvas — the "reopened tab" case.
  const restored = await page.evaluate(async () => {
    const el = document.createElement('canvas');
    document.body.appendChild(el);
    const ed2 = new window.__Editor({ fabric: window.fabric, canvasEl: el, width: 400, height: 300 });
    const extras = await window.__session.restoreSession(ed2);
    return {
      types: ed2.fc.getObjects().map(o => o.type),
      W: ed2.W, H: ed2.H,
      tray: extras && extras.tray,
      past: ed2.history.past.length,
    };
  });
  assert.deepEqual(restored.types, ['rect']);
  assert.equal(restored.W, 321);          // the artboard size round-trips, not just the objects
  assert.equal(restored.H, 222);
  assert.deepEqual(restored.tray, ['a.png']);
  // Exactly one baseline entry: undo must not walk back past a restore into the blank canvas
  // that was never the user's document.
  assert.equal(restored.past, 1);
});

test('browser: reset() blanks the document, empties history, and keeps the artboard paintable', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100, { steps: 3 });
  await page.mouse.up();

  const before = await page.evaluate(() => window.__ed.fc.getObjects().length);
  assert.ok(before >= 1);

  const after = await page.evaluate(() => {
    window.__ed.reset({ width: 500, height: 400 });
    return {
      objects: window.__ed.fc.getObjects().length,
      past: window.__ed.history.past.length,
      future: window.__ed.history.future.length,
      W: window.__ed.W, H: window.__ed.H,
      engineW: window.__ed.engine.W, engineH: window.__ed.engine.H,
      // fc.clear() nulls backgroundColor — reset must paint the page back, or the artboard
      // renders as a transparent hole over the void instead of a white page.
      bg: window.__ed.fc.backgroundColor,
      selection: window.__ed.selection,
    };
  });
  assert.equal(after.objects, 0);
  assert.equal(after.past, 1);            // a single blank baseline, like a fresh Editor
  assert.equal(after.future, 0);
  assert.equal(after.W, 500);
  assert.equal(after.H, 400);
  assert.equal(after.engineW, 500);       // the paint engine follows the new artboard
  assert.equal(after.engineH, 400);
  assert.ok(after.bg);
  assert.equal(after.selection, null);

  // Undo right after reset must not resurrect the discarded document.
  const afterUndo = await page.evaluate(() => { window.__ed.undo(); return window.__ed.fc.getObjects().length; });
  assert.equal(afterUndo, 0);

  // And the blank document is still fully usable.
  await page.evaluate(() => window.__ed.setTool('ellipse'));
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 110, canvasBox.y + 95, { steps: 3 });
  await page.mouse.up();
  const drawn = await page.evaluate(() => window.__ed.fc.getObjects().map(o => o.type));
  assert.deepEqual(drawn, ['ellipse']);
});

/* ── magic wand / object select accuracy ───────────────────────────────────────────────────
   These tools were reported as "not working correctly". Both failures only appear on
   PHOTOGRAPHIC input — flat synthetic colour passes at any setting, which is why they went
   unnoticed. Measured against a known-size subject rather than asserting "a selection exists",
   since the bug was a selection of the WRONG SIZE, not a missing one. */

/* Paints `draw` into a canvas, opens it as the document, wand-picks at (cx,cy) and returns the
   selection's width in scene px. */
async function wandWidthAt(page, { size, draw, cx, cy, tolerance }) {
  await page.evaluate(async ({ size, draw, tolerance }) => {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    // eslint-disable-next-line no-new-func
    new Function('x', 'S', draw)(c.getContext('2d'), size);
    await window.__ed.openImage(c.toDataURL('image/png'));
    window.__ed.setTool('magicwand');
    window.__ed.setToolOptions({ tolerance });
    window.__ed.clearSelection();
  }, { size, draw, tolerance });
  return page.evaluate(async ({ cx, cy }) => {
    const mod = await import('/packages/core/src/selection.js');
    await window.__ed.wandPick({ x: cx, y: cy });
    const s = window.__ed.selection;
    if (!s) return null;
    const polys = mod.selectionPolys(s) || [];
    let minx = 1e9, maxx = -1e9;
    polys.forEach(pl => pl.forEach(p => { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; }));
    return Math.round(maxx - minx);
  }, { cx, cy });
}

const PHOTO_SUBJECT = `
  const g = x.createLinearGradient(0,0,S,S); g.addColorStop(0,'#8fa7c4'); g.addColorStop(1,'#d9c9a8');
  x.fillStyle = g; x.fillRect(0,0,S,S);
  const g2 = x.createRadialGradient(S/2,S/2,20,S/2,S/2,S*0.24);
  g2.addColorStop(0,'#b8452f'); g2.addColorStop(1,'#6d2418');
  x.fillStyle = g2; x.beginPath(); x.arc(S/2,S/2,S*0.24,0,7); x.fill();
  const im = x.getImageData(0,0,S,S);
  for (let i=0;i<im.data.length;i+=4){ const n=(Math.random()-.5)*26; im.data[i]+=n; im.data[i+1]+=n; im.data[i+2]+=n; }
  x.putImageData(im,0,0);`;

test('browser: the wand hugs a soft-edged photographic subject at the default tolerance', async () => {
  const size = 1000, ideal = Math.round(size * 0.48);     // the subject's diameter
  const w = await wandWidthAt(page, {
    size, draw: PHOTO_SUBJECT, cx: size / 2, cy: size / 2,
    tolerance: 64,                                        // the shipped default
  });
  assert.ok(w !== null, 'the wand must return a selection on a photographic subject');
  // The old default (32) came back ~28% small here — it stopped at the first shading step
  // instead of the object's edge, visibly cutting inside the thing the user clicked.
  const errPct = Math.abs(w - ideal) / ideal * 100;
  assert.ok(errPct < 12, `wand selected ${w}px for a ${ideal}px subject (${errPct.toFixed(0)}% off)`);
});

test('browser: a low-contrast subject does not flood the wand selection to the whole canvas', async () => {
  const size = 1000, ideal = Math.round(size * 0.5);
  // Subject and background are close enough in colour that the flood escapes into the
  // background — the worker then used to take the >90% mask at face value and hand back the
  // ENTIRE canvas, which is never what clicking on an object means.
  const draw = `
    x.fillStyle='#9aa3ae'; x.fillRect(0,0,S,S);
    x.fillStyle='#7f8b98'; x.beginPath(); x.arc(S/2,S/2,S*0.25,0,7); x.fill();
    const im=x.getImageData(0,0,S,S);
    for(let i=0;i<im.data.length;i+=4){const n=(Math.random()-.5)*18; im.data[i]+=n; im.data[i+1]+=n; im.data[i+2]+=n;}
    x.putImageData(im,0,0);`;
  const w = await wandWidthAt(page, { size, draw, cx: size / 2, cy: size / 2, tolerance: 64 });
  assert.ok(w !== null);
  assert.ok(w < size * 0.9, `wand flooded to ${w}px of a ${size}px canvas instead of the subject`);
  assert.ok(Math.abs(w - ideal) / ideal * 100 < 15, `wand selected ${w}px for a ${ideal}px subject`);
});

test('browser: clicking flat background still selects the background, not just the subject', async () => {
  // The flood-leak fix must not break the legitimate case it has to be told apart from:
  // a deliberate click on a flat background genuinely does select almost the whole frame.
  const size = 1000;
  const draw = `
    x.fillStyle='#ffffff'; x.fillRect(0,0,S,S);
    x.fillStyle='#c0392b'; x.beginPath(); x.arc(S/2,S/2,200,0,7); x.fill();`;
  const w = await wandWidthAt(page, { size, draw, cx: 60, cy: 60, tolerance: 64 });
  assert.ok(w !== null);
  assert.ok(w > size * 0.9, `background click selected only ${w}px of a ${size}px canvas`);
});

test('browser: the wand picks the element under the cursor, not a bigger same-coloured one elsewhere', async () => {
  /* Real-world failure from an ad layout: a small green "now at" pill near the top and a large
     green product card lower down. Clicking the PILL returned the CARD — the flood/grabCut mask
     spanned both same-coloured blobs and the contour picker then preferred the largest one.
     Design work reuses a brand colour constantly, so this is the common case, not an edge case. */
  const size = 1000;
  const draw = `
    x.fillStyle='#f4f4f2'; x.fillRect(0,0,S,S);
    x.fillStyle='#4cc47a'; x.fillRect(120,120,170,60);      // small pill  (the target)
    x.fillStyle='#4cc47a'; x.fillRect(100,500,300,400);     // big card, same colour`;
  const w = await wandWidthAt(page, { size, draw, cx: 200, cy: 150, tolerance: 64 });
  assert.ok(w !== null, 'clicking the pill must select something');
  // The pill is 170px wide; the card is 300px. Before the fix this came back as the card.
  assert.ok(w < 240, `wand returned a ${w}px-wide selection for a 170px pill — it grabbed the other element`);

  // And the click must land on the pill's own box, not somewhere else on the canvas.
  const box = await page.evaluate(async () => {
    const mod = await import('/packages/core/src/selection.js');
    const s = window.__ed.selection;
    const polys = mod.selectionPolys(s) || [];
    let minx = 1e9, miny = 1e9;
    polys.forEach(pl => pl.forEach(p => { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; }));
    return { x: Math.round(minx), y: Math.round(miny) };
  });
  assert.ok(box.y < 300, `selection started at y=${box.y}; the pill is at y=120, the card at y=500`);
});
