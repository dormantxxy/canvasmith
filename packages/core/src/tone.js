/* Photographic tone & colour adjustments — exposure, highlights/shadows, white balance
   (temperature/tint), tone curves and per-band HSL — as ONE pure per-pixel pass (applyTone) plus a
   thin Fabric filter wrapper (makeToneFilterClass) so it slots into the same non-destructive
   `o.filters` chain as the built-in brightness/contrast/etc. filters (see color.js's
   fxToFilterSpecs and Editor#setImageFilters) and into adjustment layers for free.

   Why one filter rather than seven: every stage is a cheap lookup or a few multiplies, but a
   separate Fabric filter per stage would mean seven full passes over a 1600px image on every
   slider tick. Stage order follows the usual raw-developer order so results behave the way
   photographers expect:
     1. white balance + exposure   per-channel gain in LINEAR light (a real exposure change, not
                                   a brightness offset), folded into three 256-entry LUTs
     2. highlights / shadows       luminance-dependent gain from a 256-entry LUT, applied as a
                                   ratio to all three channels so hue/saturation are preserved
     3. curves                     master RGB curve, then per-channel R/G/B curves (monotone cubic
                                   through the control points, so no overshoot/ringing)
     4. HSL                        eight hue bands, each with its own hue shift / saturation /
                                   luminance, smoothly interpolated between neighbouring bands

   Human units (all 0 = unchanged):
     exposure     EV stops, -3..3           temperature  -100 (cool/blue) .. 100 (warm/amber)
     highlights   -100 (recover) .. 100     tint         -100 (green) .. 100 (magenta)
     shadows      -100 (crush) .. 100 (lift)
     curves       null, or { rgb, r, g, b } — each an array of [x, y] points in 0..255
     hsl          null, or { red: { h, s, l }, orange: {...}, ... } — each -100..100 */

export const TONE_DEFAULTS = { exposure: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, curves: null, hsl: null };
export const TONE_KEYS = Object.keys(TONE_DEFAULTS);

/* Band centres in degrees — Lightroom's eight HSL bands. Uneven spacing is deliberate: the warm
   end of the wheel (skin, foliage, sky) needs finer control than the cyan/blue stretch. */
export const HSL_BANDS = [
  ['red', 0], ['orange', 30], ['yellow', 60], ['green', 120],
  ['aqua', 180], ['blue', 240], ['purple', 270], ['magenta', 300],
];
export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];
export const CURVE_IDENTITY = [[0, 0], [255, 255]];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// sRGB <-> linear. toLinear is a 256-entry table (inputs are always bytes); fromLinear is only
// ever evaluated 256x per LUT build, so it stays a plain function.
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fromLinear = (l) => { l = clamp01(l); return 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055); };

/* ── curves ────────────────────────────────────────────────────────────────────────────────── */
const curveIsIdentity = (pts) => !pts || !pts.length || pts.every(([x, y]) => x === y);

/* 256-entry LUT through `points` ([x, y] in 0..255) using monotone cubic Hermite interpolation
   (Fritsch–Carlson): smooth like Photoshop's curves, but never overshoots between points, so a
   steep S-curve can't ring into clipped bands. Points are sorted and de-duplicated by x; beyond
   the first/last point the curve is flat (a raised black point stays raised all the way down). */
export function buildCurveLut(points) {
  const lut = new Float32Array(256);
  const pts = [...(points && points.length ? points : CURVE_IDENTITY)]
    .map(([x, y]) => [Math.max(0, Math.min(255, +x)), Math.max(0, Math.min(255, +y))])
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0]);
  const n = pts.length;
  if (n === 1) { lut.fill(pts[0][1]); return lut; }
  const dx = [], sl = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; sl[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  const m = new Array(n);
  m[0] = sl[0]; m[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / sl[i], b = m[i + 1] / sl[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0][0]) { lut[x] = pts[0][1]; continue; }
    if (x >= pts[n - 1][0]) { lut[x] = pts[n - 1][1]; continue; }
    while (x > pts[seg + 1][0]) seg++;
    const h = dx[seg], t = (x - pts[seg][0]) / h, t2 = t * t, t3 = t2 * t;
    lut[x] = (2 * t3 - 3 * t2 + 1) * pts[seg][1] + (t3 - 2 * t2 + t) * h * m[seg]
      + (-2 * t3 + 3 * t2) * pts[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
  }
  for (let x = 0; x < 256; x++) lut[x] = Math.max(0, Math.min(255, lut[x]));
  return lut;
}

