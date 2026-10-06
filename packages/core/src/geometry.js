/* Lens-style geometry corrections for image layers — straighten (rotate + auto-zoom so no empty
   corners ever show), keystone (vertical/horizontal perspective sliders) and free 4-corner
   perspective — as one resampling pass (applyGeometry) plus a Fabric filter wrapper
   (makeGeometryFilterClass).

   It's a FILTER, not a Fabric transform, on purpose: the output keeps the source's exact width ×
   height, so the layer's frame on the artboard doesn't move, per-image crop (cropX/cropY, applied
   after filters) keeps working, and it's non-destructive — undo, save/restore and "reset" all go
   through the same `o.filters` serialisation the tone filter and masks already use. Editor puts it
   FIRST in the chain (before the mask), so a mask painted afterwards stays under the brush.

   Mapping, output pixel → source pixel (inverse mapping, bilinear sampling):
     1. straighten: undo a rotation by `angle` about the centre, scaled by straightenScale() — the
        smallest zoom at which the rotated frame still covers the whole output
     2. perspective: a projective map of the unit square onto `quad` (normalised source coords,
        corners TL, TR, BR, BL). With no explicit quad, keystoneQuad() builds one from the
        vertical/horizontal sliders; it always lies inside the source, so keystone never exposes
        empty space either. A user quad may reach outside the image — those samples come out
        transparent rather than smeared.

   Human units: angle in degrees (-45..45); vertical / horizontal -100..100 (0 = none);
   quad null or [[x, y] × 4] in 0..1. */

export const GEOMETRY_DEFAULTS = { angle: 0, vertical: 0, horizontal: 0, quad: null };
export const GEOMETRY_KEYS = Object.keys(GEOMETRY_DEFAULTS);
export const UNIT_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
const KEYSTONE_MAX = 0.3; // a full ±100 keystone slider pulls an edge in by 30% of the frame

const quadIsIdentity = (q) => !q || q.every(([x, y], i) => Math.abs(x - UNIT_QUAD[i][0]) < 1e-6 && Math.abs(y - UNIT_QUAD[i][1]) < 1e-6);
export function isGeometryNeutral(p = {}) {
  return !p.angle && !p.vertical && !p.horizontal && quadIsIdentity(p.quad);
}

/* Zoom that keeps a w×h frame fully covered after rotating the content by `angleDeg`: the frame's
   corner (w/2, h/2), expressed in the rotated axes, must stay inside the zoomed (k·w)×(k·h) image.
   That gives k ≥ cos θ + (h/w)·sin θ and k ≥ cos θ + (w/h)·sin θ. */
export function straightenScale(angleDeg, w, h) {
  const t = Math.abs(angleDeg) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return c + Math.max(h / w, w / h) * s;
}

/* Keystone sliders → source quad (TL, TR, BR, BL). Positive vertical pulls the TOP edge in (in the
   source), so the output stretches the top — the fix for verticals that converge upward, the usual
   "looking up at a building" case. Positive horizontal does the same for the LEFT edge. */
export function keystoneQuad(vertical = 0, horizontal = 0) {
  const av = Math.abs(vertical) / 100 * KEYSTONE_MAX / 2, ah = Math.abs(horizontal) / 100 * KEYSTONE_MAX / 2;
  const top = vertical > 0 ? av : 0, bottom = vertical < 0 ? av : 0;
  const left = horizontal > 0 ? ah : 0, right = horizontal < 0 ? ah : 0;
  return [[top, left], [1 - top, right], [1 - bottom, 1 - right], [bottom, 1 - left]];
}

/* Projective map taking the unit square's corners (0,0),(1,0),(1,1),(0,1) onto quad[0..3]
   (Heckbert's closed form). Returns [a, b, c, d, e, f, g, h]:
     x = (a·u + b·v + c) / (g·u + h·v + 1),  y = (d·u + e·v + f) / (g·u + h·v + 1). */
export function squareToQuad(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;   // degenerate (three corners collinear)
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}
export function mapHomography(H, u, v) {
  const w = H[6] * u + H[7] * v + 1;
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

/* Where each output corner samples from, in normalised source coords — lets a UI draw the
   correction's footprint, and lets tests check the mapping without pixels. */
export function geometrySourcePoint(p, u, v, w = 1, h = 1) {
  const g = { ...GEOMETRY_DEFAULTS, ...p };
  let x = u * w, y = v * h;
  if (g.angle) {
    const t = g.angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), k = straightenScale(g.angle, w, h);
    const dx = x - w / 2, dy = y - h / 2;
    x = (dx * c + dy * s) / k + w / 2;
    y = (-dx * s + dy * c) / k + h / 2;
  }
  const quad = quadIsIdentity(g.quad) ? ((g.vertical || g.horizontal) ? keystoneQuad(g.vertical, g.horizontal) : null) : g.quad;
  if (!quad) return [x / w, y / h];
  const H = squareToQuad(quad);
  return H ? mapHomography(H, x / w, y / h) : [x / w, y / h];
}

