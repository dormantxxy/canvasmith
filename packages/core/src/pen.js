/* Pen tool / vector-edit geometry — pure functions, no Fabric or DOM state.

   A path is an array of nodes plus a `closed` flag. Each node is an anchor with optional bezier
   handles, all in SCENE coordinates (absolute, not relative to the anchor):
     { x, y, hi: {x,y}|null, ho: {x,y}|null }
   `hi` shapes the segment arriving at the node, `ho` the one leaving it. A segment with neither
   handle is a straight line ('L'); anything else is a cubic ('C') with a missing handle standing
   in as the anchor itself. Segment i runs nodes[i] -> nodes[i+1] (wrapping to nodes[0] when closed).

   Smooth vs corner is not stored — it is read off the handles (both present and pointing in
   opposite directions = smooth), so a path round-tripped through SVG data keeps its behaviour. */

export const node = (x, y, hi = null, ho = null) => ({ x, y, hi, ho });
const P = (x, y) => ({ x, y });
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

export const cloneNodes = (nodes) => nodes.map(n => node(n.x, n.y, n.hi && P(n.hi.x, n.hi.y), n.ho && P(n.ho.x, n.ho.y)));
export const segCount = (nodes, closed) => (nodes.length < 2 ? 0 : closed ? nodes.length : nodes.length - 1);
const segEnds = (nodes, s) => [nodes[s], nodes[(s + 1) % nodes.length]];
const segCubic = (a, b) => [P(a.x, a.y), a.ho || P(a.x, a.y), b.hi || P(b.x, b.y), P(b.x, b.y)];
const isStraight = (a, b) => !a.ho && !b.hi;

export function bezierAt(c, t) {
  const u = 1 - t;
  return P(u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y);
}

/* ── nodes <-> SVG path data ─────────────────────────────────────────────────────────────── */
const r2 = (v) => Math.round(v * 100) / 100;
export function nodesToPathD(nodes, closed) {
  if (!nodes.length) return '';
  const out = ['M', r2(nodes[0].x), r2(nodes[0].y)];
  const n = segCount(nodes, closed);
  for (let s = 0; s < n; s++) {
    const [a, b] = segEnds(nodes, s);
    if (closed && s === n - 1 && isStraight(a, b)) break;   // 'Z' draws the straight closing edge
    if (isStraight(a, b)) out.push('L', r2(b.x), r2(b.y));
    else { const c = segCubic(a, b); out.push('C', r2(c[1].x), r2(c[1].y), r2(c[2].x), r2(c[2].y), r2(b.x), r2(b.y)); }
  }
  if (closed) out.push('Z');
  return out.join(' ');
}

/* Fabric's parsed + simplified path (absolute M/L/C/Q/Z only — see fabric.util.makePathSimpler)
   to nodes, mapping every point through `map` (local -> scene). Returns null for anything with
   more than one subpath: a compound path can't be expressed as one node list. */
export function commandsToNodes(cmds, map = (p) => p) {
  const nodes = []; let closed = false, subpaths = 0;
  const pt = (x, y) => map(P(x, y));
  const at = (p) => node(p.x, p.y);
  for (const c of cmds) {
    const last = nodes[nodes.length - 1];
    switch (c[0]) {
      case 'M':
        if (++subpaths > 1) return null;
        nodes.push(at(pt(c[1], c[2]))); break;
      case 'L': nodes.push(at(pt(c[1], c[2]))); break;
      case 'C': {
        if (!last) return null;
        last.ho = pt(c[1], c[2]);
        const e = pt(c[5], c[6]);
        nodes.push(node(e.x, e.y, pt(c[3], c[4]))); break;
      }
      case 'Q': {
        if (!last) return null;
        // exact quadratic -> cubic elevation
        const q = pt(c[1], c[2]), e = pt(c[3], c[4]);
        last.ho = lerp(last, q, 2 / 3);
        nodes.push(node(e.x, e.y, lerp(e, q, 2 / 3))); break;
      }
      case 'Z': case 'z': closed = true; break;
      default: return null;
    }
  }
  if (closed && nodes.length > 1) {
    // An explicit segment back onto the start point duplicates the first node — fold it in.
    const f = nodes[0], l = nodes[nodes.length - 1];
    if (dist(f, l) < 0.01) { f.hi = l.hi; nodes.pop(); }
  }
  // A handle sitting exactly on its anchor is no handle at all (that's how straight runs come out of 'C').
  for (const n of nodes) {
    if (n.hi && dist(n.hi, n) < 0.01) n.hi = null;
    if (n.ho && dist(n.ho, n) < 0.01) n.ho = null;
  }
  return nodes.length ? { nodes, closed } : null;
}

