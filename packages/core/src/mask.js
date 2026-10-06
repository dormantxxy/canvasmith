/* Paintable, non-destructive layer masks. Image/paint layers use the MaskFilter below; vector
   layers (shapes, text, groups) are masked at draw time instead — see the section at the end.

   A mask is a full-artboard-resolution grayscale canvas stored on the fabric object as
   `o.maskCanvas` (white = fully visible, black = fully hidden, gray = partial) plus
   `o.maskEnabled` (bool — a disabled mask is kept but has no visual effect, Photoshop's
   shift-click-thumbnail toggle). It's applied through Fabric's own filter pipeline as a custom
   `MaskFilter` pushed onto `o.filters` alongside the brightness/contrast/etc. filters
   Editor#setImageFilters already manages — applyFilters() re-runs the whole chain from the
   pristine source on every call, so a mask edit is just "repaint maskCanvas, call
   o.applyFilters() again", the same non-destructive contract adjustment filters already have.

   MaskFilter itself needs `fabric` injected (it's built as a fabric.util.createClass subclass,
   which doesn't exist until a real fabric is loaded), so this module exports a factory instead of
   a class — call makeMaskFilterClass(fabric) once and reuse the constructor it returns. */

let _MaskFilterClass = null;
let _builtForFabric = null;

export function makeMaskFilterClass(fabric) {
  if (_MaskFilterClass && _builtForFabric === fabric) return _MaskFilterClass;
  _MaskFilterClass = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'MaskFilter',
    maskCanvas: null,
    /* Optional edge-colour fix from an offline background removal (Editor#removeBackground):
       RGBA at any resolution, mapped over the layer like the mask; where its alpha > 0 the pixel's
       colour is swapped for the stored decontaminated one (the old backdrop's tint taken out of
       semi-transparent edge pixels). Kept beside the pixels, never written into them, so removing
       the mask removes the fix too. */
    decontamCanvas: null,
    mainParameter: 'maskCanvas',

    /* Reads maskCanvas's grayscale value at each source pixel (nearest-neighbor sampled up from
       artboard resolution to whatever resolution Fabric is filtering at — its own internal
       scaling, not something this filter needs to know about beyond width/height) and multiplies
       the pixel's alpha by it. No maskCanvas (or a zero-size one) is a no-op — same "adding a
       mask a host UI never painted into shouldn't blow anything up" contract as an empty selection
       elsewhere in this codebase. */
    applyTo2d(options) {
      const { imageData } = options;
      const mc = this.maskCanvas;
      if (!mc || !mc.width || !mc.height) return;
      const data = imageData.data, w = imageData.width, h = imageData.height;
      const mctx = mc.getContext('2d');
      let mdata;
      try { mdata = mctx.getImageData(0, 0, mc.width, mc.height).data; } catch (e) { return; }
      const sx = mc.width / w, sy = mc.height / h;
      const dc = this.decontamCanvas;
      let ddata = null, dsx = 0, dsy = 0;
      if (dc && dc.width && dc.height) {
        try { ddata = dc.getContext('2d').getImageData(0, 0, dc.width, dc.height).data; dsx = dc.width / w; dsy = dc.height / h; } catch (e) { ddata = null; }
      }
      for (let y = 0; y < h; y++) {
        const my = Math.min(mc.height - 1, Math.floor(y * sy));
        for (let x = 0; x < w; x++) {
          const mx = Math.min(mc.width - 1, Math.floor(x * sx));
          const mi = (my * mc.width + mx) * 4;
          // Grayscale value read off the red channel (the mask is painted achromatically, so
          // R/G/B are equal) scaled by the mask pixel's own alpha — an untouched (transparent)
          // area of the mask canvas defaults to fully-visible (mask value 1), matching a
          // freshly-added mask that hasn't been painted on yet.
          const maskAlpha = mdata[mi + 3] / 255;
          const gray = mdata[mi] / 255;
          const value = maskAlpha > 0 ? gray : 1;
          const i = (y * w + x) * 4;
          data[i + 3] = Math.round(data[i + 3] * value);
          if (ddata && value > 0 && value < 1) {
            const di = (Math.min(dc.height - 1, Math.floor(y * dsy)) * dc.width + Math.min(dc.width - 1, Math.floor(x * dsx))) * 4;
            const da = ddata[di + 3] / 255;
            if (da > 0) { data[i] += (ddata[di] - data[i]) * da; data[i + 1] += (ddata[di + 1] - data[i + 1]) * da; data[i + 2] += (ddata[di + 2] - data[i + 2]) * da; }
          }
        }
      }
    },

    isNeutralState() { return !this.maskCanvas; },

    /* maskCanvas is a raw HTMLCanvasElement — JSON.stringify can't touch it, so toObject swaps it
       for a dataURL (mirrors how paint-layer canvases already round-trip through <img> src on
       restore) and fromObject decodes it back. Fabric's own filter fromObject supports this
       asynchronously via its callback param (see BaseFilter.fromObject) — the filter object
       itself is returned/constructed immediately with maskCanvas still null, then patched in and
       callback(filter) fires again once decoding finishes, which is what makes
       Editor#loadJSON/restore's overall "wait for loadFromJSON's callback" flow correctly wait for
       mask pixels too (io.js's restore() defers engine.adopt()/onDone to fc.loadFromJSON's own
       callback, and Fabric doesn't call ITS callback until every object — filters included — is
       through its own fromObject). */
    toObject() {
      return { type: this.type, maskDataURL: this.maskCanvas ? this.maskCanvas.toDataURL('image/png') : null,
        ...(this.decontamCanvas ? { decontamDataURL: this.decontamCanvas.toDataURL('image/png') } : {}) };
    },
  });
  _MaskFilterClass.fromObject = function (object, callback) {
    const filter = new _MaskFilterClass({});
    // mask + optional decontam canvas decode independently; the callback fires once both are in
    const jobs = [['maskDataURL', 'maskCanvas'], ['decontamDataURL', 'decontamCanvas']].filter(([k]) => object[k]);
    if (!jobs.length) { callback && callback(filter); return filter; }
    let left = jobs.length;
    const done = () => { if (--left === 0) callback && callback(filter); };
    jobs.forEach(([k, prop]) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        filter[prop] = c;
        done();
      };
      img.onerror = done;
      img.src = object[k];
    });
    return filter;
  };
  // Registered under fabric's own filters namespace so its generic enlivenObjects() dispatch
  // (used when restoring a whole scene from JSON — see io.js's restore()) can find this class by
  // its serialized `type: 'MaskFilter'` string, the same way every built-in filter is registered.
  fabric.Image.filters.MaskFilter = _MaskFilterClass;
  _builtForFabric = fabric;
  return _MaskFilterClass;
}

