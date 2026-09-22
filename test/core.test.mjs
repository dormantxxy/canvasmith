/* Unit tests for everything in core that is pure data-in/data-out — runs in bare node,
   no DOM, no fabric. The DOM-touching layers get their coverage from the demo smoke test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hexRgb, rgba, toHex, relLum, rgbToHsl, hslToRgb, hexToHsl, recolorPixels, fxToFilterSpecs, FX_DEFAULTS, normalizeGradientStops, splitGradientStopColor } from '../packages/core/src/color.js';
import { History } from '../packages/core/src/history.js';
import {
  startSelection, updateSelection, finalizeSelection, floodSelectPolygon, selectionFillRule,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
} from '../packages/core/src/selection.js';
import { getCropHandle, dragCropRect } from '../packages/core/src/crop.js';
import { readSession, writeSession, clearSession, discardToTrash, readDiscarded, parseProject } from '../packages/core/src/session.js';
import { alignDelta, snapDelta } from '../packages/core/src/layout.js';
import { parseLaunch } from '../packages/core/src/bridge.js';
import { starPoints } from '../packages/core/src/shapes.js';
import { cvWorkerSource } from '../packages/core/src/cv/worker.js';
import { CvEngine } from '../packages/core/src/cv/client.js';
import { buildPromoLayout } from '../packages/core/src/templates.js';

/* ── colour ─────────────────────────────────────────────────────────── */
test('color: hex round-trips and short form expands', () => {
  assert.deepEqual(hexRgb('#d4ff45'), [212, 255, 69]);
  assert.deepEqual(hexRgb('#fff'), [255, 255, 255]);
  assert.equal(toHex(212, 255, 69), '#d4ff45');
  assert.equal(rgba('#000000', 0.5), 'rgba(0,0,0,0.5)');
  assert.equal(toHex(300, -5, 12), '#ff000c');           // clamps out-of-range
});

test('color: relative luminance orders black < mid < white', () => {
  const black = relLum([0, 0, 0]), mid = relLum([128, 128, 128]), white = relLum([255, 255, 255]);
  assert.ok(black < mid && mid < white);
  assert.ok(Math.abs(white - 1) < 1e-9);
});

/* ── history ────────────────────────────────────────────────────────── */
test('history: push/undo/redo with dedupe, cap and lock', () => {
  const h = new History(3);
  assert.equal(h.push('a'), true);
  assert.equal(h.push('a'), false);                      // identical state collapses
  h.push('b'); h.push('c');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), 'b');                           // returns the state to RESTORE
  assert.equal(h.redo(), 'c');
  h.push('d');                                           // cap=3: 'a' fell off
  assert.deepEqual(h.past, ['b', 'c', 'd']);
  assert.equal(h.push('x') && false || (h.lock = true, h.push('y')), false);  // locked = ignored
  h.lock = false;
  h.undo();
  assert.equal(h.future.length, 1);
  h.push('z');
  assert.equal(h.future.length, 0);                      // a new edit clears redo
});

/* ── selection geometry ─────────────────────────────────────────────── */
test('selection: marquee drag produces a normalized rect; tiny drags are rejected', () => {
  const s = startSelection('marquee', { x: 100, y: 100 });
  updateSelection(s, { x: 40, y: 60 });                  // drag up-left
  assert.deepEqual([s.x, s.y, s.w, s.h], [40, 60, 60, 40]);
  assert.ok(finalizeSelection(s));
  const tiny = startSelection('marquee', { x: 0, y: 0 });
  updateSelection(tiny, { x: 4, y: 4 });
  assert.equal(finalizeSelection(tiny), null);           // slipped click, not intent
});

test('selection: shift constrains marquee to a square', () => {
  const s = startSelection('marquee', { x: 10, y: 10 });
  updateSelection(s, { x: 50, y: 30 }, { square: true });
  assert.equal(s.w, s.h);
  assert.equal(s.w, 40);
});

test('selection: inverted selections clip with evenodd', () => {
  assert.equal(selectionFillRule({ kind: 'rect', invert: true }), 'evenodd');
  assert.equal(selectionFillRule({ kind: 'rect' }), 'nonzero');
});

