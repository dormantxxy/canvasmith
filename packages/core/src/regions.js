/* Pixel helpers for convert-to-layers (Editor#commitRegions / #extractRegion):

   - fillHoles: rebuilds the background where regions were lifted off it, so moving/deleting a new
     layer reveals a plausible continuation of the panel/photo behind it — not a see-through gap,
     and not a second copy of the region (what an un-punched background showed).
   - analyzeBox: background colour (from the box's border ring) + dominant ink colour (+ outline),
     used to colour a detected text layer like the original instead of always near-black.
   - knockoutBackground: turns a text crop on a flat background into ink-only pixels, so a text
     region the AI couldn't read still lifts off cleanly as an image layer.

   All pure functions over ImageData / typed arrays — no DOM beyond what the caller passes in. */

const CELL = 4;          // label/colour propagation runs on a CELL×CELL grid — region edges are smooth anyway
const PAL_JOIN = 36;     // buckets closer than this merge into one palette colour
const PAL_MATCH = 34;    // a pixel belongs to a palette colour within this distance, else it is "other"
const PAL_MIN = 0.02;    // a palette colour must cover ≥2% of the known pixels near the holes

/* Fill every pixel where hole[i] is set.

   Designs are mostly flat regions (a green panel on beige), so the known pixels around the holes
   are first reduced to a small PALETTE of region colours. Then:
     1. grow — leftover fragments of the lifted element that its box or cutout missed (pixels that
        match NO palette colour) are taken into the hole: small touching blobs whole, the rest up to
        grow[i] px. Left in place, they were exactly what the old fill smeared into long streaks.
     2. label — each hole pixel takes the region most of its 4 nearest known neighbours (left,
        right, up, down) belong to, so a hole spanning a panel edge continues that edge straight
        instead of averaging green and beige into mud or bulging.
     3. colour — filled from pixels OF THAT REGION only (per-region push-pull), keeping gentle
        gradients while never pulling in a neighbouring element's colour.
   Where the surroundings are mostly "other" (a photo, not flat colour), the pixel falls back to a
   plain smooth push-pull of all known colours. Returns the final (grown) hole mask. */
