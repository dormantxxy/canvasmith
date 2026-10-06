/* PaintEngine — the raster heart of the editor.
   A single offscreen canvas (artboard resolution) is wrapped as a Fabric image layer; every pixel
   tool draws onto it in scene coordinates, so zoom/pan come free from Fabric's viewport transform.

   Tools implemented here: brush, pencil, eraser, dodge, burn, sponge, red-eye, clone, heal,
   bucket-style fill, linear gradient, eyedropper sampling. Selections clip strokes via setClip().

   Headless: `fabric` is injected — nothing here reads globals. */

import { hexRgb, rgba, toHex, normalizeGradientStops } from './color.js';

export const PAINT_TOOLS = ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'redeye'];

/* Renders exactly `objects` (an arbitrary subset/order of the canvas's own objects — NOT
   necessarily fc.getObjects()) to a fresh artboard-resolution offscreen canvas, at scene scale
   (viewport transform reset to identity, cropped to 0,0,W,H) — the same "flatten to a plain
   canvas" primitive captureFlat() already used for the whole scene, generalized so
   Editor#_recomputeAdjustmentLayers can flatten just "everything below this adjustment layer's
   z-index" instead. Uses fc.renderCanvas(ctx, objects) directly (Fabric's own object-list-scoped
   render, which fc.toCanvasElement() itself calls internally with the full list) rather than
   toggling every other object's `visible` off and back on around a toCanvasElement() call — no
   risk of a re-entrant render or a stray event firing off half-hidden state. Doesn't touch fc's
   own live width/height/viewportTransform at all, so no save/restore dance is needed around it. */
export function renderObjectsFlat(fc, W, H, objects) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = W; canvasEl.height = H;
  const ctx = canvasEl.getContext('2d');
  const savedVpt = fc.viewportTransform;
  // renderCanvas() cancels any on-screen render already requested (it assumes it IS that render).
  // This one is offscreen, so put the request back afterwards — otherwise a pending repaint (e.g.
  // the hover preview's) could be dropped and the screen left showing a stale frame.
  const pending = !!fc.isRendering;
  fc.viewportTransform = [1, 0, 0, 1, 0, 0];
  fc.calcViewportBoundaries();
  try { fc.renderCanvas(ctx, objects); }
  finally { fc.viewportTransform = savedVpt; fc.calcViewportBoundaries(); }
  if (pending) fc.requestRenderAll();
  return canvasEl;
}

/* Builds a real CanvasGradient from the shared {offset,color} stop shape — 'radial' treats
   (x1,y1) as the center and the distance to (x2,y2) as the radius (Canvas2D's own radial
   gradient convention: an inner radius of 0 at the center, growing out to that distance). */
export function buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type = 'linear') {
  const norm = normalizeGradientStops(stops);
  const g = type === 'radial'
    ? ctx.createRadialGradient(x1, y1, 0, x1, y1, Math.max(1, Math.hypot(x2 - x1, y2 - y1)))
    : ctx.createLinearGradient(x1, y1, x2, y2);
  norm.forEach(s => g.addColorStop(s.offset, s.color));
  return g;
}

export class PaintEngine {
  constructor(fabric, fc, W, H) {
    this.fabric = fabric; this.fc = fc; this.W = W; this.H = H;
    this.cv = document.createElement('canvas'); this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d');
    this.layer = null; this._clip = null; this._flat = null; this._src = null; this._off = null; this._last = null;
    this._lastStrokeEnd = null; this._curPt = null; this._newSourceSet = false;
  }

  /* Clone/heal source state, read by the shells to draw the source marker and the live "pixels
     come from here" ghost ring. `offset` is only meaningful once a stroke has started; before
     that the ghost tracks the raw source point. */
  cloneState() {
    return { src: this._src ? { ...this._src } : null, off: this._off ? { ...this._off } : null, pending: this._newSourceSet };
  }

  clearCloneSource() { this._src = null; this._off = null; this._newSourceSet = false; }