/* ── highlights / shadows tone LUT ─────────────────────────────────────────────────────────── */
/* Maps luminance (0..1, by byte index) to its new luminance. Each control pushes its tonal range
   toward white (positive) or black (negative) through a broad smoothstep mask, so the mid-tones
   move a little and the opposite end not at all. Strength 0.4 keeps each curve monotonic across
   the whole slider range (checked analytically: the worst-case slope stays > 0.3), and the running
   max below guarantees it even when both controls are pushed at once. */
const TONE_STRENGTH = 0.4;
function buildToneLut(highlights, shadows) {
  const lut = new Float32Array(256);
  const h = highlights / 100, s = shadows / 100;
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const L = i / 255;
    const mh = smoothstep(0.25, 1, L), ms = 1 - smoothstep(0, 0.75, L);
    let out = L;
    out += TONE_STRENGTH * h * mh * (h > 0 ? 1 - L : L);
    out += TONE_STRENGTH * s * ms * (s > 0 ? 1 - L : L);
    out = Math.max(prev, clamp01(out));
    lut[i] = prev = out;
  }
  return lut;
}

/* ── white balance ─────────────────────────────────────────────────────────────────────────── */
/* Per-channel linear-light gains. Temperature trades red against blue, tint trades green against
   magenta (red+blue); the result is renormalised to unit luminance so white balance shifts colour
   without also acting as a hidden exposure control. */
export function whiteBalanceGains(temperature = 0, tint = 0) {
  const k = temperature / 100, t = tint / 100;
  let r = 1 + 0.3 * k, g = 1 - 0.25 * t, b = 1 - 0.3 * k;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / lum, g / lum, b / lum];
}

/* ── HSL ───────────────────────────────────────────────────────────────────────────────────── */
const hslBandIsNeutral = (v) => !v || (!v.h && !v.s && !v.l);
const hslIsNeutral = (hsl) => !hsl || HSL_BANDS.every(([name]) => hslBandIsNeutral(hsl[name]));

/* 360-entry tables of the interpolated per-hue {dh, ds, dl} (as -1..1 fractions), so the per-pixel
   loop is one lookup rather than a band search. Between two neighbouring band centres the weight
   crossfades with a smoothstep, so dragging one band never leaves a hard seam in a gradient. */
function buildHslTables(hsl) {
  const dh = new Float32Array(360), ds = new Float32Array(360), dl = new Float32Array(360);
  const n = HSL_BANDS.length;
  for (let deg = 0; deg < 360; deg++) {
    let i = n - 1;
    for (let j = 0; j < n; j++) if (HSL_BANDS[j][1] <= deg) i = j;
    const [nameA, cA] = HSL_BANDS[i], [nameB, cBraw] = HSL_BANDS[(i + 1) % n];
    const cB = cBraw <= cA ? cBraw + 360 : cBraw;
    const w = smoothstep(0, 1, (deg - cA) / (cB - cA));
    const a = hsl[nameA] || {}, b = hsl[nameB] || {};
    dh[deg] = ((a.h || 0) * (1 - w) + (b.h || 0) * w) / 100;
    ds[deg] = ((a.s || 0) * (1 - w) + (b.s || 0) * w) / 100;
    dl[deg] = ((a.l || 0) * (1 - w) + (b.l || 0) * w) / 100;
  }
  return { dh, ds, dl };
}
const HSL_HUE_RANGE = 30; // a full ±100 hue slider rotates its band by ±30°, same as Lightroom
const HSL_LUM_STRENGTH = 0.35; // a full ±100 luminance slider moves a mid-tone by ±0.35 lightness