/* Fresh artboard-resolution mask canvas, fully transparent (== fully visible, per applyTo2d's
   "untouched = visible" default) so adding a mask never hides anything until the user paints it. */
export function createMaskCanvas(W, H) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W));
  c.height = Math.max(1, Math.round(H));
  return c;
}

/* Soft round brush stamp onto a mask canvas — deliberately just brush+eraser (paint
   black/white/gray to hide/reveal, Shift-drag for a straight line handled by the caller like the
   main PaintEngine does), not the full paint-tool set: dodge/burn/clone/heal/etc. have no
   coherent meaning painting onto a grayscale visibility channel. `color` is white/black/gray hex;
   `erase` resets that stamp's area back to "untouched" (transparent) instead of painting black,
   so erasing a mask stroke truly undoes it rather than painting a second, opposite stroke on top. */
export function maskStamp(ctx, x, y, o, erase) {
  const r = Math.max(1, o.size / 2);
  // Canvas2D's own radial gradient degenerates to fully transparent everywhere when the inner and
  // outer radii are exactly equal — hardness 1 (a fully hard, no-falloff brush) would otherwise
  // paint nothing at all instead of a crisp hard-edged disc. Clamping just shy of 1 keeps an
  // imperceptibly thin falloff band instead, which reads as a hard edge but never degenerates.
  const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);
  ctx.save();
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
  const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
  const c = o.color || '#ffffff';
  g.addColorStop(0, erase ? 'rgba(0,0,0,1)' : hexToOpaqueRgba(c, 1));
  g.addColorStop(1, erase ? 'rgba(0,0,0,0)' : hexToOpaqueRgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function hexToOpaqueRgba(hex, a) {
  const c = (hex || '#ffffff').replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  const r = parseInt(n.slice(0, 2), 16) || 0, g = parseInt(n.slice(2, 4), 16) || 0, b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

/* Straight line between two points (Shift-drag), same radial-stamp density approach the main
   engine's _line() uses — stamp spacing scaled to brush size so a fast drag doesn't leave gaps. */
export function maskLine(ctx, from, to, o, erase) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, (o.size || 20) * 0.2);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    maskStamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, o, erase);
  }
}