export function fillHoles(img, hole, grow, ink = []) {
  const W = img.width, H = img.height, d = img.data, N = W * H;
  hole = hole.slice();
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hole[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return hole;
  const m = Math.max(64, Math.round(Math.max(x1 - x0, y1 - y0) * 0.25));
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);

  const pal = buildPalette(d, W, hole, x0, y0, x1, y1);
  const K = pal.length;
  const labelOf = (i) => {
    if (d[i * 4 + 3] < 200) return -1;
    let best = -1, bd = PAL_MATCH * PAL_MATCH;
    for (let k = 0; k < K; k++) {
      const r = d[i * 4] - pal[k][0], g = d[i * 4 + 1] - pal[k][1], b = d[i * 4 + 2] - pal[k][2], dd = r * r + g * g + b * b;
      if (dd < bd) { bd = dd; best = k; }
    }
    return best;
  };
  // Leftover = matches no backdrop colour, OR is the lifted text's own ink (its fill/outline).
  // Ink can coincide with a genuine backdrop colour (a black outline vs. a black badge), so ink is
  // only ever taken as part of a SMALL blob touching the hole (1a) — a badge that touches the
  // headline's box is one big blob and is left alone; the step-limited growth (1b) never takes ink.
  const INK2 = 40 * 40;
  const isInk = (i) => {
    for (const c of ink) { const r = d[i * 4] - c[0], g = d[i * 4 + 1] - c[1], b = d[i * 4 + 2] - c[2]; if (r * r + g * g + b * b < INK2) return true; }
    return false;
  };
  // Blob membership is stricter about what counts as clean backdrop (within PAL_TIGHT of a palette
  // colour): a clipped letter's anti-aliased fringe is often close-ish to the backdrop (light grey
  // vs beige) and would otherwise survive as a faint outline of the letter.
  const PAL_TIGHT2 = 18 * 18;
  const cleanBackdrop = (i) => {
    for (let k = 0; k < K; k++) { const r = d[i * 4] - pal[k][0], g = d[i * 4 + 1] - pal[k][1], b = d[i * 4 + 2] - pal[k][2]; if (r * r + g * g + b * b < PAL_TIGHT2) return true; }
    return false;
  };
  const leftover = (i) => d[i * 4 + 3] >= 200 && (!cleanBackdrop(i) || isInk(i));

  // 1a. absorb whole fragments: an "other" blob (8-connected) touching a hole is swallowed in full
  //     when its extent outside the hole is within 1.6× that hole's budget — a letter clipped by
  //     the AI box, a badge rim — however far it reaches. Bigger blobs (a photo next to the text)
  //     are left to the step-limited growth below, so they only lose a thin edge.
  if (grow && K) {
    const seen = new Uint8Array(N), comp = [], st = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (!hole[i] || !grow[i]) continue;
      for (const j of [x > x0 ? i - 1 : -1, x < x1 ? i + 1 : -1, y > y0 ? i - W : -1, y < y1 ? i + W : -1]) {
        if (j < 0 || hole[j] || seen[j] || !leftover(j)) continue;
        // flood the blob, tracking its bbox and the largest budget among the holes it touches
        comp.length = 0; st.length = 0; st.push(j); seen[j] = 1;
        let bx0 = W, by0 = H, bx1 = -1, by1 = -1, lim = 0, big = false;
        while (st.length) {
          const q = st.pop(), qx = q % W, qy = (q - qx) / W;
          comp.push(q);
          if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx, ny = qy + dy;
            if ((!dx && !dy) || nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const r = ny * W + nx;
            if (hole[r]) { if (grow[r] > lim) lim = grow[r]; continue; }
            if (seen[r] || !leftover(r)) continue;
            seen[r] = 1; st.push(r);
          }
          if (comp.length > 400000) { big = true; break; }
        }
        if (big) { while (st.length) seen[st.pop()] = 1; continue; }
        if (bx1 - bx0 + 1 <= lim * 1.6 && by1 - by0 + 1 <= lim * 1.6) for (const q of comp) hole[q] = 1;
      }
    }
  }

  // 1b. grow into remaining "other" pixels, per-pixel budget (BFS keeps the best remaining budget)
  if (grow && K) {
    const budget = new Uint8Array(N), queue = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (hole[i] && grow[i]) { budget[i] = grow[i]; queue.push(i); } }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], bgt = budget[i];
      if (bgt <= 1) continue;
      const x = i % W, y = (i - x) / W;
      const nb = [x > x0 ? i - 1 : -1, x < x1 ? i + 1 : -1, y > y0 ? i - W : -1, y < y1 ? i + W : -1];
      for (const j of nb) {
        if (j < 0 || budget[j] >= bgt - 1) continue;
        if (!hole[j]) { if (d[j * 4 + 3] < 200 || labelOf(j) !== -1) continue; hole[j] = 1; }
        budget[j] = bgt - 1; queue.push(j);
      }
    }
  }

  // 2. label — majority of the nearest known pixel's region in each of the 4 directions (ties:
  //    nearer wins). Layouts are mostly axis-aligned, so a pixel whose left AND right neighbours
  //    are the backdrop stays backdrop even if the panel is closer below it: a panel's straight top
  //    edge continues straight through a hole instead of bulging into it (what blended votes did).
  const lab = new Int8Array(N).fill(-2);            // -2 hole, -1 "other", 0..K-1 palette region
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (!hole[i]) lab[i] = labelOf(i); }
  // A known pixel only stops a scan if it sits in a run of ≥MINRUN same-label pixels along that
  // scan's axis: a lone anti-aliased edge pixel or a leftover speck would otherwise become the
  // "nearest neighbour" for a whole row/column and draw a streak across the hole.
  const MINRUN = 4;
  const hRun = new Uint16Array(N), vRun = new Uint16Array(N);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1;) {
    const i = y * W + x, k = lab[i];
    let e = x; while (e + 1 <= x1 && lab[y * W + e + 1] === k) e++;
    const L = Math.min(65535, e - x + 1); for (let q = x; q <= e; q++) hRun[y * W + q] = L;
    x = e + 1;
  }
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1;) {
    const k = lab[y * W + x];
    let e = y; while (e + 1 <= y1 && lab[(e + 1) * W + x] === k) e++;
    const L = Math.min(65535, e - y + 1); for (let q = y; q <= e; q++) vRun[q * W + x] = L;
    y = e + 1;
  }
  const vk = new Int8Array(N * 4).fill(-3), vd = new Float32Array(N * 4);
  for (let y = y0; y <= y1; y++) {
    const r = y * W;
    for (let x = x0, last = -1; x <= x1; x++) { const i = r + x; if (!hole[i]) { if (hRun[i] >= MINRUN) last = x; } else if (last >= 0) { vk[i * 4] = lab[r + last]; vd[i * 4] = x - last; } }
    for (let x = x1, last = -1; x >= x0; x--) { const i = r + x; if (!hole[i]) { if (hRun[i] >= MINRUN) last = x; } else if (last >= 0) { vk[i * 4 + 1] = lab[r + last]; vd[i * 4 + 1] = last - x; } }
  }
  for (let x = x0; x <= x1; x++) {
    for (let y = y0, last = -1; y <= y1; y++) { const i = y * W + x; if (!hole[i]) { if (vRun[i] >= MINRUN) last = y; } else if (last >= 0) { vk[i * 4 + 2] = lab[last * W + x]; vd[i * 4 + 2] = y - last; } }
    for (let y = y1, last = -1; y >= y0; y--) { const i = y * W + x; if (!hole[i]) { if (vRun[i] >= MINRUN) last = y; } else if (last >= 0) { vk[i * 4 + 3] = lab[last * W + x]; vd[i * 4 + 3] = last - y; } }
  }

  // 3. colour — per-region push-pull on a coarse grid (only that region's own pixels contribute)
  const gw = Math.ceil((x1 - x0 + 1) / CELL), gh = Math.ceil((y1 - y0 + 1) / CELL), G = gw * gh;
  const regCol = []; for (let k = 0; k < K; k++) regCol.push({ val: new Float32Array(G * 3), wt: new Float32Array(G) });
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x, k = lab[i];
    if (k < 0) continue;
    const g = ((y - y0) / CELL | 0) * gw + ((x - x0) / CELL | 0), rc = regCol[k];
    rc.val[g * 3] += d[i * 4]; rc.val[g * 3 + 1] += d[i * 4 + 1]; rc.val[g * 3 + 2] += d[i * 4 + 2]; rc.wt[g] += 1;
  }
  for (const rc of regCol) {
    for (let g = 0; g < G; g++) if (rc.wt[g] > 0) { rc.val[g * 3] /= rc.wt[g]; rc.val[g * 3 + 1] /= rc.wt[g]; rc.val[g * 3 + 2] /= rc.wt[g]; rc.wt[g] = Math.min(1, rc.wt[g] / (CELL * CELL * 0.5)); }
    ppGrid(gw, gh, 3, rc.val, rc.wt);
  }
  const sample = (arr, gx, gy, c) => {
    const ix = Math.min(gw - 1, Math.max(0, Math.floor(gx))), iy = Math.min(gh - 1, Math.max(0, Math.floor(gy)));
    const ix2 = Math.min(gw - 1, ix + 1), iy2 = Math.min(gh - 1, iy + 1), fx = Math.min(1, Math.max(0, gx - ix)), fy = Math.min(1, Math.max(0, gy - iy));
    return (arr[(iy * gw + ix) * 3 + c] * (1 - fx) + arr[(iy * gw + ix2) * 3 + c] * fx) * (1 - fy)
         + (arr[(iy2 * gw + ix) * 3 + c] * (1 - fx) + arr[(iy2 * gw + ix2) * 3 + c] * fx) * fy;
  };
  const photo = new Uint8Array(N);
  let anyPhoto = false;
  const cnt = new Float32Array(K + 1), near = new Float32Array(K + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x;
    if (!hole[i]) continue;
    cnt.fill(0); near.fill(0);
    let found = 0;
    for (let dir = 0; dir < 4; dir++) {
      const k = vk[i * 4 + dir];
      if (k === -3) continue;
      const slot = k < 0 ? K : k;
      cnt[slot] += 1; near[slot] += 1 / (vd[i * 4 + dir] * vd[i * 4 + dir]); found++;
    }
    let best = -1;
    for (let c = 0; c <= K; c++) if (cnt[c] && (best < 0 || cnt[c] > cnt[best] || (cnt[c] === cnt[best] && near[c] > near[best]))) best = c;
    if (!found || best === K) { photo[i] = 1; anyPhoto = true; continue; }
    const gx = (x - x0 + 0.5) / CELL - 0.5, gy = (y - y0 + 0.5) / CELL - 0.5, rc = regCol[best].val;
    d[i * 4] = sample(rc, gx, gy, 0); d[i * 4 + 1] = sample(rc, gx, gy, 1); d[i * 4 + 2] = sample(rc, gx, gy, 2); d[i * 4 + 3] = 255;
  }
  if (anyPhoto) pushPull(img, photo);   // region-filled hole pixels already count as known
  smoothHoles(img, hole, 1);
  return hole;
}