test('magic wand: flood fill finds the square and traces its boundary', () => {
  // 20x20 white image with a 8x8 black square at (5,5)
  const w = 20, h = 20, data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 5; y < 13; y++) for (let x = 5; x < 13; x++) {
    const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const r = floodSelectPolygon({ width: w, height: h, data }, 8, 8, 32);
  assert.ok(r, 'region found');
  assert.deepEqual(r.rect, { x: 5, y: 5, w: 8, h: 8 });
  assert.ok(r.pts && r.pts.length >= 4, 'boundary polygon traced');
  for (const p of r.pts) {
    assert.ok(p.x >= 5 && p.x <= 12 && p.y >= 5 && p.y <= 12, 'contour stays on the square');
  }
});

test('magic wand: clicking noise smaller than 8px selects nothing', () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4).fill(255);
  const i = (5 * w + 5) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;   // single dark pixel
  assert.equal(floodSelectPolygon({ width: w, height: h, data }, 5, 5, 10), null);
});

/* ── crop ───────────────────────────────────────────────────────────── */
test('crop: handle hit-testing respects zoom and priority', () => {
  const c = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(getCropHandle(c, { x: 100, y: 100 }, 1), 'tl');
  assert.equal(getCropHandle(c, { x: 300, y: 200 }, 1), 'br');
  assert.equal(getCropHandle(c, { x: 200, y: 100 }, 1), 't');
  assert.equal(getCropHandle(c, { x: 200, y: 150 }, 1), 'move');
  assert.equal(getCropHandle(c, { x: 0, y: 0 }, 1), null);
  // zoomed in 4x: tolerance shrinks — 8px from the corner no longer grabs 'tl',
  // it falls through to the interior ('move'), exactly like the parent editor
  assert.equal(getCropHandle(c, { x: 108, y: 100 }, 4), 'move');
  assert.equal(getCropHandle(c, { x: 102, y: 101 }, 4), 'tl');   // 2px away still does
});

test('crop: dragging edges resizes, ratio locks aspect, min size holds', () => {
  const c = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(dragCropRect(c, 'move', 10, 5), { x: 10, y: 5, w: 100, h: 100 });
  assert.deepEqual(dragCropRect(c, 'r', 50, 0), { x: 0, y: 0, w: 150, h: 100 });
  const locked = dragCropRect(c, 'br', 100, 0, 2);       // ratio 2:1
  assert.equal(locked.w / locked.h, 2);
  const clamped = dragCropRect(c, 'r', -200, 0);
  assert.equal(clamped.w, 24);                           // never collapses below min
});

/* ── layout: align + snap ──────────────────────────────────────────── */
test('layout: alignDelta moves a box to each artboard edge/axis', () => {
  const box = { left: 30, top: 40, width: 20, height: 10 };
  assert.deepEqual(alignDelta(box, 100, 100, 'left'), { dx: -30, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'right'), { dx: 50, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'center'), { dx: 10, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'top'), { dx: 0, dy: -40 });
  assert.deepEqual(alignDelta(box, 100, 100, 'bottom'), { dx: 0, dy: 50 });
  assert.deepEqual(alignDelta(box, 100, 100, 'middle'), { dx: 0, dy: 5 });
});

test('layout: snapDelta pulls a moving box to the artboard center within threshold', () => {
  const box = { left: 46, top: 46, width: 10, height: 10 };   // center at (51,51), artboard center (50,50)
  const r = snapDelta(box, 100, 100, [], 8);
  assert.equal(r.snappedX, true); assert.equal(r.snappedY, true);
  assert.equal(box.left + r.dx + box.width / 2, 50);
  assert.equal(box.top + r.dy + box.height / 2, 50);
});

test('layout: snapDelta snaps to a sibling layer edge, ignores out-of-threshold ones', () => {
  const box = { left: 108, top: 0, width: 20, height: 20 };   // left edge at 108
  const sibling = { left: 0, top: 0, width: 100, height: 20 }; // right edge at 100 — 8px away, within threshold
  const r = snapDelta(box, 500, 500, [sibling], 8);
  assert.equal(r.snappedX, true);
  assert.equal(box.left + r.dx, 100);
  const far = snapDelta({ ...box, left: 130 }, 500, 500, [sibling], 8);
  assert.equal(far.snappedX, false);
  assert.equal(far.dx, 0);
});

