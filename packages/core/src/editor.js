/* Editor — the headless facade. One instance per artboard.

     const ed = new Editor({ fabric, canvasEl, width, height });
     ed.setTool('brush'); ed.setToolOptions({ size: 40, color: '#ff0000' });
     ed.undo(); ed.exportPNG(); ed.ai.register(new GeminiProvider());

   Everything a UI needs is events + methods — no DOM of its own, no framework, no globals.
   The React package and the vanilla demo are both thin shells over exactly this class. */

import { PaintEngine, PAINT_TOOLS, renderObjectsFlat } from './engine.js';
import { History } from './history.js';
import {
  startSelection, updateSelection, finalizeSelection, selectionToPath2D, selectionFillRule, wandSelect,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
  getSelectionHandle, dragSelectionRect,
} from './selection.js';
import { makeShape, resizeShapeTo, makeText, layerLabel, describeLayer, isContainerGroup, uid, fontCss } from './shapes.js';
import { getCropHandle, dragCropRect, applyCrop } from './crop.js';
import { makeToneFilterClass, lumaHistogram } from './tone.js';
import { makeGeometryFilterClass, GEOMETRY_DEFAULTS, UNIT_QUAD, squareToQuad, mapHomography, applyGeometry } from './geometry.js';
import { alignDelta, snapDelta } from './layout.js';
import { EXTRA, serialize, restore, exportImage, addImageLayer, artboardForImage, loadImageEl } from './io.js';
import { selectionClipObject, renderSelectedPixels } from './pixels.js';
import { recolorPixels, fxToFilterSpecs, FX_DEFAULTS, normalizeGradientStops, splitGradientStopColor, relLum, hexRgb, rgba } from './color.js';
import { AIRegistry } from './ai/registry.js';
import { buildContextMenu } from './contextmenu.js';
import { node as penNode, cloneNodes, nodesToPathD, commandsToNodes, isSmooth, mirrorFor, handlesEqual, toggleSmooth,
  constrain45, translateNode, hitAnchor, hitHandle, hitSegment, splitSegment, bendSegment, penCursor, dist as penDist } from './pen.js';
import { CvEngine, prepImageData } from './cv/client.js';
import { makeMaskFilterClass, createMaskCanvas, maskStamp, maskLine, serializeMask, deserializeMask, invertMaskCanvas,
  isVectorMaskable, createVectorMaskCanvas, vectorMaskPoint, touchVectorMask, attachVectorMask } from './mask.js';
import { stickerSpec, STICKER_PALETTE, STICKER_DEFAULT_LABEL } from './stickers.js';
import { makeCTA, makeBadge, makePrice, makeBrandLockup } from './adtext.js';
import { buildPromoLayout, buildLayerFromSpec } from './templates.js';
import { fillHoles, analyzeBox, knockoutBackground, textLines } from './regions.js';
import { installStrokePosition, applyStrokeStyle, strokeInfo } from './stroke.js';

export const SEL_TOOLS = ['marquee', 'marquee-ellipse', 'lasso', 'lasso-poly', 'lasso-mag', 'wand', 'objectselect-bbox', 'magicwand', 'objectselect', 'hoverselect'];
/* Default wand/object-select tolerance. Was 32, which is fine on flat synthetic colour but
   measurably WRONG on photographs: a soft-edged, noisy subject came back ~22-28% smaller than
   the object on every side, so the wand visibly cut inside the thing the user clicked.
   Photographic edges are gradients, and a low tolerance stops at the first shading step.
   Measured across 600/800/1000/1200/1598px images (subject = 48% of width), error vs. the true
   subject size: tol 32 ~-37%, tol 48 ~-22%, tol 64 within 1% at EVERY size. Flat synthetic
   shapes stay within 2% at all of these, so raising it costs nothing on the easy case.
   Scrub with [ and ] or the Tolerance slider. */
export const SHAPE_TOOLS = ['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'];
export const ALL_TOOLS = ['select', 'hand', ...PAINT_TOOLS, ...SEL_TOOLS, ...SHAPE_TOOLS, 'type', 'bucket', 'gradient', 'eyedropper', 'crop', 'pen', 'aiinsert'];
const CLICK_LASSOS = ['lasso-poly', 'lasso-mag'];
// Tools that draw new marks (vs. retouching existing pixels): they paint onto a paint layer of
// their own, never into the photo — see _drawTargetLayer.
const DRAW_TOOLS = ['brush', 'pencil'];

/* AI region-detection vocabulary (detectRegions/commitRegions) — the type strings a provider's
   detectRegions() returns, mapped to the LAYER ROLE a committed region becomes ('text' regions
   read as headline copy, 'sticker' regions as a decorative shape; product/logo/decorative already
   match their own final role so they pass through) and, for a host UI drawing region-review
   overlays (draft boxes during a guided convert step), a distinct accent color per type so a user
   can tell region types apart at a glance before committing them. */
/* Convert-to-layers text helpers. */
const pctBox = (rg) => ({ x0: rg.bbox.x, y0: rg.bbox.y, x1: rg.bbox.x + rg.bbox.width, y1: rg.bbox.y + rg.bbox.height });
const shareInside = (a, b) => {   // share of box a (x0..y1) that lies within box b
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return ix * iy / Math.max(1e-9, (a.x1 - a.x0) * (a.y1 - a.y0));
};
const normText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/* In place: drops the duplicates an AI detection pass tends to return —
   - a text box mostly inside another text box whose words already include it (one line reported
     both alone and as part of its block — became two overlapping text layers);
   - a text box on product packaging (the brand/flavour printed on a pack is part of the product —
     lifting it left a floating text layer over a pack that still showed the same words). */
function dedupeAiRegions(regions) {
  const drop = new Set();
  regions.forEach((a, i) => {
    if (a.type !== 'text') return;
    const A = pctBox(a);
    regions.forEach((b, j) => {
      if (i === j || drop.has(j) || drop.has(i)) return;
      const B = pctBox(b), inside = shareInside(A, B);
      const areaA = (A.x1 - A.x0) * (A.y1 - A.y0), areaB = (B.x1 - B.x0) * (B.y1 - B.y0);
      if (b.type === 'text' && inside > 0.7 && areaA <= areaB && normText(b.content).includes(normText(a.content))) drop.add(i);
      else if (b.type === 'product' && inside > 0.8) drop.add(i);
    });
  });
  for (let k = regions.length - 1; k >= 0; k--) if (drop.has(k)) regions.splice(k, 1);
}
const unionBox = (bs) => ({ x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) });
/* Words re-split into widths.length lines, each taking a share of the characters proportional to
   its measured ink width. */
function rewrapToLines(text, widths) {
  const words = text.split(/\s+/).filter(Boolean), n = Math.min(widths.length, words.length);
  if (n < 2) return text;
  const total = words.join(' ').length, sumW = widths.slice(0, n).reduce((a, b) => a + b, 0);
  const out = []; let cur = [], acc = 0, li = 0, goal = total * widths[0] / sumW;
  words.forEach((wd, i) => {
    const remainingWords = words.length - i, remainingLines = n - li - 1;
    if (cur.length && li < n - 1 && (acc + wd.length / 2 > goal || remainingWords <= remainingLines)) {
      out.push(cur.join(' ')); cur = []; li++; goal += total * widths[li] / sumW;
    }
    cur.push(wd); acc += wd.length + 1;
  });
  out.push(cur.join(' '));
  return out.join('\n');
}
/* left/center/right from how multiple ink lines line up (whichever edge varies least); null for one line. */
function alignOfLines(lines) {
  if (!lines || lines.length < 2) return null;
  const spread = (f) => { const v = lines.map(f); return Math.max(...v) - Math.min(...v); };
  const l = spread(b => b.x0), c = spread(b => (b.x0 + b.x1) / 2), r = spread(b => b.x1);
  return c <= l && c <= r ? 'center' : l <= r ? 'left' : 'right';
}
/* Waits (bounded) for a webfont so text measured right after isn't measured in the fallback font. */
async function loadFontFace(spec) {
  try {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
    await Promise.race([document.fonts.load(spec), new Promise(r => setTimeout(r, 2500))]);
  } catch (e) { /* unknown family — the browser falls back */ }
}

export const REGION_ROLE = { product: 'product', logo: 'logo', text: 'headline', sticker: 'decorative', decorative: 'decorative' };
export const REGION_COLOR = { product: '#d4ff45', logo: '#7cc4ff', text: '#ffd166', sticker: '#ff8fab', decorative: '#b794f6' };
/* Review-box visibility: a region outline is a dashed pastel stroke, which vanishes over light or
   busy artwork. outlineRegion() makes the box paint a solid dark halo first, then its own coloured
   dashed stroke on top, so it reads on any background (dark gaps between light dashes). The fill
   tint uses REGION_FILL_ALPHA (hex alpha suffix). Instance-level, so it never reaches toJSON. */
export const REGION_FILL_ALPHA = '33';
export function outlineRegion(o) {
  const base = o._render;
  o._render = function (ctx) {
    const keep = { stroke: this.stroke, strokeWidth: this.strokeWidth, strokeDashArray: this.strokeDashArray, fill: this.fill };
    this.stroke = 'rgba(12,12,16,0.7)'; this.strokeWidth = (keep.strokeWidth || 2) + 2; this.strokeDashArray = null; this.fill = null;
    base.call(this, ctx);
    Object.assign(this, keep);
    base.call(this, ctx);
  };
  return o;
}
export const REGION_NAME = { product: 'Product', logo: 'Logo', text: 'Text', sticker: 'Sticker', decorative: 'Decoration' };
const SEL_EPS = 0.0022;   // contour fidelity passed to the cv wand — smaller hugs the edge harder

/* Snaps `to` onto the nearest 45° ray from `from` — the gradient tool's Shift-constrain, matching
   Photoshop. Length is preserved (it's the projection onto the ray, not a bounding-box clamp), so
   dragging at 44° and at 46° produce the same-length axis, just mirrored about the diagonal. */