/* Region colours near the holes: 4-bit colour buckets over the known pixels, merged greedily from
   the most common down; kept when they cover ≥PAL_MIN of those pixels (max 8).
   A colour much more common INSIDE the holes than around them, and rare around them, is the lifted elements' own ink
   (white lettering, a black outline), not backdrop — even if something else nearby happens to
   share it (a white pack, badge text). It is rejected, so leftover fragments in that colour are
   still recognised as leftovers and cleaned up instead of being preserved as "background". */
function buildPalette(d, W, hole, x0, y0, x1, y1) {
  const buckets = new Map();
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x;
    if (hole[i] || d[i * 4 + 3] < 200) continue;
    const k = ((d[i * 4] >> 4) << 8) | ((d[i * 4 + 1] >> 4) << 4) | (d[i * 4 + 2] >> 4);
    let b = buckets.get(k); if (!b) { b = [0, 0, 0, 0]; buckets.set(k, b); }
    b[0] += d[i * 4]; b[1] += d[i * 4 + 1]; b[2] += d[i * 4 + 2]; b[3]++; n++;
  }
  const list = [...buckets.values()].sort((a, b) => b[3] - a[3]);
  const cl = [];
  for (const b of list) {
    const c = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const hit = cl.find(q => Math.hypot(q.c[0] - c[0], q.c[1] - c[1], q.c[2] - c[2]) < PAL_JOIN);
    if (hit) { hit.s[0] += b[0]; hit.s[1] += b[1]; hit.s[2] += b[2]; hit.s[3] += b[3]; }
    else cl.push({ c, s: b.slice() });
  }
  const pal = cl.filter(q => q.s[3] >= n * PAL_MIN).slice(0, 8).map(q => ({ c: [q.s[0] / q.s[3], q.s[1] / q.s[3], q.s[2] / q.s[3]], out: q.s[3], in: 0 }));
  let nIn = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x;
    if (!hole[i] || d[i * 4 + 3] < 200) continue;
    nIn++;
    for (const q of pal) {
      const r = d[i * 4] - q.c[0], g = d[i * 4 + 1] - q.c[1], b = d[i * 4 + 2] - q.c[2];
      if (r * r + g * g + b * b < PAL_JOIN * PAL_JOIN) { q.in++; break; }
    }
  }
  // Only a colour that is ALSO rare around the holes can be ink: the real backdrop (a panel that
  // fills most of a text box between the letters) is always common outside them too.
  return pal.filter(q => {
    const outShare = q.out / Math.max(1, n), inShare = nIn ? q.in / nIn : 0;
    return !(outShare < 0.08 && inShare > 0.03 && inShare > 1.5 * outShare);
  }).map(q => q.c);
}