function hue2rgb(p, q, t) {
  if (t < 0) t += 1; else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/* ── neutral checks ────────────────────────────────────────────────────────────────────────── */
export function curvesAreNeutral(curves) {
  return !curves || CURVE_CHANNELS.every(ch => curveIsIdentity(curves[ch]));
}
export function isToneNeutral(p = {}) {
  return !p.exposure && !p.highlights && !p.shadows && !p.temperature && !p.tint
    && curvesAreNeutral(p.curves) && hslIsNeutral(p.hsl);
}

/* ── the pass ──────────────────────────────────────────────────────────────────────────────── */
/* Mutates an RGBA byte array (ImageData.data) in place. Alpha is untouched. Each stage is skipped
   entirely when neutral, so a lone exposure tweak costs one LUT lookup per channel. */
export function applyTone(data, params = {}) {
  const p = { ...TONE_DEFAULTS, ...params };
  if (isToneNeutral(p)) return data;

  let gainLuts = null;
  if (p.exposure || p.temperature || p.tint) {
    const ev = Math.pow(2, p.exposure || 0);
    const [gr, gg, gb] = whiteBalanceGains(p.temperature, p.tint);
    gainLuts = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < 256; i++) {
      gainLuts[0][i] = fromLinear(TO_LINEAR[i] * gr * ev);
      gainLuts[1][i] = fromLinear(TO_LINEAR[i] * gg * ev);
      gainLuts[2][i] = fromLinear(TO_LINEAR[i] * gb * ev);
    }
  }

  const toneLut = (p.highlights || p.shadows) ? buildToneLut(p.highlights || 0, p.shadows || 0) : null;

  let curveLuts = null;
  if (!curvesAreNeutral(p.curves)) {
    const master = buildCurveLut(p.curves.rgb);
    curveLuts = ['r', 'g', 'b'].map(ch => {
      const c = buildCurveLut(p.curves[ch]), out = new Float32Array(256);
      // compose: channel curve applied after the master curve (Photoshop's order), with linear
      // interpolation on the channel LUT since the master's output is fractional
      for (let i = 0; i < 256; i++) {
        const v = master[i], lo = Math.floor(v), hi = Math.min(255, lo + 1), f = v - lo;
        out[i] = c[lo] * (1 - f) + c[hi] * f;
      }
      return out;
    });
  }

  const hslT = hslIsNeutral(p.hsl) ? null : buildHslTables(p.hsl);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];

    if (gainLuts) { r = gainLuts[0][r]; g = gainLuts[1][g]; b = gainLuts[2][b]; }

    if (toneLut) {
      const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const Li = L * 255 + 0.5 | 0;
      const target = toneLut[Li > 255 ? 255 : Li];
      if (L > 0.004) { const k = target / L; r *= k; g *= k; b *= k; }
      else { const add = target * 255; r += add; g += add; b += add; }
      r = r > 255 ? 255 : r; g = g > 255 ? 255 : g; b = b > 255 ? 255 : b;
    }

    if (curveLuts) {
      // earlier stages can leave fractional values — sample the LUTs with linear interpolation
      r = sampleLut(curveLuts[0], r); g = sampleLut(curveLuts[1], g); b = sampleLut(curveLuts[2], b);
    }

    if (hslT) {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
      const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
      const d = max - min;
      if (d > 1e-5) {
        let l = (max + min) / 2;
        let s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
        h *= 60;
        let hi = h | 0; if (hi >= 360) hi = 359;
        const dh = hslT.dh[hi], ds = hslT.ds[hi], dl = hslT.dl[hi];
        // near-greys have an arbitrary (noise-driven) hue — fade every band effect out by CHROMA
        // (max-min), not HSL saturation: HSL s is high for dark noisy pixels (a tiny d over a tiny
        // l), which let JPEG noise in shadows flip between bands and blotch. Chroma is small there.
        const cw = smoothstep(0.02, 0.2, d);
        h = (h + dh * HSL_HUE_RANGE * cw + 360) % 360;
        s = clamp01(s * (1 + ds * cw));
        // proportional to the distance from the nearer end, so darks/lights move gently and a
        // pixel can't leap far from neighbours that fell in a slightly different band
        l = clamp01(l + dl * cw * HSL_LUM_STRENGTH * 2 * (l < 0.5 ? l : 1 - l));
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q, hn = h / 360;
        r = hue2rgb(pp, q, hn + 1 / 3) * 255; g = hue2rgb(pp, q, hn) * 255; b = hue2rgb(pp, q, hn - 1 / 3) * 255;
      }
    }

    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return data;
}