/* ── bridge launch parsing ──────────────────────────────────────────── */
test('bridge: parses ?image=, #img=, storage handoff, and rejects junk', () => {
  assert.deepEqual(parseLaunch('?image=https%3A%2F%2Fx.com%2Fa.png', '', null),
    { kind: 'url', src: 'https://x.com/a.png' });
  assert.equal(parseLaunch('?image=javascript:alert(1)', '', null), null);   // scheme rejected
  const d = 'data:image/png;base64,AAAA';
  assert.deepEqual(parseLaunch('', '#img=' + encodeURIComponent(d), null), { kind: 'data', src: d });
  assert.deepEqual(parseLaunch('', '', d), { kind: 'storage', src: d });
  assert.equal(parseLaunch('', '', 'not-an-image'), null);
  // URL param beats storage
  assert.equal(parseLaunch('?image=https://x.com/a.png', '', d).kind, 'url');
});

/* ── shapes ─────────────────────────────────────────────────────────── */
test('shapes: starPoints yields 2n vertices alternating radii', () => {
  const pts = starPoints(0, 0, 10, 5, 5);
  assert.equal(pts.length, 10);
  const r0 = Math.hypot(pts[0].x, pts[0].y), r1 = Math.hypot(pts[1].x, pts[1].y);
  assert.ok(Math.abs(r0 - 10) < 1e-9 && Math.abs(r1 - 5) < 1e-9);
});

/* ── HSL recolour ───────────────────────────────────────────────────── */
test('color: rgb<->hsl round-trips exactly for integer channels', () => {
  for (const [r, g, b] of [[200, 50, 50], [0, 0, 0], [255, 255, 255], [10, 200, 90]]) {
    const hsl = rgbToHsl(r, g, b);
    assert.deepEqual(hslToRgb(hsl.h, hsl.s, hsl.l), { r, g, b });
  }
});

test('color: hexToHsl matches rgbToHsl of the same colour', () => {
  assert.deepEqual(hexToHsl('#6496c8'), rgbToHsl(100, 150, 200));
});

test('color: recolorPixels keeps lightness, skips transparent pixels', () => {
  // a mid-grey pixel recoloured toward pure green should land near pure green at the same lightness
  const data = new Uint8ClampedArray([128, 128, 128, 255, /* transparent: */ 9, 9, 9, 0]);
  recolorPixels(data, '#00ff00');
  const before = rgbToHsl(128, 128, 128), after = rgbToHsl(data[0], data[1], data[2]);
  assert.ok(Math.abs(before.l - after.l) < 1e-6, 'lightness preserved');
  assert.deepEqual([data[4], data[5], data[6], data[7]], [9, 9, 9, 0], 'transparent pixel untouched');
});

/* ── polygon lasso (click-to-place) ─────────────────────────────────── */
test('selection: polyBuildAdd closes the loop near the first point', () => {
  let b = startPolyBuild();
  b = polyBuildAdd(b, { x: 0, y: 0 });
  b = polyBuildAdd(b, { x: 10, y: 0 });
  b = polyBuildAdd(b, { x: 10, y: 10 });
  const closed = polyBuildAdd(b, { x: 1, y: 1 }, 12);
  assert.equal(closed.closed, true);
  assert.equal(closed.pts.length, 3);               // the closing click is not added as a 4th vertex
});

test('selection: polyBuildAdd keeps building when far from the start', () => {
  let b = startPolyBuild();
  b = polyBuildAdd(b, { x: 0, y: 0 });
  b = polyBuildAdd(b, { x: 50, y: 50 });
  assert.equal(b.closed, undefined);
  assert.equal(b.pts.length, 2);
});

test('selection: polyBuildPreview appends a trailing point without mutating the build', () => {
  const b = { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
  const preview = polyBuildPreview(b, { x: 10, y: 10 });
  assert.equal(preview.kind, 'poly');
  assert.equal(preview.building, true);
  assert.equal(preview.pts.length, 3);
  assert.equal(b.pts.length, 2);                     // original build untouched
});

test('selection: finishPolyBuild rejects cancellation and too-short builds', () => {
  assert.equal(finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), null);   // < 3 points
  assert.equal(finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, true), null); // cancelled
  const ok = finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, false);
  assert.deepEqual(ok, { kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
});