/* Push-pull on a small multi-channel grid: `val` holds per-cell means (ch channels), `wt` 0..1
   confidence (0 = unknown). Unknown/low-confidence cells are filled coarse-to-fine in place. */
function ppGrid(gw, gh, ch, val, wt) {
  const levels = [{ w: gw, h: gh, val, wt }];
  let lw = gw, lh = gh, cv = val, cw = wt;
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2)), nh = Math.max(1, Math.ceil(lh / 2));
    const nv = new Float32Array(nw * nh * ch), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sw = 0; const i = y * nw + x;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const cx = x * 2 + dx, cy = y * 2 + dy;
        if (cx >= lw || cy >= lh) continue;
        const ci = cy * lw + cx, w = cw[ci];
        if (!w) continue;
        for (let c = 0; c < ch; c++) nv[i * ch + c] += cv[ci * ch + c] * w;
        sw += w;
      }
      if (sw > 0) { for (let c = 0; c < ch; c++) nv[i * ch + c] /= sw; nwt[i] = Math.min(1, sw); }
    }
    lw = nw; lh = nh; cv = nv; cw = nwt;
    levels.push({ w: lw, h: lh, val: cv, wt: cw });
  }
  for (let L = levels.length - 2; L >= 0; L--) {
    const f = levels[L], c = levels[L + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x, a = f.wt[i];
      if (a >= 1) continue;
      const gx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), gy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const ix2 = Math.min(c.w - 1, ix + 1), iy2 = Math.min(c.h - 1, iy + 1);
      for (let k = 0; k < ch; k++) {
        const v = (c.val[(iy * c.w + ix) * ch + k] * (1 - fx) + c.val[(iy * c.w + ix2) * ch + k] * fx) * (1 - fy)
                + (c.val[(iy2 * c.w + ix) * ch + k] * (1 - fx) + c.val[(iy2 * c.w + ix2) * ch + k] * fx) * fy;
        f.val[i * ch + k] = f.val[i * ch + k] * a + v * (1 - a);
      }
      f.wt[i] = 1;
    }
  }
}

