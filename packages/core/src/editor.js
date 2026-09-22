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
import { makeShape, resizeShapeTo, makeText, layerLabel, uid } from './shapes.js';
import { getCropHandle, dragCropRect, applyCrop } from './crop.js';
import { alignDelta, snapDelta } from './layout.js';
import { EXTRA, serialize, restore, exportImage, addImageLayer, artboardForImage, loadImageEl } from './io.js';
import { selectionClipObject, renderSelectedPixels } from './pixels.js';
import { recolorPixels, fxToFilterSpecs, FX_DEFAULTS, normalizeGradientStops, splitGradientStopColor, relLum, hexRgb } from './color.js';
import { AIRegistry } from './ai/registry.js';
import { CvEngine, prepImageData } from './cv/client.js';
import { makeMaskFilterClass, createMaskCanvas, maskStamp, maskLine, serializeMask, deserializeMask, invertMaskCanvas } from './mask.js';
import { stickerSpec, STICKER_PALETTE, STICKER_DEFAULT_LABEL } from './stickers.js';
import { makeCTA, makeBadge, makePrice, makeBrandLockup } from './adtext.js';
import { buildPromoLayout, buildLayerFromSpec } from './templates.js';

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

/* AI region-detection vocabulary (detectRegions/commitRegions) — the type strings a provider's
   detectRegions() returns, mapped to the LAYER ROLE a committed region becomes ('text' regions
   read as headline copy, 'sticker' regions as a decorative shape; product/logo/decorative already
   match their own final role so they pass through) and, for a host UI drawing region-review
   overlays (draft boxes during a guided convert step), a distinct accent color per type so a user
   can tell region types apart at a glance before committing them. */
export const REGION_ROLE = { product: 'product', logo: 'logo', text: 'headline', sticker: 'decorative', decorative: 'decorative' };
export const REGION_COLOR = { product: '#d4ff45', logo: '#7cc4ff', text: '#ffd166', sticker: '#ff8fab', decorative: '#b794f6' };
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