/* Inverts a mask canvas in place (Photoshop's Cmd/Ctrl+I on a mask): white<->black, and any
   untouched (fully transparent) area — which applyTo2d treats as "fully visible" per its own
   "untouched = visible" default — is turned into an explicit opaque black stamp, i.e. "fully
   hidden", since there is no such thing as "untouched" once you've deliberately inverted the
   whole canvas. Mutates the canvas directly; the caller (Editor#invertMask) is responsible for
   re-running applyFilters()/commit() the same way every other mask edit does. */
export function invertMaskCanvas(mc) {
  if (!mc || !mc.width || !mc.height) return;
  const ctx = mc.getContext('2d');
  const imgd = ctx.getImageData(0, 0, mc.width, mc.height);
  const data = imgd.data;
  for (let i = 0; i < data.length; i += 4) {
    const wasUntouched = data[i + 3] === 0;
    data[i] = wasUntouched ? 0 : 255 - data[i];
    data[i + 1] = data[i];
    data[i + 2] = data[i];
    data[i + 3] = 255;
  }
  ctx.putImageData(imgd, 0, 0);
}

/* Serialize a mask canvas to a dataURL for history/save (mirrors how paint layers round-trip
   through <img> src on restore) — null if the layer has no mask. */
export function serializeMask(o) {
  if (!o.maskCanvas) return null;
  try { return { dataURL: o.maskCanvas.toDataURL('image/png'), enabled: o.maskEnabled !== false }; }
  catch (e) { return null; }
}

/* Rehydrate a mask canvas from serializeMask()'s output — resolves once the mask image has
   loaded (drawn into a fresh same-size canvas), or immediately with null for no mask / a failed
   decode, so a caller can always `await` this uniformly. */
export function deserializeMask(spec, W, H) {
  if (!spec || !spec.dataURL) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = createMaskCanvas(W, H);
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      resolve({ canvas: c, enabled: spec.enabled !== false });
    };
    img.onerror = () => resolve(null);
    img.src = spec.dataURL;
  });
}

/* ── Vector-layer masks (shapes, paths, text, groups) ─────────────────────────────────────────
   Image filters only run on fabric.Image, so a vector layer's mask is applied at draw time
   instead: the same `o.maskCanvas` / `o.maskEnabled` fields, but the canvas covers the layer's
   OWN local box (it moves/scales/rotates with the layer, like a linked Photoshop mask) and is
   composited `destination-in` onto the layer's private render cache right after Fabric draws its
   clipPath. The layer itself stays a fully editable vector. Attached per object (see
   attachVectorMask) rather than by patching fabric.Object.prototype, same rule as the themed
   handles in editor.js. */

export const isVectorMaskable = (o) => !!o && o.type !== 'image' && o.type !== 'activeSelection'
  && o.role !== 'bg' && o.role !== 'adjustment';

// Local (unscaled, stroke-inclusive) size of the layer — the box its mask canvas maps onto.
function localBox(o) {
  const d = o._getNonTransformedDimensions();
  return { w: Math.max(1, d.x), h: Math.max(1, d.y) };
}

/* New mask for a vector layer, at roughly 1:1 with the layer's on-artboard size. Transparent =
   untouched = fully visible, same convention as createMaskCanvas. */