/* A few passes of a 3×3 average over hole pixels only (known pixels are never changed). */
function smoothHoles(img, hole, passes) {
  const W = img.width, H = img.height, d = img.data;
  const idx = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (hole[y * W + x]) idx.push(y * W + x);
  const tmp = new Float32Array(idx.length * 4);
  for (let p = 0; p < passes; p++) {
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n];
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (i + dy * W + dx) * 4;
        r += d[j]; g += d[j + 1]; b += d[j + 2]; a += d[j + 3];
      }
      tmp[n * 4] = r / 9; tmp[n * 4 + 1] = g / 9; tmp[n * 4 + 2] = b / 9; tmp[n * 4 + 3] = a / 9;
    }
    for (let n = 0; n < idx.length; n++) { const j = idx[n] * 4; d[j] = tmp[n * 4]; d[j + 1] = tmp[n * 4 + 1]; d[j + 2] = tmp[n * 4 + 2]; d[j + 3] = tmp[n * 4 + 3]; }
  }
}

/* Coarse-to-fine push-pull over a weight pyramid — the fallback for hole pixels no scan line
   reaches. Only the bounding rect of those pixels plus a margin is processed. */
function pushPull(img, hole) {
  const W = img.width, H = img.height, d = img.data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hole[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return img;
  const m = Math.max(48, Math.round(Math.max(x1 - x0, y1 - y0) * 0.25));
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  const w0 = x1 - x0 + 1, h0 = y1 - y0 + 1;

  // level 0: premultiplied colour + weight (1 = known pixel, 0 = hole)
  const levels = [];
  let lw = w0, lh = h0;
  let col = new Float32Array(lw * lh * 4), wt = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const si = (y + y0) * W + (x + x0), i = y * lw + x;
    if (hole[si]) continue;
    const a = d[si * 4 + 3] / 255;
    col[i * 4] = d[si * 4] * a; col[i * 4 + 1] = d[si * 4 + 1] * a; col[i * 4 + 2] = d[si * 4 + 2] * a; col[i * 4 + 3] = a;
    wt[i] = 1;
  }
  levels.push({ w: lw, h: lh, col, wt });

  // push: halve until 1×1, colour = weighted mean of the 2×2 children
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2)), nh = Math.max(1, Math.ceil(lh / 2));
    const nc = new Float32Array(nw * nh * 4), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, sw = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const cx = x * 2 + dx, cy = y * 2 + dy;
        if (cx >= lw || cy >= lh) continue;
        const ci = cy * lw + cx, cw = wt[ci];
        if (!cw) continue;
        s0 += col[ci * 4] * cw; s1 += col[ci * 4 + 1] * cw; s2 += col[ci * 4 + 2] * cw; s3 += col[ci * 4 + 3] * cw; sw += cw;
      }
      const i = y * nw + x;
      if (sw > 0) { nc[i * 4] = s0 / sw; nc[i * 4 + 1] = s1 / sw; nc[i * 4 + 2] = s2 / sw; nc[i * 4 + 3] = s3 / sw; nwt[i] = Math.min(1, sw); }
    }
    lw = nw; lh = nh; col = nc; wt = nwt;
    levels.push({ w: lw, h: lh, col, wt });
  }

  // pull: blend each level's unknowns with the bilinear-upsampled coarser level
  for (let L = levels.length - 2; L >= 0; L--) {
    const f = levels[L], c = levels[L + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x, a = f.wt[i];
      if (a >= 1) continue;
      const gx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), gy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const ix2 = Math.min(c.w - 1, ix + 1), iy2 = Math.min(c.h - 1, iy + 1);
      for (let k = 0; k < 4; k++) {
        const v = (c.col[(iy * c.w + ix) * 4 + k] * (1 - fx) + c.col[(iy * c.w + ix2) * 4 + k] * fx) * (1 - fy)
                + (c.col[(iy2 * c.w + ix) * 4 + k] * (1 - fx) + c.col[(iy2 * c.w + ix2) * 4 + k] * fx) * fy;
        f.col[i * 4 + k] = f.col[i * 4 + k] * a + v * (1 - a);
      }
      f.wt[i] = 1;
    }
  }

  const top = levels[0];
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const si = (y + y0) * W + (x + x0);
    if (!hole[si]) continue;
    const i = y * w0 + x, a = top.col[i * 4 + 3];
    if (a <= 0.004) { d[si * 4 + 3] = 0; continue; }
    d[si * 4] = Math.min(255, top.col[i * 4] / a); d[si * 4 + 1] = Math.min(255, top.col[i * 4 + 1] / a);
    d[si * 4 + 2] = Math.min(255, top.col[i * 4 + 2] / a); d[si * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return img;
}