export class Editor {
  constructor({ fabric, canvasEl, width = 1080, height = 1080, background = '#ffffff', voidColor = '#0a0a0c', openCvUrl } = {}) {
    if (!fabric) throw new Error('Pass fabric (v5) into the Editor — it is a peer dependency.');
    this.fabric = fabric;
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
      selectionColor: 'rgba(13,153,255,0.08)',
      selectionBorderColor: '#0d99ff',
      selectionLineWidth: 1,
      // Fabric's own default binds Shift+drag on a side handle (ml/mr/mt/mb) to skew — the
      // classic Illustrator/Photoshop convention puts skew on Alt/Option instead, freeing Shift
      // for the proportional-resize behaviour _bindProportionalSideScale implements below.
      altActionKey: 'altKey',
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
      if (!bg) return;
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
    // Themed selection handles: circular accent-colored corners instead of Fabric's stock plain
    // white squares + light-blue border — applied per-object on 'object:added' rather than
    // mutating the shared fabric.Object.prototype globally, so multiple Editor instances on one
    // page (or other Fabric usage outside this library) never fight over one theme. `accent`
    // defaults to the toolOpts fill color set below (this.toolOpts isn't assigned yet at this
    // point in the constructor, so the literal is duplicated here rather than referenced).
    const handleAccent = '#ef6a2d';
    this.fc.on('object:added', (opt) => {
      if (opt.target) opt.target.set({
        transparentCorners: false, cornerColor: handleAccent, cornerStrokeColor: '#0c0c0e',
        borderColor: handleAccent, cornerSize: 11, cornerStyle: 'circle', borderScaleFactor: 1.5, padding: 2,
      });
    });
    this.engine = new PaintEngine(fabric, this.fc, width, height);
    // Registers fabric.Image.filters.MaskFilter (see mask.js) — must happen before any scene
    // JSON containing a mask filter is ever restored (undo/redo, loadJSON), since Fabric's own
    // enlivenObjects() resolves a filter's class by its serialized `type` string against exactly
    // that registry.
    makeMaskFilterClass(fabric);
    this.history = new History(60);
    this.ai = new AIRegistry();
    // OpenCV worker RPC — boots lazily on first cv-backed call. openCvUrl overrides
    // DEFAULT_OPENCV_URL (a root-relative path — see cv/worker.js) for hosts that serve the
    // vendored opencv.js from somewhere else, or want to point at a CDN mirror instead.
    this.cv = new CvEngine(openCvUrl ? { openCvUrl } : undefined);
    this.tool = 'select';
    this.toolOpts = {
      size: 30, opacity: 1, hardness: 0.7, color: '#ef6a2d', fill: '#ef6a2d', tolerance: 64, fontSize: 48, aligned: true,
      gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }],
      addMode: false,   // sticky "keep adding every click to the selection" toggle for wand/objectselect/hoverselect
      paintNewLayer: false,   // paint tools retouch the image itself by default — see _bindPaintTarget
    };
    this.selection = null;
    this.crop = null;               // {x,y,w,h} while the crop tool is live
    this._drag = null;
    this._snap = true;
    this._polyBuild = null;         // running lasso-poly/lasso-mag vertex list
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
    this._maskDrag = null;
    this._lastActiveId = null;      // last non-bg object the user selected/moved — see selectActiveOrCenter()
    this._cropTarget = null;        // id of the image being cropped, when crop is scoped to one layer — see setTool('crop')/applyCrop()
    this._cropRestore = null;       // pre-expand {id,left,top,cropX,cropY,width,height} to undo the "show full image" expand on cancel — see setTool('crop')/_restoreCropTarget()
    this._spaceDown = false;        // true while the spacebar is held — see _bindSpacePan()
    this._bindPointer();
    this._bindModified();
    this._bindLastActive();
    this._bindSpacePan();
    this._bindProportionalSideScale();
    this.setSnapEnabled(true);
    this.commit('init');
  }

  /* ── events: 'change' (scene), 'tool', 'selection', 'history', 'crop', 'error' (a fire-and-forget
     async call — e.g. wandPick's add/subtract on empty space — failed with nothing else to signal it) ── */
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).filter(f => f !== fn); }
  _emit(ev, data) { (this._listeners[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } }); }

  /* ── tools ────────────────────────────────────────────────────────────────────────────── */
  setTool(t) {
    if (!ALL_TOOLS.includes(t)) throw new Error('Unknown tool "' + t + '". Tools: ' + ALL_TOOLS.join(', '));
    const prev = this.tool;
    if (CLICK_LASSOS.includes(prev) && prev !== t) this._polyBuild = null;
    // Switching away from Pen mid-path must tell listeners the in-progress path is gone too —
    // _down/_move emit 'pen' on every point placed, so a host overlay (see the demo's `penBuild`)
    // that only updates from that event would otherwise keep drawing the abandoned path forever.
    if (prev === 'pen' && t !== 'pen' && this._penBuild) { this._penBuild = null; this._emit('pen', null); }
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
    if (t === 'crop') {
      // Cropping a selected image layer crops just that image (native Fabric cropX/cropY/width/
      // height) instead of the whole artboard — but only when it's unrotated: the crop rect below
      // is drawn in scene space, and mapping that back into a rotated image's own local space is
      // more than this simple rect UI is worth. Same _lastActiveId fallback as gradient/_maskable
      // above, since setTool() is about to discardActiveObject() a few lines down.
      const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      const target = active && active.type === 'image' && active.role !== 'bg' && !(active.angle % 360) ? active : null;
      this._cropTarget = target ? target.id : null;
      if (target) {
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
    if (t !== 'gradient' && this._gradAxis) this._emitGradientAxis(null);
    if (drawing) this.fc.discardActiveObject();
    this.fc.renderAll();
    this._emit('tool', t);
    this._emit('crop', this.crop);
  }

  /* Paint tools hide the OS cursor entirely — the shells draw a brush-footprint ring at the pointer
     instead, which is the only thing that shows the real stamp size (and, for clone/heal, where
     pixels are being sampled from); a 'crosshair' would just sit on top of it. */
  _cursorForTool(t) {
    if (t === 'hand') return 'grab';
    if (t === 'type') return 'text';
    if (PAINT_TOOLS.includes(t)) return 'none';
    return t === 'select' ? 'default' : 'crosshair';
  }

  setToolOptions(patch) {
    this.toolOpts = { ...this.toolOpts, ...patch };
    this._emit('tooloptions', this.toolOpts);
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
    fc.on('mouse:down', (opt) => this._down(opt));
    fc.on('mouse:move', (opt) => this._move(opt));
    fc.on('mouse:up', () => this._up());
    // Leaving the canvas must drop the brush ring, or it stays frozen at the last point it saw.
    fc.on('mouse:out', (opt) => { if (!opt || !opt.target) { this._brushCursor = null; this._emit('brushcursor', null); } });
    // wheel zoom around the cursor
    fc.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      let z = fc.getZoom() * Math.pow(0.999, delta);
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
    if (this.toolOpts.paintNewLayer) { this.engine.setDirectTarget(null); return; }
    const target = this._paintTargetLayer();
    if (!target) { this.engine.setDirectTarget(null); return; }
    // Re-bind only when the target changed: a mid-stroke re-rasterize would throw away the dabs
    // already painted into the scratch canvas this stroke.
    if (this.engine._direct && this.engine._direct.layer === target) return;
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

  /* Which layer the paint tools retouch: the active one if it holds pixels, else the topmost
     image (the photo you opened), else the topmost paint layer. */
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
  _emitGradientAxis(from, to) {
    this._gradAxis = from ? {
      from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
      type: this.toolOpts.gradientType || 'linear',
      // The stops ride along the axis as colour swatches (Figma-style), so the shell needs both
      // each stop's colour and its 0..1 position to place them.
      stops: normalizeGradientStops(this.toolOpts.gradientStops).map(s => ({ offset: s.offset, color: s.color })),
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
        maskStamp(layer.maskCanvas.getContext('2d'), pt.x, pt.y, o, t === 'eraser');
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
      if (t !== 'lasso' && this.selection && (this.selection.kind === 'rect' || this.selection.kind === 'ellipse')) {
        const handle = getSelectionHandle(this.selection, pt, this.fc.getZoom());
        if (handle) { this._drag = { kind: 'resize-sel', handle, last: pt, down: pt }; return; }
      }
      this.selection = startSelection(t, pt);
      this._drag = { kind: 'sel' };
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
      this.wandPick(pt, { add: e.shiftKey || this.toolOpts.addMode, subtract: e.altKey });
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
      else this.selectObjectAt(pt, { add, subtract: e.altKey, cycle: true });
      return;
    }
    if (t === 'magicwand') {
      const add = e.shiftKey || this.toolOpts.addMode;
      const cached = this._hoverCache && this._hoverCache.get(this._hoverCellKey(pt));
      if (cached) this._commitPoly(cached, { add, subtract: e.altKey });
      else this.wandPick(pt, { add, subtract: e.altKey });
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
      this._applySelClip();
      this.engine.fill(this.toolOpts.color);
      this.commit('bucket');
      return;
    }
    if (t === 'gradient') {
      // Dragging onto an active vector object with no pixel selection applies the gradient
      // directly as that object's own fill (scales/rotates with it, Fabric's native gradient)
      // instead of painting a raster stripe into the paint layer — same "object gradient" mode
      // the reference editor's own gradient tool has, just generalized to Canvasmith's multi-stop
      // gradientStops instead of a hardcoded 2-color pair. bg is excluded unless it's a plain
      // rect (a bg IMAGE shouldn't silently lose its pixels to a gradient fill), matching the
      // reference editor's own `o.role !== 'bg' || o.type === 'rect'` condition exactly.
      // Same _lastActiveId fallback as selectActiveOrCenter() (objectselect-bbox) — setTool()
      // already discarded Fabric's own active object by the time this click lands, since
      // 'gradient' is a drawing tool like any other.
      const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      const objTarget = active && active.type !== 'activeSelection' && (active.role !== 'bg' || active.type === 'rect') && !this.selection ? active : null;
      if (objTarget) {
        this._drag = { kind: 'gradient-obj', from: pt, obj: objTarget };
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
      if (hex) { this.setToolOptions({ color: hex }); this._emit('eyedropper', hex); }
      return;
    }
    if (t === 'crop' && this.crop) {
      const handle = getCropHandle(this.crop, pt, this.fc.getZoom());
      if (handle) this._drag = { kind: 'crop', handle, last: pt };
      return;
    }
    if (t === 'pen') {
      if (!this._penBuild) this._penBuild = startPolyBuild();
      const next = polyBuildAdd(this._penBuild, pt, 12 / (this.fc.getZoom() || 1));
      this._penBuild = next;
      if (next.closed) { this.finishPen(); return; }
      this._emit('pen', { pts: next.pts.slice() });
      this.fc.renderAll();
      return;
    }
  }

  _move(opt) {
    const pt = this._pt(opt), e = opt.e || {};
    if (PAINT_TOOLS.includes(this.tool)) this._emitBrushCursor(pt, !!e.altKey, !!e.shiftKey);
    if (this._maskEdit && this._maskDrag && (this.tool === 'brush' || this.tool === 'pencil' || this.tool === 'eraser')) {
      const layer = this._byId(this._maskEdit.layerId);
      if (layer && layer.maskCanvas) {
        maskLine(layer.maskCanvas.getContext('2d'), this._maskDrag, pt, { ...this.toolOpts }, this.tool === 'eraser');
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
    if (this.tool === 'pen' && this._penBuild) {
      this._emit('pen', polyBuildPreview(this._penBuild, pt));
      this.fc.renderAll();
      return;
    }
    if (this.tool === 'hoverselect' || this.tool === 'objectselect') { this._hoverMove(pt); return; }
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'pan') {
      const vpt = this.fc.viewportTransform;
      vpt[4] += e.clientX - d.x; vpt[5] += e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      this.fc.requestRenderAll();
      return;
    }
    if (d.kind === 'paint') { this.engine.move(this.tool, pt, { ...this.toolOpts }); return; }
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
      const to = snapAxis(d.from, pt, e.shiftKey);
      this._applyObjectGradient(d.obj, d.from, to);
      this._emitGradientAxis(d.from, to);
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
    if (this._maskEdit && this._maskDrag) { this._maskDrag = null; this._flushFrameJob('mask'); this.commit('mask-paint'); return; }
    const d = this._drag; this._drag = null;
    if (!d) return;
    if (d.kind === 'paint') {
      this.engine.up(); this.engine.setClip(null);
      // Unbind so the NEXT stroke re-rasterizes the target: the layer's pixels have just changed,
      // and clone/heal must sample the retouched result (captureFlat reads the scene, not this
      // scratch canvas). Also stops a later tool switch from writing onto a stale target.
      this.engine.setDirectTarget(null);
      this.commit('stroke');
    }
    if (d.kind === 'sel') { this.selection = finalizeSelection(this.selection); this._emit('selection', this.selection); }
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
    if (d.kind === 'gradient-obj') { this._emitGradientAxis(null); this.commit('gradient-fill'); }
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

  /* ── pen tool: click-to-place vertices into a real filled fabric.Polygon layer (not a
     selection) — Enter/double-click-near-start finishes, Escape cancels. Reuses the same
     poly-build accumulator as the polygonal lasso (startPolyBuild/polyBuildAdd), since "click to
     place points, snap-close near the start" is identical geometry either way. */
  finishPen() {
    const build = finishPolyBuild(this._penBuild, false);
    this._penBuild = null;
    this._emit('pen', null);
    if (!build) { this.fc.renderAll(); return null; }
    const pts = build.pts;
    const minX = Math.min(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y));
    const obj = new this.fabric.Polygon(pts.map(p => ({ x: p.x - minX, y: p.y - minY })), {
      left: minX, top: minY, originX: 'left', originY: 'top',
      fill: this.toolOpts.fill || this.toolOpts.color || '#ef6a2d',
      stroke: this.toolOpts.stroke || null, strokeWidth: this.toolOpts.strokeWidth || 0,
    });
    obj.set({ id: uid(), role: 'shape', name: 'Path' });
    this.fc.add(obj);
    this.fc.setActiveObject(obj);
    this.commit('pen');
    this.setTool('select');
    return obj.id;
  }
  cancelPen() {
    this._penBuild = null;
    this._emit('pen', null);
    this.fc.renderAll();
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
        if (pts && pts.length >= 3) poly = pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
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
          const poly = pts.map(p => ({ x: region.left + p.x * sx, y: region.top + p.y * sy }));
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

  /* ── hover-preview object select: debounced, cancellable, grid-cell cached ───────────────
     Shows, on hover, the polygon that a click WOULD select — same hybrid wand the click uses —
     so the user can confirm before committing. Single-flight: a fast-moving cursor replaces the
     pending point instead of queueing worker jobs. Cached by a coarse cell keyed on zoom and the
     current tolerance, so moving within one object is instant and changing tolerance can't serve
     a stale mask. */
  _hoverCellKey(pt) {
    const z = this.fc.getZoom() || 1;
    const cell = Math.max(3, 12 / z);
    return Math.round(pt.x / cell) + '_' + Math.round(pt.y / cell) + '_t' + this.toolOpts.tolerance;
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
          const scene = pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
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
      const tag = document.activeElement && document.activeElement.tagName;
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

  commit(label) {
    this._recomputeAdjustmentLayers();
    if (this.history.push(serialize(this.fc, this.W, this.H))) {
      this._emit('history', this.history.depth());
      this._emit('change', { label });
    }
  }
  undo() {
    const s = this.history.undo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'undo' }); } });
  }
  redo() {
    const s = this.history.redo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'redo' }); } });
  }
  _afterRestore(w, h) {
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this._emit('resize', { width: w, height: h });
  }

  /* ── layers ───────────────────────────────────────────────────────────────────────────── */
  layers() {
    return this.fc.getObjects().map((o, i) => ({
      id: o.id || (o.id = uid()), index: i, name: layerLabel(o), role: o.role || 'shape',
      visible: o.visible !== false, locked: !!o.locked, opacity: o.opacity != null ? o.opacity : 1,
      blend: o.globalCompositeOperation || 'source-over',
      active: this.fc.getActiveObject() === o,
      maskable: this._maskable(o), hasMask: !!o.maskCanvas, maskEnabled: o.maskEnabled !== false,
      editingMask: !!this._maskEdit && this._maskEdit.layerId === o.id,
      isAdjustment: o.role === 'adjustment', adj: o.role === 'adjustment' ? { ...FX_DEFAULTS, ...o.adj } : null,
    })).reverse();   // panel order: topmost first
  }
  _byId(id) { return this.fc.getObjects().find(o => o.id === id); }
  setLayer(id, patch) {
    const o = this._byId(id); if (!o) return;
    if ('visible' in patch) o.visible = patch.visible;
    if ('opacity' in patch) o.opacity = patch.opacity;
    if ('locked' in patch) { o.locked = patch.locked; o.selectable = !patch.locked; o.evented = !patch.locked; }
    if ('blend' in patch) o.globalCompositeOperation = patch.blend;
    if ('name' in patch) { o.name = patch.name; o.renamed = true; }
    this.fc.renderAll(); this.commit('layer');
  }
  moveLayer(id, dir) {
    const o = this._byId(id); if (!o) return;
    if (dir === 'up') this.fc.bringForward(o); else if (dir === 'down') this.fc.sendBackwards(o);
    else if (dir === 'top') this.fc.bringToFront(o); else if (dir === 'bottom') this.fc.sendToBack(o);
    this.fc.renderAll(); this.commit('reorder');
  }
  /* Drag-to-reorder: move layer `id` to sit directly in front of (default) or behind layer
     `targetId` in stacking order — "in front of" is the natural drop semantic for a layers panel
     that lists topmost-first (fc.getObjects() index order is bottom-to-top, the OPPOSITE of the
     panel's display order, so "in front of target" means one PAST target's fc index, not before
     it). No-op if either id is missing or they're the same object. */
  reorderLayerTo(id, targetId, { after = false } = {}) {
    if (id === targetId) return;
    const o = this._byId(id), target = this._byId(targetId); if (!o || !target) return;
    const objs = this.fc.getObjects();
    let idx = objs.indexOf(target);
    if (idx < 0) return;
    if (!after) idx += 1;   // "in front of" target = just past it in fc's bottom-to-top order
    if (objs.indexOf(o) < idx) idx -= 1;   // account for o's own removal shifting later indices down
    this.fc.moveTo(o, Math.max(0, idx));
    this.fc.renderAll(); this.commit('reorder');
  }
  removeLayer(id) {
    const o = this._byId(id); if (!o) return;
    // Deleting the layer currently being mask-painted must drop the in-flight mask-edit state and
    // cancel (not flush) any pending rAF refresh — the refresh's target is about to be removed
    // from the canvas, so there's nothing left to apply it to (see removeMask's identical guard).
    if (this._maskEdit && this._maskEdit.layerId === id) { this._cancelFrameJob('mask'); this._maskEdit = null; this._maskDrag = null; this._emit('maskedit', null); }
    this.fc.remove(o);
    this.commit('remove');
  }
  activate(id) {
    const o = this._byId(id);
    if (o) {
      if (this.tool !== 'select') this.setTool('select');
      this.fc.setActiveObject(o);
      this.fc.renderAll();
      this._emit('change', { label: 'activate' });
    }
  }

  duplicateLayer(id, offset = 12) {
    const o = this._byId(id); if (!o) return;
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
     drop fx) but both ultimately live on the one `o.filters` array Fabric's applyFilters() reads. */
  setImageFilters(patch) {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image') return;
    const fx = { ...FX_DEFAULTS, ...(o.fx || {}), ...patch };
    o.fx = fx;
    const maskFilter = (o.filters || []).find(f => f.type === 'MaskFilter');
    o.filters = [
      ...(maskFilter ? [maskFilter] : []),
      ...fxToFilterSpecs(fx).map(({ type, params }) => new this.fabric.Image.filters[type](params)),
    ];
    o.applyFilters();
    this.fc.renderAll();
    this.commit('filters');
  }
  getImageFilters() {
    const o = this.fc.getActiveObject();
    return { ...FX_DEFAULTS, ...((o && o.fx) || {}) };
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

  setAdjustmentParams(id, patch) {
    const o = this._byId(id); if (!o || o.role !== 'adjustment') return;
    o.adj = { ...FX_DEFAULTS, ...o.adj, ...patch };
    this._recomputeAdjustmentLayers();
    this.fc.renderAll();
    this.commit('adjustment');
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

  /* ── layer masks: paintable, non-destructive, image/paint-role layers only (see mask.js's
     header comment for why vector shapes/text aren't supported) ───────────────────────────────
     addMask() creates a blank (fully-visible) mask and pushes a MaskFilter onto the layer's own
     `o.filters`, ahead of any brightness/contrast/etc. filters (see setImageFilters above) so a
     disabled/deleted mask never disturbs those. enterMaskEdit() redirects brush/pencil/eraser
     strokes (via _down/_move/_up) into painting the mask canvas instead of the pixel layer
     itself — exitMaskEdit() (or picking any other tool) ends that redirect. */
  _maskable(o) { return !!o && (o.type === 'image' || o.role === 'paint'); }
  addMask(id) {
    const o = this._byId(id); if (!this._maskable(o) || o.maskCanvas) return;
    o.maskCanvas = createMaskCanvas(this.W, this.H);
    o.maskEnabled = true;
    const MaskFilter = makeMaskFilterClass(this.fabric);
    o.filters = [new MaskFilter({ maskCanvas: o.maskCanvas }), ...(o.filters || [])];
    o.applyFilters();
    this.fc.renderAll();
    this.commit('add-mask');
  }
  removeMask(id) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    if (this._maskEdit && this._maskEdit.layerId === id) this.exitMaskEdit();
    o.maskCanvas = null; o.maskEnabled = false;
    o.filters = (o.filters || []).filter(f => f.type !== 'MaskFilter');
    o.applyFilters();
    this.fc.renderAll();
    this.commit('remove-mask');
  }
  /* Enabled/disabled toggle (Photoshop's shift-click-the-mask-thumbnail) — the mask canvas and
     paint strokes on it are kept either way, only its visual effect is switched on/off. */
  setMaskEnabled(id, enabled) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    o.maskEnabled = !!enabled;
    const f = (o.filters || []).find(x => x.type === 'MaskFilter');
    if (f) f.maskCanvas = enabled ? o.maskCanvas : null;
    o.applyFilters();
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
    o.applyFilters();
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
  setNumeric(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
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
    if ('rx' in patch && o.type === 'rect') {
      const r = Math.max(0, patch.rx);
      o.set({ rx: r, ry: r });
      o.dirty = true;
    }
    o.setCoords();
    this.fc.renderAll();
    this.commit('transform');
  }

  /* Recolors the active object (shape fill or text colour) — an activeSelection applies the same
     colour to every member, matching how alignActiveSelection/setLayer treat a multi-selection. */
  setFill(color) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if (o.type === 'activeSelection') o.forEachObject(m => m.set('fill', color));
    else o.set('fill', color);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('fill');
  }

  /* Border/stroke — patch keys: color, width. Setting a width with no color yet defaults to black
     (mirrors the reference: picking up the width slider from 0 should show a visible border right
     away, not an invisible one). No-op with nothing selected, same silent-no-op contract as
     setFill/setNumeric for a property that may not apply to every member of a multi-selection —
     Fabric ignores stroke/strokeWidth on object types that don't render one (e.g. images). */
  setStroke(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (m) => {
      if ('width' in patch) { if (patch.width > 0 && !m.stroke) m.set('stroke', '#000000'); m.set('strokeWidth', Math.max(0, patch.width)); }
      if ('color' in patch) m.set('stroke', patch.color);
    };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('stroke-style');
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
    const p1 = obj.toLocalPoint(new this.fabric.Point(from.x, from.y), 'center', 'center');
    const p2 = obj.toLocalPoint(new this.fabric.Point(to.x, to.y), 'center', 'center');
    const sx = obj.scaleX || 1, sy = obj.scaleY || 1;
    const norm = normalizeGradientStops(this.toolOpts.gradientStops);
    const colorStops = norm.map(s => ({ offset: s.offset, color: s.color }));
    obj.set('fill', new this.fabric.Gradient({
      type: 'linear', gradientUnits: 'pixels',
      coords: { x1: p1.x / sx, y1: p1.y / sy, x2: p2.x / sx, y2: p2.y / sy },
      colorStops,
    }));
    obj.dirty = true;
    this.fc.renderAll();
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
      obj.set('fill', new this.fabric.Gradient({ type, coords, colorStops }));
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

  /* ── crop ─────────────────────────────────────────────────────────────────────────────── */
  // Undoes the "expand to full image" visual done on entering Crop for an already-cropped layer
  // (see setTool('crop')) when the user leaves the tool WITHOUT applying — otherwise the image
  // would stay expanded to its pre-crop size/position forever on a plain cancel.
  _restoreCropTarget() {
    if (!this._cropRestore) return;
    const target = this._byId(this._cropRestore.id);
    if (target) {
      target.set(this._cropRestore);
      target.dirty = true;
      target.setCoords();
      this.fc.renderAll();
    }
    this._cropRestore = null;
  }

  applyCrop() {
    if (!this.crop) return;
    const target = this._cropTarget && this._byId(this._cropTarget);
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
  async openImage(src, { fitArtboard = true } = {}) {
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
  exportPNG(mult = 1) { return exportImage(this.fc, this.W, this.H, { format: 'png', multiplier: mult }); }
  exportJPEG(quality = 0.92, mult = 1) { return exportImage(this.fc, this.W, this.H, { format: 'jpeg', quality, multiplier: mult }); }
  /* Vector export via Fabric's own toSVG — returns an SVG string (wrap in a Blob to download). */
  exportSVG() {
    this.fc.discardActiveObject();
    this.fc.renderAll();
    return this.fc.toSVG({ width: this.W, height: this.H, viewBox: { x: 0, y: 0, width: this.W, height: this.H } });
  }
  toJSON() { return serialize(this.fc, this.W, this.H); }
  loadJSON(json) { restore(this.fc, json, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this.commit('load'); } }); }

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
    this._penBuild = null;
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

  /* ── AI conveniences (thin sugar over the registry) ───────────────────────────────────── */
  async aiEdit(instruction) {
    const r = await this.ai.run('magicEdit', this.exportPNG(), instruction);
    if (r.status === 'ok') { await this.openImageResult(r.result); }
    return r;
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
  async aiBgSwap(instruction) {
    const bg = this._bgLayer();
    if (!bg) {
      const flat = this.exportPNG();
      const r = await this.ai.run('magicEdit', flat, instruction + (this.selection ? ' Keep the selected subject pixel-identical; only change the background.' : ''));
      if (r.status === 'ok') await this.openImageResult(r.result);
      return r;
    }
    const flat = this._renderLayerAlone(bg).toDataURL('image/png');
    const hasSel = !!this.selection;
    const maskURL = hasSel ? this._selectionEditMask().toDataURL('image/png') : null;
    const text = hasSel
      ? instruction + ' Replace the background (the white regions of the mask) with this. Keep every black-masked subject pixel EXACTLY unchanged — same colours, edges and position. Blend the new background\'s lighting and shadows naturally around the subject.'
      : instruction + ' Keep the main subject exactly as it is — same position, scale, colours and details. Integrate lighting and shadows naturally.';
    const r = maskURL ? await this.ai.run('magicEdit', flat, text, maskURL) : await this.ai.run('magicEdit', flat, text);
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
    const regions = (r.status === 'ok' && Array.isArray(r.result)) ? r.result.slice() : [];
    if (local && local.status === 'ok') {
      const iou = (a, b) => {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const inter = ix * iy;
        return inter / Math.max(1, a.w * a.h + b.w * b.h - inter);
      };
      const known = regions.map(rg => {
        const bb = rg.bbox || {};
        return { x: (bb.x || 0) / 100 * this.W, y: (bb.y || 0) / 100 * this.H, w: (bb.width || 0) / 100 * this.W, h: (bb.height || 0) / 100 * this.H };
      });
      const candidates = [
        ...(local.result.boxes || []).map(b => ({ b, type: 'product' })),
        ...((local.result.textBoxes || [])).map(b => ({ b, type: 'text' })),
      ];
      for (const { b, type } of candidates) {
        if (b.w * b.h > this.W * this.H * 0.6) continue;   // whole-canvas blobs are noise
        if (known.some(k => iou(b, k) > 0.3)) continue;     // the AI already found this one
        known.push(b);
        regions.push({ type, bbox: { x: b.x / this.W * 100, y: b.y / this.H * 100, width: b.w / this.W * 100, height: b.h / this.H * 100 } });
      }
    }
    if (!regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions detected.' };
    return { status: 'ok', result: { flat, regions } };
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
      // rg.style (captured on the review region as `rstyle` — see makeRegionRectObj/regionToPayload
      // in the React host) carries the detected/edited typography for this text region; apply it
      // when present instead of always falling back to makeText's plain defaults, same mapping the
      // reference editor's addTextRegionLayer uses.
      const st = rg.style || {};
      const scale = W / 1080;
      const txt = makeText(this.fabric, { x, y }, {
        text: rg.content || 'Text',
        fontSize: st.fontSize ? Math.max(12, Math.round(st.fontSize * scale)) : Math.max(12, Math.round(h * 0.6)),
        fill: st.color || undefined,
        fontWeight: st.fontWeight ? ((st.fontWeight === 'bold' || st.fontWeight >= 700) ? 700 : 400) : undefined,
      });
      if (st.textAlign) txt.set('textAlign', st.textAlign);
      txt.set({ role, regionType: rg.type, rstyle: rg.style || null, name: (rg.content || 'Text').slice(0, 24) });
      fc.add(txt);
      const holePoly = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      return { layer: txt, holePoly };
    }
    const sx = src.naturalWidth / W, sy = src.naturalHeight / H;
    const cw = Math.max(1, Math.round(w * sx)), ch = Math.max(1, Math.round(h * sy));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(src, Math.round(x * sx), Math.round(y * sy), cw, ch, 0, 0, cw, ch);
    const img = new this.fabric.Image(c, { left: x, top: y, originX: 'left', originY: 'top' });
    img.set({ id: uid(), role, regionType: rg.type, name: (rg.type || 'Layer')[0].toUpperCase() + (rg.type || 'layer').slice(1) });
    let holePoly = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    // A region drawn by hand (lasso/polygon/magnetic-lasso/object-click, see selection.js's
    // startPolyBuild/finishPolyBuild and Editor#objectPickInImage) already IS an exact silhouette
    // the user traced or a hybrid wand/grabCut already computed against the live image — re-running
    // cutoutRegion() here would throw that away and re-segment from scratch, constrained only to
    // the region's bbox, which is both wasteful and typically LOWER quality than what the user
    // already had (a bbox-seeded grabCut has less context than the original whole-canvas trace).
    // Use the given polygon as-is whenever the caller supplied one.
    if (Array.isArray(rg.polygon) && rg.polygon.length >= 3) {
      const poly = rg.polygon;
      const clip = new this.fabric.Polygon(poly.map(p => ({ x: p.x - x, y: p.y - y })), { absolutePositioned: false });
      img.clipPath = clip;
      holePoly = poly;
    } else if (cutout) {
      const poly = await this.cutoutRegion(src, { x, y, w, h }, bgMode);
      if (poly && poly.length >= 3 && !this._destroyed) {
        const clip = new this.fabric.Polygon(poly.map(p => ({ x: p.x - x, y: p.y - y })), { absolutePositioned: false });
        img.clipPath = clip;
        holePoly = poly;
      }
    }
    fc.add(img);
    return { layer: img, holePoly };
  }

  /* Punches `holes` (scene-px polygons, from _buildRegionLayer's holePoly) out of a background
     image element, returning a new <canvas> with those areas made transparent. Used by
     commitRegions/extractRegion so a region promoted to its own layer isn't ALSO still visible,
     duplicated, in the flattened background layer underneath it — ditto's reference editor gets
     the same result server-side via true segmentation/inpainting; this is the client-only
     equivalent for regions cut locally (cutoutRegion's silhouette, or a plain bbox rect). */
  _punchBackground(src, W, H, holes) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    for (const poly of holes) {
      if (!poly || poly.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
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
  async commitRegions(flat, regions, bgMode) {
    if (!Array.isArray(regions) || !regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions to commit.' };
    const src = await loadImageEl(flat);
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    // Only clear the old background and any leftover review-box overlays (role:'region', drawn by
    // a host UI's review step on top of the live canvas) — every OTHER layer the user already had
    // (hand-placed text, stickers, logos, previous extractions) must survive a convert, since `flat`
    // was rendered from the whole composition including them. Wiping unconditionally here used to
    // destroy all of it the moment commitRegions ran.
    this.fc.getObjects().slice().forEach(o => { if (o.role === 'bg' || o.role === 'region') this.fc.remove(o); });
    // Build every region's layer FIRST (against a throwaway holding canvas) so we know each one's
    // hole polygon before the background image is ever added — the background is then painted with
    // those areas already punched out, instead of laying the full original image underneath the
    // very regions that just became their own layers (which is what showed the region doubled: once
    // in the flattened bg, once in its new cutout layer — see the "layer duplicated over its own
    // background" report this fixes).
    const built = [];
    for (const rg of regions) {
      const b = await this._buildRegionLayer(this.fc, src, rg, { bgMode });
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (b) built.push(b);
    }
    const holes = built.map(b => b.holePoly).filter(Boolean);
    const bgSrc = holes.length ? this._punchBackground(src, this.W, this.H, holes).toDataURL('image/png') : flat;
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
    const src = await loadImageEl(flat);
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    const built = await this._buildRegionLayer(this.fc, src, region, { bgMode });
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    if (!built) return { status: 'error', reason: 'empty_region', message: 'Region is too small to extract.' };
    const { layer, holePoly } = built;
    if (holePoly) {
      const bg = this.fc.getObjects().find(o => o.role === 'bg');
      if (bg) {
        // Flatten the bg's own drawn appearance (respecting its current fit/scale/position) into a
        // W×H canvas first — its backing _element is the ORIGINAL unfit source image, not W×H, so
        // punching holes directly against it would target the wrong pixels once the bg has been
        // scaled/cropped to fit (e.g. commitRegions' 'cover' fit).
        const bgCanvas = this._renderLayerAlone(bg);
        const punched = this._punchBackground(bgCanvas, this.W, this.H, [holePoly]);
        await new Promise(res => bg.setSrc(punched.toDataURL(), () => res(), { crossOrigin: 'anonymous' }));
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        bg.set({ left: 0, top: 0, originX: 'left', originY: 'top', scaleX: 1, scaleY: 1 });
        bg.setCoords();
      }
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
    this.fc.dispose();
    this._listeners = {};
    if (this.cv) this.cv.destroy();
  }
}