/* ── magnetic lasso: edge map + snap ────────────────────────────────── */
test('selection: buildEdgeMapFromImageData + snapToEdge pulls a point onto a bright edge', () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4).fill(0);
  for (let x = 0; x < w; x++) { const i = (5 * w + x) * 4; data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  const map = buildEdgeMapFromImageData({ width: w, height: h, data }, 100, 100);   // scene is a 10x scale of the 10px grid
  // the Sobel gradient peaks at the bright row's edges (grid rows 4 and 6), not the row itself
  const snapped = snapToEdge(map, { x: 50, y: 42 });
  assert.ok(snapped.y === 40 || snapped.y === 60, 'snapped onto one of the bright row\'s edges');
  const farFromAnyEdge = snapToEdge(map, { x: 50, y: 95 }, 2);   // small radius can't reach the edge from here
  assert.deepEqual(farFromAnyEdge, { x: 50, y: 95 });
});

test('selection: snapToEdge returns the point unchanged with no edge map', () => {
  assert.deepEqual(snapToEdge(null, { x: 5, y: 5 }), { x: 5, y: 5 });
});

/* ── selection composition: add / bounds ────────────────────────────── */
test('selection: selectionPolys normalizes rect/poly/multipoly into polygon rings', () => {
  assert.deepEqual(selectionPolys(null), null);
  assert.deepEqual(selectionPolys({ kind: 'rect', x: 0, y: 0, w: 10, h: 5 }),
    [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]]);
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(selectionPolys({ kind: 'poly', pts }), [pts]);
  const polys = [pts, pts];
  assert.equal(selectionPolys({ kind: 'multipoly', polys }), polys);
});

test('selection: polysToSelection wraps one ring as poly, several as multipoly', () => {
  const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(polysToSelection([ring]), { kind: 'poly', pts: ring });
  assert.deepEqual(polysToSelection([ring, ring]), { kind: 'multipoly', polys: [ring, ring] });
  assert.equal(polysToSelection([]), null);
});

test('selection: addPolyToSelection accumulates into a multipoly without a prior selection', () => {
  const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const sel = addPolyToSelection(null, ring);
  assert.deepEqual(sel, { kind: 'poly', pts: ring });
  const sel2 = addPolyToSelection(sel, ring);
  assert.equal(sel2.kind, 'multipoly');
  assert.equal(sel2.polys.length, 2);
});

test('selection: selectionBounds covers rect, poly and the no-selection (full canvas) case', () => {
  assert.deepEqual(selectionBounds(null, 200, 100), { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(selectionBounds({ kind: 'rect', x: 5, y: 5, w: 10, h: 20 }, 200, 100), { x: 5, y: 5, w: 10, h: 20 });
  const poly = { kind: 'poly', pts: [{ x: 3, y: 4 }, { x: 9, y: 1 }, { x: 6, y: 8 }] };
  assert.deepEqual(selectionBounds(poly, 200, 100), { x: 3, y: 1, w: 6, h: 7 });
});

test('selection: HoverCache is a capped LRU — least-recently-inserted evicts when never accessed', () => {
  const c = new HoverCache(2);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);        // 'a' evicted — cap is 2
  assert.equal(c.get('a'), null);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

test('selection: HoverCache.get refreshes recency, so a re-accessed entry survives eviction', () => {
  const c = new HoverCache(2);
  c.put('a', 1); c.put('b', 2);
  c.get('a');                                          // 'a' is now the most-recently-used
  c.put('c', 3);                                        // 'b' is least-recently-used — evicted, not 'a'
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), null);
  assert.equal(c.get('c'), 3);
});

/* ── OpenCV worker: stringified source is self-contained and boots lazily ──────────────── */
test('cv: cvWorkerSource embeds the OpenCV URL and is syntactically valid standalone JS', () => {
  const src = cvWorkerSource('https://example.test/opencv.js');
  assert.ok(src.includes('https://example.test/opencv.js'));
  assert.ok(src.includes('importScripts'));
  assert.doesNotThrow(() => new Function(src));       // parses; never executed outside a Worker
});

test('cv: CvEngine degrades to null (never throws) with no Worker support', async () => {
  const cv = new CvEngine();
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const r = await cv.wand(img, { cx: 1, cy: 1 }, 32, 0.002);
  assert.equal(r, null);
  assert.equal(cv.unavailable, true);
  cv.destroy();
});

/* ── image adjustment: fx -> Fabric filter spec mapping (Editor#setImageFilters) ──────────── */
test('color: fxToFilterSpecs maps defaults to zero/neutral filter params', () => {
  const specs = fxToFilterSpecs(FX_DEFAULTS);
  assert.deepEqual(specs.map(s => s.type), ['Brightness', 'Contrast', 'Saturation', 'Blur', 'HueRotation', 'Vibrance', 'Invert']);
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Contrast').params, { contrast: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Saturation').params, { saturation: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0 });
  assert.deepEqual(specs.find(s => s.type === 'HueRotation').params, { rotation: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Vibrance').params, { vibrance: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Invert').params, { invert: false });
});