export function createVectorMaskCanvas(o) {
  const { w, h } = localBox(o);
  const s = Math.max(Math.abs(o.scaleX || 1), Math.abs(o.scaleY || 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.min(4096, Math.round(w * s)));
  c.height = Math.max(1, Math.min(4096, Math.round(h * s)));
  return c;
}

/* Scene point + brush size -> the same in the vector mask's pixel space. */
export function vectorMaskPoint(fabric, o, pt, size) {
  const mc = o.maskCanvas, { w, h } = localBox(o);
  const inv = fabric.util.invertTransform(o.calcTransformMatrix());
  const l = fabric.util.transformPoint(new fabric.Point(pt.x, pt.y), inv);
  const kx = mc.width / w, ky = mc.height / h;
  const sx = Math.abs(o.scaleX || 1), sy = Math.abs(o.scaleY || 1);
  return { x: (l.x + w / 2) * kx, y: (l.y + h / 2) * ky, size: size * ((kx / sx + ky / sy) / 2) };
}

/* Mask pixels changed (or were enabled/disabled): drop the cached alpha + encoding, re-render. */
export function touchVectorMask(o) {
  o._vmaskVer = (o._vmaskVer || 0) + 1;
  o.dirty = true;
}

// White-backed coverage: an untouched (transparent) pixel is fully visible, and a soft/partial
// black stroke hides proportionally to its alpha — visible = 1 - a * (1 - gray).
function alphaCanvas(o) {
  if (o._vmaskAlpha && o._vmaskAlphaVer === o._vmaskVer) return o._vmaskAlpha;
  const mc = o.maskCanvas;
  const c = document.createElement('canvas'); c.width = mc.width; c.height = mc.height;
  const ctx = c.getContext('2d');
  let src;
  try { src = mc.getContext('2d').getImageData(0, 0, mc.width, mc.height); } catch (e) { return null; }
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255, gray = d[i] / 255;
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round(255 * (1 - a * (1 - gray)));
  }
  ctx.putImageData(src, 0, 0);
  o._vmaskAlpha = c; o._vmaskAlphaVer = o._vmaskVer;
  return c;
}

/* Decoded masks by dataURL, so restoring a snapshot (undo/redo, duplicate) re-links its mask
   synchronously instead of flashing the layer unmasked for a frame while a PNG decodes. */
const _decoded = new Map();
function remember(url, canvas) {
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  _decoded.delete(url); _decoded.set(url, copy);
  while (_decoded.size > 32) _decoded.delete(_decoded.keys().next().value);
}
function fromCache(url) {
  const c = _decoded.get(url); if (!c) return null;
  const out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

/* Gives one object vector-mask rendering + serialization, and re-links a mask it was restored
   with (`o.vmask`, the dataURL its toObject wrote). Idempotent. */
export function attachVectorMask(o) {
  if (!isVectorMaskable(o) || o._vmaskAttached) return;
  o._vmaskAttached = true;
  const proto = Object.getPrototypeOf(o);
  o.needsItsOwnCache = function () {
    // destination-in must land on the layer's private cache, never the shared canvas
    return (this.maskCanvas && this.maskEnabled !== false) || proto.needsItsOwnCache.call(this);
  };
  o._drawClipPath = function (ctx, clipPath) {
    proto._drawClipPath.call(this, ctx, clipPath);
    if (!this.maskCanvas || this.maskEnabled === false || ctx !== this._cacheContext) return;
    const a = alphaCanvas(this); if (!a) return;
    const { w, h } = localBox(this);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(a, -w / 2, -h / 2, w, h);
    ctx.restore();
  };
  o.toObject = function (props) {
    const obj = proto.toObject.call(this, props);
    if (this.maskCanvas) {
      if (this._vmaskURLVer !== this._vmaskVer || !this._vmaskURL) {
        try { this._vmaskURL = this.maskCanvas.toDataURL('image/png'); remember(this._vmaskURL, this.maskCanvas); } catch (e) { this._vmaskURL = null; }
        this._vmaskURLVer = this._vmaskVer;
      }
      if (this._vmaskURL) obj.vmask = this._vmaskURL;
    } else if (this.vmask) obj.vmask = this.vmask;   // restored but still decoding
    return obj;
  };
  if (o.vmask && !o.maskCanvas) {
    const url = o.vmask, sync = fromCache(url);
    const link = (c) => { o.maskCanvas = c; o.vmask = null; touchVectorMask(o); };
    if (sync) link(sync);
    else {
      const img = new Image();
      img.onload = () => {
        if (o.maskCanvas || o.vmask !== url) return;
        const c = document.createElement('canvas'); c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        remember(url, c); link(c);
        if (o.canvas) o.canvas.requestRenderAll();
      };
      img.src = url;
    }
  }
}