/* Resamples RGBA `data` (w×h) in place. Returns data. */
export function applyGeometry(data, w, h, params = {}) {
  const g = { ...GEOMETRY_DEFAULTS, ...params };
  if (isGeometryNeutral(g) || !w || !h) return data;
  const src = new Uint8ClampedArray(data);
  const quad = quadIsIdentity(g.quad) ? ((g.vertical || g.horizontal) ? keystoneQuad(g.vertical, g.horizontal) : null) : g.quad;
  const H = quad ? squareToQuad(quad) : null;
  const rot = !!g.angle;
  const t = g.angle * Math.PI / 180, c = rot ? Math.cos(t) : 1, sn = rot ? Math.sin(t) : 0, k = rot ? straightenScale(g.angle, w, h) : 1;
  const cx = w / 2, cy = h / 2, maxX = w - 1, maxY = h - 1;
  // Everything before the perspective divide is AFFINE in the output pixel, so it's stepped
  // incrementally along each row instead of recomputed: after rotation x' = x0 + px·ax (same for
  // y'), and the homography's numerators / denominator are linear in x', y' too. One divide per
  // pixel, no trig, no matrix multiply — ~3x faster than the direct form, which matters because
  // Fabric re-runs the whole filter chain on every live slider tick.
  const ax = c / k, ay = -sn / k;                  // d(x', y') / d(px)
  // homography over pixel coords: x = (A·x' + B·y' + C) / (G·x' + Hh·y' + 1), in source pixels
  let A = 1, B = 0, C = 0, D = 0, E = 1, F = 0, G = 0, Hh = 0;
  if (H) {
    A = H[0]; B = H[1] * w / h; C = H[2] * w; D = H[3] * h / w; E = H[4]; F = H[5] * h; G = H[6] / w; Hh = H[7] / h;
  }
  for (let py = 0; py < h; py++) {
    // pixel centres (+0.5), so a neutral mapping lands exactly on source pixels
    const dx0 = 0.5 - cx, dy = py + 0.5 - cy;
    let xr = (dx0 * c + dy * sn) / k + cx, yr = (-dx0 * sn + dy * c) / k + cy;
    let nx = A * xr + B * yr + C, ny = D * xr + E * yr + F, dd = G * xr + Hh * yr + 1;
    const dnx = A * ax + B * ay, dny = D * ax + E * ay, ddd = G * ax + Hh * ay;
    let o = py * w * 4;
    for (let px = 0; px < w; px++, o += 4, nx += dnx, ny += dny, dd += ddd) {
      let x = nx / dd - 0.5, y = ny / dd - 0.5;
      // beyond half a pixel outside the source is genuinely off-image (only a user quad can reach
      // there) → transparent; within it, clamp so float error can't fringe the edges
      if (x < -0.5 || y < -0.5 || x > maxX + 0.5 || y > maxY + 0.5) { data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0; continue; }
      x = x < 0 ? 0 : x > maxX ? maxX : x;
      y = y < 0 ? 0 : y > maxY ? maxY : y;
      const x0 = x | 0, y0 = y | 0, x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      data[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      data[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      data[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      data[o + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
    }
  }
  return data;
}

/* ── Fabric filter wrapper — same factory/registration contract as tone.js / mask.js ───────── */
let _GeometryFilterClass = null, _builtForFabric = null;
export function makeGeometryFilterClass(fabric) {
  if (_GeometryFilterClass && _builtForFabric === fabric) return _GeometryFilterClass;
  _GeometryFilterClass = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'Geometry',
    mainParameter: 'angle',
    ...GEOMETRY_DEFAULTS,
    applyTo2d(options) { const d = options.imageData; applyGeometry(d.data, d.width, d.height, this.toParams()); },
    toParams() { const o = {}; GEOMETRY_KEYS.forEach(k => { o[k] = this[k]; }); return o; },
    isNeutralState() { return isGeometryNeutral(this.toParams()); },
    toObject() { return { type: this.type, ...JSON.parse(JSON.stringify(this.toParams())) }; },
  });
  _GeometryFilterClass.fromObject = fabric.Image.filters.BaseFilter.fromObject;
  fabric.Image.filters.Geometry = _GeometryFilterClass;
  _builtForFabric = fabric;
  return _GeometryFilterClass;
}

/* The Geometry panel's sliders, shared by both shells (same contract as color.js ADJUST_CONTROLS). */
export const GEOMETRY_CONTROLS = [
  { key: 'angle', label: 'Straighten', icon: 'straighten', min: -45, max: 45, step: 0.1 },
  { key: 'vertical', label: 'Vertical', icon: 'keystoneV', min: -100, max: 100, step: 1 },
  { key: 'horizontal', label: 'Horizontal', icon: 'keystoneH', min: -100, max: 100, step: 1 },
];
export function formatGeometryValue(key, v) {
  if (key === 'angle') return (v > 0 ? '+' : '') + (+v).toFixed(1) + '°';
  return (v > 0 ? '+' : '') + Math.round(v);
}