test('color: fxToFilterSpecs maps non-default human values exactly like the reference setFx', () => {
  const specs = fxToFilterSpecs({ brightness: 150, contrast: 50, saturate: 200, blur: 10, hue: 90, vibrance: 50, invert: true });
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Contrast').params, { contrast: -0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Saturation').params, { saturation: 1 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'HueRotation').params, { rotation: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Vibrance').params, { vibrance: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Invert').params, { invert: true });
});

test('color: fxToFilterSpecs fills in missing keys from FX_DEFAULTS', () => {
  const specs = fxToFilterSpecs({ blur: 4 });
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0.2 });
});

/* ── gradient stops: alpha folding + round-trip (Editor#getShapeGradient's UI-facing consumers) ── */
test('color: normalizeGradientStops passes a fully-opaque stop color through unchanged', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00', alpha: 1 }]);
  assert.equal(norm[0].color, '#ff0000');
  assert.equal(norm[1].color, '#00ff00');
});

test('color: normalizeGradientStops folds alpha < 1 into an rgba() string', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#ff0000', alpha: 0.5 }]);
  assert.equal(norm[0].color, 'rgba(255,0,0,0.5)');
});

test('color: normalizeGradientStops clamps a negative alpha to 0 rather than going negative', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#0000ff', alpha: -5 }]);
  assert.equal(norm[0].color, 'rgba(0,0,255,0)');
});

test('color: normalizeGradientStops treats alpha >= 1 as fully opaque (plain hex, no rgba wrap)', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#0000ff', alpha: 5 }]);
  assert.equal(norm[0].color, '#0000ff');
});

test('color: splitGradientStopColor decodes an rgba() string back to color + alpha', () => {
  assert.deepEqual(splitGradientStopColor('rgba(255,0,0,0.5)'), { color: '#ff0000', alpha: 0.5 });
  assert.deepEqual(splitGradientStopColor('rgb(0,255,0)'), { color: '#00ff00', alpha: 1 });
});

test('color: splitGradientStopColor treats a plain hex as fully opaque', () => {
  assert.deepEqual(splitGradientStopColor('#7c3aed'), { color: '#7c3aed', alpha: 1 });
});

/* ── promo layout: buildPromoLayout's pure percentage-of-artboard positioning (no fabric touched;
   see templates.js's own header for why the fabric-object-building half lives in the browser
   suite instead) ─────────────────────────────────────────────────────────────────────────────── */
test('templates: buildPromoLayout always leads with a locked full-canvas background layer', () => {
  const { layers } = buildPromoLayout({}, 1080, 1080);
  assert.equal(layers[0].id, 'bg');
  assert.equal(layers[0].role, 'bg');
  assert.equal(layers[0].width, 1080); assert.equal(layers[0].height, 1080);
  assert.equal(layers[0].locked, true);
});

test('templates: unknown/omitted layout falls back to the centered group', () => {
  const centered = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const omitted = buildPromoLayout({}, 1000, 1000);
  const bogus = buildPromoLayout({ layout: 'not-a-real-layout' }, 1000, 1000);
  const kinds = (r) => r.layers.map(l => l.id).sort();
  assert.deepEqual(kinds(centered), kinds(omitted));
  assert.deepEqual(kinds(centered), kinds(bogus));
  // centered group: brand centered, headline centered, product ellipse (no explicit image), no scrim/burst
  assert.ok(centered.layers.some(l => l.id === 'brand' && l.originX === 'center'));
  assert.ok(centered.layers.some(l => l.id === 'headline' && l.align === 'center'));
  assert.ok(centered.layers.some(l => l.id === 'product' && l.kind === 'ellipse'));
  assert.ok(!centered.layers.some(l => l.id === 'scrim' || l.id === 'burst'));
});