const dist = (d, i, c) => {
  const r = d[i] - c[0], g = d[i + 1] - c[1], b = d[i + 2] - c[2];
  return Math.sqrt(r * r + g * g + b * b);
};
const hex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/* Background = per-channel median of the box's outer ring; `uniform` when that ring is close to a
   single colour (a flat panel/badge, not a photo). Foreground = the most common colour (4-bit
   buckets) among pixels clearly different from the background — for white text with a dark
   outline that is the white fill, since the fill covers more pixels than the stroke. */
export function analyzeBox(img) {
  const W = img.width, H = img.height, d = img.data;
  const ring = Math.max(1, Math.round(Math.min(W, H) * 0.06));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= ring && x < W - ring && y >= ring && y < H - ring) continue;
    const i = (y * W + x) * 4;
    if (d[i + 3] < 128) continue;
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; n++;
  }
  if (!n) return { bg: null, uniform: false, fg: null };
  const med = (h) => { let s = 0; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= n / 2) return v; } return 255; };
  const bg = [med(hist[0]), med(hist[1]), med(hist[2])];
  let dev = 0, dn = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= ring && x < W - ring && y >= ring && y < H - ring) continue;
    const i = (y * W + x) * 4;
    if (d[i + 3] < 128) continue;
    dev += Math.min(120, dist(d, i, bg)); dn++;
  }
  const uniform = dn > 0 && dev / dn < 22;
  const buckets = new Map();
  let fgN = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128 || dist(d, i, bg) < 70) continue;
    fgN++;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    let b = buckets.get(k);
    if (!b) { b = [0, 0, 0, 0]; buckets.set(k, b); }
    b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b[3] > best[3]) best = b;
  const mean = (b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  const fg = best && fgN >= W * H * 0.01 ? hex(mean(best)) : null;
  // Outline: a second ink colour far from both the fill and the background, covering a real share
  // of the ink (anti-aliasing is spread thin over many buckets, so it never qualifies). White
  // lettering with a dark outline — common in ad creatives — is the case this catches.
  let outline = null;
  if (fg) {
    const f = mean(best);
    let second = null;
    for (const b of buckets.values()) {
      if (b === best) continue;
      const c = mean(b), df = Math.hypot(c[0] - f[0], c[1] - f[1], c[2] - f[2]);
      if (df > 110 && (!second || b[3] > second[3])) second = b;
    }
    if (second && second[3] >= best[3] * 0.25) outline = hex(mean(second));
  }
  return { bg, bgHex: hex(bg), uniform, fg, outline };
}

