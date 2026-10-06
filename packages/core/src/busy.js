/* A small spinning ring drawn just below-right of the pointer while a click-to-select pick is
   being computed (magic wand / object select run in the OpenCV worker, and the very first pick
   also waits for OpenCV to load). CSS cursors can't animate, so the shells draw this on the
   canvas overlay instead; the Editor keeps re-rendering while it's busy (see _setPickBusy).

   `st` is what the Editor emits on 'pickbusy': { x, y } in scene px, or null. `z` is the zoom, so
   the ring stays the same size on screen; ctx is already in scene space. */
export function drawPickSpinner(ctx, st, z, opts = {}) {
  if (!st) return;
  const px = 1 / (z || 1), accent = opts.accent || '#4f8ff0';
  const cx = st.x + 16 * px, cy = st.y + 16 * px, r = 7 * px;
  const a = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000) * Math.PI * 2 * 1.1;
  ctx.save();
  ctx.setLineDash([]); ctx.lineCap = 'round';
  // backing disc so it reads over any photo
  ctx.beginPath(); ctx.arc(cx, cy, r + 4 * px, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20,20,24,.72)'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 2.2 * px; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, a, a + Math.PI * 1.25);
  ctx.strokeStyle = accent; ctx.stroke();
  ctx.restore();
}