  /* Destructive mode: bind the engine's drawing surface to an EXISTING layer's own pixels, so
     strokes edit that image in place instead of accumulating on a separate paint layer (how the
     clone stamp works in Photoshop by default). `cv` is a scratch canvas the caller has already
     filled with the layer's current pixels AT THE LAYER'S OWN RESOLUTION, so retouching a 4000px
     photo dropped on a 1000px artboard keeps all four thousand pixels. `xf` ({scale, dx, dy}) maps
     scene coordinates onto that canvas — every tool here works in scene px, so rather than convert
     each dab by hand the transform is baked into the context and the inverse scale is handed back
     through sceneScale() for the few places that need a real pixel radius. Flushing the canvas back
     onto the layer is the caller's job (see Editor#_bindPaintTarget); null restores normal mode. */
  setDirectTarget(layer, cv, xf) {
    const was = this._direct;
    this._direct = layer ? { layer, cv, xf: xf || { scale: 1, dx: 0, dy: 0 } } : null;
    if (layer) {
      this.cv = cv; this.ctx = cv.getContext('2d'); this.layer = layer;
      return;
    }
    // Leaving destructive mode must also drop the borrowed layer/canvas, or ensure() would happily
    // keep painting onto the image we were retouching instead of making a fresh paint layer.
    if (was) { this.layer = null; this.cv = null; this.ctx = null; }
  }

  /* Scene px -> target px. 1 in normal mode; >1 when retouching an image denser than the artboard. */
  sceneScale() { return this._direct ? this._direct.xf.scale : 1; }

  /* Runs `fn` with the context mapped so scene coordinates land on the target's own pixel grid.
     Every drawing primitive below goes through this, so none of them needs to know about it. */
  _inTargetSpace(fn) {
    const ctx = this.ctx, d = this._direct;
    if (!d) return fn(ctx);
    ctx.save();
    ctx.translate(d.xf.dx, d.xf.dy);
    ctx.scale(d.xf.scale, d.xf.scale);
    try { return fn(ctx); } finally { ctx.restore(); }
  }