/* ── node behaviour ─────────────────────────────────────────────────────────────────────── */
export function isSmooth(n) {
  if (!n.hi || !n.ho) return false;
  const a = sub(n.hi, n), b = sub(n.ho, n), la = len(a), lb = len(b);
  if (la < 0.01 || lb < 0.01) return false;
  const cross = (a.x * b.y - a.y * b.x) / (la * lb), dot = (a.x * b.x + a.y * b.y) / (la * lb);
  return Math.abs(cross) < 0.02 && dot < 0;
}
/* "Mirror angle and length" when both handles were the same length (what dragging out a new
   point makes), else "mirror angle" only — keeps the opposite handle's own length. */
export function mirrorFor(n, which, h, opts = {}) {
  const other = which === 'ho' ? n.hi : n.ho;
  const d = sub(h, n), l = len(d);
  if (l < 0.01) return other;
  const keepLen = opts.equal ? l : (other ? dist(other, n) : l);
  return sub(n, mul(d, keepLen / l));
}
export function handlesEqual(n) { return !!(n.hi && n.ho && Math.abs(dist(n.hi, n) - dist(n.ho, n)) < Math.max(0.5, dist(n.ho, n) * 0.02)); }

/* Corner <-> smooth. Smooth handles run parallel to the line between the neighbours, a third of
   the way to each one — the usual auto-smooth, and what Figma's double-click on a point does. */
export function toggleSmooth(nodes, closed, i) {
  const n = nodes[i];
  if (n.hi || n.ho) { n.hi = null; n.ho = null; return; }
  const cnt = nodes.length;
  const prev = (i > 0 || closed) && cnt > 1 ? nodes[(i - 1 + cnt) % cnt] : null;
  const next = (i < cnt - 1 || closed) && cnt > 1 ? nodes[(i + 1) % cnt] : null;
  if (!prev && !next) return;
  const dir = sub(next || n, prev || n), l = len(dir);
  if (l < 0.01) return;
  const u = mul(dir, 1 / l);
  if (prev) n.hi = sub(n, mul(u, dist(prev, n) / 3));
  if (next) n.ho = add(n, mul(u, dist(next, n) / 3));
}

/* Shift-constrain `p` to the nearest 45° ray out of `from` (keeps the projected length). */
export function constrain45(from, p) {
  const d = sub(p, from), l = len(d);
  if (l < 0.01) return P(p.x, p.y);
  const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
  const proj = d.x * Math.cos(a) + d.y * Math.sin(a);
  return P(from.x + Math.cos(a) * proj, from.y + Math.sin(a) * proj);
}

export function translateNode(n, dx, dy) {
  n.x += dx; n.y += dy;
  if (n.hi) { n.hi.x += dx; n.hi.y += dy; }
  if (n.ho) { n.ho.x += dx; n.ho.y += dy; }
}

/* ── hit testing (tolerances are scene units: pass `px / zoom`) ─────────────────────────── */
export function hitAnchor(nodes, p, tol) {
  let best = -1, bd = tol;
  nodes.forEach((n, i) => { const d = dist(n, p); if (d <= bd) { bd = d; best = i; } });
  return best;
}
export function hitHandle(nodes, p, tol, only) {
  let best = null, bd = tol;
  nodes.forEach((n, i) => {
    if (only && !only.includes(i)) return;
    for (const which of ['hi', 'ho']) {
      const h = n[which];
      if (h) { const d = dist(h, p); if (d <= bd) { bd = d; best = { i, which }; } }
    }
  });
  return best;
}
/* Nearest point on any segment within tol -> { seg, t, x, y }. Coarse sampling, then a local
   ternary refine; plenty for UI picking. */
