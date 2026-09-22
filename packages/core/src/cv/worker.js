/* OpenCV.js Web Worker body — the engine behind the cv-backed wand, object detection, and polygon
   boolean ops. Ported mechanism-for-mechanism from a reference editor's worker.

   This function is never called directly: cvWorkerSource() stringifies it and runs it inside a
   Worker built from a Blob URL, so OpenCV's multi-MB WASM only loads the first time a host touches
   a cv-backed tool, and loading it never blocks the main thread. Keep this function self-contained
   (no closures over outer scope) — anything it needs must come from `self.OPENCV_URL` or the
   postMessage payload, because its source is captured via .toString() and run verbatim in the
   worker's global scope. */
export function cvWorkerBody() {
  var U = self.OPENCV_URL, B = U.slice(0, U.lastIndexOf('/') + 1);
  self.Module = { locateFile: function (f) { return /\.wasm$/.test(f) ? B + f : f; } };
  try { importScripts(U); } catch (e) { self.postMessage({ boot: 'error' }); return; }
  var cv, ready = false, q = [];
  function ok() { cv = self.cv; ready = true; self.postMessage({ boot: 'ready' }); var a = q; q = []; a.forEach(handle); }
  (function w() { if (self.cv && self.cv.Mat) ok(); else if (self.cv) self.cv.onRuntimeInitialized = ok; else setTimeout(w, 50); })();

  // Canny edge + contour object-box detection: finds rectangular regions that look like discrete
  // objects, merges overlapping boxes, and caps the result to the 20 largest.
  function boxes(img) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(g, g, new cv.Size(3, 3), 0);
    var e = new cv.Mat(); cv.Canny(g, e, 40, 130); var k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(e, e, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(e, cs, h, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    var raw = [], minA = W * H * 0.0025, maxA = W * H * 0.55;
    for (var i = 0; i < cs.size(); i++) { var ci = cs.get(i); var r = cv.boundingRect(ci); ci.delete(); var a = r.width * r.height; if (a >= minA && a <= maxA && r.width > 10 && r.height > 10) raw.push({ x: r.x, y: r.y, w: r.width, h: r.height }); }
    raw.sort(function (a, b) { return b.w * b.h - a.w * a.h; }); if (raw.length > 20) raw = raw.slice(0, 20);
    var gap = Math.round(Math.max(W, H) * 0.012), ch = true, guard = 0;
    while (ch && guard++ < 2000) { ch = false; for (var i2 = 0; i2 < raw.length && !ch; i2++) for (var j = i2 + 1; j < raw.length; j++) { var A = raw[i2], C = raw[j]; if (A.x < C.x + C.w + gap && C.x < A.x + A.w + gap && A.y < C.y + C.h + gap && C.y < A.y + A.h + gap) { var nx = Math.min(A.x, C.x), ny = Math.min(A.y, C.y); raw.splice(j, 1); raw.splice(i2, 1, { x: nx, y: ny, w: Math.max(A.x + A.w, C.x + C.w) - nx, h: Math.max(A.y + A.h, C.y + C.h) - ny }); ch = true; break; } } }
    var kept = raw.filter(function (b) { return b.w * b.h <= W * H * 0.85 && b.w > 14 && b.h > 14; }).sort(function (a, b) { return b.w * b.h - a.w * a.h; }).slice(0, 20);
    [src, g, e, k, h].forEach(function (m) { m.delete(); }); cs.delete();
    return kept;
  }

  // Text-region detector that catches LOW-CONTRAST / WHITE text (which edge detection misses):
  // boost local contrast -> morphological gradient (responds to strokes of any polarity) -> Otsu ->
  // connect characters into text lines with a wide horizontal kernel -> boxes with a text-like shape.
  function textBoxes(img) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
    try { if (cv.CLAHE) { var cl = new cv.CLAHE(2.0, new cv.Size(8, 8)); cl.apply(g, g); cl.delete(); } else cv.equalizeHist(g, g); }
    catch (e0) { try { cv.equalizeHist(g, g); } catch (e1) { } }
    var k1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    var grad = new cv.Mat(); cv.morphologyEx(g, grad, cv.MORPH_GRADIENT, k1);
    var bw = new cv.Mat(); cv.threshold(grad, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    var kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(9, Math.round(W * 0.03)), 3));
    var con = new cv.Mat(); cv.morphologyEx(bw, con, cv.MORPH_CLOSE, kx);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(con, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [], minA = W * H * 0.0008;
    for (var i = 0; i < cs.size(); i++) {
      var ci = cs.get(i), r = cv.boundingRect(ci); ci.delete();
      var a = r.width * r.height, ar = r.width / Math.max(1, r.height);
      if (a >= minA && r.width > W * 0.04 && r.height > H * 0.012 && r.height < H * 0.4 && ar > 1.2 && a < W * H * 0.6)
        out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    out.sort(function (a, b) { return b.w * b.h - a.w * a.h; }); if (out.length > 24) out = out.slice(0, 24);
    [src, g, grad, bw, con, k1, kx, h].forEach(function (m) { m.delete(); }); cs.delete();
    return out;
  }

  // Seeded GrabCut: a work rect plus a seed point carve the object inside that rect.
  function grab(img, seed, work) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD));
    cv.rectangle(mask, new cv.Point(work.x, work.y), new cv.Point(work.x + work.w, work.y + work.h), new cv.Scalar(cv.GC_PR_BGD), -1);
    var md = Math.min(work.w, work.h), rB = Math.max(8, Math.round(md * 0.32)), rS = Math.max(3, Math.round(md * 0.1));
    cv.circle(mask, new cv.Point(seed.cx, seed.cy), rB, new cv.Scalar(cv.GC_PR_FGD), -1);
    cv.circle(mask, new cv.Point(seed.cx, seed.cy), rS, new cv.Scalar(cv.GC_FGD), -1);
    var bg = new cv.Mat(), fg = new cv.Mat(); cv.grabCut(rgb, mask, new cv.Rect(0, 0, 1, 1), bg, fg, 3, cv.GC_INIT_WITH_MASK);
    var fm = cv.Mat.zeros(H, W, cv.CV_8UC1), dat = mask.data, fd = fm.data; for (var i = 0; i < dat.length; i++) { var v = dat[i]; if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fd[i] = 255; }
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(fm, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var pick = -1, pa = 0; for (var i3 = 0; i3 < cs.size(); i3++) { var c = cs.get(i3), a = cv.contourArea(c), r = cv.boundingRect(c), ins = seed.cx >= r.x && seed.cx <= r.x + r.width && seed.cy >= r.y && seed.cy <= r.y + r.height; if ((ins && a > pa) || (pick < 0 && a > pa)) { pa = a; pick = i3; } c.delete(); }
    var pts = null;
    if (pick >= 0) { var cc = cs.get(pick), ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.0025 * cv.arcLength(cc, true), true); pts = []; for (var i4 = 0; i4 < ap.rows; i4++) pts.push({ x: ap.intPtr(i4, 0)[0], y: ap.intPtr(i4, 0)[1] }); ap.delete(); cc.delete(); }
    [src, rgb, mask, bg, fg, fm, h].forEach(function (m) { m.delete(); }); cs.delete();
    return (pts && pts.length >= 3) ? pts : null;
  }

  /* Reduces a binary mask in-place to the single 4/8-connected blob containing `seed`. Used to
     stop a wand pick from spanning several same-coloured elements (see the call site). */
  function keepSeedComponent(mask, seed) {
    var labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    var n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
    if (n > 2) {                                    // 0 is background; >1 real blob means a choice
      var sx = Math.max(0, Math.min(mask.cols - 1, seed.cx | 0));
      var sy = Math.max(0, Math.min(mask.rows - 1, seed.cy | 0));
      var lbl = labels.intPtr(sy, sx)[0];
      // The seed can land on a hole left by MORPH_CLOSE; only filter when it is on a real blob.
      if (lbl > 0) {
        var md = mask.data, ld = labels.data32S;
        for (var i = 0; i < ld.length; i++) if (ld[i] !== lbl) md[i] = 0;
      }
    }
    labels.delete(); stats.delete(); cents.delete();
  }

  // Hybrid color->object magic wand: flood-fill the same-colour pixels at the click (within `tol`),
  // then let grabCut grow that seed into the complete object (shadows/edges included). Returns its
  // contour as a polygon, traced at `eps` fidelity (smaller = hugs the edge more tightly).
  function wand(img, seed, tol, eps) {
    var EPS = (typeof eps === 'number' && eps > 0) ? eps : 0.0022;
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var ff = cv.Mat.zeros(H + 2, W + 2, cv.CV_8UC1);
    var d = new cv.Scalar(tol, tol, tol, tol);
    var flags = 8 | (255 << 8) | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE;
    cv.floodFill(rgb, ff, new cv.Point(seed.cx, seed.cy), new cv.Scalar(0, 0, 0), new cv.Rect(), d, d, flags);
    var roi = ff.roi(new cv.Rect(1, 1, W, H)), region = new cv.Mat(); roi.copyTo(region); roi.delete();
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(region, region, cv.MORPH_CLOSE, k);
    /* Keep ONLY the blob the user actually clicked. floodFill itself is connected, but the
       MORPH_CLOSE above dilates then erodes, which can bridge a clicked element to a nearby
       same-coloured one; and in a design/ad layout the same brand colour is deliberately reused
       (a small "now at" pill and a large product card, say). Everything downstream — grabCut's
       foreground seeding and the contour pick — then sees several disconnected blobs and can
       return one the user never clicked. Restricting to the seed's own component here means the
       wand can only ever grow the thing under the cursor. */
    keepSeedComponent(region, seed);
    var area = cv.countNonZero(region);
    var pts = null;
    if (area > 0) {
      var fm;
      /* A flood that swallowed nearly the whole frame is ambiguous: it is either a deliberate
         click on a flat background, or — far more often — a LEAK, where a low-contrast subject
         and its surroundings fall inside `tol` and the fill escapes into the background. Trusting
         the mask in the leak case returns the entire canvas as "the selection", which is never
         what a user clicking on an object wanted (measured: a 600px subject on a 1200px canvas
         selected all 1200px once tolerance passed 24).
         Distinguishing the two from the mask alone is not possible, so re-run the fill with a
         progressively TIGHTER tolerance and keep the first result that stops short of the frame.
         If every attempt still floods, the click really was on a flat background and the mask is
         taken as-is. */
      if (area > W * H * 0.9) {
        var tight = null;
        for (var ti = 0; ti < 3 && !tight; ti++) {
          var t2 = Math.max(4, Math.round(tol / (2 << ti)));
          var ff2 = cv.Mat.zeros(H + 2, W + 2, cv.CV_8UC1);
          var d2 = new cv.Scalar(t2, t2, t2, t2);
          cv.floodFill(rgb, ff2, new cv.Point(seed.cx, seed.cy), new cv.Scalar(0, 0, 0), new cv.Rect(), d2, d2, flags);
          var roi2 = ff2.roi(new cv.Rect(1, 1, W, H)), r2 = new cv.Mat(); roi2.copyTo(r2); roi2.delete();
          cv.morphologyEx(r2, r2, cv.MORPH_CLOSE, k);
          var a2 = cv.countNonZero(r2);
          if (a2 > W * H * 0.0008 && a2 <= W * H * 0.9) { tight = r2; } else { r2.delete(); }
          ff2.delete();
        }
        if (tight) { region.delete(); region = tight; area = cv.countNonZero(region); }
      }
      if (area > W * H * 0.9 || area < W * H * 0.0008) {
        fm = region.clone();   // genuinely flat fill (background) or speck -> skip grabCut
      } else {
        var gm = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_BGD));
        gm.setTo(new cv.Scalar(cv.GC_PR_FGD), region);
        var core = new cv.Mat(); cv.erode(region, core, k);
        if (cv.countNonZero(core) > 0) gm.setTo(new cv.Scalar(cv.GC_FGD), core);
        var bg = new cv.Mat(), fg = new cv.Mat();
        try { cv.grabCut(rgb, gm, new cv.Rect(0, 0, 1, 1), bg, fg, 3, cv.GC_INIT_WITH_MASK); } catch (e) { }
        fm = cv.Mat.zeros(H, W, cv.CV_8UC1); var gd = gm.data, fd = fm.data;
        for (var i = 0; i < gd.length; i++) { var v = gd[i]; if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fd[i] = 255; }
        [gm, core, bg, fg].forEach(function (m) { m.delete(); });
      }
      cv.GaussianBlur(fm, fm, new cv.Size(3, 3), 0); cv.threshold(fm, fm, 127, 255, cv.THRESH_BINARY);
      var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(fm, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      /* Prefer the contour that actually CONTAINS the click, and only fall back to "largest" when
         nothing does. The previous test used the bounding BOX plus a `pick < 0 || a > pa` mix that
         let a bigger contour win even when a smaller one held the seed — clicking a small element
         could hand back a larger same-coloured one elsewhere on the canvas. pointPolygonTest is
         true containment, so an L-shaped or concave neighbour whose bbox merely overlaps the click
         no longer qualifies. */
      var pick = -1, pa = 0, hit = -1, ha = 0;
      for (var j = 0; j < cs.size(); j++) {
        var c = cs.get(j), a = cv.contourArea(c);
        if (cv.pointPolygonTest(c, new cv.Point(seed.cx, seed.cy), false) >= 0) {
          if (hit < 0 || a < ha) { ha = a; hit = j; }     // smallest containing contour = the clicked element
        }
        if (a > pa) { pa = a; pick = j; }
        c.delete();
      }
      if (hit >= 0) pick = hit;
      if (pick >= 0) { var cc = cs.get(pick), ap = new cv.Mat(); cv.approxPolyDP(cc, ap, EPS * cv.arcLength(cc, true), true); pts = []; for (var p = 0; p < ap.rows; p++) pts.push({ x: ap.intPtr(p, 0)[0], y: ap.intPtr(p, 0)[1] }); ap.delete(); cc.delete(); }
      fm.delete(); cs.delete(); h.delete();
    }
    [src, rgb, ff, region, k].forEach(function (m) { m.delete(); });
    return (pts && pts.length >= 3) ? pts : null;
  }

  // Polygon clipping (union): rasterise every selected polygon into one mask, then re-trace it.
  // Overlapping/touching polygons merge into a single outline; disjoint ones stay separate.
  function unionPolys(W, H, polys) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1), mv = new cv.MatVector(), tmp = [];
    for (var i = 0; i < polys.length; i++) {
      var pl = polys[i]; if (!pl || pl.length < 3) continue;
      var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0);
      var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm);
    }
    cv.fillPoly(m, mv, new cv.Scalar(255));
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, k);   // bridge hairline gaps so touching objects fuse
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) {
      var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; }
      var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.006 * cv.arcLength(cc, true), true);
      var pts = []; for (var p = 0; p < ap.rows; p++) pts.push({ x: ap.intPtr(p, 0)[0], y: ap.intPtr(p, 0)[1] });
      if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete();
    }
    tmp.forEach(function (x) { x.delete(); }); [m, k, h].forEach(function (x) { x.delete(); }); mv.delete(); cs.delete();
    return out;
  }

  // Rasterise polys, grow (r>0) / shrink (r<0) by |r| px, re-trace. Selection Expand/Contract.
  function morphPolys(W, H, polys, r) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1), mv = new cv.MatVector(), tmp = [];
    for (var i = 0; i < polys.length; i++) { var pl = polys[i]; if (!pl || pl.length < 3) continue; var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0); var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm); }
    cv.fillPoly(m, mv, new cv.Scalar(255));
    var rr = Math.max(1, Math.round(Math.abs(r))), k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * rr + 1, 2 * rr + 1));
    if (r >= 0) cv.dilate(m, m, k); else cv.erode(m, m, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.004 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    tmp.forEach(function (x) { x.delete(); }); [m, k, h].forEach(function (x) { x.delete(); }); mv.delete(); cs.delete();
    return out;
  }

  // base minus cut (alt-click subtract): fill base at 255, punch the cut back to 0, re-trace.
  function subtractPolys(W, H, base, cut) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1);
    function fill(polys, val) { var mv = new cv.MatVector(), tmp = []; for (var i = 0; i < polys.length; i++) { var pl = polys[i]; if (!pl || pl.length < 3) continue; var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0); var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm); } cv.fillPoly(m, mv, new cv.Scalar(val)); tmp.forEach(function (x) { x.delete(); }); mv.delete(); }
    fill(base, 255); fill(cut, 0);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.004 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    [m, h].forEach(function (x) { x.delete(); }); cs.delete();
    return out;
  }

  // Every region whose colour matches the seed pixel within tol ("select similar", whole-image).
  function similarRegions(img, seed, tol) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var px = rgb.ucharPtr(seed.cy, seed.cx);
    var lo = new cv.Mat(rgb.rows, rgb.cols, rgb.type(), [Math.max(0, px[0] - tol), Math.max(0, px[1] - tol), Math.max(0, px[2] - tol), 0]);
    var hi = new cv.Mat(rgb.rows, rgb.cols, rgb.type(), [Math.min(255, px[0] + tol), Math.min(255, px[1] + tol), Math.min(255, px[2] + tol), 255]);
    var mask = new cv.Mat(); cv.inRange(rgb, lo, hi, mask);
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k); cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(mask, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [], minA = W * H * 0.0006;
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < minA) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.003 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    [src, rgb, lo, hi, mask, k, h].forEach(function (x) { x.delete(); }); cs.delete();
    return out.slice(0, 40);
  }

  function handle(m) {
    try {
      if (m.type === 'detect') { var dr = { id: m.id, boxes: boxes(m.img) }; if (m.text) dr.textBoxes = textBoxes(m.img); self.postMessage(dr); }
      else if (m.type === 'grabcut') self.postMessage({ id: m.id, pts: grab(m.img, m.seed, m.work) });
      else if (m.type === 'wand') self.postMessage({ id: m.id, pts: wand(m.img, m.seed, m.tol, m.eps) });
      else if (m.type === 'union') self.postMessage({ id: m.id, polys: unionPolys(m.W, m.H, m.polys) });
      else if (m.type === 'morph') self.postMessage({ id: m.id, polys: morphPolys(m.W, m.H, m.polys, m.r) });
      else if (m.type === 'subtract') self.postMessage({ id: m.id, polys: subtractPolys(m.W, m.H, m.base, m.cut) });
      else if (m.type === 'similar') self.postMessage({ id: m.id, polys: similarRegions(m.img, m.seed, m.tol) });
    }
    catch (err) { self.postMessage({ id: m.id, error: String((err && err.message) || err) }); }
  }
  self.onmessage = function (e) { var m = e.data; if (!m || !m.type) return; if (ready) handle(m); else q.push(m); };
}