  /* The engine's Fabric layer, created on first use and re-created if the host deleted it. */
  ensure() {
    // Destructive mode already owns cv/ctx/layer — never swap in a fresh blank canvas under it.
    if (this._direct) {
      if (this.fc.getObjects().includes(this._direct.layer)) return this._direct.layer;
      this._direct = null;   // target deleted mid-session — fall through and make a paint layer
    }
    // Normal mode draws in plain scene px straight onto this.cv, so the layer must sit exactly on
    // the artboard — a paint layer trimmed to its strokes (Editor#_trimPaintLayer) or moved by the
    // user no longer does, and gets a fresh artboard-sized layer instead of misplaced pixels.
    if (this.layer && this.fc.getObjects().includes(this.layer) && this._onArtboard(this.layer)) return this.layer;
    this.cv = document.createElement('canvas');
    this.cv.width = this.W;
    this.cv.height = this.H;
    this.ctx = this.cv.getContext('2d');
    // Created mid-stroke while a drawing tool is active, so it must start out non-selectable/
    // non-evented like every other object under a drawing tool (see Editor#setTool) — otherwise
    // Fabric's own mousedown-on-target logic latches a drag transform onto this brand-new layer
    // at the same point the stroke begins, and the whole layer visibly slides under the paint
    // (worst with clone/heal, whose source-offset math also depends on the layer staying put).
    // Editor#setTool('select') flips it back to selectable/evented like everything else later.
    const img = new this.fabric.Image(this.cv, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: false, evented: false });
    img.set({
      id: 'o' + Math.random().toString(36).slice(2, 7),
      role: 'paint',
      name: 'Paint ' + (this.fc.getObjects().filter(o => o.role === 'paint').length + 1),
    });
    this.layer = img; this.fc.add(img); return img;
  }

  _onArtboard(o) {
    return o.left === 0 && o.top === 0 && (o.scaleX || 1) === 1 && (o.scaleY || 1) === 1 && !(o.angle % 360)
      && !o.cropX && !o.cropY && Math.round(o.width) === this.W && Math.round(o.height) === this.H
      && o._element === this.cv;
  }

  commit() {
    // Destructive mode: the scratch canvas IS the layer's new source, so hand it back through
    // setElement (which also refreshes _originalElement — a raw _element assignment would let a
    // later filter pass revert the layer to its pre-stroke pixels). Skipped when the layer already
    // holds this exact canvas, i.e. a paint layer drawing onto its own backing store.
    if (this._direct && this._direct.layer._element !== this.cv) this._direct.layer.setElement(this.cv);
    if (this.layer) this.layer.dirty = true;
    this.fc.renderAll();
  }

  /* Selection clipping: strokes land only inside `path2d` (evenodd supports inverted selections). */
  setClip(path2d, rule) { this._clip = path2d || null; this._clipRule = rule || 'nonzero'; }

  /* Flatten the whole scene at artboard resolution — clone/heal sample from this, and the
     eyedropper reads it, so both see COMPOSITED pixels, not just the paint layer. */
  captureFlat() {
    this._flat = renderObjectsFlat(this.fc, this.W, this.H, this.fc.getObjects());
  }

  _softStamp(x, y, o, color, comp, alphaMul) {
    const r = Math.max(1, o.size / 2);
    // Clamped shy of 1: Canvas2D's radial gradient degenerates to fully transparent everywhere
    // when the inner/outer radii are exactly equal, so a hardness-1 (fully hard) brush would
    // otherwise paint nothing instead of a crisp hard edge. See mask.js's maskStamp for the same fix.
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = comp || 'source-over';
      ctx.globalAlpha = (o.opacity != null ? o.opacity : 1) * (alphaMul || 1);
      const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
      g.addColorStop(0, rgba(color, 1)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.restore();
    });
  }

  _hardStamp(x, y, o, color) {
    const r = Math.max(0.5, o.size / 2);
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalAlpha = o.opacity != null ? o.opacity : 1; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore();
    });
  }

  /* Clone/heal: copy pixels from the flattened scene at a source offset; heal adds a blur pass so
     the patch melts into its surroundings. Soft edges come from a destination-in radial mask. */
  _cloneStamp(x, y, o, blur) {
    if (!this._flat || !this._off) return;
    const r = Math.max(1, o.size / 2);
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);   // see _softStamp's comment
    // The patch is built at the TARGET's pixel density, not the artboard's: when retouching a photo
    // denser than the artboard, a temp canvas sized in scene px would throw away that extra detail
    // on the way in and then upscale the blur, leaving a visibly soft stamp on a sharp photo.
    const sc = this.sceneScale();
    const size = Math.max(1, Math.ceil(r * 2 * sc));
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = size;
    tempCanvas.height = size;
    const tempCtx = tempCanvas.getContext('2d');
    const sx = x - this._off.x - r;
    const sy = y - this._off.y - r;
    // _flat is always artboard-resolution (captureFlat renders the scene at W×H), so the source
    // rect stays in scene px while the destination fills the denser temp canvas.
    try { tempCtx.drawImage(this._flat, sx, sy, r * 2, r * 2, 0, 0, size, size); } catch (e) { /* out of bounds */ }
    const tr = size / 2;
    tempCtx.globalCompositeOperation = 'destination-in';
    const g = tempCtx.createRadialGradient(tr, tr, tr * hard, tr, tr, tr);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tempCtx.fillStyle = g;
    tempCtx.beginPath();
    tempCtx.arc(tr, tr, tr, 0, 2 * Math.PI);
    tempCtx.fill();
    this._inTargetSpace(ctx => {
      ctx.save();
      if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
      // `filter` is applied in the context's CURRENT (scaled) space, so a scene-px radius scales
      // with the image automatically — the heal blur stays proportional at any target density.
      if (blur) ctx.filter = 'blur(' + Math.max(2, r * 0.35) + 'px)';
      ctx.drawImage(tempCanvas, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    });
  }

  /* Red-eye: detect red-dominant pixels under the brush and pull them to the G/B average. */
  _redEyeCorrection(x, y, o) {
    const ctx = this.ctx;
    // getImageData/putImageData ignore the context transform, so this one works in raw target
    // pixels: the brush centre and radius are converted up front, and the bounds come from the
    // bound canvas rather than the artboard (they differ whenever a denser image is the target).
    const d = this._direct, sc = this.sceneScale();
    const cx = d ? x * sc + d.xf.dx : x, cy = d ? y * sc + d.xf.dy : y;
    const r = Math.max(1, (o.size / 2) * sc);
    const cw = this.cv ? this.cv.width : this.W, ch = this.cv ? this.cv.height : this.H;
    const left = Math.max(0, Math.floor(cx - r));
    const top = Math.max(0, Math.floor(cy - r));
    const width = Math.min(cw - left, Math.ceil(r * 2));
    const height = Math.min(ch - top, Math.ceil(r * 2));
    if (width <= 0 || height <= 0) return;
    let imgData;
    try { imgData = ctx.getImageData(left, top, width, height); } catch (e) { return; }
    const data = imgData.data;
    const brushOpacity = o.opacity != null ? o.opacity : 1;
    let changed = false;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = (py * width + px) << 2;
        const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2], aVal = data[idx + 3];
        if (aVal > 0) {
          const dx = (left + px) - cx, dy = (top + py) - cy;
          const dist = Math.hypot(dx, dy);
          if (dist <= r && rVal > 80 && rVal > gVal * 1.3 && rVal > bVal * 1.3) {
            const falloff = 1 - (dist / r);
            const factor = Math.max(0, Math.min(1, falloff)) * brushOpacity;
            const targetRed = (gVal + bVal) / 2;
            data[idx] = Math.round(rVal * (1 - factor) + targetRed * factor);
            data[idx + 1] = Math.round(gVal * (1 - 0.25 * factor));
            data[idx + 2] = Math.round(bVal * (1 - 0.25 * factor));
            changed = true;
          }
        }
      }
    }
    if (changed) {
      if (this._clip) {
        // The clip path is in SCENE space, so this draw has to go through the same transform as
        // every other primitive — which means the destination rect is expressed in scene px too.
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext('2d').putImageData(imgData, 0, 0);
        this._inTargetSpace(c => {
          c.save();
          c.clip(this._clip, this._clipRule || 'nonzero');
          c.drawImage(tempCanvas, (left - (d ? d.xf.dx : 0)) / sc, (top - (d ? d.xf.dy : 0)) / sc, width / sc, height / sc);
          c.restore();
        });
      } else {
        ctx.putImageData(imgData, left, top);
      }
    }
  }

  /* Interpolate dabs between points so fast strokes stay continuous. */
  _line(tool, from, to, o) {
    const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
    const step = Math.max(1, (o.size || 20) * 0.18);
    const n = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i <= n; i++) { const x = from.x + dx * (i / n), y = from.y + dy * (i / n); this._dab(tool, x, y, o); }
  }

  _dab(tool, x, y, o) {
    switch (tool) {
      case 'brush': this._softStamp(x, y, o, o.color, 'source-over'); break;
      case 'pencil': this._hardStamp(x, y, o, o.color); break;
      case 'eraser': this._softStamp(x, y, o, '#000000', 'destination-out'); break;
      case 'dodge': this._softStamp(x, y, o, '#ffffff', 'color-dodge', 0.25); break;
      case 'burn': this._softStamp(x, y, o, '#000000', 'color-burn', 0.25); break;
      case 'sponge': {
        const spongeColor = (o.spongeMode === 'saturate') ? '#ff0000' : '#808080';
        this._softStamp(x, y, o, spongeColor, 'saturation', 0.7);
        break;
      }
      case 'redeye': this._redEyeCorrection(x, y, o); break;
      case 'clone': this._cloneStamp(x, y, o, false); break;
      case 'heal': this._cloneStamp(x, y, o, true); break;
      default: this._softStamp(x, y, o, o.color, 'source-over');
    }
  }

  /* Pointer protocol: down/move/up in scene coordinates.
     clone/heal: alt-click OR shift-click sets the source ('src-set' is returned so the UI can show
     it) — shift is a second, trackpad-friendly way to move the reference point, and it is free for
     clone/heal because the shift-to-join-strokes behavior below deliberately excludes them;
     other tools: shift-click joins strokes with a straight line, Photoshop-style. */
  down(tool, pt, o) {
    this.ensure();
    this._curPt = pt;
    if (tool === 'clone' || tool === 'heal') {
      if (o.alt || o.shift || !this._src) {
        this._src = { x: pt.x, y: pt.y };
        this._newSourceSet = true;
        return 'src-set';
      }
      if (o.aligned === false) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
      } else if (!this._off || this._newSourceSet) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
        this._newSourceSet = false;
      }
      this.captureFlat();
    }
    if (o.shift && this._lastStrokeEnd && !['clone', 'heal'].includes(tool)) {
      this._line(tool, this._lastStrokeEnd, pt, o);
      this._last = pt;
      this._lastStrokeEnd = pt;
      this.commit();
      return true;
    }
    this._last = pt;
    this._lastStrokeEnd = pt;
    this._dab(tool, pt.x, pt.y, o);
    this.commit();
    return true;
  }

  move(tool, pt, o) {
    if (!this._last) return;
    this._curPt = pt;
    this._line(tool, this._last, pt, o);
    this._last = pt;
    this._lastStrokeEnd = pt;
    this.commit();
  }

  up() {
    this._last = null;
    this._curPt = null;
  }

  /* Fill the (clipped) artboard with a colour — the bucket tool over a selection.
     ensure() MUST run before drawing: it swaps in a fresh canvas when no paint layer exists, so
     drawing first meant the pixels landed on a canvas that was about to be thrown away. down()
     always had the right order; fill/gradient did not — caught by the demo screenshot session. */
  fill(color) {
    this.ensure();
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = color;
      ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
    });
    this.commit();
  }

  /* Fills the (clipped) paint layer with a gradient from (x1,y1) to (x2,y2) — Photoshop's
     Gradient tool. `stops` is [{offset: 0..1, color}, ...] (2+ stops; unsorted input is sorted by
     offset). `type` is 'linear' (the two points are the axis) or 'radial' (x1,y1 is the center,
     the distance to x2,y2 is the radius — Fabric/Canvas2D's radial gradient convention).
     Called on every mousemove while dragging for a live preview, and once more on mouseup to
     commit — repeated calls simply overwrite the same rect, so no extra bookkeeping is needed for
     "redo this preview frame" the way stroke-based tools require. */
  paintGradient(x1, y1, x2, y2, stops, type = 'linear') {
    this.ensure();
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.fillStyle = buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type);
      ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
    });
    this.commit();
  }

  /* Eyedropper: composited colour at a point, as hex. */
  sample(pt) {
    this.captureFlat();
    try {
      const d = this._flat.getContext('2d').getImageData(Math.round(pt.x), Math.round(pt.y), 1, 1).data;
      return toHex(d[0], d[1], d[2]);
    } catch (e) { return null; }
  }

  /* After undo/redo reloads the scene from JSON, paint layers come back as <img> elements —
     re-wrap them as canvases so the engine can keep drawing on them. */
  adopt() {
    const paintLayers = this.fc.getObjects().filter(x => x.role === 'paint');
    paintLayers.forEach(o => {
      if (o && o._element && !(o._element instanceof HTMLCanvasElement)) {
        // At the image's OWN size: a paint layer trimmed to its strokes isn't artboard-sized, and
        // stretching it to W×H would smear it over the whole artboard after every undo.
        const cv = document.createElement('canvas');
        cv.width = o._element.naturalWidth || o._element.width || this.W;
        cv.height = o._element.naturalHeight || o._element.height || this.H;
        const ctx = cv.getContext('2d');
        try { ctx.drawImage(o._element, 0, 0, cv.width, cv.height); } catch (e) { console.error(e); }
        o._element = cv;
        o.dirty = true;
      }
    });
    // Layer masks: only the MaskFilter instance itself gets its maskCanvas rehydrated by Fabric's
    // own filter fromObject (see mask.js) — o.maskCanvas is this engine/editor's own bookkeeping
    // pointer to that same canvas (so addMask/removeMask/_refreshMaskFilter don't have to search
    // o.filters every time), and needs re-linking here after every restore.
    this.fc.getObjects().forEach(o => {
      if (o.type !== 'image') return;   // vector layers keep their own mask (see mask.js attachVectorMask)
      const f = (o.filters || []).find(x => x.type === 'MaskFilter');
      o.maskCanvas = f ? f.maskCanvas : null;
    });
    let activePaint = this.fc.getActiveObject();
    if (!activePaint || activePaint.role !== 'paint') activePaint = paintLayers[0];
    if (activePaint) {
      this.layer = activePaint;
      this.cv = activePaint._element;
      this.ctx = activePaint._element.getContext('2d');
    } else {
      // undo removed every paint layer: drop the orphaned canvas too, or the next fill/gradient
      // would draw into pixels that no fabric layer displays
      this.layer = null;
      this.cv = document.createElement('canvas');
      this.cv.width = this.W; this.cv.height = this.H;
      this.ctx = this.cv.getContext('2d');
    }
  }
}