test('templates: hero/editorial/lookbook/split all fold into the same hero group layout', () => {
  const ids = ['hero', 'editorial', 'lookbook', 'split'].map(layout => buildPromoLayout({ layout }, 1080, 1350).layers.map(l => l.id));
  ids.forEach(list => assert.deepEqual(list, ids[0]));
  const hero = buildPromoLayout({ layout: 'hero' }, 1080, 1350);
  assert.ok(hero.layers.some(l => l.id === 'scrim' && l.fill === 'scrim'));
  assert.ok(hero.layers.some(l => l.id === 'product' && l.left === 0 && l.top === 0));
});

test('templates: sale layout adds an accent burst and rotates the product corner shot', () => {
  const sale = buildPromoLayout({ layout: 'sale' }, 1080, 1080);
  const burst = sale.layers.find(l => l.id === 'burst');
  assert.ok(burst);
  assert.equal(burst.kind, 'ellipse');
  assert.equal(burst.fill, sale.accent);
  const product = sale.layers.find(l => l.id === 'product');
  assert.equal(product.angle, -8);
});

test('templates: badge layer is omitted entirely when no badge text is given, present when it is', () => {
  const noBadge = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const withBadge = buildPromoLayout({ layout: 'centered', badge: 'New' }, 1000, 1000);
  assert.ok(!noBadge.layers.some(l => l.id === 'badge'));
  const b = withBadge.layers.find(l => l.id === 'badge');
  assert.ok(b);
  assert.equal(b.text, 'New');
});

test('templates: subhead layer is omitted when sub is empty, present with the given text otherwise', () => {
  const noSub = buildPromoLayout({ layout: 'hero', sub: '' }, 1080, 1350);
  const withSub = buildPromoLayout({ layout: 'hero', sub: 'Limited time only' }, 1080, 1350);
  assert.ok(!noSub.layers.some(l => l.id === 'sub'));
  const s = withSub.layers.find(l => l.id === 'sub');
  assert.equal(s.text, 'Limited time only');
});

test('templates: a dark accent picks light (white) ink, a light accent picks dark ink, for legibility', () => {
  const dark = buildPromoLayout({ palette: { accent: '#111114' } }, 1000, 1000);
  const light = buildPromoLayout({ palette: { accent: '#f5f3ee' } }, 1000, 1000);
  const darkCta = dark.layers.find(l => l.id === 'cta'), lightCta = light.layers.find(l => l.id === 'cta');
  assert.equal(darkCta.ink, '#ffffff');
  assert.equal(lightCta.ink, '#0c0c0e');
});

test('templates: product without a productImg falls back to a placeholder kind (rect/ellipse, not image)', () => {
  const noImg = buildPromoLayout({ layout: 'hero' }, 1080, 1350);
  const withImg = buildPromoLayout({ layout: 'hero', productImg: 'data:image/png;base64,x' }, 1080, 1350);
  assert.equal(noImg.layers.find(l => l.id === 'product').kind, 'rect');
  assert.equal(withImg.layers.find(l => l.id === 'product').kind, 'image');
});

test('templates: layer geometry scales with W/H (percentage-of-artboard, not fixed pixels)', () => {
  const small = buildPromoLayout({ layout: 'centered' }, 500, 500);
  const big = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const headSmall = small.layers.find(l => l.id === 'headline'), headBig = big.layers.find(l => l.id === 'headline');
  assert.equal(headBig.size, headSmall.size * 2);
  assert.equal(headBig.top, headSmall.top * 2);
});

test('history: rebase makes a state the floor of the stack, whatever was recorded before it', () => {
  const h = new History();
  h.push('empty'); h.push('a'); h.push('b');
  h.undo();                                              // something on the redo stack too
  assert.ok(h.future.length > 0);

  assert.equal(h.rebase('restored'), true);
  assert.deepEqual(h.past, ['restored']);
  assert.equal(h.future.length, 0);
  assert.equal(h.canUndo(), false);                      // nothing behind the floor to undo into
  assert.equal(h.canRedo(), false);

  // Ordinary edits still stack on top of the floor and undo back down to it — a rebase is a
  // new starting point, not a frozen history.
  h.push('edit');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), 'restored');
  assert.equal(h.canUndo(), false);

  assert.equal(h.rebase(null), false);                   // nothing to rebase onto
});

/* ── session autosave ───────────────────────────────────────────────────────────────
   The real backend is IndexedDB (localStorage cannot hold a photo document — see session.js),
   but the backend is injected, so the envelope/versioning/quota-shedding logic is testable here
   in bare node. The fabric round-trip through a live canvas is covered in editor.browser.test.mjs.

   An injected backend is the async {get,set,del} shape session.js expects. `cap` counts only
   OTHER keys plus the incoming value, matching how a store frees the key being overwritten
   before deciding whether the new value fits. */