/* Loaded via importScripts INSIDE the worker at runtime — never bundled as a JS module import.
   Defaults to the copy vendored at packages/core/vendor/opencv/opencv.js (see VERSION alongside
   it) so a cv-backed tool works offline and doesn't depend on unpkg.com being reachable.

   This is a root-relative path, NOT `new URL('...', import.meta.url)`: this module ships both as
   raw source (the demo imports packages/core/src/cv/worker.js directly, unbundled — import.meta.url
   would work there) AND bundled into @canvasmith/react's dist/index.js and dist/standalone.js,
   where import.meta.url would resolve against the bundled file's own location (wrong path
   entirely), and the IIFE standalone build doesn't support import.meta at all (esbuild strips it
   to an empty object). A root-relative path has none of those failure modes, but it does assume
   packages/core/vendor/opencv/opencv.js is served at that same path from the consuming site's
   root — true for this repo's own Netlify deploy, NOT guaranteed for a downstream host.
   Any host bundling @canvasmith/react (or serving the demo from a subpath) MUST either copy
   vendor/opencv/opencv.js to that path themselves, or override it explicitly:
     new CvEngine({ openCvUrl: '/my-assets/opencv.js' })
   — see packages/react/README (mount()'s `openCvUrl` option) for the React-package equivalent. */
export const DEFAULT_OPENCV_URL = '/packages/core/vendor/opencv/opencv.js';

export function cvWorkerSource(openCvUrl = DEFAULT_OPENCV_URL) {
  return 'self.OPENCV_URL=' + JSON.stringify(openCvUrl) + ';(' + cvWorkerBody.toString() + ')();';
}