function sampleLut(lut, v) {
  if (v <= 0) return lut[0];
  if (v >= 255) return lut[255];
  const lo = v | 0, f = v - lo;
  return f ? lut[lo] * (1 - f) + lut[lo + 1] * f : lut[lo];
}

/* ── Fabric filter wrapper ─────────────────────────────────────────────────────────────────── */
/* Same factory shape as mask.js's makeMaskFilterClass: the class can't exist until a real fabric
   is loaded, and it must be registered on fabric.Image.filters BEFORE any scene JSON containing
   it is restored (undo/redo, loadJSON), because enlivenObjects resolves filters by `type`. Only
   the Canvas2D path (applyTo2d) is implemented — Editor forces enableGLFiltering off. */
let _ToneFilterClass = null, _builtForFabric = null;
export function makeToneFilterClass(fabric) {
  if (_ToneFilterClass && _builtForFabric === fabric) return _ToneFilterClass;
  _ToneFilterClass = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'Tone',
    mainParameter: 'exposure',
    ...TONE_DEFAULTS,
    applyTo2d(options) { applyTone(options.imageData.data, this.toParams()); },
    toParams() { const o = {}; TONE_KEYS.forEach(k => { o[k] = this[k]; }); return o; },
    isNeutralState() { return isToneNeutral(this.toParams()); },
    toObject() { return { type: this.type, ...JSON.parse(JSON.stringify(this.toParams())) }; },
  });
  _ToneFilterClass.fromObject = fabric.Image.filters.BaseFilter.fromObject;
  fabric.Image.filters.Tone = _ToneFilterClass;
  _builtForFabric = fabric;
  return _ToneFilterClass;
}

/* ── curve editing helpers (UI-agnostic; both shells draw their own SVG) ───────────────────── */
/* Points live in 0..255 on both axes. Endpoints can't be deleted and every interior point stays
   strictly between its neighbours' x, so the point list is always sorted — the same invariants
   Photoshop's curve dialog keeps. MAX_CURVE_POINTS matches its 16-point limit. */
export const MAX_CURVE_POINTS = 16;
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

/* A full { rgb, r, g, b } with identity filled in for any missing channel. */
export function normalizeCurves(curves) {
  const out = {};
  CURVE_CHANNELS.forEach(ch => { out[ch] = (curves && curves[ch] && curves[ch].length >= 2) ? curves[ch].map(p => [p[0], p[1]]) : CURVE_IDENTITY.map(p => [...p]); });
  return out;
}
/* Back to the stored shape: identity channels dropped, and null when nothing is left, so a reset
   curve serialises as nothing and isToneNeutral() short-circuits. */
export function compactCurves(curves) {
  if (!curves) return null;
  const out = {};
  CURVE_CHANNELS.forEach(ch => { if (!curveIsIdentity(curves[ch])) out[ch] = curves[ch]; });
  return Object.keys(out).length ? out : null;
}

/* Index of the point within `tol` of (x, y), nearest first, or -1. */
export function curveHitTest(points, x, y, tol = 10) {
  let best = -1, bestD = tol * tol;
  points.forEach(([px, py], i) => { const d = (px - x) ** 2 + (py - y) ** 2; if (d <= bestD) { bestD = d; best = i; } });
  return best;
}

/* Inserts a point at x (keeping order). Returns { points, index }; index is -1 (points unchanged)
   when at the point limit or when x collides with an existing point's x. */
export function curveInsertPoint(points, x, y) {
  x = clampByte(x); y = clampByte(y);
  if (points.length >= MAX_CURVE_POINTS || points.some(p => p[0] === x)) return { points, index: -1 };
  const next = [...points.map(p => [...p]), [x, y]].sort((a, b) => a[0] - b[0]);
  return { points: next, index: next.findIndex(p => p[0] === x) };
}