export function snapAxis(from, to, on) {
  if (!on) return to;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return to;
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

/* Local connected-component blob detection over `src` (a loaded <img> OR a <canvas>/other
   CanvasImageSource — detectObjects() passes engine.captureFlat()'s already-rendered <canvas>
   directly, no need to round-trip it through a data URL) — no OpenCV worker, no backend, just a
   background-colour-distance threshold + dilation + flood-fill on the main thread. Guarantees
   detectObjects() always returns SOMETHING even when the cv worker hasn't loaded/failed/found no
   contours (a genuinely blank OpenCV response otherwise leaves auto-detect/convert-to-layers with
   nothing to show). Returns scene-px boxes ({x,y,w,h}), sorted largest-first, capped at 40. */
async function detectBlobsLocal(src, region) {
  try {
    const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
    const maxd = 340, scale = Math.min(1, maxd / Math.max(iw, ih));
    const ew = Math.max(1, Math.round(iw * scale)), eh = Math.max(1, Math.round(ih * scale));
    const cv = document.createElement('canvas'); cv.width = ew; cv.height = eh;
    cv.getContext('2d').drawImage(src, 0, 0, ew, eh);
    const d = cv.getContext('2d').getImageData(0, 0, ew, eh).data;
    const corners = [[0, 0], [ew - 1, 0], [0, eh - 1], [ew - 1, eh - 1]].map(([x, y]) => { const i = (y * ew + x) * 4; return [d[i], d[i + 1], d[i + 2]]; });
    const bg = [0, 1, 2].map(k => Math.round(corners.reduce((s, c) => s + c[k], 0) / 4));
    const raw = new Uint8Array(ew * eh);
    for (let i = 0; i < ew * eh; i++) { const dist = Math.abs(d[i * 4] - bg[0]) + Math.abs(d[i * 4 + 1] - bg[1]) + Math.abs(d[i * 4 + 2] - bg[2]); raw[i] = (d[i * 4 + 3] > 40 && dist > 45) ? 1 : 0; }
    const r = Math.max(2, Math.round(maxd * 0.012)), tmp = new Uint8Array(ew * eh), fg = new Uint8Array(ew * eh);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) { let v = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < ew && raw[y * ew + xx]) { v = 1; break; } } tmp[y * ew + x] = v; }
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) { let v = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < eh && tmp[yy * ew + x]) { v = 1; break; } } fg[y * ew + x] = v; }
    const seen = new Uint8Array(ew * eh), stack = [], boxes = [], minArea = ew * eh * 0.0012;
    for (let s0 = 0; s0 < ew * eh; s0++) {
      if (!fg[s0] || seen[s0]) continue;
      let minx = s0 % ew, maxx = minx, miny = (s0 / ew) | 0, maxy = miny, cnt = 0;
      stack.push(s0); seen[s0] = 1;
      while (stack.length) {
        const p = stack.pop(), px = p % ew, py = (p / ew) | 0; cnt++;
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
        if (px > 0 && fg[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (px < ew - 1 && fg[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (py > 0 && fg[p - ew] && !seen[p - ew]) { seen[p - ew] = 1; stack.push(p - ew); }
        if (py < eh - 1 && fg[p + ew] && !seen[p + ew]) { seen[p + ew] = 1; stack.push(p + ew); }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (cnt >= minArea && bw > 6 && bh > 6) boxes.push({ minx, miny, bw, bh, cnt });
    }
    const kx = region.width / ew, ky = region.height / eh;
    return boxes.sort((a, b) => b.cnt - a.cnt).slice(0, 40).map(b => ({ x: region.left + b.minx * kx, y: region.top + b.miny * ky, w: b.bw * kx, h: b.bh * ky }));
  } catch (e) { return []; }
}

/* magicEdit's argument list with the optional trailing (mask, {reference}) only included when set,
   so a provider written against the old (image, instruction[, mask]) signature sees exactly that. */
function editArgs(image, text, mask, reference) {
  if (reference) return [image, text, mask || null, { reference }];
  return mask ? [image, text, mask] : [image, text];
}

export class Editor {
  constructor({ fabric, canvasEl, width = 1080, height = 1080, background = '#ffffff', voidColor = '#0a0a0c', openCvUrl } = {}) {
    if (!fabric) throw new Error('Pass fabric (v5) into the Editor — it is a peer dependency.');
    this.fabric = fabric;
    installStrokePosition(fabric);   // Border position (inside/outside) — see stroke.js
    // MaskFilter (see mask.js) only implements Fabric's Canvas2D filter path (applyTo2d), not a
    // WebGL shader — Fabric defaults to WebGL filtering whenever the browser supports it, which
    // would silently no-op a mask (and any other future custom filter) with no error. Forcing
    // Canvas2D keeps every filter (including the built-in brightness/contrast/saturation/blur,
    // which have real GLSL shaders and would otherwise run on the GPU) on one predictable,
    // correctness-first path — images here are already capped to 1600px on import, so the perf
    // cost of Canvas2D over WebGL is small in practice.
    fabric.enableGLFiltering = false;
    // W/H are the ARTBOARD's logical size — the "page" a design lives on and what exports crop
    // to. They are deliberately NOT the same thing as fc's own DOM width/height: the fabric
    // <canvas> element is sized to whatever the host's stage/container measures (it fills the
    // available viewport, like Photoshop/Figma's canvas), while the artboard is just a W×H region
    // drawn inside it via viewportTransform pan/zoom — same split as the reference editor's
    // fitView. A host that never bothers to fit a viewport still gets a sane 1:1 canvas the size
    // of the artboard (set below); one that DOES manage a stage should call fc.setDimensions() to
    // its own container size + fit the viewport on mount and on every 'resize' event this class
    // emits (resizeCanvas/applyCrop/openImage change W/H without ever touching fc's DOM size).
    this.W = width; this.H = height;
    this._listeners = {};
    this.fc = new fabric.Canvas(canvasEl, {
      width, height, preserveObjectStacking: true, selection: true,
      backgroundColor: background, stopContextMenu: true, fireRightClick: true,
      // Figma-style marquee: a thin solid border over a barely-there fill, instead of Fabric's
      // default heavy blue wash — kept independent of the app's lime accent, since a selection
      // indicator needs to read clearly over content of any colour.
      selectionColor: 'rgba(11,107,211,0.08)',
      selectionBorderColor: '#0b6bd3',
      selectionLineWidth: 1,
      // Fabric's own default binds Shift+drag on a side handle (ml/mr/mt/mb) to skew — the
      // classic Illustrator/Photoshop convention puts skew on Alt/Option instead, freeing Shift
      // for the proportional-resize behaviour _bindProportionalSideScale implements below.
      altActionKey: 'altKey',
      // Corners scale freely and Shift locks the aspect ratio (Figma/Illustrator), matching the
      // side handles in _bindProportionalSideScale. Fabric's default (true) inverts this: corners
      // are proportional and Shift frees them, so Shift+corner-drag distorted the shape.
      uniformScaling: false,
      // Draw selection handles ABOVE the off-canvas vignette below, so a handle sitting past the
      // artboard edge (dragging/resizing a layer that overflows) stays crisp and grabbable
      // instead of getting dimmed along with the content underneath it.
      controlsAboveOverlay: true,
    });
    this._voidColor = voidColor;   // see setVoidColor() / the off-canvas mask below
    this._background = background; // the artboard's starting page colour — reset() paints it back after fc.clear() nulls it
    // fabric.Canvas's OWN _renderBackground paints fc.backgroundColor across (0,0)-(fc.width,
    // fc.height) — fc's own DOM size, i.e. the host's stage — not the artboard, so it paints the
    // wrong region entirely once those two diverge (see the W/H comment above: a small artboard
    // in a big stage-sized canvas would otherwise get a giant mis-scaled white patch instead of
    // its own true page). Neutered here and replaced by the 'before:render' hook below, which
    // paints the SAME fc.backgroundColor (still the normal, live, real property — setBackground-
    // Color()/direct assignment/gradients/patterns all keep working exactly as before, including
    // 'transparent' for backgroundGapFraction's AI-extend-bg gap detection) but clipped to the
    // TRUE W×H artboard region instead.
    this.fc._renderBackground = () => {};
    this.fc.on('before:render', (opt) => {
      const bg = this.fc.backgroundColor;
      // A transparent or translucent page shows a checkerboard on screen only. fc.interactive is
      // false during toCanvasElement (exports, backgroundGapFraction), so exports keep real alpha.
      if (this.fc.interactive && opt && opt.ctx && (!bg || typeof bg !== 'string' || !/^#/.test(bg))) this._paintChecker(opt.ctx);
      if (!bg || bg === 'transparent') return;
      // Use the ctx fabric actually fired with, NOT fc.getContext() — that always returns the
      // main ON-SCREEN context, but exportPNG/exportJPEG (toCanvasElement) temporarily calls
      // renderCanvas against a throwaway export canvas's context instead; getContext() would
      // paint this fill onto the wrong canvas and leave the export transparent/blank where the
      // page should be filled.
      const ctx = (opt && opt.ctx) || this.fc.getContext();
      const v = this.fc.viewportTransform;
      ctx.save();
      ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
      ctx.fillStyle = bg.toLive ? bg.toLive(ctx, this.fc) : bg;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.restore();
    });
    // Photoshop-style off-canvas mask: a layer dragged/sized PAST the artboard edge keeps its
    // full pixels (this never touches data, purely a render-time cover) but the overflow is
    // hidden under an OPAQUE fill matching the stage's own void colour — same as Photoshop's
    // pasteboard, which fully covers spill-over rather than tinting it translucent (a
    // semi-transparent wash over saturated layer content reads muddy, not clean). Implemented by
    // taking over fc's OVERLAY slot directly — renderCanvas calls this._renderOverlay(ctx) at
    // exactly the "after objects, before controls" moment (see controlsAboveOverlay: true above),
    // so it covers content but never the selection handles drawn afterward. Gated on
    // this.fc.interactive, which fabric itself flips to false during toCanvasElement's temporary
    // render (exportPNG/exportJPEG) — so the exported image is never affected, only the live
    // on-screen view is.
    this.fc._renderOverlay = (ctx) => {
      if (!this.fc.interactive || !this._voidColor) return;
      const v = this.fc.viewportTransform;
      ctx.save();
      // Everything outside the artboard, in STAGE (untransformed) space — cheaper and simpler
      // than transforming an inverted scene-space path, and correct regardless of zoom/pan since
      // it's defined directly in canvas pixels.
      ctx.beginPath();
      ctx.rect(0, 0, this.fc.width, this.fc.height);
      const tl = fabric.util.transformPoint({ x: 0, y: 0 }, v);
      const br = fabric.util.transformPoint({ x: this.W, y: this.H }, v);
      ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.clip('evenodd');
      ctx.fillStyle = this._voidColor;
      ctx.fillRect(0, 0, this.fc.width, this.fc.height);
      ctx.restore();
    };
    // Themed selection handles + outline instead of Fabric's stock squares and faint light-blue
    // border — applied per-object on 'object:added' rather than mutating the shared
    // fabric.Object.prototype globally, so multiple Editor instances on one page (or other Fabric
    // usage outside this library) never fight over one theme.
    // Selection outline: a deep blue over a thin white halo, so it reads on any artwork — a single
    // colour can't (the old orange vanished on photos; plain blue vanishes on a blue shape).
    // Handles are white with a blue ring for the same reason. Same blue as the drag-select box (selectionBorderColor).
    const handleAccent = '#0b6bd3';
    const themeSelection = (o) => {
      o.set({
        transparentCorners: false, cornerColor: '#ffffff', cornerStrokeColor: handleAccent,
        borderColor: handleAccent, cornerSize: 11, cornerStyle: 'circle', borderScaleFactor: 1.5, padding: 2,
      });
      if (o.drawBorders.__halo) return;
      const base = o.drawBorders;
      // Fabric sets ctx.lineWidth just before this call; paint a wider white pass underneath.
      o.drawBorders = function (ctx, styleOverride) {
        const lw = ctx.lineWidth;
        ctx.save(); ctx.lineWidth = lw + 2;
        base.call(this, ctx, { ...styleOverride, borderColor: 'rgba(255,255,255,0.9)' });
        ctx.restore();
        return base.call(this, ctx, styleOverride);
      };
      o.drawBorders.__halo = true;
    };
    this.fc.on('object:added', (opt) => {
      if (opt.target) attachVectorMask(opt.target);   // vector-layer masks — see mask.js
      if (opt.target) themeSelection(opt.target);
    });
    // A multi-selection's ActiveSelection is never fc.add()ed, so it's themed as it appears.
    const themeActive = (opt) => { const a = this.fc.getActiveObject(); if (a && a.type === 'activeSelection') themeSelection(a); };
    this.fc.on('selection:created', themeActive);
    this.fc.on('selection:updated', themeActive);
    this.engine = new PaintEngine(fabric, this.fc, width, height);
    // Registers fabric.Image.filters.MaskFilter (see mask.js) — must happen before any scene
    // JSON containing a mask filter is ever restored (undo/redo, loadJSON), since Fabric's own
    // enlivenObjects() resolves a filter's class by its serialized `type` string against exactly
    // that registry.
    makeMaskFilterClass(fabric);
    makeToneFilterClass(fabric); // same registry requirement — see tone.js
    makeGeometryFilterClass(fabric); // and geometry.js
    this.history = new History(60);
    this.ai = new AIRegistry();
    // OpenCV worker RPC — boots lazily on first cv-backed call. openCvUrl overrides
    // DEFAULT_OPENCV_URL (a root-relative path — see cv/worker.js) for hosts that serve the
    // vendored opencv.js from somewhere else, or want to point at a CDN mirror instead.
    this.cv = new CvEngine(openCvUrl ? { openCvUrl } : undefined);
    this.tool = 'select';
    this.toolOpts = {
      size: 30, opacity: 1, hardness: 0.7, color: '#000000', fill: '#000000',   // black by default, like Photoshop's foreground colour
      tolerance: 64, fontSize: 48, aligned: true,
      gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }],
      addMode: false,   // sticky "keep adding every click to the selection" toggle for wand/objectselect/hoverselect
      paintNewLayer: false,   // paint tools retouch the image itself by default — see _bindPaintTarget
    };
    this.selection = null;
    this.crop = null;               // {x,y,w,h} while the crop tool is live
    this._drag = null;
    this._snap = true;
    this._polyBuild = null;         // running lasso-poly/lasso-mag vertex list
    this._penBuild = null;          // pen tool: path being drawn { nodes, closed, contId, undo, redo }
    this._pathEdit = null;          // vector edit mode: { id, nodes, closed, sel:Set }
    this._penDrag = null;           // the pen/vector-edit gesture in flight
    this._penLast = null;           // last pointer position seen by the pen (hover refresh on Alt/Shift)
    this._edgeMap = null;           // magnetic-lasso Sobel edge map, built lazily per artboard capture
    this._lastWandSeed = null;      // last object-select click, scene px — feeds selectSimilar()
    this._hoverSeq = 0;             // monotonic token so a stale async hover preview can't land late
    this._wandSeq = 0;              // monotonic token so an out-of-order wandPick RPC can't land late
    this._objBoxes = [];            // detected object boxes (scene px) for objectselect/hoverselect
    this._objRegion = null;         // {left,top,width,height} the scene rect _objSrc represents
    this._objSrc = null;            // <canvas>/<img> detection + click grabCut refine run against
    this._objCycle = null;          // {x,y,i} — repeated clicks near the same spot cycle nested candidates
    this._objSeq = 0;               // monotonic token guarding detectObjectBoxes against overlap
    this.objCount = 0;              // # of detected boxes, for a host UI's "N objects" readout
    this.multiCount = 0;            // # of polygons accumulated in an objectselect multipoly (before Merge)
    this._edgeMapSeq = 0;           // monotonic token so an in-flight buildMagneticEdgeMap can't land after a resize/crop
    this._destroyed = false;        // set by destroy() — async continuations check this before touching this.fc
    this._maskEdit = null;           // {layerId} while a mask is being painted — see enterMaskEdit()
    this._persp = null;              // {id, saved, corners, drag} while 4-corner perspective is being placed — see enterPerspectiveEdit()
    this.geometryGuide = null;       // [[{x,y},{x,y}], ...] scene-space grid shown while straightening live
    this._maskDrag = null;
    this._lastActiveId = null;      // last non-bg object the user selected/moved — see selectActiveOrCenter()
    this._cropTarget = null;        // id of the image being cropped, when crop is scoped to one layer — see setTool('crop')/applyCrop()
    this._cropRestore = null;       // pre-expand {id,left,top,cropX,cropY,width,height} to undo the "show full image" expand on cancel — see setTool('crop')/_restoreCropTarget()
    this._spaceDown = false;        // true while the spacebar is held — see _bindSpacePan()
    this._bindPointer();
    this._bindModified();
    this._bindLastActive();
    this._bindIsolation();
    this._bindSpacePan();
    this._bindProportionalSideScale();
    this._bindRoundCorners();
    this.setSnapEnabled(true);
    this.commit('init');
  }

  /* ── events: 'change' (scene), 'tool', 'selection', 'history', 'crop', 'error' (a fire-and-forget
     async call — e.g. wandPick's add/subtract on empty space — failed with nothing else to signal it) ── */
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).filter(f => f !== fn); }
  _emit(ev, data) {
    // Any scene change (an edit, undo/redo, opening an image, a canvas resize) invalidates what the
    // click-to-select tools computed from the OLD scene: Object/Hover select's captured snapshot
    // and the hover cache (keyed only by pointer cell, which the magic wand reads too). Without
    // this, a pick after e.g. opening a different-size image was mapped through the old
    // canvas — selections landed in the wrong place, even far outside the new artboard.
    if (ev === 'change' || ev === 'resize') {
      this._objSrc = null; this._objRegion = null;   // the next object pick re-captures the scene
      if (this._hoverCache) this._hoverCache.clear();
      // ...and the hover preview on screen, plus any hover pick still in flight (its seq no longer
      // matches, so _runHover drops the result) — the next pointer move recomputes it.
      this._hoverSeq = (this._hoverSeq || 0) + 1;
      this._hoverPending = null;
      if (this._hoverShown) { this._hoverShown = false; this._emit('hover', null); }
    }
    if (ev === 'hover') this._hoverShown = !!data;
    if (ev === 'selection' && !this._selRestoring) this._recordSelection(data);
    // the shape whose gradient handles are up was deleted (or undone away): drop the handles
    if (ev === 'change' && this._gradEdit && !this._byId(this._gradEdit.id)) { clearTimeout(this._gradCommitT); this._gradCommitT = null; this._gradEdit = null; this._emitGradientAxis(null); }
    (this._listeners[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } });
  }

  /* ── tools ────────────────────────────────────────────────────────────────────────────── */
  setTool(t) {
    if (!ALL_TOOLS.includes(t)) throw new Error('Unknown tool "' + t + '". Tools: ' + ALL_TOOLS.join(', '));
    const prev = this.tool;
    if (t !== prev) this._drawLayer = null;   // a new brush session starts a new paint layer
    if (CLICK_LASSOS.includes(prev) && prev !== t) this._polyBuild = null;
    // Keep/Remove touch-ups are brush strokes — another tool (even the eraser) ends them
    if (t !== 'brush' && this.toolOpts && this.toolOpts.maskRefine) { this.toolOpts.maskRefine = null; this._emit('maskrefine', null); }
    // Switching away from Pen mid-path keeps what was drawn (Figma: changing tools ends the path,
    // it doesn't throw it away) — and always tells listeners, so a host overlay that only updates
    // from 'pen' never keeps drawing an abandoned path.
    if (prev === 'pen' && t !== 'pen' && this._penBuild) { const b = this._penBuild; this._penBuild = null; this._penDrag = null; this._commitPenBuild(b); }
    // Vector edit mode survives Pen <-> Select (Figma's P / V inside a vector), anything else ends it.
    if (this._pathEdit && t !== 'pen' && t !== 'select') this.exitPathEdit();
    // Picking Pen with a path selected edits that path: add points on its segments, continue it
    // from an open end, or click away to start a new one.
    const penTarget = t === 'pen' && prev !== 'pen' && !this._pathEdit ? this.fc.getActiveObject() : null;
    // Switching TO the Select/Move tool with a live pixel selection lifts it into a movable layer
    // first — Select is move-only (drawing a marquee is what the marquee/lasso/wand tools are for),
    // so without this a selection made with any other tool would be stranded: nothing to drag it
    // with. Runs before the rest of this method's own state changes so liftSelectionToLayer sees
    // the pre-switch tool/selection and leaves its own setActiveObject as the final word.
    if (t === 'select' && prev !== 'select' && this.selection) this.liftSelectionToLayer();
    this.tool = t;
    const drawing = t !== 'select';
    this.fc.selection = !drawing;
    this.fc.defaultCursor = this._cursorForTool(t);
    this.fc.getObjects().forEach(o => { o.selectable = !drawing && !o.locked; o.evented = !drawing && !o.locked; });
    if (prev === 'crop' && t !== 'crop') this._restoreCropTarget();
    if (this._persp) this.cancelPerspectiveEdit();
    if (t === 'crop') {
      // Cropping a selected image layer crops just that image (native Fabric cropX/cropY/width/
      // height) instead of the whole artboard — but only when it's unrotated: the crop rect below
      // is drawn in scene space, and mapping that back into a rotated image's own local space is
      // more than this simple rect UI is worth. Same _lastActiveId fallback as gradient/_maskable
      // above, since setTool() is about to discardActiveObject() a few lines down.
      const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      const target = active && active.type === 'image' && active.role !== 'bg' && !(active.angle % 360) ? active : null;
      // Any other layer (shape, path, text, group) has no pixel window to move, so it's cropped
      // with a rect clipPath instead — see _cropClipTarget/applyCrop.
      const clipTarget = !target && this._cropClipTarget(active) ? active : null;
      this._cropTarget = (target || clipTarget) ? (target || clipTarget).id : null;
      if (clipTarget) {
        // Re-cropping shows the whole shape again with the box on the previous crop window, same
        // as an image; _restoreCropTarget() puts the old clip back if the user leaves without applying.
        const prev = clipTarget.clipPath || null;
        this._cropRestore = { id: clipTarget.id, clipPath: prev };
        const b = clipTarget.getBoundingRect(true, true);
        this.crop = prev ? this._clipSceneRect(clipTarget, prev) : { x: b.left, y: b.top, w: b.width, h: b.height };
        clipTarget.clipPath = null; clipTarget.dirty = true;
      } else if (target) {
        // Re-cropping an already-cropped image must show the FULL original source again (not just
        // the sliver currently visible) with the box seeded to the PREVIOUS crop window — "show the
        // whole image with the current crop selected," same as a fresh crop but starting from
        // wherever you left off instead of losing everything outside the last crop. Fabric's
        // cropX/cropY/width/height only ever hide part of _element; the full-res source is always
        // still there, so this is purely a visual expand-back, undone by _restoreCropTarget() if the
        // user leaves crop without applying (see prev === 'crop' above) and re-applied by
        // applyCrop()'s existing math (which already works against whatever state the object is in).
        const el = target._element;
        this._cropRestore = { id: target.id, left: target.left, top: target.top, cropX: target.cropX || 0, cropY: target.cropY || 0, width: target.width, height: target.height };
        const { left, top, width, height } = target.getBoundingRect(true);   // previous crop window, in {x,y,w,h} shape
        const prevWindow = { x: left, y: top, w: width, h: height };
        const sx = target.scaleX || 1, sy = target.scaleY || 1;
        target.set({
          left: target.left - (target.cropX || 0) * sx, top: target.top - (target.cropY || 0) * sy,
          cropX: 0, cropY: 0, width: el.naturalWidth || el.width, height: el.naturalHeight || el.height,
        });
        target.dirty = true;
        target.setCoords();
        this.crop = prevWindow;
      } else {
        this._cropRestore = null;
        // Whole-artboard crop (no eligible image target) always starts flush to the current
        // artboard — the whole canvas is "selected," matching a fresh entry.
        this.crop = { x: 0, y: 0, w: this.W, h: this.H };
      }
    } else { this.crop = null; this._cropTarget = null; }
    if (t === 'lasso-mag' && !this._edgeMap) this.buildMagneticEdgeMap();
    if ((t === 'objectselect' || t === 'hoverselect') && !this._hoverCache) this._hoverCache = new HoverCache(400);
    // Entering Object select / Hover select (from a different tool) (re)runs detection so the click
    // handler has fresh boxes to test against — matches the reference editor running its own
    // detectObjectsLocal() on the same transition. Re-entering the SAME tool (e.g. a host re-calling
    // setTool('objectselect') on every render) must not re-detect on every call.
    if ((t === 'objectselect' || t === 'hoverselect') && prev !== t) this.detectObjectBoxes(true);
    // Leaving objectselect/hoverselect drops the last hover point so a stale in-flight hover RPC
    // (an async cv.wand call started before the switch) can't land after the fact and emit a
    // 'hover' event a host UI would otherwise keep drawing forever with no tool active to clear it.
    if ((prev === 'objectselect' || prev === 'hoverselect') && t !== prev) { this._hoverPt = null; this._objCycle = null; }
    // Leaving clone/heal drops the source: coming back later to a stale source point you can no
    // longer see the origin of is more surprising than being asked to alt-click again.
    if ((prev === 'clone' || prev === 'heal') && t !== 'clone' && t !== 'heal') this.clearCloneSource();
    if (!PAINT_TOOLS.includes(t) && this._brushCursor) { this._brushCursor = null; this._emit('brushcursor', null); }
    if (t !== 'gradient' && (this._gradAxis || this._gradEdit)) { this._gradEdit = null; this._emitGradientAxis(null); }
    // Coming back to Gradient with a shape whose fill is a dragged gradient: show its handles.
    if (t === 'gradient' && prev !== 'gradient') {
      const a = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      if (a) this._beginGradEdit(a);
    }
    if (drawing) this.fc.discardActiveObject();
    if (penTarget && this.isEditablePath(penTarget)) this.editPath(penTarget.id);
    if (this._pathEdit) this._lockForPathEdit();
    this.fc.renderAll();
    this._emit('tool', t);
    this._emit('crop', this.crop);
    if (this._pathEdit || t === 'pen') this._emitPen();
  }

  /* Paint tools hide the OS cursor entirely — the shells draw a brush-footprint ring at the pointer
     instead, which is the only thing that shows the real stamp size (and, for clone/heal, where
     pixels are being sampled from); a 'crosshair' would just sit on top of it. */
  _cursorForTool(t) {
    if (t === 'hand') return 'grab';
    if (t === 'type') return 'text';
    if (PAINT_TOOLS.includes(t)) return 'none';
    if (t === 'pen') return penCursor('pen');
    return t === 'select' ? 'default' : 'crosshair';
  }

  setToolOptions(patch) {
    this.toolOpts = { ...this.toolOpts, ...patch };
    this._emit('tooloptions', this.toolOpts);
    // Editing the stops while a shape's gradient handles are up restyles that shape (one undo
    // step per burst, so dragging a colour picker isn't fifty history entries).
    const ge = patch.gradientStops && this._gradEdit && this._byId(this._gradEdit.id);
    if (ge) {
      this._applyObjectGradient(ge, this._gradEdit.from, this._gradEdit.to);
      this._emitGradientAxis(this._gradEdit.from, this._gradEdit.to);
      clearTimeout(this._gradCommitT);
      this._gradCommitT = setTimeout(() => { this._gradCommitT = null; this.commit('gradient-fill'); }, 300);
    }
    // A size/hardness change must resize the ring under a stationary pointer, not wait for a move.
    if (this._brushCursor && (patch.size != null || patch.hardness != null)) {
      this._brushCursor = { ...this._brushCursor, size: this.toolOpts.size, hardness: this.toolOpts.hardness };
      this._emit('brushcursor', this._brushCursor);
      this.fc.requestRenderAll();
    }
  }

  /* ── pointer plumbing (scene coordinates come from fabric's own transform) ─────────────── */
  _pt(opt) { return this.fc.getPointer(opt.e); }

  _bindPointer() {
    const fc = this.fc;
    // Right button (fireRightClick delivers it as mouse:down/up with button 3) is never a tool
    // click — it opens the context menu, via the native contextmenu event below (which also
    // covers Ctrl-click on a Mac and the keyboard's menu key).
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const isRight = (opt) => !!opt && (opt.button === 3 || (opt.e && (opt.e.button === 2 || (isMac && opt.e.ctrlKey && opt.e.button === 0))));
    fc.on('mouse:down', (opt) => { if (!isRight(opt)) this._down(opt); });
    fc.on('mouse:move', (opt) => this._move(opt));
    fc.on('mouse:up', (opt) => { if (!isRight(opt)) this._up(); });
    this._onCtxMenu = (e) => {
      e.preventDefault();
      this.openContextMenu(this.fc.getPointer(e), { x: e.clientX, y: e.clientY });
    };
    if (fc.upperCanvasEl) fc.upperCanvasEl.addEventListener('contextmenu', this._onCtxMenu);
    // Double-click a path (Select tool) to edit its points; inside edit mode, double-click a
    // point to toggle corner/smooth, or a segment to add a point there.
    fc.on('mouse:dblclick', (opt) => {
      if (this.tool !== 'select') return;
      const pe = this._pathEdit;
      if (!pe) { if (opt.target && this.isEditablePath(opt.target)) this.editPath(opt.target.id); return; }
      const hit = this._penHit(this._pt(opt), opt.e || {});
      if (hit.kind === 'anchor' || hit.kind === 'continue') {
        toggleSmooth(pe.nodes, pe.closed, hit.i);
      } else if (hit.kind === 'segment') {
        pe.sel = new Set([splitSegment(pe.nodes, pe.closed, hit.seg, hit.t)]);
      } else return;
      this._writePathEdit(); this.commit('path-edit'); this._emitPen();
    });
    // Leaving the canvas must drop the brush ring, or it stays frozen at the last point it saw.
    fc.on('mouse:out', (opt) => { if (!opt || !opt.target) { this._brushCursor = null; this._emit('brushcursor', null); } });
    /* Wheel zoom around the cursor. The old 0.999^deltaY curve felt dead: a trackpad pinch
       (ctrlKey, deltaY ~1-10 per event) moved <1%, and Firefox's line-mode deltas (~3) did nothing.
       Normalize line/page deltas to px, give pinch its own steeper rate, and cap a single event so
       a fast free-spinning wheel can't jump several levels at once. */
    fc.on('mouse:wheel', (opt) => {
      const e = opt.e;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;        // lines
      else if (e.deltaMode === 2) delta *= 400;  // pages
      delta = Math.max(-120, Math.min(120, delta));
      const rate = e.ctrlKey ? 0.985 : 0.998;    // pinch vs wheel/scroll
      let z = fc.getZoom() * Math.pow(rate, delta);
      z = Math.min(5, Math.max(0.1, z));
      fc.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, z);
      opt.e.preventDefault(); opt.e.stopPropagation();
      this._emit('zoom', z);
    });
  }

  _applySelClip() {
    this.engine.setClip(selectionToPath2D(this.selection, this.W, this.H), selectionFillRule(this.selection));
  }

  /* Paint tools edit the ORIGINAL image in place by default — that's what the clone stamp and
     healing brush are for (you sample a clean patch and paint the blemish out of the photo itself),
     and retouching on the image is what every other pixel tool does in a photo editor too. Turning
     on `paintNewLayer` restores the old behavior (strokes accumulate on a separate paint layer),
     which keeps the edit non-destructive at the cost of not really editing the image.

     The target keeps its OWN pixel resolution and its own transform: a 4000px photo placed on a
     1000px artboard is retouched at 4000px, so no detail is lost and the layer isn't silently
     resampled. The scene->layer mapping is handed to the engine, which bakes it into the drawing
     context (see PaintEngine#_inTargetSpace) so every tool keeps working in plain scene px. */
  _bindPaintTarget() {
    const draw = DRAW_TOOLS.includes(this.tool);
    // The eraser always erases the selected (or top) layer: "paint on a new layer" would point it at
    // an empty paint layer, where it can't remove anything — so that option doesn't apply to it.
    if (this.toolOpts.paintNewLayer && !draw && this.tool !== 'eraser') { this.engine.setDirectTarget(null); return; }
    const target = draw ? this._drawTargetLayer() : this._paintTargetLayer();
    if (!target) { this.engine.setDirectTarget(null); return; }
    // Re-bind only when the target changed: a mid-stroke re-rasterize would throw away the dabs
    // already painted into the scratch canvas this stroke.
    if (this.engine._direct && this.engine._direct.layer === target) return;
    // A paint layer is kept trimmed to its painted pixels between strokes (see _trimPaintLayer), so
    // grow it back over the whole artboard first — otherwise the new stroke clips at the old box.
    if (target.role === 'paint') this._expandPaintLayer(target);
    const xf = this._sceneToLayer(target);
    if (!xf) { this.engine.setDirectTarget(null); return; }
    const el = target._element;
    const cv = document.createElement('canvas');
    cv.width = xf.w; cv.height = xf.h;
    // Draw the layer's CURRENT source (crop window included) 1:1 into the scratch canvas — this is
    // the layer's own pixels, untouched by the artboard's resolution.
    try { cv.getContext('2d').drawImage(el, xf.cropX, xf.cropY, xf.w, xf.h, 0, 0, xf.w, xf.h); }
    catch (e) { this.engine.setDirectTarget(null); return; }
    this.engine.setDirectTarget(target, cv, xf);
  }

  /* Maps scene px onto `o`'s own pixel grid: {scale, dx, dy} such that
     target_px = scene_px * scale + d. Only axis-aligned, unflipped layers qualify — a rotated or
     mirrored image would need a full affine inverse, and every caller here draws with a plain
     translate/scale. Returns null when the layer can't be targeted safely. */
  _sceneToLayer(o) {
    if (!o._element) return null;
    if (o.angle % 360 !== 0 || o.flipX || o.flipY) return null;
    const sx = o.scaleX || 1, sy = o.scaleY || 1;
    // Non-uniform scaling would need separate x/y factors throughout the engine (brush dabs are
    // circles, so they'd have to become ellipses) — not worth it; fall back to a paint layer.
    if (Math.abs(sx - sy) > 1e-6) return null;
    const w = Math.round(o.width), h = Math.round(o.height);
    if (!(w > 0 && h > 0)) return null;
    const b = o.getBoundingRect(true);   // scene-space top-left of the drawn image
    return { scale: 1 / sx, dx: -b.left / sx, dy: -b.top / sx, w, h, cropX: o.cropX || 0, cropY: o.cropY || 0 };
  }

  /* Brush/pencil draw onto a paint layer of their own, never into the photo: the selected paint
     layer if there is one, else the one this brush session already made (so a scribble built from
     several strokes stays one layer), else a new one. The session ends when the tool changes. */
  _drawTargetLayer() {
    const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (active && active.role === 'paint' && !active.locked && this.fc.getObjects().includes(active)) return active;
    const cur = this._drawLayer;
    if (cur && !cur.locked && this.fc.getObjects().includes(cur)) return cur;
    const cv = document.createElement('canvas'); cv.width = this.W; cv.height = this.H;
    // Non-selectable while a drawing tool is active, same as PaintEngine#ensure's layer (else
    // Fabric latches a drag onto it at the stroke's first point); setTool('select') flips it back.
    const img = new this.fabric.Image(cv, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: false, evented: false });
    img.set({ id: uid(), role: 'paint', name: 'Paint ' + (this.fc.getObjects().filter(o => o.role === 'paint').length + 1) });
    this.fc.add(img);
    this._drawLayer = img;
    return img;
  }

  /* Paint layers only trim/grow when that's a pure translate: axis-aligned, uniformly scaled,
     left/top origin, and no mask (a mask canvas is sized to the layer and would drift). */
  _paintResizable(o) {
    return !!o && o._element && o.originX === 'left' && o.originY === 'top' && !o.maskCanvas
      && o.angle % 360 === 0 && !o.flipX && !o.flipY && Math.abs((o.scaleX || 1) - (o.scaleY || 1)) < 1e-6;
  }
  // Swap in a new backing canvas whose pixel (0,0) sits at the old pixel (x0,y0), without moving
  // anything on the artboard.
  _repixelPaintLayer(o, cv, x0, y0) {
    const s = o.scaleX || 1;
    o.setElement(cv);
    o.set({ cropX: 0, cropY: 0, left: o.left + x0 * s, top: o.top + y0 * s });
    o.setCoords();
    o.dirty = true;
  }
  _expandPaintLayer(o) {
    if (!this._paintResizable(o)) return;
    const s = o.scaleX || 1, w = Math.round(o.width), h = Math.round(o.height);
    // The artboard, in the layer's own pixel space — the new canvas covers it and the old pixels.
    const x0 = Math.floor(Math.min(0, -o.left / s)), y0 = Math.floor(Math.min(0, -o.top / s));
    const x1 = Math.ceil(Math.max(w, (this.W - o.left) / s)), y1 = Math.ceil(Math.max(h, (this.H - o.top) / s));
    if (x0 === 0 && y0 === 0 && x1 === w && y1 === h && !o.cropX && !o.cropY) return;
    const cv = document.createElement('canvas'); cv.width = x1 - x0; cv.height = y1 - y0;
    try { cv.getContext('2d').drawImage(o._originalElement || o._element, o.cropX || 0, o.cropY || 0, w, h, -x0, -y0, w, h); } catch (e) { return; }
    this._repixelPaintLayer(o, cv, x0, y0);
  }
  // Shrink a paint layer to the bounding box of its painted (non-transparent) pixels, so selecting
  // it frames the drawing rather than the whole artboard. An empty layer is left as it is.
  _trimPaintLayer(o) {
    if (!this._paintResizable(o)) return;
    const el = o._originalElement || o._element;
    const w = Math.round(o.width), h = Math.round(o.height);
    let data;
    try {
      const src = el instanceof HTMLCanvasElement && !o.cropX && !o.cropY && el.width === w && el.height === h ? el
        : (() => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(el, o.cropX || 0, o.cropY || 0, w, h, 0, 0, w, h); return c; })();
      data = src.getContext('2d').getImageData(0, 0, w, h).data;
    } catch (e) { return; }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3]) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw === w && bh === h) return;
    const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
    cv.getContext('2d').drawImage(el, (o.cropX || 0) + minX, (o.cropY || 0) + minY, bw, bh, 0, 0, bw, bh);
    this._repixelPaintLayer(o, cv, minX, minY);
  }

  /* Which layer the paint tools retouch: the active one if it holds pixels, else the topmost
     image (the photo you opened), else the topmost paint layer. */
  /* The eraser's target when it's a vector layer (shape, path, text, group): the selected (or
     last-selected) layer, same rule as _paintTargetLayer. Such layers are erased through a mask. */
  _vectorEraseTarget() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    return o && !o.locked && isVectorMaskable(o) && this.fc.getObjects().includes(o) ? o : null;
  }

  _paintTargetLayer() {
    const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (active && !active.locked && (active.type === 'image' || active.role === 'paint')) return active;
    const objs = this.fc.getObjects().filter(o => !o.locked && (o.type === 'image' || o.role === 'paint'));
    return objs.length ? objs[objs.length - 1] : null;
  }

  /* The gradient's live axis, for the shells to draw as a draggable-looking guide line. Without it
     the only feedback is the painted result itself, which makes the angle and especially the
     falloff length pure guesswork — every other editor shows this line while you drag.
     `type` is echoed so a radial gradient can be drawn as a radius + circle instead of an axis. */
  /* Topmost shape under `pt` that a gradient can fill: a visible, unlocked, top-level vector layer
     with a fill (shapes, filled paths, text). Images, paint layers and the background are never
     picked this way — dragging over them paints, as before. Drawing tools turn Fabric's own
     hit-testing off (evented:false), hence the manual walk. */
  _gradientShapeAt(pt) {
    const P = new this.fabric.Point(pt.x, pt.y);
    const FILLABLE = ['rect', 'ellipse', 'circle', 'triangle', 'polygon', 'path', 'i-text', 'text', 'textbox'];
    const objs = this.fc.getObjects();
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (!o.visible || o.locked || !o.id || o.role === 'bg' || o.role === 'paint' || o.excludeFromExport) continue;
      if (!FILLABLE.includes(o.type) || (o.type === 'path' && !o.fill)) continue;
      if (!o.aCoords) o.setCoords();
      if (o.containsPoint(P, null, true, true)) return o;
    }
    return null;
  }

  /* Re-open handles on an object whose fill is a pixel-unit linear gradient (what dragging makes);
     its stops become the tool's stops so re-aiming keeps the same colours. */
  _beginGradEdit(o) {
    const g = o && o.type !== 'activeSelection' && o.fill && typeof o.fill === 'object' && o.fill.type === 'linear' && o.fill.gradientUnits !== 'percentage' ? o.fill : null;
    if (!g || !o.id) return false;
    const c = g.coords;
    const from = this._gradLocalToScene(o, { x: c.x1, y: c.y1 }), to = this._gradLocalToScene(o, { x: c.x2, y: c.y2 });
    // Fabric holds resolved rgba() strings; the stop editors (and <input type=color>) want hex + alpha.
    this.toolOpts = { ...this.toolOpts, gradientType: 'linear', gradientStops: (g.colorStops || []).map(s => ({ offset: s.offset, ...splitGradientStopColor(s.color) })) };
    this._emit('tooloptions', this.toolOpts);
    this._gradEdit = { id: o.id, from, to };
    this._emitGradientAxis(from, to);
    return true;
  }
  /* Slider drags fire dozens of inputs: apply each live, but record ONE undo step once the burst
     settles (or right away if something else needs history first — see _flushLiveCommit). */
  _liveCommit(label) {
    clearTimeout(this._liveCommitT);
    this._liveCommitLabel = label;
    this._liveCommitT = setTimeout(() => { this._liveCommitT = null; this.commit(label); }, 300);
  }
  _flushLiveCommit() {
    if (!this._liveCommitT) return;
    clearTimeout(this._liveCommitT); this._liveCommitT = null;
    this.commit(this._liveCommitLabel || 'edit');
  }
  _flushGradCommit() {
    if (!this._gradCommitT) return;
    clearTimeout(this._gradCommitT); this._gradCommitT = null;
    this.commit('gradient-fill');
  }
  _endGradEdit() {
    this._flushGradCommit();
    this._gradEdit = null;
    this._emitGradientAxis(null);
  }
  /* 'from' | 'to' | 'line' | null — the ends' dots on the axis and the line between them. The
     colour swatches are _gradStopHit's. */
  _gradHit(pt) {
    const g = this._gradEdit;
    if (!g) return null;
    const z = this.fc.getZoom() || 1, tol = 9 / z;
    const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y, len = Math.hypot(dx, dy);
    const nx = len ? -dy / len : 0, ny = len ? dx / len : 0, off = 22 / z;
    const near = (p) => Math.hypot(pt.x - p.x, pt.y - p.y) <= tol;
    for (const which of ['to', 'from']) if (near(g[which])) return which;
    if (len > 0) {
      const t = ((pt.x - g.from.x) * dx + (pt.y - g.from.y) * dy) / (len * len);
      if (t > 0 && t < 1 && Math.hypot(pt.x - (g.from.x + dx * t), pt.y - (g.from.y + dy * t)) <= 6 / z) return 'line';
    }
    return null;
  }
  /* Index (into toolOpts.gradientStops) of the colour swatch under `pt`, or -1. Swatches sit
     22 screen-px to the side of each stop's point on the axis — same geometry the shells' 
     drawGradientAxis uses. */
  _gradStopHit(pt) {
    const g = this._gradEdit, a = this._gradAxis;
    if (!g || !a) return -1;
    const z = this.fc.getZoom() || 1;
    const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y, len = Math.hypot(dx, dy);
    if (!len) return -1;
    const nx = -dy / len, ny = dx / len, off = 22 / z;
    let best = -1, bd = 11 / z;
    a.stops.forEach(st => {
      if (st.i == null) return;
      const d = Math.hypot(pt.x - (g.from.x + dx * st.offset + nx * off), pt.y - (g.from.y + dy * st.offset + ny * off));
      if (d <= bd) { bd = d; best = st.i; }
    });
    return best;
  }
  _gradSwatchPoint(i) {
    const g = this._gradEdit, a = this._gradAxis, st = a && a.stops.find(s => s.i === i);
    if (!g || !st) return null;
    const z = this.fc.getZoom() || 1;
    const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y, len = Math.hypot(dx, dy) || 1;
    return { x: g.from.x + dx * st.offset - dy / len * 22 / z, y: g.from.y + dy * st.offset + dx / len * 22 / z };
  }
  /* Recolour one stop (index into toolOpts.gradientStops) — the shape being edited follows live
     (see setToolOptions). Keeps the stop's own alpha. */
  setGradientStopColor(i, color) {
    const stops = (this.toolOpts.gradientStops || []).slice();
    if (!stops[i]) return;
    stops[i] = { ...stops[i], color };
    this.setToolOptions({ gradientStops: stops });
  }
  _emitGradientAxis(from, to) {
    this._gradAxis = from ? {
      from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
      type: this.toolOpts.gradientType || 'linear',
      // The stops ride along the axis as colour swatches (Figma-style), so the shell needs both
      // each stop's colour and its 0..1 position to place them.
      // `i` is the stop's index in toolOpts.gradientStops (normalizing sorts them), so a click on a
      // swatch can recolour the right one.
      stops: (() => {
        const src = this.toolOpts.gradientStops || [], clamp = (v) => Math.max(0, Math.min(1, v));
        const order = src.length ? src.map((_, i) => i).sort((a, b) => clamp(src[a].offset) - clamp(src[b].offset)) : [];
        return normalizeGradientStops(src).map((s, k) => ({ offset: s.offset, color: s.color, i: order.length ? order[k] : null }));
      })(),
    } : null;
    this._emit('gradientaxis', this._gradAxis);
    this.fc.requestRenderAll();
  }

  /* Brush/clone cursor state for the shells. A plain 'crosshair' tells you nothing about the brush
     footprint, and clone/heal give no clue a source must be picked — so every paint-tool move
     publishes the ring radius plus, for clone/heal, the anchored source point. */
  _emitBrushCursor(pt, alt, shift) {
    const t = this.tool;
    const cur = { tool: t, x: pt.x, y: pt.y, size: this.toolOpts.size || 20, hardness: this.toolOpts.hardness };
    if (t === 'clone' || t === 'heal') {
      const cs = this.engine.cloneState();
      cur.src = cs.src;
      // Shift re-sources just like Alt (see PaintEngine#down), so it must show the same reticle.
      cur.picking = alt || shift || !cs.src;
    }
    this._brushCursor = cur;
    this._emit('brushcursor', cur);
  }

  /* Clone/heal source, so a shell can show it in a status line / clear it from a button. */
  get cloneSource() { const cs = this.engine.cloneState(); return cs.src; }
  clearCloneSource() {
    this.engine.clearCloneSource();
    this._emit('clonesource', null);
    this.fc.requestRenderAll();
  }

  _down(opt) {
    const t = this.tool, pt = this._pt(opt), e = opt.e || {};
    const o = { ...this.toolOpts, alt: e.altKey, shift: e.shiftKey };
    if (this._maskEdit && (t === 'brush' || t === 'pencil' || t === 'eraser')) {
      const layer = this._byId(this._maskEdit.layerId);
      if (layer && layer.maskCanvas) {
        // Keep/Remove touch-up: paint white/black now, re-cut around the stroke on mouseup
        if (this._refineActive(layer)) {
          const keep = this.toolOpts.maskRefine === 'keep';
          this._refineStroke = { keep, r: Math.max(1, (o.size || 20) / 2), pts: [pt] };
          Object.assign(o, { color: keep ? '#ffffff' : '#000000', opacity: 1 });
        } else this._refineStroke = null;
        this._maskPaint(layer, pt, null, o, t === 'eraser');
        this._refreshMaskFilter(layer);
        this._maskDrag = pt;
        this.fc.requestRenderAll();
      }
      return;
    }
    if (t === 'hand' || this._spaceDown) {
      this._drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      this.fc.setCursor('grabbing');
      return;
    }
    if (this._persp) {
      // perspective edit owns the pointer: grab a corner handle or do nothing
      this._persp.drag = this._perspHit(pt);
      this._emitPerspective();
      return;
    }
    if ((t === 'pen' || this._pathEdit) && this._penDown(pt, e)) return;
    if (t === 'select' && e.altKey) {
      const target = this.fc.findTarget(e);
      if (target && target.selectable && !target.locked) {
        // Left behind at the drag's start position once the drag actually completes — see
        // object:modified below. We don't clone up front: Fabric has already latched its own
        // transform onto `target` by the time this handler runs, so the object visibly dragged
        // is always the original; the copy is inserted where it started, once movement is real.
        this._altDup = { id: target.id, left: target.left, top: target.top };
      }
    }
    if (PAINT_TOOLS.includes(t)) {
      this._applySelClip();
      const vtarget = t === 'eraser' && this._vectorEraseTarget();
      if (vtarget) {
        // Erasing a vector layer paints black into its mask instead — the layer stays editable.
        if (!vtarget.maskCanvas) this._addVectorMask(vtarget);
        this._maskPaint(vtarget, pt, null, { ...o, color: '#000000' }, false);
        this._refreshMaskFilter(vtarget);
        this._drag = { kind: 'vmask-erase', id: vtarget.id, last: pt };
        this._emitBrushCursor(pt, !!e.altKey, !!e.shiftKey);
        return;
      }
      this._bindPaintTarget();
      const r = this.engine.down(t, pt, o);
      // A source-set click is not a stroke — leaving _drag set would make the following move paint.
      this._drag = r === 'src-set' ? null : { kind: 'paint' };
      if (r === 'src-set') this._emit('clonesource', { x: pt.x, y: pt.y });
      this._emitBrushCursor(pt, !!e.altKey, !!e.shiftKey);
      return;
    }
    if (t === 'marquee' || t === 'marquee-ellipse' || t === 'lasso') {
      // A rect/ellipse marquee's own selection is grabbable, crop-style: clicking one of its 8
      // handles (or its interior) resizes/moves it instead of starting a brand-new selection —
      // otherwise every click-drag on top of an existing marquee would just replace it, and the
      // only way to nudge a selection's edge would be to redraw the whole thing from scratch.
      // Shift-drag adds to / Alt-drag subtracts from an existing selection (Photoshop, and what the
      // wand tools already do); the new shape is drawn on its own and combined on release.
      const combine = this.selection && !this.selection.invert ? (e.shiftKey ? 'add' : e.altKey ? 'sub' : null) : null;
      if (!combine && t !== 'lasso' && this.selection && (this.selection.kind === 'rect' || this.selection.kind === 'ellipse')) {
        const handle = getSelectionHandle(this.selection, pt, this.fc.getZoom());
        if (handle) { this._drag = { kind: 'resize-sel', handle, last: pt, down: pt }; return; }
      }
      const base = this.selection;
      this.selection = startSelection(t, pt);
      this._drag = { kind: 'sel', combine, base };
      return;
    }
    if (CLICK_LASSOS.includes(t)) {
      const p = t === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      if (!this._polyBuild) this._polyBuild = startPolyBuild();
      // closeDist (how near the first vertex a click must land to close the loop) is scene px, so
      // without dividing by zoom it's a fixed on-CANVAS distance that becomes a tiny, easy-to-miss
      // target on screen once zoomed out (or an oversized hair-trigger zone once zoomed in) — same
      // zoom-independence bug getCropHandle/getSelectionHandle's own `12 / z` tolerance avoids.
      const next = polyBuildAdd(this._polyBuild, p, 12 / (this.fc.getZoom() || 1));
      this._polyBuild = next;
      if (next.closed) { this.finishPolyLasso(); return; }
      this.selection = { kind: 'poly', pts: next.pts.slice(), building: true };
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return;
    }
    if (t === 'wand') {
      this._trackPick(this.wandPick(pt, { add: e.shiftKey || this.toolOpts.addMode, subtract: e.altKey }), pt);
      return;
    }
    if (t === 'objectselect-bbox') {
      this.selectActiveOrCenter();
      return;
    }
    if (t === 'aiinsert') {
      // Clicking INSIDE an active selection opens region mode: the AI result fills exactly that
      // shape (see aiInsertAt). Otherwise it's a plain insert-at-point. No drag/up handling — the
      // host UI owns the prompt popover and calls aiInsertAt() itself once the user submits.
      const box = this.selection ? selectionBounds(this.selection, this.W, this.H) : null;
      const region = !!(box && pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h);
      this._emit('aiinsert', { pt, region });
      return;
    }
    if (t === 'objectselect' || t === 'hoverselect') {
      const add = e.shiftKey || this.toolOpts.addMode;
      // Set unconditionally, even on a cache-hit that skips selectObjectAt (the click's own seed
      // setter) — selectSimilar() reads this, so a click landing on an already-hovered/cached mask
      // must still update it, or Similar would search from a stale earlier click point.
      this._lastWandSeed = pt;
      // A second click landing near the same spot as the last one cycles through nested candidate
      // boxes (smallest already won the first click; this lets a click reach the bigger object
      // underneath it) instead of just re-picking the same innermost object every time.
      const cyc = !!(this._objCycle && Math.abs(this._objCycle.x - pt.x) < 10 && Math.abs(this._objCycle.y - pt.y) < 10);
      const cached = !cyc && this._hoverCache && this._hoverCache.get(this._hoverCellKey(pt));
      if (cached) this._commitObjectPoly(cached, { add, subtract: e.altKey });
      else this._trackPick(this.selectObjectAt(pt, { add, subtract: e.altKey, cycle: true }), pt);
      return;
    }
    if (t === 'magicwand') {
      const add = e.shiftKey || this.toolOpts.addMode;
      const cached = this._hoverCache && this._hoverCache.get(this._hoverCellKey(pt));
      if (cached) this._commitPoly(cached, { add, subtract: e.altKey });
      else this._trackPick(this.wandPick(pt, { add, subtract: e.altKey }), pt);
      return;
    }
    if (SHAPE_TOOLS.includes(t)) {
      const obj = makeShape(this.fabric, t, pt, this.toolOpts);
      if (obj) {
        this.fc.add(obj); this.fc.setActiveObject(obj);
        this._drag = { kind: 'shape', tool: t, obj, from: pt };
      }
      return;
    }
    if (t === 'type') {
      const txt = makeText(this.fabric, pt, this.toolOpts);
      this.fc.add(txt); this.fc.setActiveObject(txt);
      if (txt.enterEditing) {
        txt.enterEditing();
        txt.selectAll();   // placeholder text starts selected, so typing replaces it immediately
      }
      this.commit('text');
      // Back to select: like every other creation tool (see SHAPE_TOOLS' _up), so the next click
      // hits the canvas normally — Fabric's own double-click-to-edit, not "place another text".
      this.setTool('select');
      return;
    }
    if (t === 'bucket') {
      if (this.selection) this._applySelClip();
      else {
        // No selection: fill the contiguous area of similar colour under the click (Photoshop's
        // paint bucket), not the whole artboard.
        this.engine.captureFlat();
        const area = this.engine._flat && wandSelect(this.engine._flat, pt, 32);
        if (!area) return;
        this.engine.setClip(selectionToPath2D(area, this.W, this.H), selectionFillRule(area));
      }
      this.engine.fill(this.toolOpts.color);
      this.engine.setClip(null);
      this.commit('bucket');
      return;
    }
    if (t === 'gradient') {
      // Dragging on a vector shape (or, off any shape, onto the active one) with no pixel
      // selection applies the gradient directly as that object's own fill (scales/rotates with it, Fabric's native gradient)
      // instead of painting a raster stripe into the paint layer — same "object gradient" mode
      // the reference editor's own gradient tool has, just generalized to Canvasmith's multi-stop
      // gradientStops instead of a hardcoded 2-color pair. bg is excluded unless it's a plain
      // rect (a bg IMAGE shouldn't silently lose its pixels to a gradient fill), matching the
      // reference editor's own `o.role !== 'bg' || o.type === 'rect'` condition exactly.
      // Same _lastActiveId fallback as selectActiveOrCenter() (objectselect-bbox) — setTool()
      // already discarded Fabric's own active object by the time this click lands, since
      // 'gradient' is a drawing tool like any other.
      // An object gradient stays editable after the drag (Figma-style): its axis handles remain
      // on screen until you click outside the shape. Grab an end (its dot or colour swatch) to
      // re-aim it, the line to slide the whole ramp; a drag elsewhere inside the shape redraws it.
      const ge = this._gradEdit && this._byId(this._gradEdit.id);
      if (ge) {
        // A colour swatch: click it to pick that stop's colour; drag an end's swatch to re-aim the
        // gradient (like its dot), or a middle stop's to slide it along the axis.
        const si = this._gradStopHit(pt);
        if (si >= 0) {
          const off = Math.max(0, Math.min(1, this.toolOpts.gradientStops[si].offset));
          const which = off <= 0 ? 'from' : off >= 1 ? 'to' : null;
          this._drag = { kind: which ? 'grad-handle' : 'grad-stop', which, stop: si, obj: ge, moved: false, down: pt };
          return;
        }
        const hit = this._gradHit(pt);
        if (hit === 'from' || hit === 'to') { this._drag = { kind: 'grad-handle', which: hit, obj: ge, moved: false, down: pt }; return; }
        if (hit === 'line') { this._drag = { kind: 'grad-move', obj: ge, down: pt, start: { ...this._gradEdit }, moved: false }; return; }
      }
      // The shape under the pointer is the target — no need to go back and select it first. A drag
      // that starts on a different shape than the one being edited simply moves on to that one.
      const under = !this.selection && this._gradientShapeAt(pt);
      if (under) {
        if (ge && ge !== under) this._endGradEdit();
        this._lastActiveId = under.id;
        this._drag = { kind: 'gradient-obj', from: pt, obj: under, moved: false };
        if (!ge || ge !== under) this._emitGradientAxis(pt, pt);
        return;
      }
      if (ge) {
        // Clicked off every shape: done editing — handles go, and the shape stops being the
        // implicit target (a following drag on empty canvas paints, it doesn't restyle it).
        this._endGradEdit();
        this._lastActiveId = null;
        return;
      }
      const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      const objTarget = active && active.type !== 'activeSelection' && (active.role !== 'bg' || active.type === 'rect') && !this.selection ? active : null;
      if (objTarget) {
        this._drag = { kind: 'gradient-obj', from: pt, obj: objTarget, moved: false };
        this._emitGradientAxis(pt, pt);
        return;
      }
      this._applySelClip();
      this._drag = { kind: 'gradient', from: pt };
      this._emitGradientAxis(pt, pt);
      return;
    }
    if (t === 'eyedropper') {
      const hex = this.engine.sample(pt);
      if (hex) { this.setToolOptions({ color: hex, fill: hex }); this._emit('eyedropper', hex); }
      return;
    }
    if (t === 'crop' && this.crop) {
      const handle = getCropHandle(this.crop, pt, this.fc.getZoom());
      if (handle) this._drag = { kind: 'crop', handle, last: pt };
      return;
    }
  }

  _move(opt) {
    const pt = this._pt(opt), e = opt.e || {};
    if (this._pickBusy) { this._pickBusy = { x: pt.x, y: pt.y }; this._emit('pickbusy', this._pickBusy); }
    if (this._persp && !(this._drag && this._drag.kind === 'pan')) {
      const st = this._persp;
      if (st.drag >= 0) {
        const o = this._byId(st.id);
        // corners may sit a little outside the image (for content running off the edge) — up to
        // half a frame out, beyond that it's almost certainly a slip
        if (o) st.corners[st.drag] = this._sceneToImageNorm(o, pt).map(v => Math.max(-0.5, Math.min(1.5, v)));
        this._emitPerspective();
      } else {
        const h = this._perspHit(pt);
        if (h !== st.hover) { st.hover = h; this._emitPerspective(); }
        this.fc.setCursor(h >= 0 ? 'move' : 'default');
      }
      return;
    }
    if (PAINT_TOOLS.includes(this.tool)) this._emitBrushCursor(pt, !!e.altKey, !!e.shiftKey);
    if (this._maskEdit && this._maskDrag && (this.tool === 'brush' || this.tool === 'pencil' || this.tool === 'eraser')) {
      const layer = this._byId(this._maskEdit.layerId);
      if (layer && layer.maskCanvas) {
        const rs = this._refineStroke;
        if (rs) rs.pts.push(pt);
        this._maskPaint(layer, pt, this._maskDrag, rs ? { ...this.toolOpts, color: rs.keep ? '#ffffff' : '#000000', opacity: 1 } : { ...this.toolOpts }, this.tool === 'eraser');
        this._refreshMaskFilter(layer);
        this.fc.requestRenderAll();
      }
      this._maskDrag = pt;
      return;
    }
    if (CLICK_LASSOS.includes(this.tool) && this._polyBuild) {
      const p = this.tool === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      this.selection = polyBuildPreview(this._polyBuild, p);
      this.fc.renderAll();
      return;
    }
    if ((this.tool === 'pen' || this._pathEdit) && !(this._drag && this._drag.kind === 'pan') && this._penMove(pt, e)) return;
    if (this.tool === 'hoverselect' || this.tool === 'objectselect') { this._hoverMove(pt); return; }
    const d = this._drag;
    if (!d && this.tool === 'gradient' && this._gradEdit) {
      const hit = this._gradHit(pt);
      this.fc.setCursor(this._gradStopHit(pt) >= 0 ? 'pointer' : hit === 'from' || hit === 'to' ? 'grab' : hit === 'line' ? 'move' : this.fc.defaultCursor);
      return;
    }
    if (!d) return;
    if (d.kind === 'pan') {
      const vpt = this.fc.viewportTransform;
      vpt[4] += e.clientX - d.x; vpt[5] += e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      this.fc.requestRenderAll();
      return;
    }
    if (d.kind === 'paint') { this.engine.move(this.tool, pt, { ...this.toolOpts }); return; }
    if (d.kind === 'vmask-erase') {
      const layer = this._byId(d.id);
      if (layer && layer.maskCanvas) {
        this._maskPaint(layer, pt, d.last, { ...this.toolOpts, color: '#000000' }, false);
        this._refreshMaskFilter(layer);
      }
      d.last = pt;
      return;
    }
    if (d.kind === 'sel') { updateSelection(this.selection, pt, { square: e.shiftKey }); this.fc.renderAll(); this._emit('selection', this.selection); return; }
    if (d.kind === 'resize-sel') {
      this.selection = dragSelectionRect(this.selection, d.handle, pt.x - d.last.x, pt.y - d.last.y);
      d.last = pt;
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return;
    }
    if (d.kind === 'shape') { resizeShapeTo(d.obj, d.tool, d.from, pt, { square: e.shiftKey }); this.fc.renderAll(); return; }
    if (d.kind === 'gradient') {
      const to = snapAxis(d.from, pt, e.shiftKey);
      this.engine.paintGradient(d.from.x, d.from.y, to.x, to.y, this.toolOpts.gradientStops, this.toolOpts.gradientType);
      this._emitGradientAxis(d.from, to);
      return;
    }
    if (d.kind === 'gradient-obj') {
      // A click without a real drag must not collapse the fill into a zero-length ramp.
      if (!d.moved && Math.hypot(pt.x - d.from.x, pt.y - d.from.y) < 3 / (this.fc.getZoom() || 1)) return;
      d.moved = true;
      const to = snapAxis(d.from, pt, e.shiftKey);
      this._applyObjectGradient(d.obj, d.from, to);
      this._emitGradientAxis(d.from, to);
      return;
    }
    if ((d.kind === 'grad-handle' || d.kind === 'grad-stop') && !d.moved && Math.hypot(pt.x - d.down.x, pt.y - d.down.y) < 3 / (this.fc.getZoom() || 1)) return;
    if (d.kind === 'grad-stop') {
      d.moved = true;
      const g = this._gradEdit, dx = g.to.x - g.from.x, dy = g.to.y - g.from.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((pt.x - g.from.x) * dx + (pt.y - g.from.y) * dy) / l2));
      const stops = this.toolOpts.gradientStops.slice();
      stops[d.stop] = { ...stops[d.stop], offset: Math.round(t * 1000) / 1000 };
      this.setToolOptions({ gradientStops: stops });   // restyles the shape + redraws the axis
      return;
    }
    if (d.kind === 'grad-handle') {
      d.moved = true;
      const g = this._gradEdit, other = d.which === 'from' ? g.to : g.from;
      // keep the grab offset: dragging an end by its swatch (22px to the side) mustn't snap the
      // end onto the pointer
      if (!d.grab) d.grab = { x: g[d.which].x - d.down.x, y: g[d.which].y - d.down.y };
      const p = snapAxis(other, { x: pt.x + d.grab.x, y: pt.y + d.grab.y }, e.shiftKey);
      g[d.which] = { x: p.x, y: p.y };
      this._applyObjectGradient(d.obj, g.from, g.to);
      this._emitGradientAxis(g.from, g.to);
      return;
    }
    if (d.kind === 'grad-move') {
      d.moved = true;
      const dx = pt.x - d.down.x, dy = pt.y - d.down.y, g = this._gradEdit;
      g.from = { x: d.start.from.x + dx, y: d.start.from.y + dy };
      g.to = { x: d.start.to.x + dx, y: d.start.to.y + dy };
      this._applyObjectGradient(d.obj, g.from, g.to);
      this._emitGradientAxis(g.from, g.to);
      return;
    }
    if (d.kind === 'crop') {
      this.crop = dragCropRect(this.crop, d.handle, pt.x - d.last.x, pt.y - d.last.y, this.toolOpts.cropRatio || 0);
      d.last = pt;
      this._emit('crop', this.crop);
      this.fc.renderAll();
      return;
    }
  }

  _up() {
    if (this._persp && this._persp.drag >= 0) { this._persp.drag = -1; this._emitPerspective(); return; }
    if (this._maskEdit && this._maskDrag) {
      this._maskDrag = null; this._flushFrameJob('mask');
      const rs = this._refineStroke, layer = this._byId(this._maskEdit.layerId);
      this._refineStroke = null;
      if (rs && this._refineActive(layer)) this._refineCutout(layer, rs);   // commits when the re-cut lands
      else this.commit('mask-paint');
      return;
    }
    if (this._penDrag) { this._penUp(); return; }
    const d = this._drag; this._drag = null;
    if (!d) return;
    if (d.kind === 'vmask-erase') { this._flushFrameJob('mask'); this.commit('erase'); return; }
    if (d.kind === 'paint') {
      const painted = this.engine._direct && this.engine._direct.layer;
      this.engine.up(); this.engine.setClip(null);
      // Unbind so the NEXT stroke re-rasterizes the target: the layer's pixels have just changed,
      // and clone/heal must sample the retouched result (captureFlat reads the scene, not this
      // scratch canvas). Also stops a later tool switch from writing onto a stale target.
      this.engine.setDirectTarget(null);
      if (painted && painted.role === 'paint') { this._trimPaintLayer(painted); this._lastActiveId = painted.id; }   // the layer you just painted is the one you're working on (eraser targets it next)
      this.commit('stroke');
    }
    if (d.kind === 'sel') {
      const fresh = finalizeSelection(this.selection);
      if (d.combine) {
        this.selection = d.base;   // put the original back, then fold the new shape into it
        const ring = fresh && (selectionPolys(fresh) || [])[0];
        if (!ring) this._emit('selection', this.selection);
        else if (d.combine === 'add') this.addToSelection(ring);
        else this.subtractFromSelection(ring);
      } else { this.selection = fresh; this._emit('selection', this.selection); }
    }
    if (d.kind === 'resize-sel') {
      // A plain click (no real drag) on the marquee's own interior/handles is a no-op resize —
      // Ditto has no grab-to-move for marquees at all, so the same click there just restarts a
      // fresh 0-size selection that finalizeSelection then discards. Mirror that outcome here: a
      // click that moved the handle by less than a couple px clears the selection instead of
      // silently leaving it unchanged, so clicking an existing marquee again deselects it like it
      // does everywhere else in the app.
      const dx = d.last.x - d.down.x, dy = d.last.y - d.down.y;
      if (Math.hypot(dx, dy) < 2) this.selection = null;
      else this.selection = finalizeSelection(this.selection);
      this._emit('selection', this.selection);
    }
    if (d.kind === 'gradient') { this.engine.setClip(null); this._emitGradientAxis(null); this.commit('gradient'); }
    if (d.kind === 'gradient-obj') {
      if (d.moved) {
        // keep the axis up as live, draggable handles
        const g = this._gradAxis;
        this._gradEdit = { id: d.obj.id, from: { ...g.from }, to: { ...g.to } };
        this.commit('gradient-fill');
      } else if (!this._gradEdit && !this._beginGradEdit(d.obj)) this._emitGradientAxis(null);   // a click shows an existing gradient's handles
    }
    if ((d.kind === 'grad-handle' || d.kind === 'grad-move') && d.moved) this.commit('gradient-fill');
    if ((d.kind === 'grad-handle' || d.kind === 'grad-stop') && !d.moved && d.stop != null) {
      // Ask the shell to open a colour picker for this stop, anchored at its swatch. Emitted inside
      // the mouseup handler so the shell is still within the user gesture showPicker() needs.
      const st = this.toolOpts.gradientStops[d.stop], at = this._gradSwatchPoint(d.stop);
      const vt = this.fc.viewportTransform, r = this.fc.upperCanvasEl.getBoundingClientRect();
      const { color, alpha } = splitGradientStopColor(st.alpha != null && st.alpha < 1 ? rgba(st.color, st.alpha) : st.color);
      this._emit('gradientstoppick', { index: d.stop, color, alpha, x: at.x, y: at.y,
        clientX: r.left + at.x * vt[0] + vt[4], clientY: r.top + at.y * vt[3] + vt[5] });
    }
    if (d.kind === 'shape') { this.commit('shape'); this.setTool('select'); this.fc.setActiveObject(d.obj); }
    if (d.kind === 'pan' && (this.tool === 'hand' || this._spaceDown)) this.fc.setCursor('grab');
  }

  clearSelection() {
    this.selection = null; this._polyBuild = null; this.multiCount = 0; this._objCycle = null;
    this._emit('selection', null); this._emit('multicount', 0); this.fc.renderAll();
  }
  /* Whole-artboard pixel selection (⌘A) — the same full-canvas rect invertSelection() falls back
     to when nothing is selected yet, but as its own explicit entry point rather than a side effect
     of inverting. */
  selectAll() {
    this.selection = { kind: 'rect', x: 0, y: 0, w: this.W, h: this.H };
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }
  invertSelection() {
    if (!this.selection) { this.selection = { kind: 'rect', x: 0, y: 0, w: this.W, h: this.H }; }
    else this.selection.invert = !this.selection.invert;
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }

  /* The 'objectselect-bbox' tool (reference editor: "Object / magic select", key W) — a trivial,
     non-CV click: select the active object's own bounding box as a rect selection, or (nothing
     active) a fixed center region of the artboard. No pixel analysis at all — this is deliberately
     the lightweight sibling of `magicwand`/`objectselect`'s real CV-backed picking, matching the
     reference editor's own near-stub behavior for this exact tool/key.
     Reads getActiveObject() first, but falls back to _lastActiveId — setTool() has already
     discarded the live Fabric selection by the time any drawing-tool click reaches here (this
     tool is not 'select'), so getActiveObject() alone would see nothing on every click and always
     fall through to the center region. Mirrors the reference editor's own active()/lastUpdatedRef. */
  selectActiveOrCenter() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (o && o.type !== 'activeSelection') {
      o.setCoords();
      const b = o.getBoundingRect(true);
      this.selection = { kind: 'rect', x: b.left, y: b.top, w: b.width, h: b.height };
    } else {
      this.selection = { kind: 'rect', x: this.W * 0.18, y: this.H * 0.18, w: this.W * 0.64, h: this.H * 0.64 };
    }
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }

  /* ── polygon / magnetic lasso: click-to-place vertices, Enter/Escape to finish ──────────── */
  finishPolyLasso() {
    const sel = finishPolyBuild(this._polyBuild, false);
    this._polyBuild = null;
    this.selection = sel;
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }
  cancelPolyLasso() {
    this._polyBuild = null;
    this.selection = null;
    this._emit('selection', null);
    this.fc.renderAll();
  }

  /* ── pen tool + vector edit mode ──────────────────────────────────────────────────────────
     Figma's pen, on real bezier nodes (pen.js holds the geometry):
       click = corner point · click-drag = smooth point with mirrored handles (⌥ breaks the
       mirror, ⇧ snaps to 45°, Space moves the point being placed) · click the first point to
       close (drag there to curve the closing segment) · click the last point to drop its out
       handle, drag from it to pull a new one · Enter/Escape finish, Backspace removes the last
       point, ⌘Z/⌘⇧Z step points back/forward while drawing.
     A finished path is a real fabric.Path layer (closed = filled, open = stroked). Double-click
     it, press Enter on it, or pick Pen with it selected for vector edit mode: drag points and
     handles, drag a segment to move it (⌘-drag bends it), double-click a segment or Pen-click it
     to add a point, Delete removes points, double-click / ⌥-click a point toggles corner/smooth,
     Pen-click an open end to keep drawing from it. Every finished gesture is one undo step.

     While editing, the layer is kept as an untransformed Path whose data IS the scene geometry
     (see _bakePathForEdit), so a node edit is just "rewrite the path data". */
  _penTol(px = 7) { return px / (this.fc.getZoom() || 1); }

  isEditablePath(o) {
    if (!o || o.group || o.locked || o.role === 'bg' || o.role === 'paint' || isContainerGroup(o)) return false;
    if (o.type !== 'path' && o.type !== 'polygon' && o.type !== 'polyline') return false;
    // A mask is mapped onto the layer's own bounding box, which every node edit resizes — it would
    // smear across the new shape. Masked layers aren't point-editable (remove the mask first).
    if (o.maskCanvas) return false;
    return o.type !== 'path' || !!commandsToNodes(o.path || []);
  }
  _isPlainPath(o) {
    return o.type === 'path' && !o.angle && Math.abs(o.scaleX || 1) === 1 && Math.abs(o.scaleY || 1) === 1
      && !o.skewX && !o.skewY && !o.flipX && !o.flipY;
  }

  /* The layer's geometry as scene-space nodes, through its full transform. */
  _pathNodesOf(o) {
    const F = this.fabric, m = o.calcTransformMatrix(), off = o.pathOffset || { x: 0, y: 0 };
    const map = (p) => { const q = F.util.transformPoint(new F.Point(p.x - off.x, p.y - off.y), m); return { x: q.x, y: q.y }; };
    if (o.type === 'path') return commandsToNodes(o.path || [], map);
    const nodes = (o.points || []).map(p => { const q = map(p); return penNode(q.x, q.y); });
    return nodes.length ? { nodes, closed: o.type === 'polygon' } : null;
  }

  /* Make the layer a plain, untransformed fabric.Path drawn from `geo`. Rotation/scale/skew get
     baked into the points (the stroke keeps its on-screen weight); a polygon/polyline is swapped
     for an equivalent Path at the same z-index, keeping its id, name and look. */
  _bakePathForEdit(o, geo) {
    if (this._isPlainPath(o)) return o;
    const d = nodesToPathD(geo.nodes, geo.closed);
    const sw = (o.strokeWidth || 0) * Math.sqrt(Math.abs((o.scaleX || 1) * (o.scaleY || 1)));
    if (o.type === 'path') {
      o.set({ angle: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, flipX: false, flipY: false, strokeWidth: sw });
      o._setPath(d); o.setCoords(); o.dirty = true;
      return o;
    }
    const keep = ['fill', 'stroke', 'strokeDashArray', 'strokeLineCap', 'strokeLineJoin', 'strokeMiterLimit', 'strokeUniform',
      'opacity', 'visible', 'shadow', 'globalCompositeOperation', 'paintFirst', 'fillRule', 'clipPath', ...EXTRA];
    const props = {};
    keep.forEach(k => { if (o[k] !== undefined) props[k] = o[k]; });
    const path = new this.fabric.Path(d, { ...props, strokeWidth: sw });
    path.set({ shapeKind: 'pen' });   // its star/polygon parameters no longer describe it
    const idx = this.fc.getObjects().indexOf(o);
    this.fc.remove(o);
    this.fc.insertAt(path, Math.max(0, idx), false);
    return path;
  }

  editPath(id) {
    let o = this._byId(id);
    if (!this.isEditablePath(o)) return false;
    if (this._penBuild) { const b = this._penBuild; this._penBuild = null; this._commitPenBuild(b); }
    if (this._pathEdit) this._endPathEdit(false);
    const geo = this._pathNodesOf(o);
    if (!geo || geo.nodes.length < 2) return false;
    const before = o;
    o = this._bakePathForEdit(o, geo);
    if (o !== before || !this._isPlainPath(before)) this._emit('change', { label: 'path-edit' });   // layer type/geometry changed for the panels
    this._pathEdit = { id: o.id, nodes: geo.nodes, closed: geo.closed, sel: new Set(), marquee: null };
    this._penHover = null;
    this._lockForPathEdit();
    this._emit('pathedit', { id: o.id });
    this._emitPen();
    return true;
  }
  exitPathEdit() { this._endPathEdit(true); }
  _endPathEdit(reselect) {
    const pe = this._pathEdit;
    if (!pe) return;
    this._pathEdit = null; this._penDrag = null; this._penHover = null;
    const drawing = this.tool !== 'select';
    this.fc.selection = !drawing;
    this.fc.getObjects().forEach(o => { o.selectable = !drawing && !o.locked; o.evented = !drawing && !o.locked; });
    const o = this._byId(pe.id);
    if (o && reselect && !drawing) this.fc.setActiveObject(o);
    this.fc.setCursor(this.fc.defaultCursor = this._cursorForTool(this.tool));
    this._emit('pathedit', null);
    this._emitPen();
  }
  _lockForPathEdit() {
    // Fabric must not grab, move or marquee-select anything while the pen owns the pointer.
    this.fc.discardActiveObject();
    this.fc.selection = false;
    this.fc.getObjects().forEach(o => { o.selectable = false; o.evented = false; });
  }
  _writePathEdit() {
    const pe = this._pathEdit, o = pe && this._byId(pe.id);
    if (!o) return;
    this._setPathKeepingAnchors(o, nodesToPathD(pe.nodes, pe.closed));
    this.fc.requestRenderAll();
  }
  /* Rewrite a path's data without moving what's attached to its box: _setPath re-derives the
     box/centre from the new points, but a crop (clipPath, centre-relative) and a pixel-unit
     gradient (top-left-relative) are anchored to that box — re-express both so they stay put on
     the canvas. */
  _setPathKeepingAnchors(o, d) {
    const grads = ['fill', 'stroke'].map(k => {
      const g = o[k];
      if (!g || typeof g !== 'object' || !g.coords || g.gradientUnits === 'percentage') return null;
      const c = g.coords;
      return { g, a: this._gradLocalToScene(o, { x: c.x1, y: c.y1 }), b: this._gradLocalToScene(o, { x: c.x2, y: c.y2 }) };
    }).filter(Boolean);
    const c0 = o.getCenterPoint();
    o._setPath(d);
    o.setCoords();
    const c1 = o.getCenterPoint();
    const cp = o.clipPath;
    if (cp && !cp.absolutePositioned) { cp.set({ left: cp.left - (c1.x - c0.x), top: cp.top - (c1.y - c0.y) }); cp.setCoords && cp.setCoords(); }
    grads.forEach(({ g, a, b }) => {
      const p1 = this._sceneToGradLocal(o, a), p2 = this._sceneToGradLocal(o, b);
      Object.assign(g.coords, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    });
    o.dirty = true;
  }
  /* Handles are shown (and grabbable) for the selected points and their neighbours — what Figma
     shows — plus whichever point the pointer is over. */
  _editHandleNodes() {
    const pe = this._pathEdit, cnt = pe.nodes.length, out = new Set();
    pe.sel.forEach(i => {
      out.add(i);
      if (i > 0 || pe.closed) out.add((i - 1 + cnt) % cnt);
      if (i < cnt - 1 || pe.closed) out.add((i + 1) % cnt);
    });
    const h = this._penHover;
    if (h && h.anchor != null) out.add(h.anchor);
    if (h && h.handleOf != null) out.add(h.handleOf);
    return [...out];
  }

  _emitPen() {
    const b = this._penBuild, pe = this._pathEdit, hov = this._penHover || {};
    const pts = (ns) => ns.map(p => ({ x: p.x, y: p.y }));
    if (b) {
      const n = b.nodes.length, handles = [n - 1, n - 2].filter(i => i >= 0);
      if (b.closing || hov.close) handles.push(0);
      this._emit('pen', { mode: 'draw', nodes: b.nodes, closed: false, pts: pts(b.nodes), sel: [n - 1], handles,
        preview: this._penDrag ? null : (hov.pt || null), closeHover: !!hov.close });
    } else if (pe) {
      this._emit('pen', { mode: 'edit', id: pe.id, nodes: pe.nodes, closed: pe.closed, pts: pts(pe.nodes), sel: [...pe.sel],
        handles: this._editHandleNodes(), hoverAnchor: hov.anchor != null ? hov.anchor : null, segHover: hov.seg || null, marquee: pe.marquee });
    } else this._emit('pen', null);
    this.fc.requestRenderAll();
  }

  /* What's under the pointer in vector edit mode, most specific first. */
  _penHit(pt, e) {
    const pe = this._pathEdit;
    if (!pe) return { kind: 'none' };
    const h = hitHandle(pe.nodes, pt, this._penTol(), this._editHandleNodes());
    if (h) return { kind: 'handle', ...h };
    const a = hitAnchor(pe.nodes, pt, this._penTol());
    if (a >= 0) {
      const end = !pe.closed && (a === 0 || a === pe.nodes.length - 1);
      return { kind: end && !e.altKey ? 'continue' : 'anchor', i: a };
    }
    const s = hitSegment(pe.nodes, pe.closed, pt, this._penTol(5));
    return s ? { kind: 'segment', ...s } : { kind: 'none' };
  }

  _penSnap(b) { b.undo.push(cloneNodes(b.nodes)); b.redo = []; }

  _penDown(pt, e) {
    this._penLast = pt;
    const b = this._penBuild, pe = this._pathEdit, tol = this._penTol();
    if (this.tool === 'pen') {
      if (b) {
        const n = b.nodes, last = n[n.length - 1];
        this._penSnap(b);
        if (n.length >= 2 && penDist(pt, n[0]) <= tol) {
          b.closing = true;
          this._penDrag = { kind: 'close', down: pt, moved: false };
        } else if (penDist(pt, last) <= tol) {
          this._penDrag = { kind: 'last-handle', down: pt, moved: false };
        } else {
          const p = e.shiftKey ? constrain45(last, pt) : pt;
          n.push(penNode(p.x, p.y));
          this._penDrag = { kind: 'new-node', i: n.length - 1, down: p, last: pt, moved: false };
        }
        this._penHover = null; this._emitPen();
        return true;
      }
      if (pe) {
        const hit = this._penHit(pt, e);
        if (hit.kind === 'handle') { this._startHandleDrag(hit, pt); return true; }
        if (hit.kind === 'continue') {
          this._continuePath(hit.i);
          this._penDrag = { kind: 'last-handle', down: pt, moved: false };
          this._emitPen();
          return true;
        }
        if (hit.kind === 'anchor') {
          if (e.altKey) this._penDrag = { kind: 'convert', i: hit.i, down: pt, moved: false };
          // the 2nd click of a double-click on a segment lands on the point the 1st just added
          else if (!(this._penJustAdded && this._penJustAdded.i === hit.i && Date.now() - this._penJustAdded.t < 450)) this._deletePathNodes([hit.i]);
          return true;
        }
        if (hit.kind === 'segment') {
          const ni = splitSegment(pe.nodes, pe.closed, hit.seg, hit.t);
          this._penJustAdded = { i: ni, t: Date.now() };
          pe.sel = new Set([ni]);
          this._writePathEdit(); this.commit('path-edit');
          this._penHover = null; this._emitPen();
          return true;
        }
        this.exitPathEdit();   // clicked away from the path: start a new one right here
      }
      this._penBuild = { nodes: [penNode(pt.x, pt.y)], closed: false, contId: null, undo: [], redo: [] };
      this._penDrag = { kind: 'new-node', i: 0, down: pt, last: pt, moved: false };
      this._penHover = null; this._emitPen();
      return true;
    }
    if (!pe) return false;
    // Select tool inside vector edit mode
    const hit = this._penHit(pt, e);
    if (hit.kind === 'handle') { this._startHandleDrag(hit, pt); return true; }
    if (hit.kind === 'anchor' || hit.kind === 'continue') {
      if (e.altKey) { this._penDrag = { kind: 'convert', i: hit.i, down: pt, moved: false }; return true; }
      if (e.shiftKey) { if (pe.sel.has(hit.i)) pe.sel.delete(hit.i); else pe.sel.add(hit.i); }
      else if (!pe.sel.has(hit.i)) pe.sel = new Set([hit.i]);
      this._penDrag = { kind: 'anchors', down: pt, moved: false, before: cloneNodes(pe.nodes) };
      this._emitPen();
      return true;
    }
    if (hit.kind === 'segment') {
      const ends = [hit.seg, (hit.seg + 1) % pe.nodes.length];
      if (e.metaKey || e.ctrlKey) {
        this._penDrag = { kind: 'bend', seg: hit.seg, t: hit.t, down: pt, moved: false, before: cloneNodes(pe.nodes) };
      } else {
        pe.sel = e.shiftKey ? new Set([...pe.sel, ...ends]) : new Set(ends);
        this._penDrag = { kind: 'anchors', down: pt, moved: false, before: cloneNodes(pe.nodes) };
      }
      this._emitPen();
      return true;
    }
    if (!e.shiftKey) pe.sel = new Set();
    this._penDrag = { kind: 'marquee', down: pt, moved: false, base: new Set(pe.sel) };
    this._emitPen();
    return true;
  }
  _startHandleDrag(hit, pt) {
    const n = this._pathEdit.nodes[hit.i];
    this._penDrag = { kind: 'handle', i: hit.i, which: hit.which, down: pt, moved: false, smooth: isSmooth(n), equal: handlesEqual(n) };
  }

  _penMove(pt, e) {
    this._penLast = pt;
    const d = this._penDrag, b = this._penBuild, pe = this._pathEdit;
    if (d) {
      if (!d.moved && penDist(pt, d.down) < this._penTol(3)) return true;
      d.moved = true;
      const snap = (from) => (e.shiftKey ? constrain45(from, pt) : { x: pt.x, y: pt.y });
      switch (d.kind) {
        case 'new-node': {
          const n = b.nodes[d.i];
          if (!n) { this._penDrag = null; break; }
          // Space held: reposition the point being placed instead of shaping it
          if (this._spaceDown) { translateNode(n, pt.x - d.last.x, pt.y - d.last.y); d.last = pt; break; }
          d.last = pt;
          n.ho = snap(n);
          if (!e.altKey) n.hi = mirrorFor(n, 'ho', n.ho, { equal: true });
          break;
        }
        case 'close': {
          // Dragging over the first point carries the path's direction through it: the out
          // handle follows the pointer and the in handle (the closing segment's) mirrors it.
          const f = b.nodes[0], h = snap(f);
          if (!e.altKey) f.ho = h;
          f.hi = mirrorFor(f, 'ho', h, { equal: true });
          break;
        }
        case 'last-handle': { const l = b.nodes[b.nodes.length - 1]; l.ho = snap(l); break; }
        case 'handle': {
          const n = pe.nodes[d.i], h = snap(n);
          n[d.which] = h;
          if (d.smooth && !e.altKey) n[d.which === 'ho' ? 'hi' : 'ho'] = mirrorFor(n, d.which, h, { equal: d.equal });
          this._writePathEdit();
          break;
        }
        case 'convert': {
          const n = pe.nodes[d.i];
          n.ho = snap(n); n.hi = mirrorFor(n, 'ho', n.ho, { equal: true });
          this._writePathEdit();
          break;
        }
        case 'anchors': {
          let dx = pt.x - d.down.x, dy = pt.y - d.down.y;
          if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          pe.sel.forEach(i => {
            const o = d.before[i];
            pe.nodes[i] = penNode(o.x, o.y, o.hi && { ...o.hi }, o.ho && { ...o.ho });
            translateNode(pe.nodes[i], dx, dy);
          });
          this._writePathEdit();
          break;
        }
        case 'bend': {
          const cnt = d.before.length;
          bendSegment(pe.nodes, d.seg, d.t, [d.before[d.seg], d.before[(d.seg + 1) % cnt]], { x: pt.x - d.down.x, y: pt.y - d.down.y });
          this._writePathEdit();
          break;
        }
        case 'marquee': {
          const x = Math.min(d.down.x, pt.x), y = Math.min(d.down.y, pt.y), w = Math.abs(pt.x - d.down.x), h = Math.abs(pt.y - d.down.y);
          pe.marquee = { x, y, w, h };
          pe.sel = new Set(d.base);
          pe.nodes.forEach((n, i) => { if (n.x >= x && n.x <= x + w && n.y >= y && n.y <= y + h) pe.sel.add(i); });
          break;
        }
      }
      this._emitPen();
      return true;
    }
    // Hover: the cursor says what a click would do, the overlay previews it.
    if (!b && !pe) { if (this.tool === 'pen') this.fc.setCursor(penCursor('pen')); return this.tool === 'pen'; }
    const pen = this.tool === 'pen', hov = {};
    let cursor = pen ? penCursor('pen') : 'default';
    if (b) {
      const n = b.nodes, last = n[n.length - 1], tol = this._penTol();
      if (n.length >= 2 && penDist(pt, n[0]) <= tol) { hov.close = true; cursor = penCursor('close'); }
      else if (penDist(pt, last) <= tol) cursor = penCursor('convert');
      hov.pt = !hov.close && e.shiftKey ? constrain45(last, pt) : { x: pt.x, y: pt.y };
    } else {
      const hit = this._penHit(pt, e);
      if (hit.kind === 'handle') { hov.handleOf = hit.i; cursor = 'move'; }
      else if (hit.kind === 'anchor' || hit.kind === 'continue') {
        hov.anchor = hit.i;
        cursor = !pen ? 'move' : hit.kind === 'continue' ? penCursor('continue') : e.altKey ? penCursor('convert') : penCursor('remove');
      } else if (hit.kind === 'segment') {
        if (pen) { hov.seg = { x: hit.x, y: hit.y }; cursor = penCursor('add'); } else cursor = 'pointer';
      }
    }
    this._penHover = hov;
    this.fc.setCursor(cursor);
    this._emitPen();
    return true;
  }

  _penUp() {
    const d = this._penDrag; this._penDrag = null;
    const b = this._penBuild, pe = this._pathEdit;
    if (!d) return;
    if (d.kind === 'close' && b) { b.closed = true; this.finishPen(); return; }
    if (d.kind === 'last-handle' && b && !d.moved) b.nodes[b.nodes.length - 1].ho = null;
    if (pe) {
      if ((d.kind === 'handle' || d.kind === 'anchors' || d.kind === 'bend') && d.moved) this.commit('path-edit');
      if (d.kind === 'convert') {
        if (!d.moved) { toggleSmooth(pe.nodes, pe.closed, d.i); this._writePathEdit(); }
        this.commit('path-edit');
      }
      if (d.kind === 'marquee') {
        pe.marquee = null;
        if (!d.moved) { this.exitPathEdit(); return; }   // a plain click off the path leaves edit mode
      }
    }
    this._emitPen();
  }

  _continuePath(i) {
    const pe = this._pathEdit;
    let nodes = cloneNodes(pe.nodes);
    // Always extend from the END of the node list — drawing on from the first point reverses it.
    if (i === 0) nodes = nodes.reverse().map(n => penNode(n.x, n.y, n.ho, n.hi));
    this._pathEdit = null; this._penHover = null;
    this._emit('pathedit', null);
    this._penBuild = { nodes, closed: false, contId: pe.id, undo: [], redo: [] };
  }

  _deletePathNodes(idx) {
    const pe = this._pathEdit;
    if (!pe || !idx.length) return;
    const drop = new Set(idx);
    pe.nodes = pe.nodes.filter((_, i) => !drop.has(i));
    pe.sel = new Set(); this._penHover = null;
    if (pe.nodes.length < 2) {
      // nothing left that draws: the layer goes too
      const id = pe.id;
      this._endPathEdit(false);
      this.removeLayer(id);
      return;
    }
    this._writePathEdit();
    this.commit('path-edit');
    this._emitPen();
  }

  /* ── public vector-edit commands (keyboard + the shells' edit bar) ── */
  deleteSelectedPathNodes() { const pe = this._pathEdit; if (pe && pe.sel.size) this._deletePathNodes([...pe.sel]); }
  selectAllPathNodes() { const pe = this._pathEdit; if (!pe) return; pe.sel = new Set(pe.nodes.map((_, i) => i)); this._emitPen(); }
  nudgePathNodes(dx, dy) {
    const pe = this._pathEdit;
    if (!pe || !pe.sel.size) return;
    pe.sel.forEach(i => translateNode(pe.nodes[i], dx, dy));
    this._writePathEdit(); this.commit('path-edit'); this._emitPen();
  }
  /* 'smooth' | 'corner' for the selected points (all points when none is selected). */
  setPathNodeType(type) {
    const pe = this._pathEdit;
    if (!pe) return;
    const idx = pe.sel.size ? [...pe.sel] : pe.nodes.map((_, i) => i);
    idx.forEach(i => {
      const n = pe.nodes[i], has = !!(n.hi || n.ho);
      if (type === 'corner' && has) { n.hi = null; n.ho = null; }
      if (type === 'smooth' && !isSmooth(n)) { n.hi = null; n.ho = null; toggleSmooth(pe.nodes, pe.closed, i); }
    });
    this._writePathEdit(); this.commit('path-edit'); this._emitPen();
  }
  get pathEdit() { const pe = this._pathEdit; return pe ? { id: pe.id, closed: pe.closed, count: pe.nodes.length, selected: [...pe.sel] } : null; }

  /* ── drawing: finish / cancel / step back ── */
  _commitPenBuild(b) {
    this._penHover = null;
    this._emitPen();
    if (!b || b.nodes.length < 2) { this.fc.requestRenderAll(); return null; }
    const d = nodesToPathD(b.nodes, b.closed);
    const color = this.toolOpts.fill || this.toolOpts.color || '#000000';
    if (b.contId) {
      const o = this._byId(b.contId);
      if (o) {
        this._setPathKeepingAnchors(o, d);
        if (b.closed && !o.fill) o.set({ fill: color });
        this.commit('pen');
        return o;
      }
    }
    // Closed = a filled shape; open = a stroked line (a fill would only close it visually).
    const sw = this.toolOpts.penStrokeWidth != null ? this.toolOpts.penStrokeWidth : 3;
    const style = b.closed
      ? { fill: color, stroke: null, strokeWidth: 0 }
      : { fill: null, stroke: color, strokeWidth: sw, strokeLineCap: 'round', strokeLineJoin: 'round' };
    const obj = new this.fabric.Path(d, style);
    obj.set({ id: uid(), role: 'shape', name: 'Path', shapeKind: 'pen' });
    this.fc.add(obj);
    this.commit('pen');
    return obj;
  }
  finishPen() {
    const b = this._penBuild;
    this._penBuild = null; this._penDrag = null;
    const obj = this._commitPenBuild(b);
    if (!obj) return null;
    this.setTool('select');
    this.fc.setActiveObject(obj);
    this.fc.requestRenderAll();
    return obj.id;
  }
  cancelPen() {
    this._penBuild = null; this._penDrag = null; this._penHover = null;
    this._emitPen();
  }
  penUndoPoint() {
    const b = this._penBuild;
    this._penDrag = null;   // a drag in flight pointed at a node that's about to change
    if (!b) return;
    if (!b.undo.length) { this.cancelPen(); return; }
    b.redo.push(cloneNodes(b.nodes)); b.nodes = b.undo.pop();
    this._emitPen();
  }
  penRedoPoint() {
    const b = this._penBuild;
    this._penDrag = null;   // a drag in flight pointed at a node that's about to change
    if (!b || !b.redo.length) return;
    b.undo.push(cloneNodes(b.nodes)); b.nodes = b.redo.pop();
    this._emitPen();
  }
  penRemoveLastPoint() {
    const b = this._penBuild;
    this._penDrag = null;   // a drag in flight pointed at a node that's about to change
    if (!b) return;
    if (b.nodes.length <= 1) { this.cancelPen(); return; }
    this._penSnap(b); b.nodes.pop();
    this._emitPen();
  }
  /* Undo/redo/reset swap the whole scene out from under any pen state — drop it rather than let
     it point at objects that are about to be replaced. */
  _penAbandon() {
    this._penBuild = null; this._penDrag = null; this._penHover = null;
    if (this._pathEdit) this._endPathEdit(false);
    else this._emitPen();
  }

  /* Magnetic lasso needs an edge map of the flattened scene before it can snap — build it once
     when the tool is picked (or lazily on first use) rather than per mouse-move. Guarded by a
     monotonic token (same pattern as _wandSeq/_hoverSeq): resizeCanvas()/applyCrop() bump it when
     they invalidate _edgeMap, so a build that was already in flight when the artboard changed
     size/origin can't land afterward and overwrite the (correct) null with stale pre-resize
     geometry. */
  async buildMagneticEdgeMap() {
    const seq = ++this._edgeMapSeq;
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) { if (seq === this._edgeMapSeq) this._edgeMap = null; return; }
    try {
      const data = prepImageData(flat, 700);
      const edgeMap = buildEdgeMapFromImageData(data, this.W, this.H);
      if (seq === this._edgeMapSeq) this._edgeMap = edgeMap;
    } catch (e) { if (seq === this._edgeMapSeq) this._edgeMap = null; }
  }

  /* ── magic wand / object select: cv-backed hybrid flood+grabCut, falling back to plain flood ──
     `add`/`subtract` implement shift-click-add / alt-click-subtract composition; when the cv
     worker is ready they run a true polygon union/subtract, otherwise they fall back to the
     always-available accumulate-into-multipoly (add) or are reported unavailable (subtract, which
     has no meaningful non-boolean fallback). */
  /* Contour points from the cv worker are pixel CENTRES of a downscaled copy, so a region that runs
     to the image's last column/row comes back ~1 source px short of the artboard edge — leaving a
     sliver unselected. Points on the analysed image's border are pushed out to the true edge. */
  _toSceneEdgeSnapped(pts, iw, ih, sx, sy, ox, oy) {
    return pts.map(p => ({
      x: p.x <= 0 ? ox : p.x >= iw - 1 ? ox + iw * sx : ox + p.x * sx,
      y: p.y <= 0 ? oy : p.y >= ih - 1 ? oy + ih * sy : oy + p.y * sy,
    }));
  }

  /* Busy ring at the pointer while a click-to-select pick runs (drawn by the shells — see
     busy.js). Overlapping picks share one ring; it goes when the LAST one settles. While busy we
     keep re-rendering every frame so the ring spins even if the pointer stays still. */
  _trackPick(promise, pt) {
    if (!promise || typeof promise.then !== 'function') return promise;
    this._pickCount = (this._pickCount || 0) + 1;
    this._setPickBusy({ x: pt.x, y: pt.y });
    const done = () => { this._pickCount = Math.max(0, this._pickCount - 1); if (!this._pickCount) this._setPickBusy(null); };
    promise.then(done, done);
    return promise;
  }
  _setPickBusy(at) {
    const was = !!this._pickBusy;
    this._pickBusy = at;
    this._emit('pickbusy', at);
    this.fc.requestRenderAll();
    if (at && !was && typeof requestAnimationFrame !== 'undefined') {
      const spin = () => { if (!this._pickBusy || this._destroyed) return; this.fc.requestRenderAll(); requestAnimationFrame(spin); };
      requestAnimationFrame(spin);
    }
  }
  get pickBusy() { return !!this._pickBusy; }

  async wandPick(pt, { add = false, subtract = false } = {}) {
    this._lastWandSeed = pt;
    // Monotonic token guarding against out-of-order resolution: _down() fires this fire-and-forget
    // (never awaited), so a rapid double-click can have two wandPick calls in flight at once — if
    // the first click's cv RPC resolves AFTER the second click's, it must not clobber the second
    // click's (later, more current) selection. Mirrors _runHover's seq === this._hoverSeq guard.
    const seq = ++this._wandSeq;
    this.engine.captureFlat();
    const flat = this.engine._flat;
    let poly = null;
    if (flat && this.cv && typeof Worker !== 'undefined') {
      try {
        const imgd = prepImageData(flat, 768);
        const kx = imgd.width / this.W, ky = imgd.height / this.H;
        const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(pt.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(pt.y * ky))) };
        const pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance, SEL_EPS);
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        if (pts && pts.length >= 3) poly = this._toSceneEdgeSnapped(pts, imgd.width, imgd.height, 1 / kx, 1 / ky, 0, 0);
      } catch (e) { poly = null; }
    }
    if (seq !== this._wandSeq) return { status: 'error', reason: 'superseded' };
    if (!poly && flat) {
      const sel = wandSelect(flat, pt, this.toolOpts.tolerance);
      poly = sel ? (sel.pts || selectionPolys(sel)[0]) : null;
    }
    if (!poly) {
      const result = { status: 'error', reason: 'no_match' };
      if (!add && !subtract) { this.selection = null; this._emit('selection', null); this.fc.renderAll(); }
      /* add/subtract on empty space is otherwise a silent no-op: nothing changes, no event fires,
         and _down() doesn't await this call — so a host UI has no way to know the click did
         nothing unless it listens for this. */
      else this._emit('error', result);
      return result;
    }
    if (subtract) return this.subtractFromSelection(poly);
    if (add) return this.addToSelection(poly);
    this.selection = { kind: 'poly', pts: poly };
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  _commitPoly(poly, { add, subtract } = {}) {
    if (subtract) return this.subtractFromSelection(poly);
    if (add) return this.addToSelection(poly);
    this.selection = { kind: 'poly', pts: poly };
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  /* Shift-click add: true union via the cv worker when it's ready (clean merged outline),
     otherwise the always-available multipoly accumulate. */
  async addToSelection(poly) {
    const cur = selectionPolys(this.selection);
    if (cur && cur.length) {
      try {
        const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
        const S = pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }));
        const merged = await this.cv.union(Math.round(this.W * sc), Math.round(this.H * sc), cur.concat([poly]).map(S));
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        if (merged && merged.length) {
          this.selection = polysToSelection(merged.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc }))));
          this._emit('selection', this.selection);
          this.fc.renderAll();
          return { status: 'ok' };
        }
      } catch (e) { /* fall through to the plain accumulate */ }
    }
    this.selection = addPolyToSelection(this.selection, poly);
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  /* Alt-click subtract: punches `poly` out of the current selection via the cv worker's boolean
     subtract. No cv, no meaningful subtract — reported unavailable rather than guessing. */
  async subtractFromSelection(poly) {
    const base = selectionPolys(this.selection);
    if (!base) return { status: 'error', reason: 'no_selection' };
    try {
      const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
      const S = pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }));
      const res = await this.cv.subtract(Math.round(this.W * sc), Math.round(this.H * sc), base.map(S), [S(poly)]);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (res == null) return { status: 'error', reason: 'cv_unavailable' };
      const out = res.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc })));
      this.selection = polysToSelection(out);
      this.multiCount = out.length;
      this._emit('selection', this.selection);
      this._emit('multicount', this.multiCount);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Select → Modify → Expand/Contract: grow (px>0) or shrink (px<0) the selection outline.
     cv-only — there's no accurate plain-JS polygon offset, so this reports unavailable rather
     than faking it with a bounding-box nudge. */
  async expandSelection(px) { return this._morphSelection(Math.abs(px)); }
  async contractSelection(px) { return this._morphSelection(-Math.abs(px)); }
  async _morphSelection(delta) {
    const polys = selectionPolys(this.selection);
    if (!polys) return { status: 'error', reason: 'no_selection' };
    try {
      const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
      const res = await this.cv.morph(Math.round(this.W * sc), Math.round(this.H * sc),
        polys.map(pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }))), Math.max(1, Math.abs(delta) * sc) * Math.sign(delta));
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (res == null) return { status: 'error', reason: 'cv_unavailable' };
      const out = res.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc })));
      this.selection = polysToSelection(out);
      this.multiCount = out.length;
      this._emit('selection', this.selection);
      this._emit('multicount', this.multiCount);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Select → Similar: every region in the whole image matching the last wand/object-select
     seed's colour, within the current tolerance. cv-only. */
  async selectSimilar() {
    if (!this._lastWandSeed) return { status: 'error', reason: 'no_seed' };
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return { status: 'error', reason: 'no_image' };
    try {
      const imgd = prepImageData(flat, 768);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(this._lastWandSeed.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(this._lastWandSeed.y * ky))) };
      const polys = await this.cv.similar({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (polys == null) return { status: 'error', reason: 'cv_unavailable' };
      if (!polys.length) return { status: 'error', reason: 'no_match' };
      const out = polys.map(pl => pl.map(p => ({ x: p.x / kx, y: p.y / ky })));
      this.selection = polysToSelection(out);
      this.multiCount = out.length;
      this._emit('selection', this.selection);
      this._emit('multicount', this.multiCount);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Auto-detect: Canny-edge object boxes (and, with {text:true}, a separate text-region pass)
     over the whole flattened scene — cv-only, coarser than the wand's precise contour (a
     rectangle per candidate, not a traced outline), meant for "here's what's in this image"
     at a glance rather than a one-click final selection. Returns scene-space boxes for a host UI
     to render as clickable candidates; selectDetectedBox() turns one into a real selection. */
  async detectObjects({ text = false } = {}) {
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return { status: 'error', reason: 'no_image' };
    try {
      const imgd = prepImageData(flat, 900);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const r = await this.cv.detect({ data: imgd.data, width: imgd.width, height: imgd.height }, { text });
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      const toScene = (b) => ({ x: b.x / kx, y: b.y / ky, w: b.w / kx, h: b.h / ky });
      let boxes = r ? (r.boxes || []).map(toScene) : [];
      const textBoxes = r && r.textBoxes ? r.textBoxes.map(toScene) : null;
      // cv unavailable, or a genuine "found nothing" response — either way, fall back to a cheap
      // local blob detector (background-colour-distance + connected components) so callers always
      // get SOMETHING to show/adjust rather than a bare error, same as the reference editor.
      if (!boxes.length && !(textBoxes && textBoxes.length)) {
        boxes = await detectBlobsLocal(flat, { left: 0, top: 0, width: this.W, height: this.H });
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      }
      if (!boxes.length && !(textBoxes && textBoxes.length)) return { status: 'error', reason: 'no_match' };
      return { status: 'ok', result: { boxes, textBoxes } };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Commits one detectObjects() box as a real rectangular pixel selection — the same selection
     marquee/lasso/wand all populate, so expand/contract/select-similar/recolor etc. all work on
     it unchanged. */
  selectDetectedBox(box) {
    const sel = startSelection('marquee', { x: box.x, y: box.y });
    updateSelection(sel, { x: box.x + box.w, y: box.y + box.h });
    this.selection = finalizeSelection(sel);
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }

  /* Turns detectObjects() boxes into real layers — the step the AI Vision "Detected subjects" list
     was missing (it only ever listed boxes / made a selection, so nothing landed in Layers). Runs the
     same Convert-to-layers pipeline as the review step: each box is GrabCut-cut into its own layer
     and lifted out of a fresh Background (commitRegions also replaces the opened photo, so nothing
     shows twice). One undo restores the original. */
  async detectedBoxesToLayers(boxes, bgMode) {
    if (!Array.isArray(boxes) || !boxes.length) return { status: 'error', reason: 'no_regions', message: 'No subjects to convert.' };
    const flat = this.exportPNG();
    const regions = boxes.map(b => ({ type: 'product', bbox: { x: b.x / this.W * 100, y: b.y / this.H * 100, width: b.w / this.W * 100, height: b.h / this.H * 100 } }));
    return this.commitRegions(flat, regions, bgMode);
  }

  /* ── objectselect/hoverselect: detect object boxes to click against ──────────────────────
     Populates this._objBoxes with the instant local heuristic immediately (so the tool is usable
     right away), then upgrades in place with real OpenCV detection once the worker resolves —
     same two-phase pattern as the reference editor's detectObjectsLocal(). A click (_down) tests
     the clicked point against these boxes (smallest containing box wins) before falling back to a
     plain radius-seeded grabCut; this is what makes objectselect land on the actual object under
     the cursor instead of flood-filling from the exact clicked pixel. `quiet` skips the 'objcount'
     ping-style event for the instant phase (still emitted once real boxes are known) — used when
     switching tools, where a host doesn't need two rapid readout updates. */
  async detectObjectBoxes(quiet) {
    const seq = ++this._objSeq;
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return;
    this._objSrc = flat;
    this._objRegion = { left: 0, top: 0, width: this.W, height: this.H };
    if (this._hoverCache) this._hoverCache.clear();
    this._objCycle = null;
    this._objBoxes = await detectBlobsLocal(flat, this._objRegion);
    if (this._destroyed || seq !== this._objSeq) return;
    this.objCount = this._objBoxes.length;
    if (!quiet) this._emit('objcount', this.objCount);
    try {
      const imgd = prepImageData(flat, 520);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const r = await this.cv.detect({ data: imgd.data, width: imgd.width, height: imgd.height }, {});
      if (this._destroyed || seq !== this._objSeq) return;
      if ((this.tool !== 'objectselect' && this.tool !== 'hoverselect') || !r || !r.boxes || !r.boxes.length) return;
      this._objBoxes = r.boxes.map(b => ({ x: b.x / kx, y: b.y / ky, w: b.w / kx, h: b.h / ky }));
      this.objCount = this._objBoxes.length;
      if (this._hoverCache) this._hoverCache.clear();
      this._emit('objcount', this.objCount);
    } catch (e) { /* keep the local heuristic */ }
  }

  /* Smallest detected box containing pt — a click should land on the most specific/nested object,
     not the first (usually largest, e.g. a background) box that happens to contain the point. */
  _objBoxAt(pt) {
    let best = null;
    this._objBoxes.forEach(b => {
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h && (!best || b.w * b.h < best.w * best.h)) best = b;
    });
    return best;
  }

  /* Click-to-select for objectselect/hoverselect: resolve the box under the click (cycling through
     nested candidates on a repeated click near the same spot, smallest-first), then grabCut-refine
     within that box for a precise polygon instead of just using its rectangle. Falls back to a
     generic radius-seeded grabCut when no box contains the click (e.g. detection found nothing).
     Mirrors the reference editor's selectObjectAt(); this is what actually fixes "clicking selects
     the wrong region" — wandPick's plain colour-flood from the exact pixel had no concept of
     detected object boxes at all. */
  async selectObjectAt(pt, { add = false, subtract = false, cycle = false } = {}) {
    this._lastWandSeed = pt;
    // Re-detect against the CURRENT scene if it changed since the tool's snapshot was taken.
    if (!this._objRegion || this._objRegion.width !== this.W || this._objRegion.height !== this.H) {
      await this.detectObjectBoxes(true);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    }
    const cands = this._objBoxes
      .filter(b => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h)
      .sort((a, b) => a.w * a.h - b.w * b.h);
    let cycleI = 0;
    if (cycle && this._objCycle && Math.abs(this._objCycle.x - pt.x) < 10 && Math.abs(this._objCycle.y - pt.y) < 10) {
      cycleI = this._objCycle.i + 1;
    }
    this._objCycle = { x: pt.x, y: pt.y, i: cycleI };
    const box = cands.length ? cands[cycleI % cands.length] : null;
    const seq = ++this._wandSeq;
    if (this._objSrc && this._objRegion && typeof Worker !== 'undefined') {
      try {
        const region = this._objRegion;
        let work = (box && box.w * box.h < region.width * region.height * 0.45) ? box : null;
        if (!work) { const d = Math.min(region.width, region.height) * 0.45; work = { x: pt.x - d / 2, y: pt.y - d / 2, w: d, h: d }; }
        const imgd = prepImageData(this._objSrc, 768);
        const kx = imgd.width / region.width, ky = imgd.height / region.height;
        const seed = { cx: Math.round((pt.x - region.left) * kx), cy: Math.round((pt.y - region.top) * ky) };
        const wk = { x: Math.max(0, Math.round((work.x - region.left) * kx)), y: Math.max(0, Math.round((work.y - region.top) * ky)), w: Math.round(work.w * kx), h: Math.round(work.h * ky) };
        // Colour-flood seeded from the clicked pixel first (fast, exact for a flat-colour object);
        // only fall to the slower box-scoped grabCut once that fails. Skipped when cycling through
        // nested candidates — the flood would just re-find the same innermost object every time.
        let pts = null;
        if (!cycleI) pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance, SEL_EPS);
        if (!pts || pts.length < 3) {
          const imgd2 = prepImageData(this._objSrc, 768);
          pts = await this.cv.grabcut({ data: imgd2.data, width: imgd2.width, height: imgd2.height }, seed, wk);
        }
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        if (seq === this._wandSeq && pts && pts.length >= 3) {
          const sx = region.width / imgd.width, sy = region.height / imgd.height;
          const poly = this._toSceneEdgeSnapped(pts, imgd.width, imgd.height, sx, sy, region.left, region.top);
          return this._commitObjectPoly(poly, { add, subtract });
        }
      } catch (e) { /* fall through to the plain box rect below */ }
    }
    if (box && !subtract) { this.selection = { kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h }; this.multiCount = 1; this._emit('selection', this.selection); this._emit('multicount', 1); this.fc.renderAll(); return { status: 'ok' }; }
    if (box && subtract) return this._commitObjectPoly([{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }], { add, subtract });
    return { status: 'error', reason: 'no_match' };
  }

  /* Shift-click / Add-mode accumulates polygons into a multipoly WITHOUT unioning them (unlike
     wandPick's addToSelection) — objectselect deliberately keeps each picked object separate so
     mergeObjectSelection() has something to combine; auto-unioning here would make Merge a no-op.
     Alt-click still does a real boolean subtract via the cv worker, same as everywhere else. */
  async _commitObjectPoly(poly, { add, subtract } = {}) {
    if (subtract) return this.subtractFromSelection(poly);
    if (add) {
      const cur = selectionPolys(this.selection);
      const polys = (cur || []).concat([poly]);
      this.selection = polysToSelection(polys);
      this.multiCount = polys.length;
    } else {
      this.selection = { kind: 'poly', pts: poly };
      this.multiCount = 1;
    }
    this._emit('selection', this.selection);
    this._emit('multicount', this.multiCount);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  /* Merge every polygon accumulated by objectselect's Shift-click/Add mode into clean combined
     outline(s) via the cv worker's boolean union — the deliberate second step Shift-click alone
     doesn't take (see _commitObjectPoly). cv-only, like every other boolean selection op. */
  async mergeObjectSelection() {
    const polys = selectionPolys(this.selection);
    if (!polys || !polys.length) return { status: 'error', reason: 'no_selection' };
    try {
      const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
      const merged = await this.cv.union(Math.round(this.W * sc), Math.round(this.H * sc), polys.map(pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }))));
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (!merged || !merged.length) return { status: 'error', reason: 'no_match' };
      const out = merged.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc })));
      this.selection = polysToSelection(out);
      this.multiCount = out.length;
      this._emit('selection', this.selection);
      this._emit('multicount', this.multiCount);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Right-click → "Select object": shrink a rough marquee/lasso selection to the objects inside
     it (Photoshop's Object Selection in rectangle/lasso mode). The area just outside the selection
     is cropped in too — it's what the cv worker learns "background" from — and every foreground
     object found comes back as its own ring, so a box over several products selects all of them.
     `at` (scene px) is where the busy ring shows; defaults to the selection's centre. cv-only. */
  selectObjectsInSelection(at) {
    const polys = selectionPolys(this.selection);
    if (!polys || !polys.length) return Promise.resolve({ status: 'error', reason: 'no_selection' });
    // An inverted selection is the whole artboard minus its rings, so that's the area to search.
    const b = this.selection.invert ? { x: 0, y: 0, w: this.W, h: this.H } : selectionBounds(this.selection, this.W, this.H);
    // Too few pixels for GrabCut's colour models (it throws) — and nothing meaningful to find anyway.
    if (Math.abs(b.w) < 8 || Math.abs(b.h) < 8) return Promise.resolve({ status: 'error', reason: 'no_match', message: 'The selection is too small to find an object in.' });
    return this._trackPick(this._objectsInSelection(polys, b), at || { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }
  async _objectsInSelection(polys, b) {
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return { status: 'error', reason: 'no_image' };
    const sel = this.selection;
    try {
      const pad = Math.max(24, Math.max(b.w, b.h) * 0.2);
      const left = Math.max(0, b.x - pad), top = Math.max(0, b.y - pad);
      const rw = Math.min(this.W, b.x + b.w + pad) - left, rh = Math.min(this.H, b.y + b.h + pad) - top;
      if (rw < 4 || rh < 4) return { status: 'error', reason: 'no_match' };
      const k = Math.min(1, 900 / Math.max(rw, rh));
      const fx = (flat.width || this.W) / this.W, fy = (flat.height || this.H) / this.H;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(rw * k)); c.height = Math.max(1, Math.round(rh * k));
      const ctx = c.getContext('2d');
      ctx.drawImage(flat, left * fx, top * fy, rw * fx, rh * fy, 0, 0, c.width, c.height);
      const imgd = ctx.getImageData(0, 0, c.width, c.height);
      const local = polys.map(pl => pl.map(p => ({ x: (p.x - left) * k, y: (p.y - top) * k })));
      const res = await this.cv.objects({ data: imgd.data, width: imgd.width, height: imgd.height }, local, !!sel.invert);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (res == null) return { status: 'error', reason: 'cv_unavailable' };
      // The user moved on (new selection / deselect) while the worker ran — don't clobber it.
      if (this.selection !== sel) return { status: 'error', reason: 'superseded' };
      if (!res.length) return { status: 'error', reason: 'no_match', message: 'No object found inside the selection.' };
      const out = res.map(pl => pl.map(p => ({ x: left + p.x / k, y: top + p.y / k })));
      this.selection = polysToSelection(out);
      this.multiCount = out.length;
      this._emit('selection', this.selection);
      this._emit('multicount', this.multiCount);
      this.fc.renderAll();
      return { status: 'ok', count: out.length };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* ── hover-preview object select: debounced, cancellable, grid-cell cached ───────────────
     Shows, on hover, the polygon that a click WOULD select — same hybrid wand the click uses —
     so the user can confirm before committing. Single-flight: a fast-moving cursor replaces the
     pending point instead of queueing worker jobs. Cached by a coarse cell keyed on zoom and the
     current tolerance, so moving within one object is instant and changing tolerance can't serve
     a stale mask. */
  _hoverCellKey(pt) {
    const z = this.fc.getZoom() || 1;
    const cell = Math.max(3, 12 / z);
    // The cell size changes with zoom, so it's part of the key — otherwise after zooming, cell "10_20"
    // means a different spot and a preview cached for somewhere else would be shown here.
    return Math.round(pt.x / cell) + '_' + Math.round(pt.y / cell) + '_c' + cell.toFixed(2) + '_t' + this.toolOpts.tolerance;
  }
  _hoverMove(pt) {
    if (!this._hoverCache) this._hoverCache = new HoverCache(400);
    const key = this._hoverCellKey(pt);
    const cached = this._hoverCache.get(key);
    if (cached) { this._emit('hover', { pt, pts: cached }); return; }
    this._hoverPt = pt;
    if (this._hoverBusy) { this._hoverPending = pt; return; }
    this._runHover(pt);
  }
  async _runHover(pt) {
    this._hoverBusy = true;
    const seq = ++this._hoverSeq;
    try {
      this.engine.captureFlat();
      const flat = this.engine._flat;
      if (flat) {
        const imgd = prepImageData(flat, 520);
        const kx = imgd.width / this.W, ky = imgd.height / this.H;
        const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(pt.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(pt.y * ky))) };
        const pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance, SEL_EPS);
        if (this._destroyed) return;   // editor torn down mid-RPC — drop the result, don't recurse
        if (pts && pts.length >= 3 && seq === this._hoverSeq) {
          const scene = this._toSceneEdgeSnapped(pts, imgd.width, imgd.height, 1 / kx, 1 / ky, 0, 0);
          this._hoverCache.put(this._hoverCellKey(pt), scene);
          if (this._hoverPt && this._hoverCellKey(this._hoverPt) === this._hoverCellKey(pt)) this._emit('hover', { pt, pts: scene });
        }
      }
    } catch (e) { /* no preview for this spot */ }
    this._hoverBusy = false;
    const next = this._hoverPending; this._hoverPending = null;
    if (next && !this._destroyed) this._runHover(next);
  }

  /* ── history ──────────────────────────────────────────────────────────────────────────── */
  _bindModified() {
    this.fc.on('object:modified', (opt) => this._onModified(opt));
    this.fc.on('text:changed', () => this._soon());
  }

  /* Tracks the last non-bg object the user selected or moved, independent of Fabric's own
     getActiveObject() — which setTool() discards the instant a drawing tool (anything but
     'select') is picked (see setTool's `if (drawing) this.fc.discardActiveObject()`), so by the
     time a drawing-tool click actually lands there is normally no active object left to read.
     Mirrors the reference editor's own lastUpdatedRef/active() fallback pattern; currently the
     sole consumer is selectActiveOrCenter() (the 'objectselect-bbox' tool). */
  _bindLastActive() {
    // selection:created/selection:updated carry the newly-active object(s) in `selected` (an
    // array), NOT `target` — object:modified is the opposite (`target`, no `selected`) — so this
    // needs both read shapes rather than one shared `opt.target` read.
    const trackSelected = (opt) => { const t = opt && opt.selected && opt.selected[0]; if (t && t.role !== 'bg' && t.id) this._lastActiveId = t.id; };
    const trackTarget = (opt) => { const t = opt && opt.target; if (t && t.role !== 'bg' && t.id) this._lastActiveId = t.id; };
    this.fc.on('selection:created', trackSelected);
    this.fc.on('selection:updated', trackSelected);
    this.fc.on('object:modified', trackTarget);
    this.fc.on('selection:cleared', (opt) => { if (opt && opt.e) this._lastActiveId = null; });

  }

  /* Spacebar-hold pan (Photoshop/Figma convention): held while any tool is active, drag-panning
     works the same as the Hand tool without switching away from — and back to — whatever tool was
     selected. Tracked as real keydown/keyup state on document (there is no such thing as a
     MouseEvent.spaceKey; _down's own `t === 'hand' || e.spaceKey` check further down is reading a
     property that literally does not exist on a mouse event, so this state is what actually makes
     that condition true). Skips the same isTypingTarget-style targets keybindings.js guards, so
     holding Space to type an actual space character in a text field or a layer-rename input never
     gets hijacked into a pan gesture. */
  _bindSpacePan() {
    if (typeof document === 'undefined') return;
    const isTyping = () => {
      const el = document.activeElement, tag = el && el.tagName;
      if (tag === 'INPUT' && ['range', 'checkbox', 'radio', 'color', 'button'].includes((el.type || '').toLowerCase())) return false;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      const active = this.fc.getActiveObject();
      return !!(active && active.isEditing);
    };
    this._onSpaceDown = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTyping()) return;
      if (!this._spaceDown) { this._spaceDown = true; if (this.tool !== 'hand') this.fc.defaultCursor = 'grab'; }
      e.preventDefault();
    };
    this._onSpaceUp = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      this._spaceDown = false;
      if (this.tool !== 'hand') this.fc.defaultCursor = this._cursorForTool(this.tool);
    };
    // Alt/Shift switch clone/heal into "pick a source" mode, and the shells draw a different
    // cursor for it — but mouse:move only fires when the pointer actually MOVES, so holding the
    // modifier over a stationary cursor would otherwise show the wrong reticle until you twitch.
    this._onPickModifier = (e) => {
      if (e.key !== 'Alt' && e.key !== 'Shift') return;
      // Pen: Alt over an anchor flips the cursor to "convert", Shift snaps the rubber band —
      // both must show without waiting for the pointer to move.
      if ((this.tool === 'pen' || this._pathEdit) && this._penLast && !this._penDrag) this._penMove(this._penLast, e);
      if (!this._brushCursor || (this.tool !== 'clone' && this.tool !== 'heal')) return;
      this._emitBrushCursor({ x: this._brushCursor.x, y: this._brushCursor.y }, !!e.altKey, !!e.shiftKey);
      this.fc.requestRenderAll();
    };
    document.addEventListener('keydown', this._onSpaceDown);
    document.addEventListener('keyup', this._onSpaceUp);
    document.addEventListener('keydown', this._onPickModifier);
    document.addEventListener('keyup', this._onPickModifier);
  }

  /* Option/Alt+drag duplicate: mirrors the delta the object actually moved onto a fresh clone
     left at the drag's start position, so the object under the cursor stays "the one you grabbed"
     while a copy is dropped where it began — the usual Figma/design-tool convention. Only fires
     for a genuine drag (not a resize/rotate) on the same single object that was armed in _down. */
  _onModified(opt) {
    const armed = this._altDup; this._altDup = null;
    const target = opt && opt.target;
    if (armed && target && target.id === armed.id && opt.transform && opt.transform.action === 'drag'
        && (target.left !== armed.left || target.top !== armed.top)) {
      target.clone(clone => {
        clone.set({ id: uid(), name: (target.renamed ? target.name : layerLabel(target)) + ' copy', renamed: true,
          left: armed.left, top: armed.top });
        this.fc.add(clone);
        this.fc.moveTo(clone, this.fc.getObjects().indexOf(target));
        this.fc.renderAll();
        this.commit('duplicate-drag');
      }, EXTRA);
      return;
    }
    this.commit('transform');
  }
  _soon() { clearTimeout(this._st); this._st = setTimeout(() => this.commit('text-edit'), 350); }

  /* Pixel-selection history. Every settled selection change (not each tick of a marquee drag)
     records the previous selection; ⌘Z steps back through those BEFORE touching the document, and
     any document edit (commit) starts a fresh run — the same model as Photoshop's history. Without
     it, ⌘Z after Expand/Contract/Deselect undid the last document edit instead (even "Open"). */
  _recordSelection(sel) {
    const live = !!(this._drag && (this._drag.kind === 'sel' || this._drag.kind === 'resize-sel')) || !!this._polyBuild;
    if (live) return;
    const snap = sel ? JSON.parse(JSON.stringify(sel)) : null;
    const last = this._selLast === undefined ? null : this._selLast;
    if (JSON.stringify(snap) === JSON.stringify(last)) return;
    (this._selUndo = this._selUndo || []).push(last);
    if (this._selUndo.length > 50) this._selUndo.shift();
    this._selRedo = [];
    this._selLast = snap;
  }
  _restoreSelection(sel) {
    this._selRestoring = true;
    this.selection = sel ? JSON.parse(JSON.stringify(sel)) : null;
    this._selLast = sel;
    this.multiCount = this.selection ? (selectionPolys(this.selection) || []).length : 0;
    this._emit('selection', this.selection);
    this._emit('multicount', this.multiCount);
    this._selRestoring = false;
    this.fc.renderAll();
  }
  get canUndoSelection() { return !!(this._selUndo && this._selUndo.length); }
  commit(label) {
    this._recomputeAdjustmentLayers();
    this._selUndo = []; this._selRedo = [];   // a document edit starts a fresh selection run
    this._selLast = this.selection ? JSON.parse(JSON.stringify(this.selection)) : null;
    if (this.history.push(this._withIsoRestored(() => serialize(this.fc, this.W, this.H)))) {
      this._emit('history', this.history.depth());
      this._emit('change', { label });
    }
  }
  undo() {
    this._flushGradCommit();   // a pending stop edit is its own step — undo must see it
    this._flushLiveCommit();
    if (this._selUndo && this._selUndo.length) {   // selection steps come first (see _recordSelection)
      (this._selRedo = this._selRedo || []).push(this._selLast === undefined ? null : this._selLast);
      this._restoreSelection(this._selUndo.pop());
      return;
    }
    if (this._persp) this.cancelPerspectiveEdit();
    const reGrad = this._gradEdit && this._gradEdit.id;
    // Undo inside vector edit mode stays in it (Figma) — re-enter on the restored layer.
    const reEdit = this._pathEdit && this._pathEdit.id;
    this._penAbandon();
    this._iso = [];
    const s = this.history.undo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'undo' }); if (reEdit && this._byId(reEdit)) this.editPath(reEdit); if (reGrad) { const go = this._byId(reGrad); if (!go || !this._beginGradEdit(go)) this._endGradEdit(); } } });
  }
  redo() {
    this._flushGradCommit();   // a pending stop edit is its own step — undo must see it
    this._flushLiveCommit();
    if (this._selRedo && this._selRedo.length) {
      (this._selUndo = this._selUndo || []).push(this._selLast === undefined ? null : this._selLast);
      this._restoreSelection(this._selRedo.pop());
      return;
    }
    if (this._persp) this.cancelPerspectiveEdit();
    const reGrad = this._gradEdit && this._gradEdit.id;
    // Undo inside vector edit mode stays in it (Figma) — re-enter on the restored layer.
    const reEdit = this._pathEdit && this._pathEdit.id;
    this._penAbandon();
    this._iso = [];
    const s = this.history.redo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'redo' }); if (reEdit && this._byId(reEdit)) this.editPath(reEdit); if (reGrad) { const go = this._byId(reGrad); if (!go || !this._beginGradEdit(go)) this._endGradEdit(); } } });
  }
  _afterRestore(w, h) {
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this._emit('resize', { width: w, height: h });
  }

  /* ── layers ───────────────────────────────────────────────────────────────────────────── */
  /* Panel order is topmost first. A container group (isContainerGroup — the user's ⌘G groups,
     not stickers/ad-copy, which are Groups internally but edit as one layer) also carries
     `children`: its members as layer entries (topmost first, `parentId` set), so a panel can nest
     them the way Photoshop/Figma do. The top-level list itself stays one entry per canvas object,
     so every `layers().find(l => l.active)` / `.length` caller keeps meaning the same thing.
     A child's `active` means "the panel's focused member of the active group" (see
     activate()) — Fabric 5 can't make a group member the canvas's active object itself. */
  layers() {
    const active = this.fc.getActiveObject();
    const multi = active && active.type === 'activeSelection' ? active.getObjects() : null;
    const inMulti = (o) => !!multi && multi.includes(o);
    // A member entered by double-click (see _enterMember) sits on the canvas while it's being
    // edited; the panel still shows it at its place inside its group — the document's real tree.
    const vkids = (g) => this._isoKids(g);
    const hasFocused = (g) => vkids(g).some(c => c === active || (isContainerGroup(c) && hasFocused(c)));
    const entry = (o, i, parent) => {
      const kids = isContainerGroup(o) ? vkids(o) : null;
      return {
        id: o.id || (o.id = uid()), index: i, name: layerLabel(o), role: o.role || 'shape',
        visible: o.visible !== false, locked: !!o.locked, opacity: o.opacity != null ? o.opacity : 1,
        blend: o.globalCompositeOperation || 'source-over',
        active: active === o,
        // `selected` also covers members of a multi-selection (shift-click in the panel or on the
        // canvas) — `active` stays single-object so `.find(l => l.active)` callers are unaffected.
        selected: active === o || inMulti(o),
        maskable: !parent && this._maskable(o), hasMask: !!o.maskCanvas, maskEnabled: o.maskEnabled !== false,
        editingMask: !!this._maskEdit && this._maskEdit.layerId === o.id,
        isAdjustment: o.role === 'adjustment', adj: o.role === 'adjustment' ? { ...FX_DEFAULTS, ...o.adj } : null,
        ...(({ kind, subtitle, shape }) => ({ kind, subtitle, shape: shape || null }))(describeLayer(o)),
        fill: typeof o.fill === 'string' && !o.fillOff ? o.fill : null, hasShadow: !!o.shadow,   // a hidden fill (eye off) has no swatch
        parentId: parent ? parent.id : null,
        ...(kids ? { isGroup: true, children: kids.map((c, j) => entry(c, j, o)).reverse(),
          childActive: !!active && hasFocused(o) } : {}),
      };
    };
    return this.fc.getObjects().filter(o => !this._isoEntry(o)).map((o, i) => entry(o, i, null)).reverse();
  }
  /* Like _byId, but also finds members of container groups (the ids layers()' `children` carry).
     Only the layer-panel operations below use it — everything else keeps _byId's top-level-only
     contract, since a group member isn't independently selectable/transformable on the canvas. */
  _findLayer(id, objs = this.fc.getObjects()) {
    for (const o of objs) {
      if (o.id === id) return o;
      if (isContainerGroup(o)) { const c = this._findLayer(id, o.getObjects()); if (c) return c; }
    }
    return null;
  }
  /* The container group `o` is a member of, or null. Not just `o.group`: Fabric 5 also sets that
     on every member of a multi-selection (pointing at the ActiveSelection), which must keep being
     treated as plain top-level layers. */
  _parentGroup(o) { return o && o.group && o.group.type !== 'activeSelection' ? o.group : null; }
  // The top-level ancestor of a (possibly nested) group member — the one canvas-selectable unit.
  _rootLayer(o) { let r = o; while (this._parentGroup(r)) r = r.group; return r; }
  // A member's change must bust the render cache of every group it's nested in, not just its own.
  _dirtyUp(o) { for (let g = this._parentGroup(o); g; g = this._parentGroup(g)) g.dirty = true; }

  /* ── entering groups (Figma-style double-click drill-down) ─────────────────────────────────
     Fabric 5 can't make a group member the canvas's active object, so "selecting inside a group"
     lifts that member out onto the canvas (same absolute transform, stacked just above its group)
     where it gets real handles, and puts it back — at its original index — once the selection
     moves elsewhere. `_iso` is the stack of lifted members, outermost first: drilling two levels
     deep lifts the inner group, then its member.

     The lifted state is never persisted: commit()/toJSON() run with every member put back
     (_withIsoRestored), so history, autosave and project files only ever see the real tree, and
     layers() reports members at their real place. The one visible difference while editing is
     z-order — the lifted member draws above its group's other members until it's put back. */
  _isoEntry(o) { return (this._iso || []).find(e => e.obj === o) || null; }
  _isoKids(g) {
    const kids = g.getObjects().slice();
    for (const e of this._iso || []) if (e.parent === g && !kids.includes(e.obj)) kids.splice(Math.min(e.index, kids.length), 0, e.obj);
    return kids;
  }
  // Canvas-list splices that fire no object:added/removed or selection events — lifting/restoring
  // is bookkeeping, not an edit, and must not trip the selection listeners that trigger it.
  _rawRemove(o) {
    const i = this.fc._objects.indexOf(o); if (i < 0) return false;
    this.fc._objects.splice(i, 1); this.fc._objectsToRender = undefined;
    return true;
  }
  _lift(o) {
    const g = this._parentGroup(o); if (!g) return;
    const gi = this.fc._objects.indexOf(g); if (gi < 0) return;   // only from a group that's on the canvas
    const index = g._objects.indexOf(o);
    g.removeWithUpdate(o);   // hands o back its absolute transform
    this.fc._objects.splice(this.fc._objects.indexOf(g) + 1, 0, o);
    this.fc._objectsToRender = undefined;
    o.canvas = this.fc; o.setCoords();
    this._iso.push({ obj: o, parent: g, index });
  }
  _unliftTop() {
    const e = this._iso.pop(); if (!e) return;
    // Deleted while lifted (removeLayer on the lifted member): nothing to put back.
    if (!this._rawRemove(e.obj)) return;
    e.parent.addWithUpdate(e.obj);
    const kids = e.parent._objects;
    kids.splice(kids.indexOf(e.obj), 1); kids.splice(Math.min(e.index, kids.length), 0, e.obj);
    e.parent.dirty = true; e.parent.setCoords();
  }
  _exitIsolation(keep = null) {
    // Put back everything lifted above `keep` (a still-lifted member the new selection is on), or all.
    while (this._iso.length && this._iso[this._iso.length - 1].obj !== keep) this._unliftTop();
  }
  _withIsoRestored(fn) {
    if (!this._iso.length) return fn();
    const chain = this._iso.map(e => e.obj);
    this._exitIsolation();
    try { return fn(); } finally { chain.forEach(o => this._lift(o)); }
  }
  // Lift the chain of groups from `o`'s outermost ancestor down to `o` itself, putting back any
  // lifted member that isn't on that chain first.
  _enterMember(o) {
    const chain = [];
    for (let x = o; x; x = this._isoEntry(x) ? this._isoEntry(x).parent : this._parentGroup(x)) chain.unshift(x);
    let keep = null;
    for (const e of this._iso) { if (chain.includes(e.obj)) keep = e.obj; else break; }
    this._exitIsolation(keep);
    for (const x of chain) if (this._parentGroup(x)) this._lift(x);
  }
  // Topmost visible, unlocked member of `g` under scene point `p` (bounding-box hit test).
  _memberAt(g, p) {
    const u = this.fabric.util;
    const local = u.transformPoint(p, u.invertTransform(g.calcTransformMatrix()));
    const kids = g.getObjects();
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (c.visible === false || c.locked) continue;
      const q = u.transformPoint(local, u.invertTransform(c.calcOwnMatrix()));
      const w = (c.width || 0) + (c.strokeWidth || 0), h = (c.height || 0) + (c.strokeWidth || 0);
      if (Math.abs(q.x) <= w / 2 && Math.abs(q.y) <= h / 2) return c;
    }
    return null;
  }
  _bindIsolation() {
    this._iso = [];
    // Double-click a group (select tool): select the member under the pointer, one level deeper
    // per double-click — the group itself stays selectable by a plain click as before.
    this.fc.on('mouse:dblclick', (opt) => {
      if (this.tool !== 'select') return;
      const t = opt.target;
      if (!t || !isContainerGroup(t) || t.locked) return;
      const m = this._memberAt(t, this.fc.getPointer(opt.e));
      if (!m) return;
      this._enterMember(m);
      this.fc.setActiveObject(m);
      this.fc.requestRenderAll();
      this._emit('change', { label: 'activate' });
    });
    const onSel = () => {
      if (this._isoBusy || !this._iso.length) return;
      const a = this.fc.getActiveObject();
      if (a && a.type === 'activeSelection' && a.getObjects().some(o => this._isoEntry(o))) {
        // Shift-clicked a lifted member into a multi-selection: it can't be put back while it's
        // inside the ActiveSelection, so rebuild the selection from each member's outermost group.
        this._isoBusy = true;
        const roots = [...new Set(a.getObjects().map(o => { let r = o; while (this._isoEntry(r)) r = this._isoEntry(r).parent; return this._rootLayer(r); }))];
        this.fc.discardActiveObject();
        this._exitIsolation();
        if (roots.length > 1) this.fc.setActiveObject(new this.fabric.ActiveSelection(roots, { canvas: this.fc }));
        else if (roots.length) this.fc.setActiveObject(roots[0]);
        this._isoBusy = false;
        this.fc.requestRenderAll();
        return;
      }
      this._exitIsolation(a && this._isoEntry(a) ? a : null);
      this.fc.requestRenderAll();
    };
    ['selection:created', 'selection:updated', 'selection:cleared'].forEach(ev => this.fc.on(ev, onSel));
  }
  _byId(id) { return this.fc.getObjects().find(o => o.id === id); }
  setLayer(id, patch, { live = false } = {}) {
    const o = this._findLayer(id); if (!o) return;
    if ('visible' in patch) o.visible = patch.visible;
    if ('opacity' in patch) o.opacity = patch.opacity;
    if ('locked' in patch) { o.locked = patch.locked; o.selectable = !patch.locked; o.evented = !patch.locked; this._syncLockProps(o); }
    if ('blend' in patch) o.globalCompositeOperation = patch.blend;
    if ('name' in patch) { o.name = patch.name; o.renamed = true; }
    this._dirtyUp(o);
    this.fc.renderAll();
    if (live) this._liveCommit('layer'); else this.commit('layer');
  }
  moveLayer(id, dir) {
    if (this._iso.length) return this._withIsoRestored(() => this.moveLayer(id, dir));
    const o = this._findLayer(id); if (!o) return;
    if (this._parentGroup(o)) {   // a member restacks within its own group ("up" = toward the group's top)
      const kids = o.group._objects, i = kids.indexOf(o);
      const j = dir === 'up' ? i + 1 : dir === 'down' ? i - 1 : dir === 'top' ? kids.length - 1 : 0;
      if (j < 0 || j >= kids.length || j === i) return;
      kids.splice(i, 1); kids.splice(j, 0, o);
      this._dirtyUp(o);
      this.fc.renderAll(); this.commit('reorder');
      return;
    }
    if (dir === 'up') this.fc.bringForward(o); else if (dir === 'down') this.fc.sendBackwards(o);
    else if (dir === 'top') this.fc.bringToFront(o); else if (dir === 'bottom') this.fc.sendToBack(o);
    this._keepBgAtBottom();
    this.fc.renderAll(); this.commit('reorder');
  }
  /* Drag-to-reorder: move layer `id` to sit directly in front of (default) or behind layer
     `targetId` in stacking order — "in front of" is the natural drop semantic for a layers panel
     that lists topmost-first (fc.getObjects() index order is bottom-to-top, the OPPOSITE of the
     panel's display order, so "in front of target" means one PAST target's fc index, not before
     it). No-op if either id is missing or they're the same object. */
  reorderLayerTo(id, targetId, { after = false } = {}) {
    if (id === targetId) return;
    // Drops that involve a group member rebuild group bounds, so start from the real tree with
    // nothing selected (lifted members put back — see _exitIsolation — and no stale handles).
    const involvesMember = (x) => x && (this._parentGroup(x) || this._isoEntry(x));
    if (this._iso.length || involvesMember(this._findLayer(id)) || involvesMember(this._findLayer(targetId))) this.fc.discardActiveObject();
    const o = this._findLayer(id), target = this._findLayer(targetId); if (!o || !target) return;
    if (this._parentGroup(o) || this._parentGroup(target)) {
      // A group can't be dropped inside itself.
      for (let g = this._parentGroup(target); g; g = this._parentGroup(g)) if (g === o) return;
      if (o.role === 'bg') return;
      // Moving across levels (into a group, out of one, or between groups) keeps o where it is on
      // the artboard: capture its absolute transform, detach it, then re-express that transform in
      // the destination's coordinate plane.
      const u = this.fabric.util;
      const abs = o.calcTransformMatrix();
      // Where target sits now — the fallback if detaching o empties (and so removes) target itself,
      // e.g. a group's only member dropped onto that group's own row.
      const dest = this._parentGroup(target);
      const preIdx = (dest ? dest._objects : this.fc._objects).indexOf(target);
      this._detachMember(o, abs);
      const at = (list) => { const i = list.indexOf(target); return i < 0 ? preIdx - 1 : i; };
      if (dest) {
        const t = at(dest._objects);
        u.applyTransformToObject(o, u.multiplyTransformMatrices(u.invertTransform(dest.calcTransformMatrix()), abs));
        dest._objects.splice(after ? t : t + 1, 0, o);
        o.group = dest; o.canvas = this.fc;
        dest.addWithUpdate();   // re-fits dest's bounds (and its parents', for a nested dest)
        dest.dirty = true; this._dirtyUp(dest);
      } else {
        const t = at(this.fc._objects);
        this.fc._objects.splice(after ? t : t + 1, 0, o);
        this.fc._objectsToRender = undefined;
        o.canvas = this.fc;
      }
      o.setCoords();
      this.fc.renderAll(); this.commit('reorder');
      return;
    }
    const objs = this.fc.getObjects();
    let idx = objs.indexOf(target);
    if (idx < 0) return;
    if (!after) idx += 1;   // "in front of" target = just past it in fc's bottom-to-top order
    if (objs.indexOf(o) < idx) idx -= 1;   // account for o's own removal shifting later indices down
    this.fc.moveTo(o, Math.max(0, idx));
    this.fc.renderAll(); this.commit('reorder');
  }
  /* Take `o` out of whatever holds it (canvas or group) without firing canvas events, leaving it
     un-parented with absolute transform `abs`. A group left empty goes too, recursively; one that
     still has members re-fits its bounds. */
  _detachMember(o, abs) {
    const g = this._parentGroup(o);
    if (g) {
      g.remove(o);   // Collection.remove: drops o.group, no bounds refit yet
      if (!g.size()) this._detachMember(g, g.calcTransformMatrix());
      else { g.addWithUpdate(); g.dirty = true; this._dirtyUp(g); g.setCoords(); }
    } else {
      this._rawRemove(o);
    }
    this.fabric.util.applyTransformToObject(o, abs);
  }
  removeLayer(id) {
    // Dropping the selection puts every lifted member back first, so `id` is found at its real place.
    if (this._iso.length) this.fc.discardActiveObject();
    const o = this._findLayer(id); if (!o) return;
    if (this._parentGroup(o)) {   // removing a member: drop it from its group, and the group once it's empty
      const g = o.group;
      if (g.size() <= 1) { this.removeLayer(g.id); return; }   // recurses: a nested group leaves its parent
      g.removeWithUpdate(o);
      g.dirty = true; this._dirtyUp(g); g.setCoords();   // o has left g, so walk up from g
      this.fc.renderAll(); this.commit('remove');
      return;
    }
    // Deleting the layer currently being mask-painted must drop the in-flight mask-edit state and
    // cancel (not flush) any pending rAF refresh — the refresh's target is about to be removed
    // from the canvas, so there's nothing left to apply it to (see removeMask's identical guard).
    if (this._maskEdit && this._maskEdit.layerId === id) { this._cancelFrameJob('mask'); this._maskEdit = null; this._maskDrag = null; this._emit('maskedit', null); }
    this.fc.remove(o);
    this.commit('remove');
  }
  activate(id) {
    const o = this._findLayer(id);
    if (o) {
      if (this.tool !== 'select') this.setTool('select');
      // A group member (panel click) is entered the same way a canvas double-click enters it.
      if (this._parentGroup(o) || this._isoEntry(o)) this._enterMember(o);
      this._syncLockProps(o);
      this.fc.setActiveObject(o);
      this.fc.renderAll();
      this._emit('change', { label: 'activate' });
    }
  }

  /* Shift/Cmd-click in a layers panel: add layer `id` to the canvas selection, or drop it if it's
     already in — building a Fabric ActiveSelection past one layer, so group/align/delete then act
     on the lot. A group member stands in for its group (Fabric 5 can't multi-select inside one);
     the background and locked layers never join, same as on the canvas. */
  toggleLayerSelection(id) {
    // Multi-selection is top-level only: put lifted members back, then work in outermost groups.
    this._exitIsolation();
    let o = this._findLayer(id); if (!o) return;
    o = this._rootLayer(o);
    if (o.role === 'bg' || o.locked) return;
    if (this.tool !== 'select') this.setTool('select');
    const cur = this.fc.getActiveObject();
    const picked = [...new Set((!cur ? [] : cur.type === 'activeSelection' ? cur.getObjects() : [cur]).map(x => this._rootLayer(x)))];
    const i = picked.indexOf(o);
    if (i >= 0) picked.splice(i, 1); else picked.push(o);
    // Discard first so the old selection's members get their own transforms back before regrouping.
    this.fc.discardActiveObject();
    const all = this.fc.getObjects();
    picked.sort((a, b) => all.indexOf(a) - all.indexOf(b));   // keep stacking order inside the selection
    if (picked.length === 1) this.fc.setActiveObject(picked[0]);
    else if (picked.length > 1) this.fc.setActiveObject(new this.fabric.ActiveSelection(picked, { canvas: this.fc }));
    this.fc.renderAll();
    this._emit('change', { label: 'activate' });
  }

  duplicateLayer(id, offset = 12) {
    const o = this._byId(id); if (!o) return;   // top-level only: a member's coords are group-relative
    return new Promise(resolve => {
      o.clone(clone => {
        clone.set({ id: uid(), name: (o.renamed ? o.name : layerLabel(o)) + ' copy', renamed: true,
          left: (clone.left || 0) + offset, top: (clone.top || 0) + offset });
        this.fc.add(clone);
        this.fc.setActiveObject(clone);
        this.commit('duplicate');
        resolve(clone.id);
      }, EXTRA);
    });
  }

  /* Copy/paste — clipboard lives in memory on the Editor (not the OS clipboard), so it works the
     same across the vanilla demo and the React shell without a Clipboard API permission dance.
     copySelection() clones the active object/activeSelection now, so later edits to the source
     don't leak into what gets pasted. Each paste offsets a little further, so repeated Cmd/Ctrl+V
     fans copies out instead of stacking them exactly on top of each other. */
  copySelection() {
    const a = this.fc.getActiveObject();
    if (!a) return false;
    return new Promise(resolve => {
      a.clone(clone => { this._clipboard = clone; this._pasteCount = 0; resolve(true); }, EXTRA);
    });
  }

  pasteClipboard(offset = 12) {
    const src = this._clipboard;
    if (!src) return;
    this._pasteCount = (this._pasteCount || 0) + 1;
    const d = offset * this._pasteCount;
    return new Promise(resolve => {
      src.clone(clone => {
        this.fc.discardActiveObject();
        if (clone.type === 'activeSelection') {
          clone.canvas = this.fc;
          clone.forEachObject(o => {
            o.set({ id: uid(), name: (o.renamed ? o.name : layerLabel(o)) + ' copy', renamed: true,
              left: (o.left || 0) + d, top: (o.top || 0) + d });
            this.fc.add(o);
          });
          clone.setCoords();
          this.fc.setActiveObject(clone);
        } else {
          clone.set({ id: uid(), name: (clone.renamed ? clone.name : layerLabel(clone)) + ' copy', renamed: true,
            left: (clone.left || 0) + d, top: (clone.top || 0) + d });
          this.fc.add(clone);
          this.fc.setActiveObject(clone);
        }
        this.fc.renderAll();
        this.commit('paste');
        resolve(clone.id);
      }, EXTRA);
    });
  }

  /* ── right-click menu ───────────────────────────────────────────────────────────────────
     Figma behaviour: right-clicking a layer that isn't already selected selects it first (a
     right-click inside a multi-selection keeps the whole selection); right-clicking empty canvas
     clears the selection. Then emits 'contextmenu' { x, y, pt, sections } for the shell to render
     (see contextmenu.js — buildContextMenu decides the items, mountContextMenu draws them). */
  _layersAt(pt) {
    const F = this.fabric, P = new F.Point(pt.x, pt.y);
    return this.fc.getObjects().slice().reverse().filter(o => {
      if (o.visible === false || o.excludeFromExport || o.role === 'draft') return false;
      if (!o.aCoords) o.setCoords();
      // Members of a multi-selection keep coordinates relative to it — test in that space.
      const q = o.group ? F.util.transformPoint(P, F.util.invertTransform(o.group.calcTransformMatrix())) : P;
      return o.containsPoint(q, null, true, true);
    });
  }
  openContextMenu(pt, client = {}) {
    if (this._drag || this._penDrag) return null;
    const hit = this._layersAt(pt)[0] || null;
    const b = this.selection ? selectionBounds(this.selection, this.W, this.H) : null;
    this._ctxOnSelection = !!(b && SEL_TOOLS.includes(this.tool) && pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
    if (!this._penBuild && !this._pathEdit && !this._ctxOnSelection) {
      const active = this.fc.getActiveObject();
      const inActive = !!(active && hit && (active === hit || (active.type === 'activeSelection' && active.contains(hit))));
      // (not `selectable` — drawing tools set that false on every layer; activate() switches to Select)
      if (hit && !hit.locked) { if (!inActive) this.activate(hit.id); }
      else if (!hit && active) { this.fc.discardActiveObject(); this.fc.requestRenderAll(); this._emit('change', { label: 'activate' }); }
      else if (hit && hit.locked && active && !inActive) { this.fc.discardActiveObject(); this.fc.requestRenderAll(); }
    }
    const sections = buildContextMenu(this, { pt, hit });
    const ev = { x: client.x != null ? client.x : 0, y: client.y != null ? client.y : 0, pt, targetId: hit && hit.id, sections };
    this._emit('contextmenu', ev);
    return ev;
  }

  /* The active selection as a list of top-level layers (an ActiveSelection's members, or the one object). */
  _selectedLayers() {
    const a = this.fc.getActiveObject();
    if (!a) return [];
    return a.type === 'activeSelection' ? a.getObjects().slice() : [a];
  }
  duplicateSelection() {
    const a = this.fc.getActiveObject(); if (!a) return null;
    if (a.type !== 'activeSelection') return this.duplicateLayer(a.id);
    return Promise.resolve(this.copySelection()).then(() => this.pasteClipboard());
  }
  deleteSelection() {
    const objs = this._selectedLayers(); if (!objs.length) return;
    this.fc.discardActiveObject();
    if (objs.length === 1) { this.removeLayer(objs[0].id); return; }
    objs.forEach(o => this.fc.remove(o));
    this.fc.renderAll();
    this.commit('remove');
  }
  async cutSelection() {
    if (!this.fc.getActiveObject()) return false;
    await this.copySelection();
    this.deleteSelection();
    return true;
  }
  /* Paste the clipboard centred on scene point `pt` (the right-click spot). */
  pasteAt(pt, { commit = true } = {}) {
    const src = this._clipboard; if (!src) return null;
    return new Promise(resolve => {
      src.clone(clone => {
        if (!clone) { resolve(null); return; }   // e.g. an image whose source failed to reload
        this.fc.discardActiveObject();
        if (this.tool !== 'select') this.setTool('select');
        const center = new this.fabric.Point(pt.x, pt.y);
        if (clone.type === 'activeSelection') {
          clone.canvas = this.fc;
          clone.setPositionByOrigin(center, 'center', 'center');
          clone.forEachObject(o => {
            o.set({ id: uid(), name: (o.renamed ? o.name : layerLabel(o)) + ' copy', renamed: true });
            this.fc.add(o);
          });
          clone.setCoords();
          this.fc.setActiveObject(clone);
        } else {
          clone.set({ id: uid(), name: (clone.renamed ? clone.name : layerLabel(clone)) + ' copy', renamed: true });
          clone.setPositionByOrigin(center, 'center', 'center');
          clone.setCoords();
          this.fc.add(clone);
          this.fc.setActiveObject(clone);
        }
        this.fc.renderAll();
        if (commit) this.commit('paste');
        resolve(clone.id);
      }, EXTRA);
    });
  }
  /* Swap the selected layer(s) for the clipboard, centred where they were and at their stacking
     position — one undo step. */
  pasteToReplace() {
    const objs = this._selectedLayers(); if (!objs.length || !this._clipboard) return null;
    const a = this.fc.getActiveObject();
    const c = a.getCenterPoint();
    const all = this.fc.getObjects(), idx = Math.min(...objs.map(o => all.indexOf(o)));
    this.fc.discardActiveObject();
    objs.forEach(o => this.fc.remove(o));
    // one undo step for remove + paste: the paste itself doesn't commit, this does
    return this.pasteAt({ x: c.x, y: c.y }, { commit: false }).then(id => {
      const o = id && this._byId(id);
      if (o && idx >= 0) this.fc.moveTo(o, idx);
      this.fc.renderAll();
      this.commit('paste-replace');
      return id;
    });
  }
  /* Bring to front / forward / send backward / to back for whatever is selected. */
  arrangeSelection(dir) {
    const a = this.fc.getActiveObject(); if (!a) return;
    if (a.type !== 'activeSelection') { this.moveLayer(a.id, dir); return; }
    if (dir === 'top') this.fc.bringToFront(a); else if (dir === 'bottom') this.fc.sendToBack(a);
    else if (dir === 'up') this.fc.bringForward(a); else if (dir === 'down') this.fc.sendBackwards(a);
    this._keepBgAtBottom();
    this.fc.renderAll(); this.commit('reorder');
  }
  /* "Send to back" means just above the background — a layer sent under the bg is hidden behind it. */
  _keepBgAtBottom() {
    const bgs = this.fc.getObjects().filter(o => o.role === 'bg');
    for (let i = bgs.length - 1; i >= 0; i--) this.fc.moveTo(bgs[i], 0);
  }
  selectAllLayers() {
    if (this.tool !== 'select') this.setTool('select');
    const objs = this.fc.getObjects().filter(o => o.selectable !== false && !o.locked && o.role !== 'bg' && o.visible !== false && !o.excludeFromExport);
    this.fc.discardActiveObject();
    if (objs.length === 1) this.fc.setActiveObject(objs[0]);
    else if (objs.length > 1) this.fc.setActiveObject(new this.fabric.ActiveSelection(objs, { canvas: this.fc }));
    this.fc.renderAll();
    this._emit('change', { label: 'activate' });
    return objs.length;
  }
  /* Hide/show and lock/unlock the selection as ONE undo step (setLayer commits per layer). */
  toggleSelectionVisible() {
    const objs = this._selectedLayers(); if (!objs.length) return;
    const show = objs.every(o => o.visible === false);
    objs.forEach(o => { o.visible = show; this._dirtyUp(o); });
    // the selection stays (Figma does the same), so pressing ⇧⌘H again shows it again
    this.fc.renderAll(); this.commit('layer');
  }
  /* A locked layer can still be selected (layers panel) to unlock/inspect it, but never transformed. */
  _syncLockProps(o) {
    const l = !!o.locked;
    o.set({ lockMovementX: l, lockMovementY: l, lockScalingX: l, lockScalingY: l, lockRotation: l, hasControls: !l });
  }
  toggleSelectionLock() {
    const objs = this._selectedLayers(); if (!objs.length) return;
    const lock = !objs.every(o => o.locked);
    this.fc.discardActiveObject();
    objs.forEach(o => { o.locked = lock; o.selectable = !lock; o.evented = !lock && this.tool === 'select'; this._syncLockProps(o); this._dirtyUp(o); });
    this.fc.renderAll(); this.commit('layer');
  }
  /* The selection, rendered on its own at its on-canvas size, onto the system clipboard as a PNG. */
  async copyAsPNG() {
    const a = this.fc.getActiveObject(); if (!a) return { status: 'error', reason: 'no_selection' };
    const url = a.toDataURL({ format: 'png', multiplier: 1, enableRetinaScaling: false });
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('Clipboard images are not supported in this browser');
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return { status: 'ok' };
    } catch (e) {
      const r = { status: 'error', reason: 'clipboard_failed', message: String(e && e.message || e) };
      this._emit('error', r);
      return r;
    }
  }

  /* Aligns a layer to the artboard bounds. edge: 'left'|'center'|'right'|'top'|'middle'|'bottom'. */
  alignLayer(id, edge) {
    const o = this._byId(id); if (!o) return;
    o.setCoords();
    const b = o.getBoundingRect(true);
    const { dx, dy } = alignDelta(b, this.W, this.H, edge);
    o.left = (o.left || 0) + dx;
    o.top = (o.top || 0) + dy;
    o.setCoords();
    this.fc.renderAll();
    this.commit('align');
  }

  /* Aligns the current selection: a single layer aligns to the artboard (alignLayer above); two or
     more (a fabric activeSelection) align to each other's combined bounds instead, Figma-style —
     each member moves independently to line up on the shared edge/axis, the group shape unchanged. */
  alignActiveSelection(edge) {
    const a = this.fc.getActiveObject();
    if (!a) return;
    if (a.type !== 'activeSelection') { if (a.id) this.alignLayer(a.id, edge); return; }
    const members = a.getObjects();
    if (!members.length) return;
    a.setCoords();
    /* A fabric ActiveSelection positions its members relative to its own center, not the canvas —
       member.left/top and member.getBoundingRect(true) already live in that shifted space. Adding
       half the selection's own size re-origins that space to the selection's top-left corner, which
       is what alignDelta expects (a box measured from a 0,0 reference). */
    const selW = a.width * (a.scaleX || 1), selH = a.height * (a.scaleY || 1);
    members.forEach(o => {
      o.setCoords();
      const b = o.getBoundingRect(true);
      const local = { left: b.left + selW / 2, top: b.top + selH / 2, width: b.width, height: b.height };
      const { dx, dy } = alignDelta(local, selW, selH, edge);
      o.left = (o.left || 0) + dx;
      o.top = (o.top || 0) + dy;
      o.setCoords();
    });
    a.setCoords();
    this.fc.renderAll();
    this.commit('align');
  }

  /* The off-canvas mask's fill colour (see the constructor) — a host should call this whenever
     its own stage background changes (e.g. a light/dark theme toggle) so the mask keeps matching
     the surrounding chrome instead of showing a mismatched patch around the artboard. */
  setVoidColor(color) {
    this._voidColor = color;
    this.fc.requestRenderAll();
  }

  /* ── snap-while-dragging: object edges/centers snap to the artboard and to other layers, and
     emit "smart guide" lines (Figma's dragged-alignment indicators) for a host UI to draw ──── */
  setSnapEnabled(on) {
    this._snap = !!on;
    if (on && !this._snapBound) {
      this._snapBound = true;
      this.fc.on('object:moving', (opt) => { this._snapMove(opt.target); this._liveAdjustmentPreview(); });
      this.fc.on('object:scaling', () => this._liveAdjustmentPreview());
      this.fc.on('object:rotating', () => this._liveAdjustmentPreview());
      this.fc.on('object:modified', () => { this._flushFrameJob('adjustment'); this._emit('guides', null); });
      this.fc.on('mouse:up', () => this._emit('guides', null));
    }
  }
  _snapMove(o) {
    if (!this._snap) { this._emit('guides', null); return; }
    o.setCoords();
    const b = o.getBoundingRect(true);
    const others = this.fc.getObjects().filter(x => x !== o).map(x => x.getBoundingRect(true));
    const { dx, dy, snappedX, snappedY, guideX, guideY } = snapDelta(b, this.W, this.H, others);
    if (snappedX) o.left += dx;
    if (snappedY) o.top += dy;
    if (snappedX || snappedY) o.setCoords();
    this._emit('snap', { x: snappedX, y: snappedY });
    this._emit('guides', (guideX || guideY) ? { x: guideX, y: guideY } : null);
  }

  /* Adjustment layers only recompute their captured bitmap in commit() (mouseup) — without this,
     transforming (move/scale/rotate) a layer that sits below an adjustment layer shows a stale,
     un-adjusted preview of it mid-gesture that only snaps to the correct filtered composite once
     the gesture ends. Skipped entirely when there are no adjustment layers in the scene, so the
     common case (no adjustment layers at all) pays no extra per-frame cost while dragging.
     _recomputeAdjustmentLayers() is a full re-flatten + per-pixel filter pass per adjustment
     layer, too expensive to run on every raw pointermove/scaling tick (those can fire faster than
     the display refreshes) — coalesced to the shared per-animation-frame scheduler below, same
     pattern as _refreshMaskFilter's mask-paint throttling. */
  _liveAdjustmentPreview() {
    if (this.fc.getObjects().some(o => o.role === 'adjustment')) this._coalesceToFrame('adjustment');
  }

  /* Shared "run this at most once per animation frame" scheduler — later calls with the same key
     before the frame fires just replace which job runs, so a burst of raw pointer events during a
     drag/scale/rotate collapses to a single recompute per frame instead of one per event. `flush`
     runs the job synchronously right now (used at a gesture's end, so a commit()/serialize() right
     after never captures a scene whose last-tick recompute hasn't actually run yet). */
  _coalesceToFrame(key, job) {
    this._frameJobs = this._frameJobs || {};
    this._frameHandles = this._frameHandles || {};
    if (job) this._frameJobs[key] = job;
    if (this._frameHandles[key]) return;
    this._frameHandles[key] = requestAnimationFrame(() => { this._frameHandles[key] = null; this._flushFrameJob(key); });
  }
  _flushFrameJob(key) {
    if (this._frameHandles && this._frameHandles[key]) { cancelAnimationFrame(this._frameHandles[key]); this._frameHandles[key] = null; }
    const job = this._frameJobs && this._frameJobs[key]; if (this._frameJobs) this._frameJobs[key] = null;
    if (key === 'adjustment') { this._recomputeAdjustmentLayers(); this.fc.requestRenderAll(); }
    else if (key === 'mask') {
      const target = this._pendingMaskTarget; this._pendingMaskTarget = null;
      if (!target) return;
      if (this._isVectorMasked(target)) { touchVectorMask(target); this.fc.requestRenderAll(); return; }
      const f = (target.filters || []).find(x => x.type === 'MaskFilter');
      if (f) { f.maskCanvas = target.maskEnabled !== false ? target.maskCanvas : null; target.applyFilters(); this.fc.requestRenderAll(); }
    }
    else if (typeof job === 'function') job();
  }
  /* Cancels a scheduled frame job without running it — used when the target it would have acted
     on is gone (layer deleted, editor destroyed) so the deferred work has nothing left to do. */
  _cancelFrameJob(key) {
    if (this._frameHandles && this._frameHandles[key]) { cancelAnimationFrame(this._frameHandles[key]); this._frameHandles[key] = null; }
    if (this._frameJobs) this._frameJobs[key] = null;
    if (key === 'mask') this._pendingMaskTarget = null;
  }

  /* Rounded corners stay ROUND under any resize. Fabric draws a rect's rx/ry in its own local
     space, so scaling a rect non-uniformly (a side handle, or W/H in the panel) stretches the
     corners into ovals — a 20px radius dragged to 2× width renders 40px wide by 20px tall. The
     radius the user means is stored in scene pixels as `o.cornerRadius`, and rx/ry are derived
     from it and the object's EFFECTIVE scale (its own × every parent group's, via qrDecompose):
     rx = R / scaleX, ry = R / scaleY. Clamped to half the shorter side, so shrinking a rect never
     over-rounds it and growing it back restores the original radius. Runs live on every scaling
     tick (also for rects inside a scaled group/multi-selection — e.g. an ad CTA pill) and after
     numeric edits. Stroke width is left as it was (it still scales with the object). */
  _bindRoundCorners() {
    this.fc.on('object:scaling', (opt) => { if (opt.target) this._normalizeCorners(opt.target); });
    this.fc.on('object:modified', (opt) => { if (opt.target) this._normalizeCorners(opt.target); });
  }
  cornerRadiusOf(o) {
    if (!o || o.type !== 'rect') return 0;
    if (o.cornerRadius != null) return o.cornerRadius;
    const m = this.fabric.util.qrDecompose(o.calcTransformMatrix());
    // a legacy rect (made before cornerRadius existed): the radius as it renders on the SHORTER
    // corner axis — the one the user most plausibly set
    return Math.min((o.rx || 0) * Math.abs(m.scaleX), (o.ry || 0) * Math.abs(m.scaleY));
  }
  _normalizeCorners(o) {
    if (o.type === 'group' || o.type === 'activeSelection') { (o._objects || []).forEach(c => this._normalizeCorners(c)); return; }
    if (o.type !== 'rect' || (!o.rx && !o.ry && !o.cornerRadius)) return;
    const R = this.cornerRadiusOf(o);
    if (o.cornerRadius == null) o.cornerRadius = R;
    const m = this.fabric.util.qrDecompose(o.calcTransformMatrix());
    const sx = Math.abs(m.scaleX) || 1, sy = Math.abs(m.scaleY) || 1;
    const r = Math.min(R, (o.width * sx) / 2, (o.height * sy) / 2);
    o.set({ rx: r / sx, ry: r / sy });
    o.dirty = true;
    if (o.group) o.group.dirty = true;
  }

  /* Shift+drag a side handle (mr/ml/mt/mb — normally single-axis) keeps the object's aspect
     ratio, mirroring the corner handles' own uniform-scale-on-Shift behaviour. Fabric only wires
     that convention to the corners natively, so side handles need it applied by hand here: on
     every scaling tick, if a side handle is active and Shift is currently held, the axis that
     handle doesn't drive is recomputed from the one it does, using the ratio the object had when
     the drag started (not a hardcoded 1:1), so a non-square shape keeps its own proportions. */
  _bindProportionalSideScale() {
    this.fc.on('object:scaling', (opt) => {
      const corner = opt.transform && opt.transform.corner;
      const sideX = corner === 'ml' || corner === 'mr';   // drives scaleX only
      const sideY = corner === 'mt' || corner === 'mb';   // drives scaleY only
      if (!opt.e || !opt.e.shiftKey || (!sideX && !sideY)) return;
      const t = opt.transform.target;
      const orig = opt.transform.original;
      const ratio = (orig.scaleY || 1) / (orig.scaleX || 1);
      if (sideX) t.scaleY = t.scaleX * ratio;
      else t.scaleX = t.scaleY / ratio;
      t.setCoords();
    });
  }

  /* Active layer, or null — the shared "what does a selection-pixel op act on" resolver. Prefers
     the active object; falls back to the topmost image/paint layer so a marquee drawn with nothing
     selected still has an obvious target (mirrors how the wand/marquee tools work without forcing
     a click on the layer first). */
  _pixelSourceLayer() {
    const a = this.fc.getActiveObject();
    if (a && a.type !== 'activeSelection') return a;
    // No live Fabric active object — most commonly because a drawing tool (marquee/lasso/wand,
    // any non-'select' tool) already discarded it via setTool()'s own discardActiveObject() call,
    // exactly when a pixel-selection op like this is actually invoked. _lastActiveId (tracked
    // independently of Fabric's own selection state — see _bindLastActive) recovers "the layer
    // the user was last working on" the same way selectActiveOrCenter/the gradient tool's
    // object-local mode already do, rather than only ever falling back to the topmost image/paint
    // layer regardless of what the user actually had selected.
    const last = this._lastActiveId && this._byId(this._lastActiveId);
    if (last) return last;
    const objs = this.fc.getObjects();
    for (let i = objs.length - 1; i >= 0; i--) { if (objs[i].type === 'image' || objs[i].role === 'paint') return objs[i]; }
    return null;
  }

  /* Cmd+J: copy the selected pixels of the active layer into a new layer, non-destructively
     (the source is untouched). Photoshop's "Layer via Copy". */
  duplicateSelectionToLayer() {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const img = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top', selectable: true, evented: true });
    img.set({ id: uid(), role: 'paint', name: (src.name || src.role || 'Layer') + ' copy' });
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('copy-selection');
    return img.id;
  }

  /* Turn a pixel selection into a real floating layer, Photoshop-style: lift renders the selected
     pixels into a tight new layer AND cuts them from the source (leaving a hole, like a real
     move); cut just clears the selected pixels from the active layer without creating anything
     (Backspace/Delete with an active selection). Both clear the selection afterward. */
  liftSelectionToLayer() {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const floatImg = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top', selectable: true, evented: true });
    floatImg.set({ id: uid(), role: 'paint', name: (src.name || src.role || 'Layer') + ' (moved)' });
    const clip = selectionClipObject(this.fabric, this.selection);
    if (clip) { clip.absolutePositioned = true; clip.inverted = !this.selection.invert; src.clipPath = clip; src.dirty = true; }
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(floatImg);
    if (idx !== -1) { this.fc.remove(floatImg); this.fc.insertAt(floatImg, idx + 1, false); }
    this.clearSelection();
    this.fc.setActiveObject(floatImg);
    this.fc.renderAll();
    this.commit('lift-selection');
    return floatImg.id;
  }

  /* Same _lastActiveId fallback as _pixelSourceLayer/selectActiveOrCenter/the gradient tool's
     object-local mode: this is invoked from Delete/Backspace (see keybindings.js) while a
     marquee/lasso/wand drawing tool is active, at which point setTool() has already discarded
     Fabric's own active object even though the user very much still has a layer "active" in the
     sense that matters here. */
  cutSelectionFromLayer() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o) return;
    if (!this.selection) { this.fc.remove(o); this.fc.discardActiveObject(); this.commit('remove'); return; }
    const clip = selectionClipObject(this.fabric, this.selection);
    if (clip) { clip.absolutePositioned = true; clip.inverted = !this.selection.invert; o.clipPath = clip; o.dirty = true; }
    this.fc.renderAll();
    this.commit('cut-selection');
  }

  /* Non-destructive "crop to selection": hides the active layer's pixels OUTSIDE the current
     marquee/lasso/wand selection by setting a clipPath, same mechanism as cutSelectionFromLayer
     (its exact mirror — inverted there, not-inverted here) but without touching the layer's own
     pixel data, position, or size — clearLayerClip() (or drawing a new selection and re-clipping)
     fully reverses it. Unlike the Crop tool, this doesn't resize the artboard or re-origin every
     other layer; it only affects the one layer currently selected. */
  /* Same _lastActiveId fallback as cutSelectionFromLayer/_pixelSourceLayer/selectActiveOrCenter
     and the gradient tool's object-local mode: a pixel selection normally exists while a drawing
     tool (marquee/lasso/wand) is active, and setTool() has already discarded Fabric's own active
     object by the time a host UI's "Clip layer to selection" button gets clicked — without this
     fallback, that click would always hit the "nothing active" branch below and silently no-op. */
  clipLayerToSelection() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o || !this.selection) return;
    const clip = selectionClipObject(this.fabric, this.selection);
    if (!clip) return;
    clip.absolutePositioned = true; clip.inverted = !!this.selection.invert;
    o.clipPath = clip; o.dirty = true;
    this.fc.renderAll();
    this.commit('clip-to-selection');
  }

  /* Removes whatever clipPath is on the active layer — undoes clipLayerToSelection (or any other
     clip) without needing to remember what the clip shape was. Same _lastActiveId fallback as
     clipLayerToSelection above, for the same reason. */
  clearLayerClip() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o || !o.clipPath) return;
    o.clipPath = null; o.dirty = true;
    this.fc.renderAll();
    this.commit('clear-clip');
  }

  /* Token-free recolour: copies the selected pixels to a new layer and swaps hue/saturation
     toward `hex` while KEEPING each pixel's lightness, so shadows/folds/texture survive. Non-
     destructive — deleting the new layer reverts it. */
  recolorSelection(hex) {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const ctx = r.canvas.getContext('2d');
    const idata = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height);
    recolorPixels(idata.data, hex);
    ctx.putImageData(idata, 0, 0);
    const img = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top' });
    img.set({ id: uid(), role: 'paint', name: 'Recolor' });
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this.clearSelection();
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('recolor');
    return img.id;
  }

  /* Drop shadow on the active layer. patch: {color, blur, offsetX, offsetY}; clearing every
     field (all falsy) removes the shadow. */
  setShadow(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const cur = o.shadow ? { color: o.shadow.color, blur: o.shadow.blur, offsetX: o.shadow.offsetX, offsetY: o.shadow.offsetY } : { color: '#000000', blur: 0, offsetX: 0, offsetY: 0 };
    const s = { ...cur, ...patch };
    o.set('shadow', (s.blur || s.offsetX || s.offsetY) ? new this.fabric.Shadow(s) : null);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('shadow');
  }

  /* ── image adjustment: non-destructive brightness/contrast/saturation/blur ─────────────────
     Mirrors the reference editor's setFx: human values live on a custom `o.fx`, the real Fabric
     `filters` array is rebuilt from it every call via the pure fxToFilterSpecs() mapping, then
     applyFilters() bakes them into the image's cached render. No-op on anything but an image.
     Preserves a mask filter (see addMask) at the front of the array if one is present — the two
     filter families are independent (fx patches shouldn't drop a mask, and mask edits shouldn't
     drop fx) but both ultimately live on the one `o.filters` array Fabric's applyFilters() reads.
     `{ live: true }` renders the change without pushing an undo step — for slider drags and curve
     edits, which fire dozens of times a second; the host commits once on release by calling again
     without it (or via commitLive()). Otherwise one drag would flood the 60-step history. */
  setImageFilters(patch, { live = false } = {}) {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image') return;
    o.fx = { ...FX_DEFAULTS, ...(o.fx || {}), ...patch };
    this._rebuildImageFilters(o);
    this.fc.renderAll();
    if (live) this._emit('change', { label: 'filters', live: true });
    else this.commit('filters');
  }
  /* The one place an image's `o.filters` chain is assembled: geometry first (straighten/perspective
     resample the pixels, so everything after — including a mask painted on screen — lines up with
     what's displayed), then the mask (kept as the same instance, it owns the painted canvas), then
     the tone + fx adjustments. Rebuilt from o.geom / o.fx on every edit, then re-applied. */
  _rebuildImageFilters(o) {
    const maskFilter = (o.filters || []).find(f => f.type === 'MaskFilter');
    o.filters = [
      new this.fabric.Image.filters.Geometry({ ...GEOMETRY_DEFAULTS, ...(o.geom || {}) }),
      ...(maskFilter ? [maskFilter] : []),
      ...fxToFilterSpecs(o.fx || FX_DEFAULTS).map(({ type, params }) => new this.fabric.Image.filters[type](params)),
    ];
    o.applyFilters();
  }

  /* ── geometry: straighten + perspective (see geometry.js) ─────────────────────────────────
     Non-destructive and frame-preserving: the layer keeps its size/position on the artboard, its
     pixels are resampled inside it. patch keys: angle (deg), vertical / horizontal (keystone,
     -100..100), quad (4 normalised source corners or null). `{ live }` as setImageFilters. */
  setImageGeometry(patch, { live = false } = {}) {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image' || o.role === 'adjustment') return;
    o.geom = { ...GEOMETRY_DEFAULTS, ...(o.geom || {}), ...patch };
    this._rebuildImageFilters(o);
    // a rule-of-thirds-and-finer grid over the frame while dragging, to line the horizon up
    // against — dropped on release. Shells draw it (see their drawOverlays).
    this.geometryGuide = live ? this._frameGrid(o, 6) : null;
    this.fc.renderAll();
    this._emit('geometryguide', this.geometryGuide);
    if (live) this._emit('change', { label: 'geometry', live: true });
    else this.commit('geometry');
  }
  _frameGrid(o, n) {
    const H = squareToQuad(this._imageCornersScene(o, UNIT_QUAD).map(p => [p.x, p.y]));
    if (!H) return null;
    const P = (u, v) => { const [x, y] = mapHomography(H, u, v); return { x, y }; };
    const lines = [];
    for (let i = 1; i < n; i++) { lines.push([P(i / n, 0), P(i / n, 1)]); lines.push([P(0, i / n), P(1, i / n)]); }
    return lines;
  }
  /* Normalised source coords (0..1 of the image's full, uncropped element) <-> scene coords,
     through the object's own transform (position/scale/rotation) and its cropX/cropY window. */
  _imageCornersScene(o, pts) {
    const el = o._originalElement || o._element, nw = el.naturalWidth || el.width, nh = el.naturalHeight || el.height;
    const m = o.calcTransformMatrix();
    return pts.map(([u, v]) => this.fabric.util.transformPoint(new this.fabric.Point(u * nw - (o.cropX || 0) - o.width / 2, v * nh - (o.cropY || 0) - o.height / 2), m));
  }
  _sceneToImageNorm(o, pt) {
    const el = o._originalElement || o._element, nw = el.naturalWidth || el.width, nh = el.naturalHeight || el.height;
    const l = this.fabric.util.transformPoint(new this.fabric.Point(pt.x, pt.y), this.fabric.util.invertTransform(o.calcTransformMatrix()));
    return [(l.x + o.width / 2 + (o.cropX || 0)) / nw, (l.y + o.height / 2 + (o.cropY || 0)) / nh];
  }

  /* ── 4-corner perspective: an edit mode (like enterMaskEdit), not a tool ─────────────────────
     While active the image shows UNCORRECTED so the four handles can be dropped onto real content
     — the corners of a document, a window, a façade — and applyPerspectiveEdit() then maps that
     quad onto the full frame (geometry.js quad). Straighten/keystone are kept and composed on top.
     Pointer drags on the handles are handled here; shells only draw `ed.perspective` (corners,
     guide lines, active handle, all in scene coords) on their overlay, re-drawn on the
     'perspective' event. Leaving any other way (tool switch, undo/redo) cancels. */
  enterPerspectiveEdit() {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image' || o.role === 'adjustment' || this._persp) return false;
    const saved = { ...GEOMETRY_DEFAULTS, ...(o.geom || {}) };
    this._persp = { id: o.id, saved, corners: (saved.quad || UNIT_QUAD).map(p => [...p]), drag: -1, hover: -1, wasSelectable: o.selectable, wasEvented: o.evented };
    o.geom = { ...GEOMETRY_DEFAULTS };
    this._rebuildImageFilters(o);
    o.set({ selectable: false, evented: false });
    this.fc.discardActiveObject();
    this.fc.selection = false;
    this._emitPerspective();
    return true;
  }
  applyPerspectiveEdit() { return this._endPerspectiveEdit(true); }
  cancelPerspectiveEdit() { return this._endPerspectiveEdit(false); }
  resetPerspectiveCorners() {
    if (!this._persp) return;
    this._persp.corners = UNIT_QUAD.map(p => [...p]);
    this._emitPerspective();
  }
  _endPerspectiveEdit(apply) {
    const st = this._persp; if (!st) return false;
    this._persp = null;
    const o = this._byId(st.id);
    if (o) {
      const identity = st.corners.every(([x, y], i) => Math.abs(x - UNIT_QUAD[i][0]) < 1e-4 && Math.abs(y - UNIT_QUAD[i][1]) < 1e-4);
      o.geom = apply ? { ...st.saved, quad: identity ? null : st.corners.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]) } : st.saved;
      this._rebuildImageFilters(o);
      o.set({ selectable: st.wasSelectable, evented: st.wasEvented });
      this.fc.selection = this.tool === 'select';
      if (this.tool === 'select') this.fc.setActiveObject(o);
    }
    this._emitPerspective();
    if (apply && o) this.commit('perspective');
    return true;
  }
  get perspective() {
    const st = this._persp; if (!st) return null;
    const o = this._byId(st.id); if (!o) return null;
    const corners = this._imageCornersScene(o, st.corners);
    const H = squareToQuad(corners.map(p => [p.x, p.y]));
    const lines = [];
    if (H) {
      const P = (u, v) => { const [x, y] = mapHomography(H, u, v); return { x, y }; };
      for (let i = 1; i < 4; i++) { lines.push([P(i / 4, 0), P(i / 4, 1)]); lines.push([P(0, i / 4), P(1, i / 4)]); }
    }
    return { corners, lines, active: st.drag >= 0 ? st.drag : st.hover, valid: !!H };
  }
  _emitPerspective() { this._emit('perspective', this.perspective); this.fc.requestRenderAll(); }
  _perspHit(pt) {
    const p = this.perspective; if (!p) return -1;
    const tol = 12 / (this.fc.getZoom() || 1);
    let best = -1, bd = tol * tol;
    p.corners.forEach((c, i) => { const d = (c.x - pt.x) ** 2 + (c.y - pt.y) ** 2; if (d <= bd) { bd = d; best = i; } });
    return best;
  }
  getImageGeometry() {
    const o = this.fc.getActiveObject();
    return { ...GEOMETRY_DEFAULTS, ...((o && o.geom) || {}) };
  }

  /* Pushes the undo step a run of `{ live: true }` edits deferred. */
  commitLive(label = 'filters') { this.commit(label); }
  getImageFilters() {
    const o = this.fc.getActiveObject();
    return { ...FX_DEFAULTS, ...((o && o.fx) || {}) };
  }
  /* Luminance histogram (256 bins, 0..1, see tone.js lumaHistogram) behind the curves editor.
     For an image it's the layer's UNFILTERED source, like a curves dialog shows the input it's
     remapping; for an adjustment layer it's the flattened stack below it. Downsampled to ≤256px
     — plenty for a 256-bin chart. Null when the active object is neither. */
  getImageHistogram() {
    const o = this.fc.getActiveObject();
    if (!o) return null;
    let src;
    if (o.role === 'adjustment') src = renderObjectsFlat(this.fc, this.W, this.H, this.fc.getObjects().slice(0, this.fc.getObjects().indexOf(o)));
    else if (o.type === 'image') src = o._originalElement || o._element;
    else return null;
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    if (!sw || !sh) return null;
    const k = Math.min(1, 256 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, c.width, c.height);
    try { return lumaHistogram(ctx.getImageData(0, 0, c.width, c.height).data); } catch (e) { return null; }   // tainted cross-origin source
  }

  /* ── adjustment layers: non-destructive, affect everything BELOW them in the stack ────────
     Unlike setImageFilters (which bakes onto one image object's own pixels), an adjustment layer
     is a real, reorderable, deletable Fabric object of its own (role: 'adjustment') whose
     displayed bitmap is a captured-and-filtered composite of every layer below its z-index —
     recomputed via _recomputeAdjustmentLayers() on every commit(), so moving it, editing a layer
     below it, or adding a new layer underneath all keep it live without any special-casing at the
     call site. params is the same partial-fx shape setImageFilters takes (brightness/contrast/
     saturate/blur), so one adjustment layer can combine several effects like Photoshop's own
     "Brightness/Contrast" dialog, rather than needing a separate layer per effect. */
  addAdjustmentLayer(params = {}) {
    const img = new this.fabric.Image(document.createElement('canvas'), {
      left: 0, top: 0, originX: 'left', originY: 'top', selectable: true, evented: true,
    });
    img.set({ id: uid(), role: 'adjustment', name: 'Adjustments', adj: { ...FX_DEFAULTS, ...params } });
    const active = this.fc.getActiveObject();
    const idx = (active && active.type !== 'activeSelection') ? this.fc.getObjects().indexOf(active) : -1;
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this._recomputeAdjustmentLayers();
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('add-adjustment');
    return img.id;
  }
  /* Builds one base sticker primitive (circle/rect/polygon/path) from a stickers.js spec, in the
     shape's own 0-100 local coordinate space (not yet placed on the canvas) — shared by addSticker
     (places it directly, centered at `pt`) and its 'group' branch (nests it under a text label via
     fabric.Group, which needs the child un-positioned/un-scaled so the group's own transform is the
     only one that applies). `props` overrides originX/originY/left/top/scaleX/scaleY as needed. */
  _buildStickerShape(spec, fill, props = {}) {
    if (spec.kind === 'circle') return new this.fabric.Circle({ radius: spec.r, left: spec.cx, top: spec.cy, originX: 'center', originY: 'center', fill, ...props });
    if (spec.kind === 'rect') return new this.fabric.Rect({ width: spec.w, height: spec.h, rx: spec.rx, ry: spec.rx, left: spec.x, top: spec.y, fill, ...props });
    if (spec.kind === 'polygon') return new this.fabric.Polygon(spec.points.split(' ').map(p => { const [x, y] = p.split(',').map(Number); return { x, y }; }), { left: 0, top: 0, fill, ...props });
    if (spec.kind === 'path') return new this.fabric.Path(spec.d, { left: 0, top: 0, fill: spec.stroke ? null : fill, stroke: spec.stroke ? fill : null, strokeWidth: spec.stroke ? 10 : 0, fillRule: spec.fillRule || 'nonzero', ...props });
    return null;
  }

  /* Decorative sticker: a recolorable vector shape from the built-in library (stickers.js), added
     centered at `pt` (default: artboard center) at a fixed 160px nominal size — same size/role
     convention as makeShape(), so it behaves exactly like any other vector shape layer (Fill
     colour swatch recolors it, Transform resizes/rotates it, etc.) once placed. A `kind: 'group'`
     spec (badgeText/tagBannerText/burstText/priceTagText — the ad-generator reference's baked-text
     badge/tag/banner/burst stickers) nests its named base shape under a centered, auto-contrast
     IText label (STICKER_DEFAULT_LABEL) in a fabric.Group instead — same placement/role/commit
     contract, and the text is a normal editable IText child once placed (double-click to retype),
     so renaming the sticker's own promo copy needs no dedicated UI. */
  addSticker(key, pt, size = 160) {
    const spec = stickerSpec(key); if (!spec) return null;
    const center = pt || { x: this.W / 2, y: this.H / 2 };
    const fill = STICKER_PALETTE[0];
    const common = { originX: 'center', originY: 'center', left: center.x, top: center.y, scaleX: size / 100, scaleY: size / 100 };
    let obj = null;
    if (spec.kind === 'group') {
      const baseSpec = stickerSpec(spec.shape); if (!baseSpec) return null;
      const shape = this._buildStickerShape(baseSpec, fill, { originX: 'center', originY: 'center', left: 50, top: 50 });
      if (!shape) return null;
      const ink = relLum(hexRgb(fill)) > 0.6 ? '#0c0c0e' : '#ffffff';
      const label = new this.fabric.IText(STICKER_DEFAULT_LABEL, {
        left: 50, top: 50, originX: 'center', originY: 'center',
        fontFamily: 'system-ui, sans-serif', fontWeight: 800, fontSize: STICKER_DEFAULT_LABEL.length > 4 ? 14 : 19, fill: ink,
      });
      obj = new this.fabric.Group([shape, label], { ...common });
    } else {
      obj = this._buildStickerShape(spec, fill, common);
    }
    if (!obj) return null;
    obj.set({ id: uid(), role: 'shape', name: 'Sticker' });
    this.fc.add(obj);
    this.fc.setActiveObject(obj);
    this.commit('sticker');
    return obj.id;
  }

  /* ── ad-copy layers (adtext.js): CTA pill, badge chip, price group, brand lockup ───────────
     Same click-to-place/default-to-center convention as addSticker() above — `pt` defaults to the
     artboard center, `opts` is the same shape toolOpts already carries (size/fill/color) plus each
     factory's own fields (text/current/original/save/accent/font/ink). Each returns the new
     object's id, or null if the factory itself declined (none currently do, but this mirrors
     addSticker's own null-on-failure contract for a host that checks the return value). */
  addCTA(pt, opts = {}) { return this._addAdText(makeCTA, pt, opts, 'cta'); }
  addBadge(pt, opts = {}) { return this._addAdText(makeBadge, pt, opts, 'badge'); }
  addPrice(pt, opts = {}) { return this._addAdText(makePrice, pt, opts, 'price'); }
  addBrandLockup(pt, opts = {}) { return this._addAdText(makeBrandLockup, pt, opts, 'brand'); }
  _addAdText(factory, pt, opts, label) {
    const center = pt || { x: this.W / 2, y: this.H / 2 };
    const o = factory(this.fabric, center, { ...this.toolOpts, ...opts });
    if (!o) return null;
    this.fc.add(o);
    this.fc.setActiveObject(o);
    this.commit(label);
    return o.id;
  }

  /* Replaces the whole composition with a hero/sale/centered promotional layout (templates.js) —
     background + brand lockup + headline/subhead + CTA + optional badge + a product image or
     placeholder. Same "replace the composition, keep history" contract as openImageResult/
     commitRegions: undo returns to whatever was on the canvas before. `spec` is
     buildPromoLayout()'s own input shape (layout/palette/head/sub/cta/badge/brand/productImg/
     font/uiFont), every field optional. Loads spec.productImg (if given) once up front so every
     'image'-kind layer spec in the layout can synchronously build off the same decoded element. */
  async applyPromoLayout(spec = {}) {
    const layout = buildPromoLayout(spec, this.W, this.H);
    const imgEl = spec.productImg ? await loadImageEl(spec.productImg) : null;
    if (this._destroyed) return null;
    this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
    layout.layers.forEach(ls => {
      const obj = buildLayerFromSpec(this.fabric, ls, ls.kind === 'image' ? imgEl : null);
      this.fc.add(obj);
    });
    this.fc.discardActiveObject();
    this.fc.renderAll();
    this.commit('promo-layout');
    return layout;
  }

  setAdjustmentParams(id, patch, { live = false } = {}) {
    const o = this._byId(id); if (!o || o.role !== 'adjustment') return;
    o.adj = { ...FX_DEFAULTS, ...o.adj, ...patch };
    this._recomputeAdjustmentLayers();
    this.fc.renderAll();
    if (live) this._emit('change', { label: 'adjustment', live: true });   // see setImageFilters
    else this.commit('adjustment');
  }
  getAdjustmentParams(id) {
    const o = this._byId(id);
    return (o && o.role === 'adjustment') ? { ...FX_DEFAULTS, ...o.adj } : null;
  }

  /* Rebuilds every adjustment layer's displayed bitmap from the layers currently below it,
     bottom-up (so a stack of adjustment layers composes: the second one sees the first one's
     effect already baked into what it captures). Called from commit() itself — mutates each
     adjustment layer's own image element directly rather than going through applyFilters()'s
     fx/filters bookkeeping (that pipeline is for a single image's OWN pixels; here the "source
     pixels" are a fresh capture of other objects entirely, so there's no persistent
     _originalElement to re-filter from — each recompute captures fresh below-layers pixels and
     filters those). Guarded re-entrantly: recomputing must never itself call commit() (that would
     recurse through here again) — it only mutates bitmaps and calls fc.renderAll(). */
  _recomputeAdjustmentLayers() {
    const objs = this.fc.getObjects();
    objs.forEach((o, i) => {
      if (o.role !== 'adjustment') return;
      const below = objs.slice(0, i);
      const flat = renderObjectsFlat(this.fc, this.W, this.H, below);
      const filters = fxToFilterSpecs(o.adj || FX_DEFAULTS).map(({ type, params }) => new this.fabric.Image.filters[type](params));
      const filtered = document.createElement('canvas');
      filtered.width = this.W; filtered.height = this.H;
      const fctx = filtered.getContext('2d');
      fctx.drawImage(flat, 0, 0);
      const nonNeutral = filters.filter(f => !f.isNeutralState());
      if (nonNeutral.length) {
        const imgd = fctx.getImageData(0, 0, this.W, this.H);
        nonNeutral.forEach(f => f.applyTo2d({ imageData: imgd }));
        fctx.putImageData(imgd, 0, 0);
      }
      // setElement (not a raw o._element assignment) — it also sets _originalElement, so a later
      // scale/resize-filter pass (applyResizeFilters, which reads _filteredEl || _originalElement)
      // can't silently revert the layer back to its blank construction-time canvas. o.filters is
      // deliberately left empty: the fx chain was already applied by hand above (against a fresh
      // per-recompute capture, not a persistent original this object owns), so letting Fabric's
      // own applyFilters() run too would double-apply it.
      o.setElement(filtered);
      o.dirty = true;
    });
  }

  /* ── layer masks: paintable, non-destructive ──────────────────────────────────────────────
     Image/paint layers: addMask() creates a blank (fully-visible) mask and pushes a MaskFilter onto the layer's own
     `o.filters`, ahead of any brightness/contrast/etc. filters (see setImageFilters above) so a
     disabled/deleted mask never disturbs those. enterMaskEdit() redirects brush/pencil/eraser
     strokes (via _down/_move/_up) into painting the mask canvas instead of the pixel layer
     itself — exitMaskEdit() (or picking any other tool) ends that redirect. Vector layers get a
     mask in their own local box, drawn at render time (mask.js) — same API, no filters. The eraser
     on a vector layer paints black into that mask, so erasing never rasterizes the shape. */
  _maskable(o) { return !!o && (o.type === 'image' || o.role === 'paint' || isVectorMaskable(o)); }
  // Vector layers (shapes/text/groups) are masked at draw time, not by an image filter — see mask.js.
  _isVectorMasked(o) { return !!o && o.type !== 'image' && isVectorMaskable(o); }
  _addVectorMask(o) {
    o.maskCanvas = createVectorMaskCanvas(o);
    o.maskEnabled = true;
    touchVectorMask(o);
  }
  /* Scene point → the image mask's own pixels. MaskFilter stretches maskCanvas over the layer's
     whole element (see mask.js), so a mask pixel is an element position, not an artboard one —
     only the same thing when the image fills the artboard unscaled. Goes through the layer's full
     transform (position, scale, rotation, flip, parent group, crop), so a fitted, offset or
     stroke-trimmed layer gets painted under the pointer. `size` (scene px) comes back in mask px. */
  _imageMaskPoint(layer, pt, size) {
    const F = this.fabric, mc = layer.maskCanvas;
    const el = layer._originalElement || layer._element;
    const ew = (el && (el.naturalWidth || el.width)) || layer.width || 1, eh = (el && (el.naturalHeight || el.height)) || layer.height || 1;
    const m = layer.calcTransformMatrix();
    const p = F.util.transformPoint(new F.Point(pt.x, pt.y), F.util.invertTransform(m));
    const ex = p.x + (layer.width || ew) / 2 + (layer.cropX || 0), ey = p.y + (layer.height || eh) / 2 + (layer.cropY || 0);
    const kx = mc.width / ew, ky = mc.height / eh;
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;   // scene px per element px
    return { x: ex * kx, y: ey * ky, size: (size || 20) / scale * Math.sqrt(kx * ky) };
  }
  /* One mask stamp (or a line from `from`) in whatever space the layer's mask lives in: the
     image's own pixels for image masks (see _imageMaskPoint), the layer's own box for vector masks. */
  _maskPaint(layer, pt, from, opts, erase) {
    const ctx = layer.maskCanvas.getContext('2d');
    if (!this._isVectorMasked(layer)) {
      const a = this._imageMaskPoint(layer, pt, opts.size), o2 = { ...opts, size: a.size };
      if (from) maskLine(ctx, this._imageMaskPoint(layer, from, opts.size), a, o2, erase); else maskStamp(ctx, a.x, a.y, o2, erase);
      return;
    }
    const a = vectorMaskPoint(this.fabric, layer, pt, opts.size || 20);
    const o2 = { ...opts, size: a.size };
    if (from) { const b = vectorMaskPoint(this.fabric, layer, from, opts.size || 20); maskLine(ctx, b, a, o2, erase); }
    else maskStamp(ctx, a.x, a.y, o2, erase);
  }
  addMask(id) {
    const o = this._byId(id); if (!this._maskable(o) || o.maskCanvas) return;
    if (this._isVectorMasked(o)) { this._addVectorMask(o); this.fc.renderAll(); this.commit('add-mask'); return; }
    o.maskCanvas = createMaskCanvas(this.W, this.H);
    o.maskEnabled = true;
    const MaskFilter = makeMaskFilterClass(this.fabric);
    // after Geometry (see _rebuildImageFilters) so the mask lines up with the corrected pixels
    const fs = o.filters || [], gi = fs.findIndex(f => f.type === 'Geometry');
    o.filters = [...fs.slice(0, gi + 1), new MaskFilter({ maskCanvas: o.maskCanvas }), ...fs.slice(gi + 1)];
    o.applyFilters();
    this.fc.renderAll();
    this.commit('add-mask');
  }
  removeMask(id) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    if (this._maskEdit && this._maskEdit.layerId === id) this.exitMaskEdit();
    o.maskCanvas = null; o.maskEnabled = false;
    if (this._isVectorMasked(o)) touchVectorMask(o);
    else {
      o.filters = (o.filters || []).filter(f => f.type !== 'MaskFilter');
      o.applyFilters();
    }
    this.fc.renderAll();
    this.commit('remove-mask');
  }
  /* Enabled/disabled toggle (Photoshop's shift-click-the-mask-thumbnail) — the mask canvas and
     paint strokes on it are kept either way, only its visual effect is switched on/off. */
  setMaskEnabled(id, enabled) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    o.maskEnabled = !!enabled;
    if (this._isVectorMasked(o)) touchVectorMask(o);
    else {
      const f = (o.filters || []).find(x => x.type === 'MaskFilter');
      if (f) f.maskCanvas = enabled ? o.maskCanvas : null;
      o.applyFilters();
    }
    this.fc.renderAll();
    this.commit('mask-enabled');
  }
  /* Cmd/Ctrl+I on a mask (Photoshop) — swaps hidden<->visible across the WHOLE mask in one step,
     the single most-reached-for mask edit after "paint it": flip a mask that hid the wrong region
     instead of repainting it by hand. A no-op re-paint of the enable/apply plumbing every other
     mask edit already goes through, so undo/redo and the enabled-toggle keep working unchanged. */
  invertMask(id) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    invertMaskCanvas(o.maskCanvas);
    // the edge-colour fix belongs to the subject side — after inverting it would tint the backdrop
    const mf = (o.filters || []).find(f => f.type === 'MaskFilter'); if (mf) mf.decontamCanvas = null;
    if (this._isVectorMasked(o)) touchVectorMask(o); else o.applyFilters();
    this.fc.renderAll();
    this.commit('invert-mask');
  }
  enterMaskEdit(id) {
    const o = this._byId(id); if (!this._maskable(o) || !o.maskCanvas) return;
    this._maskEdit = { layerId: id };
    // Mask strokes only ever come from brush/pencil/eraser (see _down/_move) — auto-switching to
    // brush means a host UI's "Add mask" / "Edit mask" action can paint immediately, rather than
    // silently doing nothing until the caller separately remembers to also pick a paint tool.
    if (!['brush', 'pencil', 'eraser'].includes(this.tool)) this.setTool('brush');
    this._emit('maskedit', this._maskEdit);
  }
  /* Ending mask edit outside the normal mouseup path (a host UI switching layers mid-stroke, or
     picking another tool) must still flush any pending rAF-coalesced refresh — otherwise a stale
     callback fires a frame later against whatever state the editor has moved on to. */
  exitMaskEdit() {
    if (!this._maskEdit) return;
    this._flushFrameJob('mask');
    this._maskEdit = null;
    this._maskDrag = null;
    this._refineStroke = null;
    if (this.toolOpts.maskRefine) { this.toolOpts.maskRefine = null; this._emit('maskrefine', null); }
    this._emit('maskedit', null);
  }
  /* applyFilters() re-runs the WHOLE filter chain from the pristine source (including MaskFilter's
     own full getImageData + per-pixel loop over the artboard) — expensive enough that calling it
     once per mousemove tick while painting a mask is visibly janky on a large artboard. mousemove
     can fire faster than the display refreshes, so coalesce to at most one actual refresh per
     animation frame via the shared _coalesceToFrame scheduler (same one _liveAdjustmentPreview
     uses) — later calls within the same frame just replace which layer's refresh will run. */
  _refreshMaskFilter(o) {
    this._pendingMaskTarget = o;
    this._coalesceToFrame('mask');
  }

  /* ── group / ungroup active multi-selection ──────────────────────────────────────────────
     Status-reporting, same pattern as wandPick/expandSelection — this library reports what
     happened, a host UI decides how (if at all) to surface it. */
  groupSelection() {
    const a = this.fc.getActiveObject();
    if (!a || a.type !== 'activeSelection') return { status: 'error', reason: 'need_multi_selection' };
    const g = a.toGroup();
    g.set({ id: uid(), role: 'group', name: 'Group' });
    this.fc.requestRenderAll();
    this.commit('group');
    return { status: 'ok' };
  }
  ungroupSelection() {
    const a = this.fc.getActiveObject();
    if (!a || a.type !== 'group') return { status: 'error', reason: 'need_group' };
    a.toActiveSelection();
    this.fc.requestRenderAll();
    this.commit('ungroup');
    return { status: 'ok' };
  }

  /* ── flip / numeric transform on the active object ──────────────────────────────────────
     Centering-on-axis is already covered by alignLayer(id,'center'|'middle') — no separate
     centerLayer method here, callers should use that instead. */
  flipLayer(axis) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if (axis === 'x') o.set('flipX', !o.flipX); else if (axis === 'y') o.set('flipY', !o.flipY);
    o.setCoords();
    this.fc.renderAll();
    this.commit('flip');
  }
  /* patch keys: any of x, y, w, h, angle, skewX, skewY, rx — mirrors the reference's setNumeric.
     w/h are read off the same getScaledWidth()/getScaledHeight() the properties panel displays
     (readProps in @canvasmith/react), which factor in stroke width and skew — not just
     `width * scaleX` — so the new scale is derived from the CURRENT scaled size rather than
     assumed to be `patch.w / o.width`, which drifted for any object with a stroke or a nonzero
     skew (the field would resize by the wrong factor). rx sets a rect's corner radius uniformly
     (both rx and ry together — the properties panel exposes one "corner radius" field, not
     independent x/y radii); no-op on anything but a rect, same silent-no-op contract as
     setFill/setShapeGradient for a property that doesn't apply to the active object's type. */
  setNumeric(patch, { live = false } = {}) {
    const o = this.fc.getActiveObject(); if (!o) return;
    // pin a legacy rect's radius BEFORE any w/h rescale below, or it'd be re-read off the stretched shape
    if (o.type === 'rect' && o.cornerRadius == null) o.cornerRadius = this.cornerRadiusOf(o);
    if ('x' in patch) o.left = patch.x;
    if ('y' in patch) o.top = patch.y;
    if ('w' in patch) {
      const curW = o.getScaledWidth ? o.getScaledWidth() : o.width * (o.scaleX || 1);
      if (curW) o.scaleX = (o.scaleX || 1) * (Math.max(1, patch.w) / curW);
    }
    if ('h' in patch) {
      const curH = o.getScaledHeight ? o.getScaledHeight() : o.height * (o.scaleY || 1);
      if (curH) o.scaleY = (o.scaleY || 1) * (Math.max(1, patch.h) / curH);
    }
    if ('angle' in patch) o.angle = patch.angle;
    if ('skewX' in patch) o.skewX = patch.skewX;
    if ('skewY' in patch) o.skewY = patch.skewY;
    if ('rx' in patch && o.type === 'rect') o.cornerRadius = Math.max(0, patch.rx);   // scene px — see _bindRoundCorners
    this._normalizeCorners(o);   // rects, and rects inside a group (e.g. an ad CTA pill)
    o.setCoords();
    this.fc.renderAll();
    if (live) this._liveCommit('transform'); else this.commit('transform');
  }

  /* Recolors the active object (shape fill or text colour) — an activeSelection applies the same
     colour to every member, matching how alignActiveSelection/setLayer treat a multi-selection. */
  setFill(color) {
    const o = this.fc.getActiveObject(); if (!o) return;
    // picking a colour for a hidden fill shows it again — otherwise the change is invisible
    if (o.type === 'activeSelection') o.forEachObject(m => m.set({ fill: color, fillOff: false }));
    else o.set({ fill: color, fillOff: false });
    o.dirty = true;
    this.fc.renderAll();
    this.commit('fill');
  }

  /* Border/stroke — patch keys: color, width, plus the style keys stroke.js handles: style
     ('solid'|'dashed'|'dotted'), dash, gap (px), cap ('butt'|'round'|'square'), join
     ('miter'|'round'|'bevel'), position ('inside'|'center'|'outside', closed shapes only).
     Setting a width with no color yet defaults to black (mirrors the reference: picking up the
     width slider from 0 should show a visible border right away, not an invisible one). No-op with
     nothing selected, same silent-no-op contract as setFill/setNumeric for a property that may not
     apply to every member of a multi-selection — Fabric ignores stroke/strokeWidth on object types
     that don't render one (e.g. images). */
  setStroke(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (m) => {
      const prevWidth = m.strokeWidth || 0;
      if ('width' in patch) { if (patch.width > 0 && !m.stroke) m.set('stroke', '#000000'); m.set('strokeWidth', Math.max(0, patch.width)); }
      if ('color' in patch) m.set('stroke', patch.color);
      applyStrokeStyle(m, patch, 'width' in patch ? prevWidth : null);
      m.set('strokeOff', false);   // editing a hidden border shows it again (same as setFill)
    };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('stroke-style');
  }

  /* Fill / border eye toggles (Figma's per-paint visibility): hide or show the paint without
     losing it — the colour, gradient, width, dash etc. stay on the object and come back as they
     were. Applies to every member of a multi-selection. One undo step each. */
  setFillVisible(visible) { this._setPaintOff('fillOff', !visible, 'fill-visible'); }
  setStrokeVisible(visible) { this._setPaintOff('strokeOff', !visible, 'stroke-visible'); }
  _setPaintOff(key, off, label) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (m) => { m.set(key, off); m.dirty = true; };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit(label);
  }
  /* Whether the active object's fill is showing (false once its eye is toggled off). */
  isFillVisible() {
    const o = this.fc.getActiveObject();
    const t = o && o.type === 'activeSelection' ? o.getObjects()[0] : o;
    return !(t && t.fillOff);
  }

  /* The active object's border settings — { width, style, dash, gap, cap, join, position,
     canPosition } (see stroke.js strokeInfo). null with nothing selected. */
  getStroke() {
    const o = this.fc.getActiveObject();
    return o ? strokeInfo(o.type === 'activeSelection' ? o.getObjects()[0] : o) : null;
  }

  /* Object-local gradient mode's shared apply step (called live on every drag tick from _move,
     and once more implicitly via the same drag state on _up) — maps the scene-space drag line
     (from, to) into `obj`'s own local coordinate space via toLocalPoint(...,'center','center')
     then divides by scale (fabric.Gradient's gradientUnits:'pixels' coords are unscaled
     object-space, so a scaled object needs the drag line un-scaled back into that space first,
     exactly like the reference editor's own applyCustomGradient). Always linear (a drag defines a
     two-point AXIS, which a radial gradient — center + radius, no axis — has no use for; radial
     object gradients go through setShapeGradient's angle-based mode instead). */
  _applyObjectGradient(obj, from, to) {
    const p1 = this._sceneToGradLocal(obj, from), p2 = this._sceneToGradLocal(obj, to);
    const norm = normalizeGradientStops(this.toolOpts.gradientStops);
    const colorStops = norm.map(s => ({ offset: s.offset, color: s.color }));
    obj.set('fill', new this.fabric.Gradient({
      type: 'linear', gradientUnits: 'pixels',
      coords: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
      colorStops,
    }));
    obj.dirty = true;
    this.fc.renderAll();
  }

  /* Scene point <-> a pixel-unit gradient's own coordinate space. Fabric draws those coords from
     the object's TOP-LEFT (see Object#_applyPatternGradientTransform: offset -width/2, -height/2
     from the centre), unscaled, and the full transform (scale, rotation, skew, flip, parent group)
     applies on top. Mapping through calcTransformMatrix both ways keeps the drawn handles exactly
     on the colours. (These used to be centre-relative, which shifted every dragged gradient by half
     the object's size — the ramp started half a width before the point you dragged from.) */
  _sceneToGradLocal(obj, p) {
    const F = this.fabric, inv = F.util.invertTransform(obj.calcTransformMatrix());
    const q = F.util.transformPoint(new F.Point(p.x, p.y), inv);
    return { x: q.x + (obj.width || 0) / 2, y: q.y + (obj.height || 0) / 2 };
  }
  _gradLocalToScene(obj, p) {
    const F = this.fabric;
    const q = F.util.transformPoint(new F.Point(p.x - (obj.width || 0) / 2, p.y - (obj.height || 0) / 2), obj.calcTransformMatrix());
    return { x: q.x, y: q.y };
  }

  /* Gradient fill for a vector shape (rect/ellipse/triangle/polygon/star/text) — Fabric's own
     fabric.Gradient, so it scales/rotates with the object for free (coords are in the OBJECT's own
     bounding-box space, not scene space, per Fabric's convention: 0,0 is the object's top-left).
     `type`: 'linear' (angle in degrees, 0 = left-to-right) or 'radial' (centered, edge-to-edge).
     No-op on anything without a fill (images, lines, paint layers) — same contract as setFill. */
  setShapeGradient(stops, type = 'linear', angle = 0) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (obj) => {
      const w = obj.width || 1, h = obj.height || 1;
      const norm = normalizeGradientStops(stops);
      const colorStops = norm.map(s => ({ offset: s.offset, color: s.color }));
      let coords;
      if (type === 'radial') {
        coords = { x1: w / 2, y1: h / 2, r1: 0, x2: w / 2, y2: h / 2, r2: Math.max(w, h) / 2 };
      } else {
        const rad = (angle * Math.PI) / 180;
        const dx = Math.cos(rad) * w / 2, dy = Math.sin(rad) * h / 2;
        coords = { x1: w / 2 - dx, y1: h / 2 - dy, x2: w / 2 + dx, y2: h / 2 + dy };
      }
      obj.set({ fill: new this.fabric.Gradient({ type, coords, colorStops }), fillOff: false });
    };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('gradient-fill');
  }
  /* Null if the active object has no gradient fill (flat color, or non-fillable like an image). */
  getShapeGradient() {
    const o = this.fc.getActiveObject();
    const t = o && o.type === 'activeSelection' ? o.getObjects()[0] : o;
    const g = t && t.fill && typeof t.fill === 'object' && t.fill.type ? t.fill : null;
    if (!g) return null;
    return { type: g.type, stops: (g.colorStops || []).map(s => ({ offset: s.offset, ...splitGradientStopColor(s.color) })) };
  }

  /* Typography — patch keys: any of fontFamily, fontSize, fontWeight, fontStyle ('normal'|'italic'),
     textAlign ('left'|'center'|'right'|'justify'), lineHeight, charSpacing (Fabric's letter-spacing,
     in 1/1000-em units), underline, linethrough. No-op on anything but a text object (or an
     activeSelection whose every member is text) — same silent-no-op contract as setFill/setNumeric. */
  setTextProps(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const isText = (t) => t.type === 'i-text' || t.type === 'text' || t.type === 'textbox';
    if (o.type === 'activeSelection') { if (!o.getObjects().every(isText)) return; o.forEachObject(m => m.set(patch)); }
    else { if (!isText(o)) return; o.set(patch); }
    o.dirty = true;
    this.fc.renderAll();
    this.commit('text-props');
  }
  getTextProps() {
    const o = this.fc.getActiveObject();
    const t = o && o.type === 'activeSelection' ? o.getObjects()[0] : o;
    if (!t || (t.type !== 'i-text' && t.type !== 'text' && t.type !== 'textbox')) return null;
    return {
      fontFamily: t.fontFamily || 'system-ui, sans-serif', fontSize: t.fontSize || 48,
      fontWeight: t.fontWeight || 400, fontStyle: t.fontStyle || 'normal',
      textAlign: t.textAlign || 'left', lineHeight: t.lineHeight != null ? t.lineHeight : 1.16,
      charSpacing: t.charSpacing || 0, underline: !!t.underline, linethrough: !!t.linethrough,
    };
  }

  /* Resizes the artboard boundary itself (Photoshop's "Canvas Size", not "Image Size") — existing
     layers keep their absolute position and scale, so growing the canvas adds blank space and
     shrinking it can clip content rather than rescaling everything to fit. This is a purely
     LOGICAL resize: W/H are the artboard's own size, independent of fc's own DOM dimensions
     (which stay whatever the host's stage measures them at — see the constructor comment). The
     'resize' event below is the host's cue to re-fit its viewport transform around the new W/H. */
  resizeCanvas(width, height) {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this.engine.W = w; this.engine.H = h;
    // The magnetic-lasso edge map, the last wand seed, and every cached hover-preview polygon are
    // all scene-space coordinates measured against the OLD artboard size/origin — stale (and
    // potentially out of bounds) once W/H change, so drop them rather than let the next magnetic-
    // lasso/select-similar/hover-confirm call snap against or commit pre-resize geometry.
    this._edgeMap = null;
    this._lastWandSeed = null;
    this._edgeMapSeq++;
    if (this._hoverCache) this._hoverCache.clear();
    this.fc.renderAll();
    this.commit('resize-canvas');
    this._emit('resize', { width: w, height: h });
  }

  /* Artboard page colour (fc.backgroundColor) as { color, alpha, transparent } for a sidebar's
     Background fill row. `color` keeps the last real hex even while transparent, so un-toggling
     restores it rather than jumping to black. */
  canvasBackground() {
    const bg = this.fc.backgroundColor;
    if (!bg || bg === 'transparent') return { color: this._lastBgHex || '#ffffff', alpha: 0, transparent: true };
    if (typeof bg !== 'string') return { color: this._lastBgHex || '#ffffff', alpha: 1, transparent: false };
    const { color, alpha } = splitGradientStopColor(bg);
    return { color, alpha, transparent: alpha === 0 };
  }

  /* Set the page colour. `null`/'transparent' clears it; otherwise patch keys: color (hex), alpha
     (0..1). Commits, so Ctrl+Z works — fc.toJSON already carries `background`. */
  setCanvasBackground(patch) {
    let next;
    if (patch == null || patch === 'transparent') next = null;
    else {
      const cur = this.canvasBackground();
      const color = patch.color || cur.color;
      const alpha = patch.alpha != null ? Math.max(0, Math.min(1, patch.alpha)) : (cur.transparent ? 1 : cur.alpha);
      this._lastBgHex = color;
      next = alpha >= 1 ? color : alpha <= 0 ? null : rgba(color, +alpha.toFixed(3));
    }
    if ((this.fc.backgroundColor || null) === next) return;
    this.fc.backgroundColor = next;
    this.fc.renderAll();
    this.commit('canvas-bg');
  }

  _paintChecker(ctx) {
    const v = this.fc.viewportTransform, s = 8;
    if (!this._checker) {
      const c = document.createElement('canvas'); c.width = c.height = s * 2;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, s * 2, s * 2);
      g.fillStyle = '#d9d9de'; g.fillRect(0, 0, s, s); g.fillRect(s, s, s, s);
      this._checker = ctx.createPattern(c, 'repeat');
    }
    // Checker squares stay a fixed screen size at any zoom: clip in scene space, fill in stage space.
    const tl = this.fabric.util.transformPoint({ x: 0, y: 0 }, v);
    const br = this.fabric.util.transformPoint({ x: this.W, y: this.H }, v);
    ctx.save();
    ctx.fillStyle = this._checker;
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.restore();
  }

  /* ── crop ─────────────────────────────────────────────────────────────────────────────── */
  // Undoes the "expand to full image" visual done on entering Crop for an already-cropped layer
  // (see setTool('crop')) when the user leaves the tool WITHOUT applying — otherwise the image
  // would stay expanded to its pre-crop size/position forever on a plain cancel.
  _restoreCropTarget() {
    if (!this._cropRestore) return;
    const target = this._byId(this._cropRestore.id);
    if (target && target.type !== 'image') {
      target.clipPath = this._cropRestore.clipPath; target.dirty = true;
      this.fc.renderAll();
    } else if (target) {
      target.set(this._cropRestore);
      target.dirty = true;
      target.setCoords();
      this.fc.renderAll();
    }
    this._cropRestore = null;
  }

  // Layers Crop clips with a rect clipPath: unrotated non-image layers that aren't the background /
  // an adjustment, and that don't already carry some other clip (a clip-to-selection would be lost).
  _cropClipTarget(o) {
    return !!o && o.type !== 'image' && o.type !== 'activeSelection' && o.role !== 'bg' && o.role !== 'adjustment'
      && !(o.angle % 360) && (!o.clipPath || o.clipPath.role === 'crop');
  }
  // Scene-space {x,y,w,h} of a crop clip. Non-absolute clipPaths live in the object's own
  // centre-origin frame, so map the clip's corners out through the object's transform.
  _clipSceneRect(o, clip) {
    const m = o.calcTransformMatrix(), f = this.fabric;
    const pts = [[clip.left, clip.top], [clip.left + clip.width, clip.top + clip.height]]
      .map(([x, y]) => f.util.transformPoint(new f.Point(x, y), m));
    const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
    return { x, y, w: Math.abs(pts[1].x - pts[0].x), h: Math.abs(pts[1].y - pts[0].y) };
  }

  applyCrop() {
    if (!this.crop) return;
    const target = this._cropTarget && this._byId(this._cropTarget);
    if (target && target.type !== 'image') {
      const b = target.getBoundingRect(true, true);
      const { x, y, w, h } = this.crop;
      // A box covering the whole shape is "no crop" — don't leave a no-op clip behind.
      const covers = x <= b.left + 0.5 && y <= b.top + 0.5 && x + w >= b.left + b.width - 0.5 && y + h >= b.top + b.height - 0.5;
      let clip = null;
      if (!covers) {
        const f = this.fabric, inv = f.util.invertTransform(target.calcTransformMatrix());
        const pts = [[x, y], [x + w, y + h]].map(([px, py]) => f.util.transformPoint(new f.Point(px, py), inv));
        clip = new f.Rect({
          left: Math.min(pts[0].x, pts[1].x), top: Math.min(pts[0].y, pts[1].y), originX: 'left', originY: 'top',
          width: Math.abs(pts[1].x - pts[0].x), height: Math.abs(pts[1].y - pts[0].y), strokeWidth: 0, fill: '#000',
        });
        clip.role = 'crop';
      }
      target.clipPath = clip; target.dirty = true;
      this.crop = null;
      this._cropTarget = null;
      this._cropRestore = null;
      this.setTool('select');
      this.fc.setActiveObject(target);
      this.fc.renderAll();
      this.commit('crop');
      return;
    }
    if (target) {
      // Crop just this image (Fabric's native cropX/cropY/width/height, in the image's own
      // unscaled pixel space) instead of the whole artboard. this.crop is in scene space, seeded
      // from target's bounding rect in setTool() and dragged from there, so map it back through
      // the object's current scale/crop to get the new local crop box.
      const before = target.getBoundingRect(true);
      const sx = target.scaleX || 1, sy = target.scaleY || 1;
      const localX = (target.cropX || 0) + (this.crop.x - before.left) / sx;
      const localY = (target.cropY || 0) + (this.crop.y - before.top) / sy;
      target.set({
        left: this.crop.x, top: this.crop.y, originX: 'left', originY: 'top',
        cropX: localX, cropY: localY,
        width: this.crop.w / sx, height: this.crop.h / sy,
      });
      target.dirty = true;
      target.setCoords();
      this.crop = null;
      this._cropTarget = null;
      this._cropRestore = null;   // the crop just applied IS the new state — nothing left to restore
      this.setTool('select');
      this.fc.setActiveObject(target);
      this.fc.renderAll();
      this.commit('crop');
      return;
    }
    const dim = applyCrop(this.fc, this.crop, this.engine);
    this.W = dim.width; this.H = dim.height;
    this.crop = null;
    // Same reasoning as resizeCanvas(): the artboard origin just shifted (every object was
    // re-based by -x,-y) so any cached scene-space geometry from before the crop is stale.
    this._edgeMap = null;
    this._lastWandSeed = null;
    this._edgeMapSeq++;
    if (this._hoverCache) this._hoverCache.clear();
    this.setTool('select');
    this.commit('crop');
    this._emit('resize', dim);
  }

  /* ── io ───────────────────────────────────────────────────────────────────────────────── */
  async openImage(src, { fitArtboard = true, replace = true } = {}) {
    if (replace) {
      // "Open image" starts a new document from the image — the old layers go (⌘Z brings them back).
      this._penAbandon(); this._endGradEdit();
      if (this._persp) this.cancelPerspectiveEdit();
      if (this._exitIsolation) this._exitIsolation();
      this.fc.discardActiveObject();
      this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
      this.selection = null; this._polyBuild = null; this._lastActiveId = null;
      this._emit('selection', null);
    }
    if (fitArtboard) {
      const dim = await artboardForImage(src);
      if (this._destroyed) return null;
      this.W = dim.width; this.H = dim.height;
      this.engine.W = dim.width; this.engine.H = dim.height;
      this._emit('resize', dim);
    }
    const img = await addImageLayer(this.fabric, this.fc, src, { W: this.W, H: this.H });
    if (this._destroyed) return img;
    this.commit('open');
    return img;
  }
  addImage(src, opts = {}) { return addImageLayer(this.fabric, this.fc, src, { W: this.W, H: this.H, ...opts }).then(i => { if (!this._destroyed) this.commit('image'); return i; }); }
  // Export with lifted members back in place, so z-order matches the document (see _withIsoRestored).
  exportPNG(mult = 1) { return this._withIsoRestored(() => exportImage(this.fc, this.W, this.H, { format: 'png', multiplier: mult })); }
  exportJPEG(quality = 0.92, mult = 1) {
    // JPEG has no alpha, so a transparent page would come out black; flatten onto white instead.
    const bg = this.fc.backgroundColor, clear = !bg || bg === 'transparent';
    if (clear) this.fc.backgroundColor = '#ffffff';
    try { return this._withIsoRestored(() => exportImage(this.fc, this.W, this.H, { format: 'jpeg', quality, multiplier: mult })); }
    finally { if (clear) this.fc.backgroundColor = bg; }
  }
  /* Vector export via Fabric's own toSVG — returns an SVG string (wrap in a Blob to download). */
  exportSVG() {
    this.fc.discardActiveObject();
    this.fc.renderAll();
    return this.fc.toSVG({ width: this.W, height: this.H, viewBox: { x: 0, y: 0, width: this.W, height: this.H } });
  }
  toJSON() { return this._withIsoRestored(() => serialize(this.fc, this.W, this.H)); }
  loadJSON(json) { this._iso = []; restore(this.fc, json, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this.commit('load'); } }); }

  /* Back to a blank document — what a host's "New" command calls. Everything that survives is
     the things that aren't the DOCUMENT: the registered AI provider/key, the cv engine, the
     host's own event subscriptions, and the fabric canvas element itself (fc's DOM size belongs
     to the host's stage, not the artboard — see the constructor).

     History is emptied rather than kept, because "New" is not an edit: leaving the old document
     on the undo stack would let Ctrl+Z resurrect a document the user explicitly discarded, and
     the whole point of the button is to get rid of it. The blank state is then committed as the
     single baseline entry, exactly as the constructor does for a fresh Editor.

     Every transient cache keyed to the OLD scene's geometry is dropped for the same reason
     resizeCanvas() drops them — they're scene-space coordinates that no longer refer to
     anything, and a stale hover/edge-map entry would otherwise snap the first selection in the
     new document against geometry from the discarded one. */
  reset({ width = this.W, height = this.H, background } = {}) {
    this.history.lock = true;                 // the teardown below is not a sequence of undo steps
    this._iso = [];
    if (this.tool === 'crop') this._restoreCropTarget();
    if (this._maskEdit) this.exitMaskEdit();
    this.fc.discardActiveObject();
    this.fc.clear();                          // drops every object AND fc.backgroundColor
    this.W = Math.max(1, Math.round(width));
    this.H = Math.max(1, Math.round(height));
    this.engine.W = this.W; this.engine.H = this.H;
    // fc.clear() nulls backgroundColor; restore it so the artboard paints as a page again rather
    // than as a transparent hole over the void (see the _renderBackground override above).
    this.fc.backgroundColor = background != null ? background : this._background;
    this.clearSelection();
    this._edgeMap = null;
    this._lastWandSeed = null;
    this._edgeMapSeq++;
    this._objBoxes = []; this._objRegion = null; this._objSrc = null; this._objCycle = null;
    this._objSeq++;
    this.objCount = 0; this.multiCount = 0;
    this._lastActiveId = null;
    this._cropTarget = null;
    this._cropRestore = null;
    this._polyBuild = null;
    this._penAbandon();
    this._gradEdit = null; this._gradAxis = null; this._emit('gradientaxis', null);
    if (this._hoverCache) this._hoverCache.clear();
    this.history.past = []; this.history.future = [];
    this.history.lock = false;
    this.fc.renderAll();
    this.commit('new');                       // single baseline entry, like the constructor's commit('init')
    this._emit('resize', { width: this.W, height: this.H });
    this._emit('objcount', 0);
    this._emit('pen', null);
    this._emit('selection', null);
    return this;
  }

  /* ── one-click subject tools (left panel's AI card) ──────────────────────────────────────
     removeBackground(): cuts the active image/paint layer's subject out NON-destructively, as a
     layer mask (white = subject) — the pixels are all still there, so the user can refine the
     mask with the brush, toggle it, or delete it. `method`:
       'ai'    the registered provider's removeBackground (Gemini returns the subject on #00FF00,
               a dedicated cutout provider may return real alpha — both are keyed to a mask here)
       'local' offline, in the CV worker (see _maskOffline): a plain backdrop is keyed out by
               colour, anything else gets auto-seeded GrabCut refined along the edge; soft edges
               and decontaminated edge colours either way. Free; touch up with setMaskRefine()
       'auto'  (default) AI when the provider has a key, else local; an AI failure falls back to
               local rather than leaving the user with nothing.
     Resolves { status: 'ok', method } or { status: 'error', reason, message }. One undo step. */
  async removeBackground({ method = 'auto', id } = {}) {
    const o = id ? this._byId(id) : this.fc.getActiveObject();
    if (!o || !(o.type === 'image' || o.role === 'paint') || o.role === 'adjustment') return { status: 'error', reason: 'no_target', message: 'Select an image or paint layer first.' };
    const provider = this.ai && this.ai._provider;
    const aiReady = this.ai.can('removeBackground') && !(provider && typeof provider.hasKey === 'function' && !provider.hasKey());
    let mask = null, used = null, aiError = null;
    if (method === 'ai' || (method === 'auto' && aiReady)) {
      const r = await this.ai.run('removeBackground', this._layerSourceCanvas(o).toDataURL('image/png'));
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (r.status === 'ok') {
        mask = await this._maskFromCutout(r.result, o); used = 'ai';
        // An image model often hands back something that isn't a usable cutout (kept the whole
        // poster, off-green background, different framing) — fall back rather than "succeed" with
        // a mask that hides nothing.
        if (!mask) aiError = { status: 'error', reason: 'weak_cutout', message: 'The AI result did not separate a subject from its background.' };
      }
      else aiError = r;
      if (!mask && method === 'ai') return aiError || { status: 'error', reason: 'provider_failed', message: 'The AI cutout came back empty.' };
    }
    let decon = null, detail = null;
    if (!mask) {
      const cut = await this._maskOffline(o);
      used = 'local';
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (!cut) return { status: 'error', reason: 'no_subject', message: 'Could not find a subject to keep — try the brush on a layer mask instead.' };
      mask = cut.mask; decon = cut.decon; detail = cut.method;
    } else if (this._cutout) { this._cutout = null; if (this.cv) this.cv.cutoutFree(); }   // an AI cutout has nothing for Keep/Remove touch-ups to resume
    if (!o.maskCanvas) {
      o.maskCanvas = createMaskCanvas(this.W, this.H);
      o.maskEnabled = true;
      const MaskFilter = makeMaskFilterClass(this.fabric);
      const fs = o.filters || [], gi = fs.findIndex(f => f.type === 'Geometry');
      o.filters = [...fs.slice(0, gi + 1), new MaskFilter({ maskCanvas: o.maskCanvas }), ...fs.slice(gi + 1)];
    }
    const mctx = o.maskCanvas.getContext('2d');
    mctx.clearRect(0, 0, o.maskCanvas.width, o.maskCanvas.height);
    mctx.drawImage(mask, 0, 0, o.maskCanvas.width, o.maskCanvas.height);
    o.maskEnabled = true;
    const mf = (o.filters || []).find(f => f.type === 'MaskFilter');
    if (mf) { mf.maskCanvas = o.maskCanvas; mf.decontamCanvas = decon; }
    if (used === 'local' && this._cutout) this._cutout.maskCanvas = o.maskCanvas;
    o.applyFilters();   // synchronously (not _refreshMaskFilter's next-frame coalesce) so the commit below and the screen agree
    this.fc.renderAll();
    this.commit('remove-bg');
    return { status: 'ok', method: used, ...(detail ? { detail } : {}), ...(aiError ? { aiFallback: aiError.reason } : {}) };
  }
  /* The layer's own pixels as the mask filter sees them: full element, geometry applied (the mask
     runs after Geometry in the chain, see _rebuildImageFilters). */
  _layerSourceCanvas(o) {
    const el = o._originalElement || o._element;
    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(el, 0, 0);
    if (o.geom) { const d = ctx.getImageData(0, 0, w, h); applyGeometry(d.data, w, h, o.geom); ctx.putImageData(d, 0, 0); }
    return c;
  }
  /* A cutout image → an opaque grayscale mask canvas (white = keep), or null when it isn't a
     usable cutout of layer `o`:
     - real alpha (a provider that returns transparency) is used as-is;
     - otherwise the background is keyed by colour: its colour is sampled around the image's
       border (Gemini is asked for #00FF00, but rarely returns it exactly), and only background
       CONNECTED to the border is removed (a flood fill within a tolerance) — so an off-green or
       white backdrop still keys, and subject pixels that happen to match it stay.
     Rejected: a result whose aspect ratio doesn't match the layer (the model reframed the image, so
     the mask wouldn't line up), or one that keeps nearly everything / nothing. Edges get a 1px
     feather so the cut doesn't look jagged. */
  async _maskFromCutout(dataURL, o) {
    let img;
    try { img = await loadImageEl(dataURL); } catch (e) { return null; }
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    if (o) {
      const el = o._originalElement || o._element;
      const lw = el.naturalWidth || el.width, lh = el.naturalHeight || el.height;
      if (lw && lh && Math.abs((w / h) / (lw / lh) - 1) > 0.03) return null;
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h), px = d.data, n = w * h;
    const keep = new Uint8Array(n);
    let transparent = 0;
    for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 128) transparent++;
    if (transparent > n * 0.01) {
      for (let i = 0; i < n; i++) keep[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    } else {
      // Background colour = per-channel median of the border ring.
      const ring = [];
      const push = (x, y) => { const j = (y * w + x) * 4; ring.push([px[j], px[j + 1], px[j + 2]]); };
      for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
      for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
      const med = (k) => { const v = ring.map(p => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
      const bg = [med(0), med(1), med(2)];
      const TOL2 = 70 * 70;
      const near = (i) => { const j = i * 4, dr = px[j] - bg[0], dg = px[j + 1] - bg[1], db = px[j + 2] - bg[2]; return dr * dr + dg * dg + db * db <= TOL2; };
      keep.fill(1);
      const stack = new Int32Array(n); let sp = 0;
      const seed = (i) => { if (keep[i] && near(i)) { keep[i] = 0; stack[sp++] = i; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (sp) {
        const i = stack[--sp], x = i % w;
        if (x > 0) seed(i - 1);
        if (x < w - 1) seed(i + 1);
        if (i >= w) seed(i - w);
        if (i < n - w) seed(i + w);
      }
    }
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const v = keep[i] ? 255 : 0; if (keep[i]) kept++;
      const j = i * 4; px[j] = px[j + 1] = px[j + 2] = v; px[j + 3] = 255;
    }
    if (kept < n * 0.01 || kept > n * 0.97) return null;   // nothing, or ~everything, kept — not a cutout
    ctx.putImageData(d, 0, 0);
    return this._featherMask(c);
  }
  /* Offline cutout (the CV worker's cutout(): plain-backdrop keying, else auto-seeded GrabCut
     refined along the edge, then soft alpha + edge-colour decontamination). Works on the layer's
     own pixels capped at 1280px. Resolves { mask, decon, method } as canvases at that size, or
     null. Remembers the layer in this._cutout so Keep/Remove touch-ups can resume the cut. */
  async _maskOffline(o) {
    if (!this.cv || typeof Worker === 'undefined') return null;
    try {
      const imgd = prepImageData(this._layerSourceCanvas(o), 1280);
      const r = await this.cv.cutout({ data: imgd.data, width: imgd.width, height: imgd.height });
      if (!r || r.empty || !r.alpha) { this._cutout = null; return null; }
      this._cutout = { layerId: o.id, W: r.W, H: r.H, maskCanvas: null };
      return this._cutCanvases(r);
    } catch (e) { this._cutout = null; return null; }
  }
  _cutCanvases(r) {
    const mask = document.createElement('canvas'); mask.width = r.W; mask.height = r.H;
    const mctx = mask.getContext('2d'), md = mctx.createImageData(r.W, r.H);
    for (let i = 0, n = r.W * r.H; i < n; i++) { const v = r.alpha[i], j = i * 4; md.data[j] = md.data[j + 1] = md.data[j + 2] = v; md.data[j + 3] = 255; }
    mctx.putImageData(md, 0, 0);
    let decon = null;
    if (r.decon) {
      decon = document.createElement('canvas'); decon.width = r.W; decon.height = r.H;
      decon.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.decon.buffer || r.decon), r.W, r.H), 0, 0);
    }
    return { mask, decon, method: r.method };
  }

  /* ── Keep/Remove touch-ups on an offline cutout ──────────────────────────────────────────
     While editing the mask of a layer whose background was removed offline, setMaskRefine('keep'
     | 'remove') turns brush strokes into hints: each stroke paints straight away (white / black)
     for feedback, then the CV worker re-runs GrabCut around it from where the cut left off and
     the refined mask (soft edges, decontaminated colours) replaces it — one undo step per stroke.
     setMaskRefine(null) goes back to plain mask painting. Not available after an undo / reload
     (the layer is a fresh object then) or for an AI cutout. */
  canRefineCutout(id) {
    const c = this._cutout;
    if (!c || (id && id !== c.layerId)) return false;
    const o = this._byId(c.layerId);
    return !!(o && o.maskCanvas && o.maskCanvas === c.maskCanvas);
  }
  setMaskRefine(mode) {
    const m = mode === 'keep' || mode === 'remove' ? mode : null;
    if (m && !this.canRefineCutout()) return false;
    this.toolOpts.maskRefine = m;
    if (m) {
      if (!this._maskEdit || this._maskEdit.layerId !== this._cutout.layerId) this.enterMaskEdit(this._cutout.layerId);
      if (this.tool !== 'brush') this.setTool('brush');
    }
    this._emit('maskrefine', m);
    return true;
  }
  _refineActive(layer) {
    return !!(this.toolOpts.maskRefine && layer && this.canRefineCutout(layer.id) && this.tool === 'brush');
  }
  /* A finished stroke (scene px) → the image's mask px (_imageMaskPoint) → cutout px hint →
     worker → mask. */
  _refineCutout(layer, stroke) {
    const c = this._cutout, kx = c.W / layer.maskCanvas.width, ky = c.H / layer.maskCanvas.height;
    const pts = stroke.pts.map(p => this._imageMaskPoint(layer, p, stroke.r * 2));
    const hint = { keep: stroke.keep, r: pts[0].size / 2 * Math.sqrt(kx * ky), pts: pts.map(p => ({ x: p.x * kx, y: p.y * ky })) };
    const last = stroke.pts[stroke.pts.length - 1];
    const run = (async () => {
      const r = await this.cv.cutoutRefine([hint]);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      // Undone / replaced while the worker ran: that state already moved on — committing now would
      // push a stale entry (and wipe redo). A worker failure keeps the painted stroke as a plain edit.
      if (!this.canRefineCutout(layer.id)) return { status: 'error', reason: 'superseded' };
      if (!r || !r.alpha) { this.commit('mask-paint'); return { status: 'error', reason: 'no_refine' }; }
      const cut = this._cutCanvases(r);
      const mctx = layer.maskCanvas.getContext('2d');
      mctx.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
      mctx.drawImage(cut.mask, 0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
      const mf = (layer.filters || []).find(f => f.type === 'MaskFilter');
      if (mf) mf.decontamCanvas = cut.decon;
      layer.applyFilters();
      this.fc.renderAll();
      this.commit('mask-refine');
      return { status: 'ok' };
    })();
    return this._trackPick(run, last);
  }

  _featherMask(c) {
    const f = document.createElement('canvas'); f.width = c.width; f.height = c.height;
    const ctx = f.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, f.width, f.height);
    ctx.filter = 'blur(' + Math.max(0.6, Math.min(f.width, f.height) / 700) + 'px)';
    ctx.drawImage(c, 0, 0);
    return f;
  }

  /* Soft drop shadow sized to the object (blur ≈ 4% of its longest side, a little downward
     offset) — the one-click "sit it on the page" look. Toggles: a layer that already has a shadow
     gets it removed. Works on anything Fabric can shadow; on a cut-out image it follows the
     silhouette, since Fabric shadows the drawn alpha. Resolves { on } — one undo step. */
  toggleAutoShadow(id) {
    const o = id ? this._byId(id) : this.fc.getActiveObject();
    if (!o || o.role === 'adjustment' || o.role === 'bg') return null;
    if (o.shadow) o.set('shadow', null);
    else {
      const w = o.getScaledWidth ? o.getScaledWidth() : o.width, h = o.getScaledHeight ? o.getScaledHeight() : o.height;
      const k = 1 / (Math.abs(o.scaleX || 1) || 1);   // Fabric scales shadow blur/offset with the object
      o.set('shadow', new this.fabric.Shadow({ color: 'rgba(0,0,0,0.38)', blur: Math.round(Math.max(w, h) * 0.04 * k), offsetX: 0, offsetY: Math.round(h * 0.025 * k) }));
    }
    o.dirty = true;
    this.fc.renderAll();
    this.commit('shadow');
    return { on: !!o.shadow };
  }

  /* ── AI conveniences (thin sugar over the registry) ───────────────────────────────────── */
  /* Free-text edit of the flattened canvas. With a pixel selection, the edit is mask-guided to the
     selected area only. opts.reference: an optional image dataURL the model takes cues from. */
  async aiEdit(instruction, { reference } = {}) {
    const mask = this.selection ? this._selectionOnlyMask().toDataURL('image/png') : null;
    const text = mask ? instruction + ' Only change the white-masked area; keep everything else exactly as it is.' : instruction;
    const r = await this.ai.run('magicEdit', ...editArgs(this.exportPNG(), text, mask, reference));
    if (r.status === 'ok') { await this.openImageResult(r.result); }
    return r;
  }

  /* AI object removal: erases what's inside the current pixel selection from the background layer
     and fills it in from the surroundings (mask-guided magicEdit, swapped in place like aiBgSwap).
     Needs a selection — returns {status:'error', reason:'no_selection'} without one. */
  async aiRemoveSelection() {
    if (!this.selection) return { status: 'error', reason: 'no_selection', message: 'Select what to remove first (marquee, lasso, wand or object select).' };
    const text = 'Remove the object(s) in the white-masked area completely and fill that area in naturally so it matches the surrounding background — texture, lighting and perspective. Do not change anything outside the mask.';
    const mask = this._selectionOnlyMask().toDataURL('image/png');
    const bg = this._bgLayer();
    if (!bg) {
      const r = await this.ai.run('magicEdit', this.exportPNG(), text, mask);
      if (r.status === 'ok') { await this.openImageResult(r.result); if (!this._destroyed) this.clearSelection(); }
      return r;
    }
    const r = await this.ai.run('magicEdit', this._renderLayerAlone(bg).toDataURL('image/png'), text, mask);
    if (this._destroyed) return r;
    if (r.status === 'ok') {
      await this._swapLayerImage(bg, r.result);
      if (this._destroyed) return r;
      this.clearSelection();
      this.fc.renderAll();
      this.commit('ai-remove');
    }
    return r;
  }

  /* Rewrites a short request into a clearer instruction via the provider's enhancePrompt. */
  async aiEnhancePrompt(text, { kind = 'edit' } = {}) {
    return this.ai.run('enhancePrompt', text, { kind });
  }
  async aiInsert(prompt) {
    const r = await this.ai.run('generateImage', prompt);
    if (r.status === 'ok') await this.addImage(r.result, { name: prompt.slice(0, 24) });
    return r;
  }
  async openImageResult(dataURL) {
    if (this._destroyed) return;
    /* An AI edit replaces the composition: keep history (undo returns to the original). */
    this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
    await this.addImage(dataURL, { name: 'AI edit', fit: 'cover' });
    if (this._destroyed) return;
    this.commit('ai');
  }

  /* Resolves "the background layer" the same priority order the reference editor's own bgGapInfo/
     submitBgSwap use: an explicit role:'bg' image first, else the bottom-most image layer (an
     opened photo with no separate bg layer) — excluding paint layers, which are never a
     background swap's target. Returns null if there's no image at all to operate on. */
  _bgLayer() {
    const objs = this.fc.getObjects();
    return objs.find(o => o.role === 'bg' && o.type === 'image') || objs.find(o => o.type === 'image' && o.role !== 'paint') || null;
  }

  /* Renders `layer` alone (not the flattened scene) to an artboard-size canvas via its own
     render(ctx) — the same "one layer's own pixels, ignoring everything above/below it in the
     stack" primitive pixels.js's renderSelectedPixels uses for a pixel-selection lift/copy. */
  _renderLayerAlone(layer) {
    const c = document.createElement('canvas'); c.width = this.W; c.height = this.H;
    try { layer.render(c.getContext('2d')); } catch (e) { /* not renderable — caller sees a blank canvas */ }
    return c;
  }

  /* White-where-transparent alpha mask of `layer` alone — the reference editor's bgGapInfo mask,
     used by aiExtendBackground to tell magicEdit exactly which pixels are still empty canvas
     (white = the model may fill it in, black = real pixels to leave alone). Returns
     {canvas, maskCanvas, gapFraction} or null if the layer isn't renderable. */
  _gapMaskFromLayer(layer) {
    const canvas = this._renderLayerAlone(layer);
    const ctx = canvas.getContext('2d');
    let data;
    try { data = ctx.getImageData(0, 0, this.W, this.H).data; } catch (e) { return null; }
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = this.W; maskCanvas.height = this.H;
    const mctx = maskCanvas.getContext('2d');
    const md = mctx.createImageData(this.W, this.H);
    let gap = 0;
    for (let i = 0; i < data.length; i += 4) {
      const empty = data[i + 3] < 8;
      if (empty) gap++;
      md.data[i] = md.data[i + 1] = md.data[i + 2] = empty ? 255 : 0;
      md.data[i + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    return { canvas, maskCanvas, gapFraction: gap / (this.W * this.H) };
  }

  /* Selection-derived protect mask: white = the current pixel selection's shape (the AI may
     repaint it), black = everywhere else (kept pixel-identical) — the inverse of a normal
     selection clip, since here white means "editable" rather than "selected region to act on".
     Returns a full-artboard canvas (never null; a null/absent selection just means an
     all-white — everything editable — mask, matching aiBgSwap's own contract of "no selection ⇒
     the model may repaint the whole background"). */
  _selectionEditMask() {
    const c = document.createElement('canvas'); c.width = this.W; c.height = this.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.W, this.H);
    if (this.selection) {
      const path = selectionToPath2D(this.selection, this.W, this.H);
      if (path) { ctx.fillStyle = '#000000'; ctx.fill(path, selectionFillRule(this.selection)); }
    }
    return c;
  }

  /* The inverse of _selectionEditMask: white = inside the selection (editable), black = the rest. */
  _selectionOnlyMask() {
    const c = document.createElement('canvas'); c.width = this.W; c.height = this.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, this.W, this.H);
    const path = this.selection && selectionToPath2D(this.selection, this.W, this.H);
    if (path) { ctx.fillStyle = '#ffffff'; ctx.fill(path, selectionFillRule(this.selection)); }
    return c;
  }

  /* Swaps `oldLayer`'s pixels for a freshly-loaded image, in place: same id/role/name/locked
     identity, same z-index, full-bleed at the artboard's own W×H — everything else in the stack
     is untouched. This is what makes aiExtendBackground/aiBgSwap non-destructive (unlike
     openImageResult, which replaces the WHOLE composition) — undo still returns to the exact
     prior pixels, but every other layer survives an AI background edit unchanged. */
  async _swapLayerImage(oldLayer, dataURL) {
    const img = await new Promise((resolve, reject) => {
      this.fabric.Image.fromURL(dataURL, (im) => { im && im.width ? resolve(im) : reject(new Error('Could not load the AI result image.')); }, { crossOrigin: 'anonymous' });
    });
    if (this._destroyed) return null;
    const idx = this.fc.getObjects().indexOf(oldLayer);
    img.set({
      id: oldLayer.id || uid(), role: oldLayer.role || 'bg', name: oldLayer.name || 'Background', locked: !!oldLayer.locked,
      left: 0, top: 0, originX: 'left', originY: 'top', angle: 0,
      scaleX: this.W / img.width, scaleY: this.H / img.height,
    });
    if (oldLayer.locked) img.set({ selectable: false, evented: false, hasControls: false });
    this.fc.remove(oldLayer);
    this.fc.add(img);
    if (idx >= 0) { this.fc.remove(img); this.fc.insertAt(img, idx, false); }
    if (img.role === 'bg') this.fc.sendToBack(img);
    return img;
  }

  /* AI background replacement: targets the background layer specifically (see _bgLayer) and
     swaps only its pixels — every other layer in the composition survives untouched, unlike
     openImageResult's whole-composition replacement. With an active pixel selection, builds a
     real mask (white = background the model may repaint, black = the selected subject, kept
     pixel-identical) and passes it to magicEdit's optional 3rd argument when the registered
     provider reads it (AIRegistry#run forwards whatever args are given; a provider that ignores
     the mask still gets a usable result via the instruction text alone, same as before). Falls
     back to the old whole-scene openImageResult behavior when there's no image layer to target at
     all (nothing to swap in place). */
  async aiBgSwap(instruction, { reference } = {}) {
    const bg = this._bgLayer();
    if (!bg) {
      const flat = this.exportPNG();
      const r = await this.ai.run('magicEdit', ...editArgs(flat, instruction + (this.selection ? ' Keep the selected subject pixel-identical; only change the background.' : ''), null, reference));
      if (r.status === 'ok') await this.openImageResult(r.result);
      return r;
    }
    const flat = this._renderLayerAlone(bg).toDataURL('image/png');
    const hasSel = !!this.selection;
    const maskURL = hasSel ? this._selectionEditMask().toDataURL('image/png') : null;
    const text = hasSel
      ? instruction + ' Replace the background (the white regions of the mask) with this. Keep every black-masked subject pixel EXACTLY unchanged — same colours, edges and position. Blend the new background\'s lighting and shadows naturally around the subject.'
      : instruction + ' Keep the main subject exactly as it is — same position, scale, colours and details. Integrate lighting and shadows naturally.';
    const r = await this.ai.run('magicEdit', ...editArgs(flat, text, maskURL, reference));
    if (this._destroyed) return r;
    if (r.status === 'ok') {
      await this._swapLayerImage(bg, r.result);
      if (this._destroyed) return r;
      this.clearSelection();
      this.fc.renderAll();
      this.commit('ai-bg-swap');
    }
    return r;
  }

  /* Fraction (0..1) of the artboard that is still fully transparent once everything is flattened —
     used to decide whether an "extend background" affordance is worth showing. Samples on a coarse
     grid rather than every pixel; good enough for a UI nudge, not meant to be exact. */
  backgroundGapFraction() {
    const flat = this.exportPNG();
    return loadImageEl(flat).then(img => {
      if (this._destroyed) return 0;
      const c = document.createElement('canvas');
      const gw = 48, gh = Math.max(1, Math.round(gw * (this.H / this.W)));
      c.width = gw; c.height = gh;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, gw, gh);
      const data = ctx.getImageData(0, 0, gw, gh).data;
      let transparent = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 8) transparent++;
      return transparent / (gw * gh);
    }).catch(() => 0);
  }

  /* AI outpaint: targets the background layer specifically (see _bgLayer) and asks magicEdit to
     fill exactly its transparent gap, guided by a real white-where-empty mask (_gapMaskFromLayer)
     — pixel-precise, not just an instruction hoping the model infers the gap shape from the flat
     PNG. Swaps only that layer's pixels in place; every other layer survives untouched, same
     non-destructive contract as aiBgSwap. Falls back to the old whole-scene instruction-only
     behavior when there's no image layer to target (nothing to build a per-layer mask from). */
  async aiExtendBackground() {
    const bg = this._bgLayer();
    if (!bg) {
      const flat = this.exportPNG();
      const r = await this.ai.run('magicEdit', flat,
        'Extend and continue this image to fill the entire canvas — fill in any transparent or empty areas by naturally continuing the existing background, lighting, and style. Do not add new subjects.');
      if (r.status === 'ok') await this.openImageResult(r.result);
      return r;
    }
    const info = this._gapMaskFromLayer(bg);
    if (!info) return { status: 'error', reason: 'no_image' };
    if (!info.gapFraction) return { status: 'error', reason: 'no_gap', message: 'Background already fills the canvas.' };
    const r = await this.ai.run('magicEdit', info.canvas.toDataURL('image/png'),
      'Extend the background to fill the empty areas. Do not generate any text, letters, numbers or logos in the extended areas.',
      info.maskCanvas.toDataURL('image/png'));
    if (this._destroyed) return r;
    if (r.status === 'ok') {
      await this._swapLayerImage(bg, r.result);
      if (this._destroyed) return r;
      this.fc.renderAll();
      this.commit('ai-extend-bg');
    }
    return r;
  }

  /* Pure-geometry background fill (no AI call): scales the background image up to cover the whole
     artboard, same "cover" convention addImageLayer uses elsewhere. Prefers an explicit
     role:'bg' image; falls back to the bottom-most image layer (an opened photo with no separate
     bg layer). Returns false if there's no image to extend. */
  extendBackgroundToCanvas() {
    const objs = this.fc.getObjects();
    const bg = objs.find(o => o.role === 'bg' && o.type === 'image') || objs.find(o => o.type === 'image');
    if (!bg) return false;
    const w = bg.width * (bg.scaleX || 1), h = bg.height * (bg.scaleY || 1);
    if (w <= 0 || h <= 0) return false;
    const sc = Math.max(this.W / bg.width, this.H / bg.height);
    bg.clipPath = null;
    bg.set({ originX: 'center', originY: 'center', left: this.W / 2, top: this.H / 2, scaleX: sc, scaleY: sc, angle: 0 });
    bg.setCoords();
    this.fc.renderAll();
    this.commit('extend-bg');
    return true;
  }

  /* Fill the active selection (or the whole canvas, with none) with a flat colour — the Bucket
     tool's own fill, exposed as a direct call so a UI button can trigger it without a canvas
     click. Paints into the shared paint-engine layer, same as the bucket tool. */
  fillWithColor(color) {
    this._applySelClip();
    this.engine.fill(color);
    this.commit('bucket');
  }

  /* Fill the active selection (or the whole canvas) with an image, cropped/scaled to cover the
     fill region — same clip mechanism as fillWithColor, but stamps a bitmap instead of a flat
     colour into the paint-engine layer. */
  async fillWithImage(src) {
    const img = await loadImageEl(src);
    if (this._destroyed) return;
    this.engine.ensure();
    this._applySelClip();
    const ctx = this.engine.ctx;
    const box = this.selection ? selectionBounds(this.selection, this.W, this.H) : { x: 0, y: 0, w: this.W, h: this.H };
    const sc = Math.max(box.w / img.width, box.h / img.height);
    const dw = img.width * sc, dh = img.height * sc;
    const dx = box.x + (box.w - dw) / 2, dy = box.y + (box.h - dh) / 2;
    ctx.save();
    if (this.engine._clip) ctx.clip(this.engine._clip, this.engine._clipRule || 'nonzero');
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
    this.engine.commit();
    this.commit('fill-image');
  }

  /* AI-generate-an-image-at-a-point: inserts centered at `pt`, or — with an active selection —
     fills the selection's bounds, clipped to its shape so it reads as "filled the selection". */
  async aiInsertAt(prompt, pt) {
    const r = await this.ai.run('generateImage', prompt);
    if (this._destroyed) return r;
    if (r.status !== 'ok') return r;
    if (this.selection) {
      const box = selectionBounds(this.selection, this.W, this.H);
      const clip = selectionClipObject(this.fabric, this.selection);
      await new Promise(resolve => {
        this.fabric.Image.fromURL(r.result, img => {
          if (this._destroyed) return resolve();
          const sc = Math.max(box.w / (img.width || 1), box.h / (img.height || 1));
          img.set({ originX: 'center', originY: 'center', left: box.x + box.w / 2, top: box.y + box.h / 2, scaleX: sc, scaleY: sc, id: uid(), role: 'image', name: 'AI fill: ' + prompt.slice(0, 20) });
          if (clip) { clip.absolutePositioned = true; img.clipPath = clip; }
          this.fc.add(img); this.fc.setActiveObject(img);
          resolve();
        }, { crossOrigin: 'anonymous' });
      });
      if (this._destroyed) return r;
      this.clearSelection();
      this.commit('ai-insert');
      return r;
    }
    await new Promise(resolve => {
      this.fabric.Image.fromURL(r.result, img => {
        if (this._destroyed) return resolve();
        const sc = Math.min(1, (this.W * 0.34) / (img.width || this.W));
        img.set({ left: pt ? pt.x : this.W / 2, top: pt ? pt.y : this.H / 2, originX: 'center', originY: 'center', scaleX: sc, scaleY: sc, id: uid(), role: 'image', name: 'AI: ' + prompt.slice(0, 24) });
        this.fc.add(img); this.fc.setActiveObject(img);
        resolve();
      }, { crossOrigin: 'anonymous' });
    });
    if (this._destroyed) return r;
    this.commit('ai-insert');
    return r;
  }

  /* Flatten -> AI detectRegions, WITHOUT committing anything — returns the raw region list
     ({type, bbox:{x,y,width,height in %}, content?}) plus the flattened source image a host UI can
     show as a review step (adjust/delete/add boxes, retype a region) before calling
     commitRegions() with the (possibly edited) array. detectRegionsToLayers() below is the
     one-shot convenience that skips review entirely.

     Also runs the free local CV detector (detectObjects) IN PARALLEL with the AI call — matching
     the reference editor's own hybrid detect (startGuidedConvert): the local edge/contour + text
     pass catches objects the AI provider sometimes misses (or every object, if there's no AI key/
     the AI call fails) at zero cost, so its finds are merged in wherever they don't already
     overlap something the AI found (>30% IoU = "AI already found it", dropped as a near-duplicate).
     Never lets a local-detect failure block the AI result — same never-throws contract as the rest
     of the AI-detect surface. */
  async detectRegions() {
    const flat = this.exportPNG();
    const [r, local] = await Promise.all([
      this.ai.run('detectRegions', flat),
      this.detectObjects({ text: true }).catch(() => ({ status: 'error' })),
    ]);
    if (this._destroyed) return r;
    if (r.status !== 'ok' && (!local || local.status !== 'ok')) return r;
    // AI boxes: clamped to the canvas; a box covering (nearly) the whole image is the background
    // itself, never a layer to lift — lifting it would hollow out the entire Background.
    const clampBox = (bb) => {
      const x = Math.max(0, Math.min(100, +bb.x || 0)), y = Math.max(0, Math.min(100, +bb.y || 0));
      return { x, y, width: Math.max(0, Math.min(100 - x, +bb.width || 0)), height: Math.max(0, Math.min(100 - y, +bb.height || 0)) };
    };
    const regions = ((r.status === 'ok' && Array.isArray(r.result)) ? r.result : [])
      .filter(rg => rg && rg.bbox)
      .map(rg => ({ ...rg, bbox: clampBox(rg.bbox) }))
      .filter(rg => rg.bbox.width > 0.3 && rg.bbox.height > 0.3 && rg.bbox.width * rg.bbox.height < 90 * 90);
    dedupeAiRegions(regions);
    if (local && local.status === 'ok') {
      const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const iou = (a, b) => { const i = inter(a, b); return i / Math.max(1, a.w * a.h + b.w * b.h - i); };
      const inside = (a, b) => inter(a, b) / Math.max(1, a.w * a.h);   // share of `a` that lies within `b`
      const known = regions.map(rg => {
        const bb = rg.bbox;
        return { x: bb.x / 100 * this.W, y: bb.y / 100 * this.H, w: bb.width / 100 * this.W, h: bb.height / 100 * this.H };
      });
      const aiFound = known.length > 0;
      const candidates = [
        ...(local.result.boxes || []).map(b => ({ b, type: 'product' })),
        ...((local.result.textBoxes || [])).map(b => ({ b, type: 'text' })),
      ];
      let localObjects = 0;
      for (const { b, type } of candidates) {
        const area = b.w * b.h;
        if (area > this.W * this.H * 0.6) continue;   // whole-canvas blobs are noise
        // Already covered: overlaps a known box, or sits mostly INSIDE one — a text line within the
        // AI's multi-line headline box, a word within a line. Plain IoU misses nesting (a small box
        // inside a big one scores low), which is what turned one headline into two or three layers.
        if (known.some(k => iou(b, k) > 0.3 || inside(b, k) > 0.7)) continue;
        // A local box that swallows two or more known regions is a grouping of them, not an object.
        if (known.filter(k => inside(k, b) > 0.7).length >= 2) continue;
        // When the AI answered, local edge boxes are only gap-fillers: skip specks, and cap them so
        // paw-print fragments and badge pieces don't bury the real regions in clutter.
        if (aiFound && type === 'product' && (area < this.W * this.H * 0.01 || ++localObjects > 6)) continue;
        known.push(b);
        regions.push({ type, bbox: { x: b.x / this.W * 100, y: b.y / this.H * 100, width: b.w / this.W * 100, height: b.h / this.H * 100 } });
      }
    }
    if (!regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions detected.' };
    // The AI failing while the local pass still found something is a partial result, not a clean
    // one — report it so the host can say the boxes are local-only (unlabeled, no text content).
    const aiError = r.status === 'ok' ? null : (r.message || r.reason || 'AI detection failed');
    return { status: 'ok', result: { flat, regions, aiError } };
  }

  /* Real client-only silhouette cutout for one region box: seeded GrabCut (this.cv.grabcut)
     constrained to the box's own rect, no color-flood step (a region box has no click point, just
     an area — unlike wandPick's hybrid flood+grabCut). Returns a scene-px polygon or null on any
     failure/cv-unavailable, so callers fall back to a plain rectangular crop — same never-throws
     contract as wandPick/selectSimilar/expandSelection etc. `src` is a loaded <img>/<canvas> (the
     flattened composition commitRegions/extractRegion already load once and reuse per region).
     `bgMode` ('auto'/'cheap'/'best', the review UI's "Clean background" picker) scales the working
     resolution: 'cheap' trades fidelity for speed, 'best' raises the cap for a cleaner silhouette —
     there's no paid backend tier to switch to locally, so resolution is the one real quality/cost
     lever this client-only path has. */
  async cutoutRegion(src, box, bgMode) {
    if (!this.cv || typeof Worker === 'undefined') return null;
    try {
      const res = bgMode === 'cheap' ? 600 : bgMode === 'best' ? 1200 : 900;
      const imgd = prepImageData(src, res);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const work = { x: Math.max(0, Math.round(box.x * kx)), y: Math.max(0, Math.round(box.y * ky)), w: Math.max(4, Math.round(box.w * kx)), h: Math.max(4, Math.round(box.h * ky)) };
      const seed = { cx: Math.round((box.x + box.w / 2) * kx), cy: Math.round((box.y + box.h / 2) * ky) };
      const pts = await this.cv.grabcut({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, work);
      if (this._destroyed || !pts || pts.length < 3) return null;
      return pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
    } catch (e) { return null; }
  }

  /* Same hybrid flood+grabCut wand algorithm as wandPick(), but against an arbitrary STATIC image
     source instead of the live fc canvas — for a host UI's "click an object to auto-cut it" over a
     flattened snapshot (e.g. a convert-to-layers review step) where the live canvas has extra
     non-scene objects (draft/region overlay shapes) on it that would corrupt wandPick's own
     captureFlat()-based colour read. Returns a scene-px polygon or null, same never-throws
     contract as cutoutRegion/wandPick. The whole artboard is the source here (not a small live-
     canvas click), so this uses a higher resolution cap (820 vs the usual 768) for a cleaner mask,
     and — when the colour wand finds nothing (a low-contrast subject/background) — falls back to a
     box-seeded GrabCut centered on the click before giving up, same as the reference editor. */
  async objectPickInImage(src, pt, tolerance) {
    if (!this.cv || typeof Worker === 'undefined') return null;
    try {
      const MAXD = Math.max(768, 820);
      const imgd = prepImageData(src, MAXD);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(pt.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(pt.y * ky))) };
      const tol = tolerance != null ? tolerance : this.toolOpts.tolerance;
      let pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, tol, SEL_EPS);
      if (this._destroyed) return null;
      if (!pts || pts.length < 3) {
        const d = Math.min(this.W, this.H) * 0.4;
        const work = {
          x: Math.max(0, Math.round((pt.x - d / 2) * kx)),
          y: Math.max(0, Math.round((pt.y - d / 2) * ky)),
          w: Math.round(d * kx), h: Math.round(d * ky),
        };
        pts = await this.cv.grabcut({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, work);
        if (this._destroyed) return null;
      }
      if (!pts || pts.length < 3) return null;
      return pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
    } catch (e) { return null; }
  }

  /* Builds one region's layer (text layer for `text`, image layer otherwise) and adds it to `fc`.
     Shared by commitRegions (wipe+rebuild, every region) and extractRegion (additive, one region)
     so the two never drift. `opts.cutout` (default true) tries cutoutRegion() first for a true
     silhouette clipPath on non-text regions, falling back to today's plain rectangular crop when
     the cv cutout is unavailable/fails — text regions are unaffected (no pixels to segment).
     Returns { layer, holePoly } — holePoly is the scene-px polygon (silhouette when cutout
     succeeded, else the plain bbox rect) the caller should punch out of the background so the
     region isn't left rendered twice: the flattened source (`src`/`flat`) has this region's pixels
     baked in — product/logo/etc. as an image, but a text region JUST AS MUCH as rasterized glyph
     pixels — so the bbox rect is punched for text too, or the old flattened text is left showing
     through/behind the new live text layer at the same spot (doubled text, no cutout available:
     there's no silhouette to segment for text, so it's always the plain bbox). */
  async _buildRegionLayer(fc, src, rg, opts = {}) {
    const { W = this.W, H = this.H, cutout = true, bgMode } = opts;
    const bbox = rg.bbox || {};
    const x = (bbox.x || 0) / 100 * W, y = (bbox.y || 0) / 100 * H;
    const w = (bbox.width || 0) / 100 * W, h = (bbox.height || 0) / 100 * H;
    if (w < 1 || h < 1) return null;
    const role = REGION_ROLE[rg.type] || rg.type || 'image';
    if (rg.type === 'text') {
      // The hole is padded a little past the box (detector boxes hug the glyphs). Kept small: the
      // background rebuild's `grow` chases any ink the box missed, while a big pad would also
      // erase the shape the text sits on (a pill or button behind a label).
      const pad = Math.max(2, Math.round(h * 0.04));
      const hx0 = Math.max(0, x - pad), hy0 = Math.max(0, y - pad), hx1 = Math.min(W, x + w + pad), hy1 = Math.min(H, y + h + pad);
      const holePoly = [{ x: hx0, y: hy0 }, { x: hx1, y: hy0 }, { x: hx1, y: hy1 }, { x: hx0, y: hy1 }];
      // How far the background clean-up may chase leftover ink past the box (see fillHoles' grow):
      // AI text boxes regularly clip a whole first/last letter or an outline, and a letter is
      // roughly 0.8 of a line tall — so the budget scales with the LINE height, not the box's.
      const lineH = h / Math.max(1, String(rg.content || '').trim().split('\n').length);
      const textGrow = Math.max(8, Math.min(110, Math.round(lineH)));
      const crop = this._cropSource(src, hx0, hy0, hx1 - hx0, hy1 - hy0, W, H);
      let info = {}, cropData = null;
      try { cropData = crop.getContext('2d').getImageData(0, 0, crop.width, crop.height); info = analyzeBox(cropData); } catch (e) { /* tainted — no sampling */ }
      const content = String(rg.content || '').replace(/\r/g, '').trim();
      // The lettering's own colours: the rebuild chases leftover ink in exactly these (see fillHoles).
      const holeInk = [info.fg, info.outline].filter(Boolean).map(hexRgb).filter(Boolean);
      if (!content) {
        // No string to set (the local CV text pass finds WHERE text is, not what it says): lift the
        // original pixels as an image layer instead of inventing a placeholder "Text" layer. On a
        // flat panel the background is knocked out so only the lettering moves with the layer.
        if (cropData && info.uniform && info.bg) { knockoutBackground(cropData, info.bg); crop.getContext('2d').putImageData(cropData, 0, 0); }
        const img = new this.fabric.Image(crop, { left: hx0, top: hy0, originX: 'left', originY: 'top', scaleX: (hx1 - hx0) / crop.width, scaleY: (hy1 - hy0) / crop.height });
        img.set({ id: uid(), role, regionType: rg.type, name: 'Text' });
        fc.add(img);
        return { layer: img, holePoly, holeGrow: textGrow, holeInk };
      }
      // rg.style carries typography from the AI or a review edit: font (a MATCH_FONTS name, or an
      // explicit fontFamily), weight, italic, align, and optionally a fixed fontSize. Colour falls
      // back to the dominant ink colour sampled from the pixels, not a fixed near-black.
      const st = rg.style || {};
      const family = st.fontFamily || fontCss(st.font) || 'Inter, sans-serif';
      const weight = st.fontWeight ? ((st.fontWeight === 'bold' || st.fontWeight >= 700) ? 700 : 400) : 700;
      const italic = st.italic === true || st.fontStyle === 'italic';
      await loadFontFace(`${italic ? 'italic ' : ''}${weight} 100px ${family}`);
      if (this._destroyed) return null;
      // The lettering's real lines, measured from the pixels (scene px). They fix what the AI's
      // box and text can't: how many lines there really are, their height, spacing and width.
      const kc = crop.width / Math.max(1, hx1 - hx0);
      const inkLines = cropData ? textLines(cropData, { bg: info.bg, fg: info.fg ? hexRgb(info.fg) : null, outline: info.outline ? hexRgb(info.outline) : null })
        .map(b => ({ x0: hx0 + b.x0 / kc, x1: hx0 + (b.x1 + 1) / kc, y0: hy0 + b.y0 / kc, y1: hy0 + (b.y1 + 1) / kc })) : [];
      // One line of text but the pixels show several (the AI dropped the line breaks): re-wrap the
      // words to the detected line count, splitting in proportion to each line's measured width.
      let text = content;
      if (!text.includes('\n') && inkLines.length > 1) text = rewrapToLines(text, inkLines.map(b => b.x1 - b.x0));
      const nLines = text.split('\n').length;
      const txt = makeText(this.fabric, { x, y }, {
        text, fontSize: 100, fontFamily: family, fontWeight: weight,
        fill: st.color || info.fg || st.colorHint || undefined,
      });
      if (italic) txt.set('fontStyle', 'italic');
      txt.set('textAlign', st.textAlign || alignOfLines(inkLines) || (nLines > 1 ? 'center' : 'left'));
      // Outlined lettering (e.g. white fill, dark outline): painted stroke-first so the stroke sits
      // outside the glyphs like the original. Only when the style doesn't already fix the colour.
      const outlined = !st.color && info.outline && info.fg;
      const applyStroke = () => { if (outlined) txt.set({ stroke: info.outline, strokeWidth: Math.max(1, Math.round(txt.fontSize * 0.12)), paintFirst: 'stroke', strokeLineJoin: 'round' }); };
      if (st.fontSize) { txt.set('fontSize', Math.max(12, Math.round(st.fontSize * (W / 1080)))); applyStroke(); }
      else {
        // First guess from the box, then calibrate by RENDERING: compare the rendered layer's own
        // ink lines with the original's and correct size (line height), line spacing (pitch) and
        // letter spacing (line width) — font-agnostic, so it holds for any matched font.
        txt.initDimensions();
        txt.set('fontSize', Math.max(8, Math.round(Math.min(100 * w / Math.max(1, txt.width), 100 * h / Math.max(1, txt.height) * 1.25))));
        applyStroke();
        if (inkLines.length === nLines) this._calibrateText(txt, inkLines, applyStroke);
        else if (inkLines.length) this._calibrateText(txt, [unionBox(inkLines)], applyStroke, true);
      }
      txt.initDimensions();
      // Place by INK: the rendered glyphs' centre onto the original glyphs' centre (a text box's
      // own bounds include ascender/descender space the lettering doesn't fill).
      const target = inkLines.length ? unionBox(inkLines) : { x0: x, y0: y, x1: x + w, y1: y + h };
      const r = this._renderedInk(txt);
      if (r) {
        txt.setPositionByOrigin(new this.fabric.Point((target.x0 + target.x1) / 2 - r.dx, (target.y0 + target.y1) / 2 - r.dy), 'center', 'center');
      } else txt.set({ left: x + (w - txt.width) / 2, top: y + (h - txt.height) / 2 });
      txt.setCoords();
      txt.set({ role, regionType: rg.type, rstyle: rg.style || null, name: content.replace(/\s+/g, ' ').slice(0, 24) });
      fc.add(txt);
      return { layer: txt, holePoly, holeGrow: textGrow, holeInk };
    }
    const c = this._cropSource(src, x, y, w, h, W, H), cw = c.width, ch = c.height;
    const kx = cw / w, ky = ch / h;   // source px per scene px (1 for today's W×H export)
    if (opts.innerHoles && opts.innerHoles.length) this._eraseInner(c, x, y, kx, ky, opts.innerHoles);
    const img = new this.fabric.Image(c, { left: x, top: y, originX: 'left', originY: 'top', scaleX: 1 / kx, scaleY: 1 / ky });
    img.set({ id: uid(), role, regionType: rg.type, name: (rg.type || 'Layer')[0].toUpperCase() + (rg.type || 'layer').slice(1) });
    let holePoly = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    // A GrabCut silhouette often stops inside the object's real edge (a dark base strip, a badge
    // rim past its box) — let the rebuild chase that remainder, in proportion to the object.
    let holeGrow = Math.max(10, Math.min(48, Math.round(Math.min(w, h) * 0.22)));
    // A non-absolute clipPath lives in the image's OWN frame, whose origin is the image's CENTRE
    // (in source px) — not its top-left. Mapping scene points relative to the top-left put the
    // silhouette a half-width right and a half-height down, so the layer only ever showed the
    // bottom-right quarter of the cutout.
    const toClip = (poly) => new this.fabric.Polygon(poly.map(p => ({ x: (p.x - x) * kx - cw / 2, y: (p.y - y) * ky - ch / 2 })), { absolutePositioned: false });
    // A region drawn by hand (lasso/polygon/magnetic-lasso/object-click, see selection.js's
    // startPolyBuild/finishPolyBuild and Editor#objectPickInImage) already IS an exact silhouette
    // the user traced or a hybrid wand/grabCut already computed against the live image — re-running
    // cutoutRegion() here would throw that away and re-segment from scratch, constrained only to
    // the region's bbox, which is both wasteful and typically LOWER quality than what the user
    // already had (a bbox-seeded grabCut has less context than the original whole-canvas trace).
    // Use the given polygon as-is whenever the caller supplied one.
    if (Array.isArray(rg.polygon) && rg.polygon.length >= 3) {
      const poly = rg.polygon;
      img.clipPath = toClip(poly);
      holePoly = poly;
      holeGrow = 4;      // traced by the user / wand against the live image: already tight
    } else if (cutout) {
      const poly = await this.cutoutRegion(src, { x, y, w, h }, bgMode);
      if (poly && poly.length >= 3 && !this._destroyed) {
        img.clipPath = toClip(poly);
        holePoly = poly;
      }
    }
    fc.add(img);
    return { layer: img, holePoly, holeGrow };
  }

  /* Renders a text object alone and measures its ink: `lines` (textLines of the render, in the
     render's px — multiplier 1, so scene px) and dx/dy, the ink centre's offset from the object's
     centre. Null if it can't be rendered/read. */
  _renderedInk(txt) {
    try {
      txt.initDimensions(); txt.setCoords();
      const el = txt.toCanvasElement({ multiplier: 1, enableRetinaScaling: false });
      const id = el.getContext('2d').getImageData(0, 0, el.width, el.height);
      const lines = textLines(id, {});
      if (!lines.length) return null;
      const u = unionBox(lines.map(b => ({ x0: b.x0, x1: b.x1 + 1, y0: b.y0, y1: b.y1 + 1 })));
      return { lines, box: u, dx: (u.x0 + u.x1) / 2 - el.width / 2, dy: (u.y0 + u.y1) / 2 - el.height / 2 };
    } catch (e) { return null; }
  }

  /* Adjusts fontSize, lineHeight and charSpacing so the rendered text's ink lines match `target`
     (scene-px ink lines of the original). A few passes: each corrects size from the median line
     height ratio, spacing from the line pitch, and letter spacing from the remaining width
     difference per character gap. `whole`: only the overall ink box is known (line count didn't
     match) — fit size to it, nothing else. */
  _calibrateText(txt, target, applyStroke, whole = false) {
    const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    const rows = String(txt.text).split('\n');
    for (let pass = 0; pass < 3; pass++) {
      const r = this._renderedInk(txt);
      if (!r) return;
      const R = whole ? [{ x0: r.box.x0, x1: r.box.x1 - 1, y0: r.box.y0, y1: r.box.y1 - 1 }] : r.lines;
      if (R.length !== target.length) {
        const tb = unionBox(target), s = Math.min((tb.y1 - tb.y0) / Math.max(1, r.box.y1 - r.box.y0), (tb.x1 - tb.x0) / Math.max(1, r.box.x1 - r.box.x0));
        txt.set('fontSize', Math.max(6, Math.round(txt.fontSize * s))); applyStroke(); txt.initDimensions();
        continue;
      }
      const hr = med(target.map((t, i) => (t.y1 - t.y0) / Math.max(1, R[i].y1 - R[i].y0 + 1)));
      const fs = Math.max(6, txt.fontSize * hr);
      const upd = { fontSize: Math.round(fs * 10) / 10 };
      if (!whole && target.length > 1) {
        const pT = (target[target.length - 1].y0 - target[0].y0) / (target.length - 1);
        const pR = (R[R.length - 1].y0 - R[0].y0) / (R.length - 1) * hr;
        if (pR > 0) upd.lineHeight = Math.max(0.6, Math.min(3, (txt.lineHeight || 1.16) * pT / pR));
      }
      if (!whole) {
        // remaining width gap per character gap → charSpacing (1/1000 em)
        const per = target.map((t, i) => {
          const gaps = Math.max(1, (rows[i] || '').length - 1);
          return ((t.x1 - t.x0) - (R[i].x1 - R[i].x0 + 1) * hr) / gaps;
        });
        const cs = (txt.charSpacing || 0) + med(per) / fs * 1000;
        upd.charSpacing = Math.max(-150, Math.min(1000, Math.round(cs)));
      }
      txt.set(upd); applyStroke(); txt.initDimensions();
    }
  }

  /* Fills text areas ({poly, grow, ink} in scene px) out of a region's own crop — the badge keeps
     its shape and colour, minus the words that became their own text layer. */
  _eraseInner(c, x, y, kx, ky, holes) {
    try {
      const ctx = c.getContext('2d'), m = document.createElement('canvas'); m.width = c.width; m.height = c.height;
      const mc = m.getContext('2d');
      mc.fillStyle = '#fff';
      for (const h of holes) {
        if (!h.poly || h.poly.length < 3) continue;
        mc.beginPath(); h.poly.forEach((p, i) => (i ? mc.lineTo : mc.moveTo).call(mc, (p.x - x) * kx, (p.y - y) * ky)); mc.closePath(); mc.fill();
      }
      const md = mc.getImageData(0, 0, m.width, m.height).data, N = m.width * m.height;
      const hole = new Uint8Array(N), grow = new Uint8Array(N);
      const g = Math.max(1, Math.min(255, Math.round(Math.max(...holes.map(h => h.grow || 1)) * kx)));
      for (let i = 0; i < N; i++) if (md[i * 4 + 3] > 0) { hole[i] = 1; grow[i] = g; }
      const img = ctx.getImageData(0, 0, c.width, c.height);
      fillHoles(img, hole, grow, holes.flatMap(h => h.ink || []));
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* unreadable — keep the crop as is */ }
  }

  /* Crops scene-px rect (x, y, w, h) out of a loaded source image/canvas at the source's own
     resolution (the flattened export is W×H today, but nothing here assumes it). */
  _cropSource(src, x, y, w, h, W = this.W, H = this.H) {
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const sx = sw / W, sy = sh / H;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * sx)); c.height = Math.max(1, Math.round(h * sy));
    c.getContext('2d').drawImage(src, Math.round(x * sx), Math.round(y * sy), c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  /* Rebuilds a background with `holes` ({poly, grow} in scene px, from _buildRegionLayer) taken
     out — so a region promoted to its own layer isn't ALSO still visible, duplicated, underneath
     it — and returns a new W×H <canvas>. Used by commitRegions/extractRegion.
     1. Local fill (regions.js#fillHoles): region-aware, so a hole continues the panel/backdrop it
        sits on and leftover fragments of the lifted element are chased out (`grow`) instead of
        smeared. Each hole is dilated a couple of px first as a halo guard.
     2. AI repaint (bgMode 'auto'/'best', when the provider can magicEdit and has a key): the model
        repaints only the filled areas of the local result into a seamless background. Its output
        is pasted back INSIDE the (feathered) hole mask only, so nothing outside the holes can
        change; it is discarded on any failure or if it comes back at a different aspect ratio
        (a stretched result would misalign). 'cheap' never calls the AI.
     Falls back to a plain transparent punch if the pixels can't be read at all. */
  async _rebuildBackground(src, holes, bgMode) {
    const W = this.W, H = this.H;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, W, H);
    const m = document.createElement('canvas'); m.width = W; m.height = H;
    const mctx = m.getContext('2d');
    mctx.lineJoin = 'round';
    mctx.lineWidth = 2 * Math.max(2, Math.round(Math.min(W, H) * 0.002));   // halo guard; `grow` handles the rest
    mctx.globalCompositeOperation = 'lighten';   // overlapping holes keep the larger grow budget
    for (const h of holes) {
      const poly = h && (h.poly || h), g = Math.max(1, Math.min(255, Math.round((h && h.grow) || 1)));
      if (!poly || poly.length < 3) continue;
      mctx.fillStyle = mctx.strokeStyle = `rgb(${g},${g},${g})`;
      mctx.beginPath();
      mctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) mctx.lineTo(poly[i].x, poly[i].y);
      mctx.closePath();
      mctx.fill(); mctx.stroke();
    }
    let finalHole;
    try {
      const md = mctx.getImageData(0, 0, W, H).data, hole = new Uint8Array(W * H), grow = new Uint8Array(W * H);
      for (let i = 0; i < hole.length; i++) if (md[i * 4 + 3] > 0) { hole[i] = 1; grow[i] = md[i * 4]; }
      const img = ctx.getImageData(0, 0, W, H);
      finalHole = fillHoles(img, hole, grow, holes.flatMap(h => (h && h.ink) || []));
      ctx.putImageData(img, 0, 0);
    } catch (e) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(m, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      return c;
    }
    if (bgMode === 'cheap') return c;
    const p = this.ai.provider();
    if (!this.ai.can('magicEdit') || (p && typeof p.hasKey === 'function' && !p.hasKey())) return c;
    // mask: white = repaint (grown hole, dilated a little more so the seam lands on known pixels)
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const kctx = mask.getContext('2d');
    const mi = kctx.createImageData(W, H);
    for (let i = 0; i < finalHole.length; i++) { const v = finalHole[i] ? 255 : 0; mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
    kctx.putImageData(mi, 0, 0);
    const r = await this.ai.run('magicEdit', c.toDataURL('image/png'),
      'This is a background plate. The areas that are white in the mask were roughly filled in after objects and text were removed. '
      + 'Repaint ONLY those areas so they continue the surrounding background seamlessly: same colours, gradients, textures, shapes and edges. '
      + 'Do not add any text, letters, products, people, logos or new objects anywhere. Keep everything else identical.',
      mask.toDataURL('image/png'));
    if (this._destroyed || r.status !== 'ok') { this._lastBgClean = r.status === 'ok' ? null : (r.message || r.reason); return c; }
    let out;
    try { out = await loadImageEl(r.result); } catch (e) { return c; }
    if (this._destroyed) return c;
    const ow = out.naturalWidth || out.width, oh = out.naturalHeight || out.height;
    if (!ow || !oh || Math.abs(ow / oh - W / H) > 0.02 * (W / H)) { this._lastBgClean = 'aspect_mismatch'; return c; }
    // feathered mask: soft edge so the pasted repaint blends into the untouched pixels
    const fm = document.createElement('canvas'); fm.width = W; fm.height = H;
    const fctx = fm.getContext('2d');
    const feather = Math.max(2, Math.round(Math.min(W, H) * 0.004));
    fctx.filter = `blur(${feather}px)`;
    const alphaMask = document.createElement('canvas'); alphaMask.width = W; alphaMask.height = H;
    const ami = alphaMask.getContext('2d').createImageData(W, H);
    for (let i = 0; i < finalHole.length; i++) { ami.data[i * 4 + 3] = finalHole[i] ? 255 : 0; }
    alphaMask.getContext('2d').putImageData(ami, 0, 0);
    fctx.drawImage(alphaMask, 0, 0);
    fctx.filter = 'none';
    fctx.globalCompositeOperation = 'source-in';
    fctx.drawImage(out, 0, 0, W, H);
    ctx.drawImage(fm, 0, 0);
    this._lastBgClean = 'ai';
    return c;
  }

  /* Explode `regions` (same shape as detectRegions()' result.regions, in percent-of-canvas bbox
     coordinates, PLUS an optional `polygon` — scene-px points, from a hand-drawn lasso/magnetic-
     lasso/object-click region a host UI's review step already traced) into real editable layers
     over a background image built from `flat` — a text region becomes a text layer (using
     `content` as the string), everything else an image layer cropped from `flat` at that bbox
     (silhouette-clipped to `rg.polygon` when given, else via _buildRegionLayer's cutoutRegion pass
     when the cv worker is available). Replaces the current composition, same history contract as
     openImageResult. Pure layer-building — no AI call of its own, so a review UI can call this
     however many times the user wants after adjusting boxes returned by detectRegions(). `bgMode`
     ('auto'/'cheap'/'best') is forwarded to _buildRegionLayer/cutoutRegion to control the local
     cutout's working resolution — see cutoutRegion's docstring. */
  async commitRegions(flat, regions, bgMode, { replace } = {}) {
    if (!Array.isArray(regions) || !regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions to commit.' };
    // `flat` already contains the opened photo, and the new Background is rebuilt from `flat` — so
    // the photo itself must go, or it sits under the new Background and shows through every hole
    // (each region then appears twice). An opened photo isn't role:'bg', hence the explicit pick.
    // Resolved before any await so it names the layer `flat` was actually rendered from.
    if (replace === undefined) {
      const photo = this._bgLayer();
      replace = photo && photo.role !== 'bg' && photo.visible !== false ? [photo] : [];
    }
    const src = await loadImageEl(flat);
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    // Only clear the old background and any leftover review-box overlays (role:'region', drawn by
    // a host UI's review step on top of the live canvas) — every OTHER layer the user already had
    // (hand-placed text, stickers, logos, previous extractions) must survive a convert, since `flat`
    // was rendered from the whole composition including them. Wiping unconditionally here used to
    // destroy all of it the moment commitRegions ran.
    // `replace`: extra layers `flat` already absorbs (by default the opened photo, see above).
    // Collected now, removed only once the new Background is ready — the rebuild can wait on an AI
    // repaint for several seconds, and the canvas shouldn't sit without a background meanwhile.
    const stale = this.fc.getObjects().filter(o => o.role === 'bg' || o.role === 'region' || replace.includes(o));
    // Build every region's layer FIRST (against a throwaway holding canvas) so we know each one's
    // hole polygon before the background image is ever added — the background is then painted with
    // those areas already punched out, instead of laying the full original image underneath the
    // very regions that just became their own layers (which is what showed the region doubled: once
    // in the flattened bg, once in its new cutout layer — see the "layer duplicated over its own
    // background" report this fixes).
    // Text first: a text region sitting on a badge/button/logo region is erased from that region's
    // image (innerHoles) so the words exist once — as the editable text layer on top — instead of
    // also staying baked into the badge underneath it. Text layers go back on top afterwards.
    const order = regions.map((rg, i) => i).sort((a, b) => (regions[b].type === 'text') - (regions[a].type === 'text'));
    const builtBy = new Map();
    for (const i of order) {
      const rg = regions[i];
      let innerHoles;
      if (rg.type !== 'text' && rg.bbox) {
        const P = pctBox(rg);
        innerHoles = regions.map((t, j) => (t.type === 'text' && t.bbox && shareInside(pctBox(t), P) > 0.8 && builtBy.get(j)) || null)
          .filter(Boolean).map(t => ({ poly: t.holePoly, grow: t.holeGrow, ink: t.holeInk }));
      }
      const b = await this._buildRegionLayer(this.fc, src, rg, { bgMode, innerHoles });
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (b) builtBy.set(i, b);
    }
    const built = regions.map((rg, i) => builtBy.get(i)).filter(Boolean);
    built.forEach(b => { if (b.layer.regionType === 'text') this.fc.bringToFront(b.layer); });
    const holes = built.filter(b => b.holePoly).map(b => ({ poly: b.holePoly, grow: b.holeGrow, ink: b.holeInk }));
    const bgSrc = holes.length ? (await this._rebuildBackground(src, holes, bgMode)).toDataURL('image/png') : flat;
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    stale.forEach(o => this.fc.remove(o));
    const bg = await addImageLayer(this.fabric, this.fc, bgSrc, { W: this.W, H: this.H, name: 'Background', role: 'bg', fit: 'cover' });
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    bg.set({ selectable: false, evented: false, locked: true });
    this.fc.sendToBack(bg);
    this.fc.discardActiveObject();
    this.fc.renderAll();
    this.commit('regions-to-layers');
    this.animateLayersIn(this.fc.getObjects().slice());
    return { status: 'ok', result: regions.length };
  }

  /* Add ONE region as a new layer on top of the current composition, without touching anything
     else already on the canvas — the additive counterpart to commitRegions' full-replace. Used by
     a review UI's "Extract" action (one box → one layer) so extracting doesn't wipe boxes the user
     hasn't dealt with yet. `flat` is the same flattened-source data URL commitRegions takes.
     Also punches the extracted region's silhouette out of the existing `bg` layer (if any) so the
     same pixels aren't left doubled underneath the freshly extracted layer. `bgMode` — see
     commitRegions/cutoutRegion. */
  async extractRegion(flat, region, bgMode) {
    if (!region) return { status: 'error', reason: 'no_region', message: 'No region to extract.' };
    // Resolved up front: once the region's own image layer is added, a canvas with no photo would
    // otherwise resolve _bgLayer() to that brand-new layer and swallow it into the Background.
    const under = this._bgLayer();
    const src = await loadImageEl(flat);
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    const built = await this._buildRegionLayer(this.fc, src, region, { bgMode });
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    if (!built) return { status: 'error', reason: 'empty_region', message: 'Region is too small to extract.' };
    const { layer, holePoly, holeGrow, holeInk } = built;
    // Lift the region out of whatever is actually underneath: an explicit role:'bg' image, or an
    // opened photo (role:'image' — previously skipped, so the extracted region stayed doubled in
    // it). _bgLayer only returns images, so a template's role:'bg' Rect (no setSrc) is never hit.
    // The target is rendered alone to W×H (bakes its fit/scale/rotation, filters and mask) and
    // swapped for a fresh locked Background at the same stack position — a new object, so no
    // filter or mask gets applied a second time on top of the baked pixels.
    const target = holePoly && under && this.fc.getObjects().includes(under) ? under : null;
    if (target && target.visible !== false) {
      const punched = await this._rebuildBackground(this._renderLayerAlone(target), [{ poly: holePoly, grow: holeGrow, ink: holeInk }], bgMode);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      const idx = this.fc.getObjects().indexOf(target);
      const bg = await addImageLayer(this.fabric, this.fc, punched.toDataURL('image/png'), { W: this.W, H: this.H, name: 'Background', role: 'bg', fit: 'cover' });
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      bg.set({ selectable: false, evented: false, locked: true });
      if (target.role === 'bg') bg.set({ id: target.id, name: target.name || 'Background' });
      this.fc.remove(target);
      this.fc.moveTo(bg, idx);
    }
    this.fc.discardActiveObject();
    this.fc.setActiveObject(layer);
    this.fc.renderAll();
    this.commit('extract-region');
    return { status: 'ok', result: { id: layer.id } };
  }

  /* Snap any in-flight layer-reveal animation to its final state — called before a new reveal
     starts, and from destroy(), so timers/animate loops never touch a disposed canvas. */
  _finishReveal() {
    const r = this._reveal;
    if (!r || r.aborted) return;
    r.aborted = true;
    (r.timers || []).forEach(clearTimeout);
    r.timers = [];
    (r.items || []).forEach(({ o, op, top }) => { o.set({ opacity: op, top, shadow: null }); o.dirty = true; if (o.setCoords) o.setCoords(); });
    if (!this._destroyed) { this.fc.calcOffset(); this.fc.requestRenderAll(); }
  }

  /* Staggered "layer reveal" after commitRegions/extractRegion: each new layer rises + fades in
     with a brief accent-color glow as it lands, background first then each region in turn — purely
     visual (runs AFTER commit(), so undo/redo/history already hold the final state) and respects
     prefers-reduced-motion. Mirrors the reference editor's animateLayersIn/finishReveal so a
     convert-to-layers result reads as "here's what just got created" instead of popping in all at
     once with no feedback tying each layer to the region it came from. */
  animateLayersIn(objs) {
    const fc = this.fc, fabric = this.fabric;
    if (this._destroyed || !fc || !fabric || !objs || !objs.length) return;
    this._finishReveal();
    const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !fabric.util || !fabric.util.animate) { fc.requestRenderAll(); return; }
    const ease = fabric.util.ease && fabric.util.ease.easeOutCubic;
    const r = { aborted: false, timers: [], items: [] };
    this._reveal = r;
    const abort = () => r.aborted;
    let n = 0;
    objs.forEach((o) => {
      const op = (o.opacity == null ? 1 : o.opacity);
      const base = o.role === 'bg';
      const top = o.top, drift = base ? 0 : 18;
      r.items.push({ o, op, top });
      o.set({ opacity: 0, top: top + drift }); o.dirty = true;
      const delay = base ? 0 : (340 + n * 180); if (!base) n++;
      const t = setTimeout(() => {
        if (this._destroyed || r.aborted) return;
        fabric.util.animate({ startValue: 0, endValue: op, duration: 820, easing: ease, abort, onChange: (v) => { o.set('opacity', v); fc.requestRenderAll(); } });
        fabric.util.animate({ startValue: top + drift, endValue: top, duration: 940, easing: ease, abort, onChange: (v) => { o.set('top', v); fc.requestRenderAll(); }, onComplete: () => { if (o.setCoords) o.setCoords(); } });
        if (!base) {
          o.set('shadow', new fabric.Shadow({ color: 'rgba(212,255,69,0.85)', blur: 30, offsetX: 0, offsetY: 0 }));
          fabric.util.animate({ startValue: 30, endValue: 0, duration: 1040, abort, onChange: (v) => { if (o.shadow) { o.shadow.blur = v; fc.requestRenderAll(); } }, onComplete: () => { o.set('shadow', null); fc.requestRenderAll(); } });
        }
      }, delay);
      r.timers.push(t);
    });
    fc.requestRenderAll();
  }

  /* One-shot convenience: detect + commit immediately with no review step (what the AI panel's
     original "Detect regions → layers" button already did before commitRegions() existed). */
  async detectRegionsToLayers() {
    const r = await this.detectRegions();
    if (r.status !== 'ok') return r;
    return this.commitRegions(r.result.flat, r.result.regions);
  }

  destroy() {
    if (this._reveal && !this._reveal.aborted) { this._reveal.aborted = true; (this._reveal.timers || []).forEach(clearTimeout); this._reveal.timers = []; }
    this._destroyed = true;
    if (this._frameHandles) Object.keys(this._frameHandles).forEach(key => this._cancelFrameJob(key));
    if (typeof document !== 'undefined') {
      if (this._onSpaceDown) document.removeEventListener('keydown', this._onSpaceDown);
      if (this._onSpaceUp) document.removeEventListener('keyup', this._onSpaceUp);
      if (this._onPickModifier) {
        document.removeEventListener('keydown', this._onPickModifier);
        document.removeEventListener('keyup', this._onPickModifier);
      }
    }
    clearTimeout(this._gradCommitT); this._gradCommitT = null;
    clearTimeout(this._liveCommitT); this._liveCommitT = null;
    if (this._onCtxMenu && this.fc.upperCanvasEl) this.fc.upperCanvasEl.removeEventListener('contextmenu', this._onCtxMenu);
    this.fc.dispose();
    this._listeners = {};
    if (this.cv) this.cv.destroy();
  }
}