export function hitSegment(nodes, closed, p, tol) {
  let best = null, bd = tol;
  const n = segCount(nodes, closed);
  for (let s = 0; s < n; s++) {
    const c = segCubic(...segEnds(nodes, s));
    const N = 48;
    let bt = 0, bdd = Infinity;
    for (let k = 0; k <= N; k++) { const d = dist(bezierAt(c, k / N), p); if (d < bdd) { bdd = d; bt = k / N; } }
    let lo = Math.max(0, bt - 1 / N), hi = Math.min(1, bt + 1 / N);
    for (let k = 0; k < 20; k++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (dist(bezierAt(c, m1), p) < dist(bezierAt(c, m2), p)) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2, q = bezierAt(c, t), d = dist(q, p);
    if (d <= bd) { bd = d; best = { seg: s, t, x: q.x, y: q.y }; }
  }
  return best;
}

/* Insert a node on segment `seg` at `t` without changing the curve's shape (de Casteljau).
   Returns the new node's index. */
export function splitSegment(nodes, closed, seg, t) {
  const [a, b] = segEnds(nodes, seg);
  const at = seg + 1;
  if (isStraight(a, b)) {
    const q = lerp(a, b, t);
    nodes.splice(at, 0, node(q.x, q.y));
    return at;
  }
  const c = segCubic(a, b);
  const p01 = lerp(c[0], c[1], t), p12 = lerp(c[1], c[2], t), p23 = lerp(c[2], c[3], t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
  a.ho = p01; b.hi = p23;
  nodes.splice(at, 0, node(m.x, m.y, p012, p123));
  return at;
}

/* Drag a segment so the point grabbed at `t` follows the pointer by `delta`: the minimum-norm
   change to the two control points (the "bend" gesture). `orig` is the pre-drag [a, b]. */
export function bendSegment(nodes, seg, t, orig, delta) {
  const [a, b] = segEnds(nodes, seg);
  const tt = Math.max(0.08, Math.min(0.92, t));
  const w1 = 3 * (1 - tt) * (1 - tt) * tt, w2 = 3 * (1 - tt) * tt * tt, ww = w1 * w1 + w2 * w2;
  const c1 = orig[0].ho || P(orig[0].x, orig[0].y), c2 = orig[1].hi || P(orig[1].x, orig[1].y);
  a.ho = add(c1, mul(delta, w1 / ww));
  b.hi = add(c2, mul(delta, w2 / ww));
}

export function nodesBounds(nodes) {
  const xs = [], ys = [];
  nodes.forEach(n => { xs.push(n.x); ys.push(n.y); });
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/* ── cursors ─────────────────────────────────────────────────────────────────────────────
   A fountain-pen nib, tip at the hotspot (3,3), with a small modifier glyph bottom-right saying
   what a click will do — the same vocabulary as Figma/Illustrator's pen cursors. */
const GLYPHS = {
  pen: '',
  close: '<circle cx="21" cy="21" r="3.2"/>',
  add: '<path d="M21 17.2V24.8M17.2 21H24.8"/>',
  remove: '<path d="M17.2 21H24.8"/>',
  convert: '<path d="M17.5 23.5L21 18.5L24.5 23.5"/>',
  continue: '<path d="M18 24L24 18"/>',
};
const _cursorCache = {};
export function penCursor(kind = 'pen') {
  if (_cursorCache[kind]) return _cursorCache[kind];
  const g = GLYPHS[kind] || '';
  const glyph = g ? `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="3.6">${g}</g><g stroke="#111" stroke-width="1.6">${g}</g></g>` : '';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">'
    + '<g fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round" paint-order="stroke">'
    + '<path d="M3 3L12.4 6.4L14.6 10.2L10.2 14.6L6.4 12.4Z"/><path d="M14.6 10.2L17.6 13.2L13.2 17.6L10.2 14.6Z"/></g>'
    + '<path d="M3.6 3.6L7.4 7.4" stroke="#fff" stroke-width="1" stroke-linecap="round"/><circle cx="8.3" cy="8.3" r="1.25" fill="#fff"/>'
    + glyph + '</svg>';
  return (_cursorCache[kind] = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 3, crosshair`);
}

/* ── overlay (both shells call this from their after:render hook) ────────────────────────
   `st` is what the Editor emits on 'pen': { mode: 'draw'|'edit', nodes, closed, sel, handles,
   preview, closeHover, hoverAnchor, segHover, marquee }. `z` is the zoom (line widths stay
   constant on screen); ctx is already in scene space. */
export function drawPenOverlay(ctx, st, z, opts = {}) {
  if (!st || !st.nodes) return;
  const accent = opts.accent || '#4f8ff0', px = 1 / (z || 1), nodes = st.nodes;
  const tracePath = (ns, closed) => {
    ctx.beginPath();
    if (!ns.length) return;
    ctx.moveTo(ns[0].x, ns[0].y);
    const n = segCount(ns, closed);
    for (let s = 0; s < n; s++) {
      const [a, b] = segEnds(ns, s);
      if (isStraight(a, b)) ctx.lineTo(b.x, b.y);
      else { const c = segCubic(a, b); ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, b.x, b.y); }
    }
    if (closed) ctx.closePath();
  };
  ctx.save();
  ctx.setLineDash([]); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // path outline: a dark halo under the accent so it reads on any photo
  tracePath(nodes, st.closed);
  ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
  ctx.lineWidth = 1.5 * px; ctx.strokeStyle = accent; ctx.stroke();
  // rubber band from the last point to the pointer (or onto the first point when about to close)
  if (st.preview && nodes.length) {
    const l = nodes[nodes.length - 1], to = st.preview, f = nodes[0];
    ctx.beginPath(); ctx.moveTo(l.x, l.y);
    const c1 = l.ho || l, c2 = st.closeHover ? (f.hi || f) : to;
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, st.closeHover ? f.x : to.x, st.closeHover ? f.y : to.y);
    ctx.lineWidth = 1.2 * px; ctx.strokeStyle = accent; ctx.globalAlpha = 0.75; ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (st.marquee) {
    const m = st.marquee;
    ctx.fillStyle = 'rgba(79,143,240,.08)'; ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = 1 * px; ctx.strokeStyle = accent; ctx.strokeRect(m.x, m.y, m.w, m.h); ctx.setLineDash([]);
  }
  // handles: a thin arm + a small hollow diamond at the tip
  (st.handles || []).forEach(i => {
    const n = nodes[i]; if (!n) return;
    for (const h of [n.hi, n.ho]) {
      if (!h) continue;
      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(h.x, h.y);
      ctx.lineWidth = 1 * px; ctx.strokeStyle = accent; ctx.stroke();
      const r = 3.6 * px;
      ctx.beginPath(); ctx.moveTo(h.x, h.y - r); ctx.lineTo(h.x + r, h.y); ctx.lineTo(h.x, h.y + r); ctx.lineTo(h.x - r, h.y); ctx.closePath();
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 1.2 * px; ctx.stroke();
    }
  });
  // anchors: white with accent ring; selected = solid accent; hovered grows a little
  const sel = new Set(st.sel || []);
  nodes.forEach((n, i) => {
    const hot = st.hoverAnchor === i || (st.closeHover && i === 0);
    const r = (hot ? 5 : 4) * px;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = sel.has(i) ? accent : '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.5 * px; ctx.strokeStyle = sel.has(i) ? '#ffffff' : accent; ctx.stroke();
    if (sel.has(i)) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 1 * px, 0, Math.PI * 2); ctx.lineWidth = 1 * px; ctx.strokeStyle = accent; ctx.stroke(); }
  });
  // where a click would insert a point
  if (st.segHover) {
    const s = st.segHover;
    ctx.beginPath(); ctx.arc(s.x, s.y, 3.5 * px, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill(); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  ctx.restore();
}