/* Moves point `index` to (x, y), clamped so it can't cross its neighbours (1 unit gap). */
export function curveMovePoint(points, index, x, y) {
  const next = points.map(p => [...p]);
  const lo = index > 0 ? next[index - 1][0] + 1 : 0;
  const hi = index < next.length - 1 ? next[index + 1][0] - 1 : 255;
  next[index] = [Math.max(lo, Math.min(hi, clampByte(x))), clampByte(y)];
  return next;
}

/* Removes an interior point; endpoints are permanent (returns points unchanged). */
export function curveRemovePoint(points, index) {
  if (index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, i) => i !== index).map(p => [...p]);
}

/* SVG path for the curve in a `size`×`size` box, y flipped (0 at the bottom, like every curves
   dialog). Sampled from the same LUT applyTone uses, so what's drawn is exactly what's applied. */
export function curveSvgPath(points, size = 256) {
  const lut = buildCurveLut(points), k = size / 255;
  let d = '';
  for (let x = 0; x < 256; x += 3) d += (x ? 'L' : 'M') + (x * k).toFixed(1) + ' ' + (size - lut[x] * k).toFixed(1);
  return d + 'L' + size + ' ' + (size - lut[255] * k).toFixed(1);
}

/* 256-bin luminance histogram of RGBA bytes (fully transparent pixels skipped), normalised to a
   0..1 peak on a sqrt scale so a few huge bins (a white background) don't flatten everything else.
   `stride` samples every Nth pixel — a 1600px image doesn't need 2.5M reads for a 256px chart. */
export function lumaHistogram(data, stride = 1) {
  const bins = new Float32Array(256);
  const step = 4 * Math.max(1, stride | 0);
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] === 0) continue;
    bins[(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] + 0.5) | 0]++;
  }
  let max = 0;
  for (let i = 0; i < 256; i++) { bins[i] = Math.sqrt(bins[i]); if (bins[i] > max) max = bins[i]; }
  if (max) for (let i = 0; i < 256; i++) bins[i] /= max;
  return bins;
}

/* ── HSL mixer helpers (UI-agnostic) ───────────────────────────────────────────────────────── */
export const HSL_PROPS = [['h', 'Hue'], ['s', 'Saturation'], ['l', 'Luminance']];
const BAND_LABELS = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta' };
export const hslBandLabel = (band) => BAND_LABELS[band] || band;

/* One band's value for one property (0 when unset). */
export const getHslValue = (hsl, band, prop) => (hsl && hsl[band] && hsl[band][prop]) || 0;

/* Immutable update that keeps the stored shape minimal: zeroed props and emptied bands are
   dropped, and an all-neutral mixer collapses to null (so it serialises as nothing). */
export function setHslValue(hsl, band, prop, value) {
  const next = {};
  HSL_BANDS.forEach(([name]) => {
    const cur = { ...((hsl && hsl[name]) || {}) };
    if (name === band) cur[prop] = value;
    const kept = {};
    ['h', 's', 'l'].forEach(k => { if (cur[k]) kept[k] = cur[k]; });
    if (Object.keys(kept).length) next[name] = kept;
  });
  return Object.keys(next).length ? next : null;
}

/* CSS gradient for a band slider's track, previewing what dragging does: hue spans the band's
   ±30° reach, saturation runs grey → full colour, luminance dark → light. */
export function hslBandTrack(band, prop) {
  const c = (HSL_BANDS.find(([n]) => n === band) || [, 0])[1];
  if (prop === 'h') return `linear-gradient(to right, hsl(${c - HSL_HUE_RANGE} 75% 52%), hsl(${c} 75% 52%), hsl(${c + HSL_HUE_RANGE} 75% 52%))`;
  if (prop === 's') return `linear-gradient(to right, hsl(${c} 0% 55%), hsl(${c} 85% 52%))`;
  return `linear-gradient(to right, hsl(${c} 70% 18%), hsl(${c} 70% 50%), hsl(${c} 70% 84%))`;
}