/* Remove `bg` from `img` in place: pixels near the background colour go transparent, anti-aliased
   edges are un-blended from it (so no background-coloured fringe is left around the glyphs). */
export function knockoutBackground(img, bg, lo = 20, hi = 70) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.max(0, Math.min(1, (dist(d, i, bg) - lo) / (hi - lo)));
    if (a <= 0) { d[i + 3] = 0; continue; }
    if (a < 1) for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - (1 - a) * bg[k]) / a));
    d[i + 3] = Math.round(d[i + 3] * a);
  }
  return img;
}

/* Text lines measured from pixels: rows containing ink grouped into horizontal bands (small gaps —
   an i-dot, an accent — merged in), each with its ink extent. Ink is the text's own colour(s) when
   known (`fg`, `outline` as [r,g,b]), else anything far from `bg`, else any opaque pixel (a
   rendered text layer on transparency). Returns [{x0, y0, x1, y1}] in image px, top to bottom. */
export function textLines(img, { bg = null, fg = null, outline = null } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const near = (i, c, t) => { const r = d[i] - c[0], g = d[i + 1] - c[1], b = d[i + 2] - c[2]; return r * r + g * g + b * b < t * t; };
  const isInk = (i) => {
    if (d[i + 3] < 128) return false;
    if (fg) return near(i, fg, 50) || (!!outline && near(i, outline, 50));
    if (bg) return !near(i, bg, 70);
    return true;
  };
  const rows = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (isInk((y * W + x) * 4)) n++; rows[y] = n; }
  const thr = Math.max(1, Math.round(W * 0.004));
  let bands = [];
  for (let y = 0; y < H;) {
    if (rows[y] < thr) { y++; continue; }
    let e = y; while (e + 1 < H && rows[e + 1] >= thr) e++;
    bands.push({ y0: y, y1: e }); y = e + 1;
  }
  if (!bands.length) return [];
  const hs = bands.map(b => b.y1 - b.y0 + 1).sort((a, b) => a - b), med = hs[hs.length >> 1];
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 - 1 <= Math.max(2, med * 0.25)) last.y1 = b.y1; else merged.push({ ...b });
  }
  const maxH = Math.max(...merged.map(b => b.y1 - b.y0 + 1));
  bands = merged.filter(b => b.y1 - b.y0 + 1 >= maxH * 0.3);
  for (const b of bands) {
    let x0 = W, x1 = -1;
    for (let y = b.y0; y <= b.y1; y++) for (let x = 0; x < W; x++) if (isInk((y * W + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    b.x0 = x0; b.x1 = x1;
  }
  return bands.filter(b => b.x1 >= b.x0);
}