function memStore(cap = Infinity) {
  const m = new Map();
  return {
    kind: 'mem',
    _raw: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) {
      const other = [...m].filter(([kk]) => kk !== k).reduce((sum, [, vv]) => sum + vv.length, 0);
      if (other + v.length > cap) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    async del(k) { m.delete(k); },
  };
}

test('session: round-trips the scene string and the host extras', async () => {
  const storage = memStore();
  assert.equal(await writeSession('{"w":10,"h":10}', { assets: [{ src: 'a' }] }, { storage }), 'ok');
  const r = await readSession({ storage });
  assert.equal(r.scene, '{"w":10,"h":10}');
  assert.deepEqual(r.extras.assets, [{ src: 'a' }]);
});

test('session: over quota, extras are shed but the scene still saves', async () => {
  const scene = 'S'.repeat(300);
  const storage = memStore(400);
  assert.equal(await writeSession(scene, { thumbs: 'X'.repeat(500) }, { storage }), 'ok-trimmed');
  assert.equal((await readSession({ storage })).scene, scene);
  assert.deepEqual((await readSession({ storage })).extras, {});
});

test('session: a scene too big even alone reports failure and leaves no stale save behind', async () => {
  const storage = memStore(100);
  assert.equal(await writeSession('S'.repeat(500), {}, { storage }), 'failed');
  assert.equal(await readSession({ storage }), null);
});

test('session: a newer save replaces an equally large older one', async () => {
  const storage = memStore(400);
  assert.equal(await writeSession('A'.repeat(300), {}, { storage }), 'ok');
  assert.equal(await writeSession('B'.repeat(300), {}, { storage }), 'ok');
  assert.ok((await readSession({ storage })).scene.startsWith('B'));
});

test('session: a corrupt/truncated payload is dropped rather than thrown', async () => {
  const storage = memStore();
  await storage.set('canvasmith.session', '{not json');
  assert.equal(await readSession({ storage }), null);
  assert.equal(await storage.get('canvasmith.session'), null);   // cleared, so the next boot starts clean
});

test('session: a payload from a different schema version is ignored, not half-restored', async () => {
  const storage = memStore();
  await storage.set('canvasmith.session', JSON.stringify({ v: 99, scene: '{}' }));
  assert.equal(await readSession({ storage }), null);
});

test('session: a backend that throws on every write reports failure, never throws at the caller', async () => {
  const hostile = {
    kind: 'hostile',
    async get() { return null; },
    async set() { throw new Error('blocked'); },
    async del() { },
  };
  assert.equal(await writeSession('x', { a: 1 }, { storage: hostile }), 'failed');
  assert.equal(await readSession({ storage: hostile }), null);
});

test('session: New parks the old document in a trash slot so the action is recoverable', async () => {
  const storage = memStore();
  await writeSession('{"scene":"work"}', { assets: ['a'] }, { storage });
  assert.equal(await discardToTrash({ storage }), true);
  // New then clears the LIVE slot — the trashed copy must survive that.
  await clearSession({ storage });
  assert.equal(await readSession({ storage }), null);
  const trashed = await readDiscarded({ storage });
  assert.equal(trashed.scene, '{"scene":"work"}');
  assert.deepEqual(trashed.extras.assets, ['a']);
});

test('session: discarding with nothing saved is a no-op, not an error', async () => {
  const storage = memStore();
  assert.equal(await discardToTrash({ storage }), false);
  assert.equal(await readDiscarded({ storage }), null);
});

test('project: a non-project file is rejected with a message meant for the user', () => {
  assert.throws(() => parseProject('not json at all'), /isn.t valid JSON|isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ hello: 1 })), /isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ kind: 'something/else', scene: '{}' })), /isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ kind: 'canvasmith/project', v: 99, scene: '{}' })), /newer version/);
});

test('project: a valid project round-trips its scene and extras', () => {
  const file = JSON.stringify({ kind: 'canvasmith/project', v: 1, scene: '{"w":10,"h":10}', extras: { assets: [1, 2] } });
  const p = parseProject(file);
  assert.equal(p.scene, '{"w":10,"h":10}');
  assert.deepEqual(p.extras.assets, [1, 2]);
});
