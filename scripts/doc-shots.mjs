/* Regenerates the screenshots used by docs/index.html. Needs the demo server running
   (`npm run demo`) and Playwright with a local Chrome:  node scripts/doc-shots.mjs [only-shot-name] */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.DEMO_URL || 'http://localhost:8901/apps/demo/';
const OUT = new URL('../docs/shots/', import.meta.url).pathname;
const ONLY = process.argv[2];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });

async function fresh({ image = true, theme = 'dark', vw = 1440, vh = 860 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: theme });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  pageerror:', e.message));
  // no autosaved session from a previous shot
  await p.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await p.goto(BASE + (image ? '?image=' + encodeURIComponent(new URL('sample.png', BASE).href) : ''), { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.ed && (!location.search || window.ed.fc.getObjects().some(o => o.type === 'image')), null, { timeout: 15000 });
  await p.waitForTimeout(700);
  return p;
}
// artboard (doc) coords -> page coords
const pt = (p, x, y) => p.evaluate(([x, y]) => {
  const ed = window.ed, r = ed.fc.upperCanvasEl.getBoundingClientRect(), v = ed.fc.viewportTransform;
  return { x: r.left + v[0] * x + v[4], y: r.top + v[3] * y + v[5] };
}, [x, y]);
const drag = async (p, a, b, steps = 18) => {
  const A = await pt(p, ...a), B = await pt(p, ...b);
  await p.mouse.move(A.x, A.y); await p.mouse.down();
  await p.mouse.move(B.x, B.y, { steps }); await p.mouse.up();
};
const click = async (p, x, y, mods = []) => { const P = await pt(p, x, y); for (const m of mods) await p.keyboard.down(m); await p.mouse.click(P.x, P.y); for (const m of mods) await p.keyboard.up(m); };
const imgId = p => p.evaluate(() => window.ed.fc.getObjects().find(o => o.type === 'image').id);
const tab = (p, t) => p.click(`#right-tabs button[data-tab="${t}"]`);
const tool = (p, t) => p.evaluate(t => window.ed.setTool(t), t);

async function buildGroup(p) {
  await p.evaluate(() => {
    const ed = window.ed, F = ed.fabric;
    const card = new F.Rect({ left: 120, top: 70, width: 340, height: 220, rx: 18, ry: 18, fill: '#ffffff', strokeWidth: 0 });
    card.set({ id: 'g-card', role: 'shape', name: 'Card' });
    const dot = new F.Ellipse({ left: 150, top: 100, rx: 56, ry: 56, fill: '#7c4dff', strokeWidth: 0 });
    dot.set({ id: 'g-dot', role: 'shape', name: 'Avatar' });
    const txt = new F.IText('Quiet light', { left: 285, top: 130, fontSize: 40, fontWeight: '700', fill: '#14161a', fontFamily: 'system-ui' });
    txt.set({ id: 'g-txt', role: 'text', name: 'Title' });
    [card, dot, txt].forEach(o => ed.fc.add(o)); ed.commit('mk');
    ed.fc.setActiveObject(new F.ActiveSelection([card, dot, txt], { canvas: ed.fc }));
    ed.groupSelection(); ed.fc.renderAll();
  });
  await p.waitForTimeout(400);
}

const shots = {
  // ── the whole editor ──
  async overview(p) {
    await p.evaluate(() => document.getElementById('add-text').click()); await p.waitForTimeout(150);
    await p.evaluate(() => { const ed = window.ed, t = ed.fc.getActiveObject(); t.set({ text: 'Quiet light', left: 70, top: 60, fill: '#ffffff', fontSize: 64 }); ed.fc.renderAll(); ed.commit('t'); });
    await p.evaluate(() => window.ed.addBadge(null, { text: 'New' }));
    await p.evaluate(() => { const ed = window.ed, o = ed.fc.getActiveObject(); o.set({ left: 760, top: 70 }); o.setCoords(); ed.fc.discardActiveObject(); ed.fc.renderAll(); ed.commit('m'); });
    await p.evaluate(id => window.ed.activate(id), await imgId(p));
    await p.waitForTimeout(300);
    return { full: true };
  },
  async theme_light(p) {
    await p.click('#theme-toggle'); await p.waitForTimeout(400);
    return { full: true };
  },
  // ── tools ──
  async rail_flyout(p) {
    await p.click('#tools .rail-btn[data-gi="1"]'); await p.waitForTimeout(250);
    return { clip: { x: 0, y: 48, width: 330, height: 420 } };
  },
  async wand(p) {
    await tool(p, 'wand'); await p.evaluate(() => window.ed.setToolOptions({ tolerance: 28 })); await click(p, 120, 140); await p.waitForFunction(() => window.ed.selection, null, { timeout: 20000 }); await p.waitForTimeout(500);
    return { stage: true };
  },
  async magicwand(p) {
    await tool(p, 'magicwand'); await click(p, 450, 330); await p.waitForFunction(() => window.ed.selection, null, { timeout: 20000 }); await p.waitForTimeout(500);
    return { stage: true };
  },
  async brush(p) {
    await tool(p, 'brush');
    await p.evaluate(() => window.ed.setToolOptions({ size: 26, color: '#d4ff45' }));
    await drag(p, [90, 380], [270, 300], 30); await drag(p, [620, 300], [820, 400], 30);
    await p.waitForTimeout(300);
    return { stage: true, panel: true };
  },
  async gradient(p) {
    await tool(p, 'marquee-ellipse'); await drag(p, [80, 80], [300, 260]);
    await tool(p, 'gradient'); await drag(p, [90, 100], [290, 240]); await p.waitForTimeout(300);
    return { stage: true, panel: true };
  },
  async crop(p) {
    await p.evaluate(id => window.ed.activate(id), await imgId(p));
    await tool(p, 'crop'); await p.waitForTimeout(400);
    return { stage: true };
  },
  async shapes(p) {
    await tool(p, 'ellipse'); await drag(p, [620, 60], [820, 250]); await p.evaluate(() => { window.ed.setFill('#ffd23f'); window.ed.setStroke({ width: 0 }); });
    await tool(p, 'rect'); await drag(p, [60, 300], [260, 460]);
    await p.evaluate(() => { const ed = window.ed; ed.setShapeGradient([{ offset: 0, color: '#d4ff45' }, { offset: 1, color: '#7c4dff' }], 'linear', 45); ed.setStroke({ width: 6, color: '#ffffff', dash: [14, 8] }); });
    await p.evaluate(() => window.ed.setTool('select')); await p.waitForTimeout(300);
    return { full: true };
  },
  async pen(p) {
    await tool(p, 'pen');
    await click(p, 120, 420); await drag(p, [300, 200], [380, 160], 10); await drag(p, [560, 400], [640, 440], 10); await click(p, 780, 180);
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    await p.evaluate(() => { const ed = window.ed, o = ed.fc.getObjects().at(-1); ed.editPath(o.id); });
    await p.waitForTimeout(300);
    return { stage: true };
  },
  async text(p) {
    await p.evaluate(() => document.getElementById('add-text').click()); await p.waitForTimeout(150);
    await p.evaluate(() => { const ed = window.ed, t = ed.fc.getActiveObject(); t.set({ text: 'Quiet light', left: 70, top: 60, fill: '#ffffff', fontSize: 72 }); t.setCoords(); ed.fc.renderAll(); ed.commit('t'); });
    await p.waitForTimeout(300);
    return { stage: true, panel: true };
  },
  // ── image properties ──
  async adjust(p) {
    await p.evaluate(id => { const ed = window.ed; ed.activate(id); ed.setImageFilters({ exposure: 0.25, contrast: 112, temperature: 22, saturate: 118, vibrance: 15 }); }, await imgId(p));
    await p.click('#curves-toggle'); await p.waitForTimeout(400);
    await p.evaluate(() => document.getElementById('adjust-section').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(200);
    return { full: true };
  },
  async layers_mask(p) {
    await p.evaluate(() => document.getElementById('add-text').click()); await p.waitForTimeout(100);
    await p.evaluate(() => document.getElementById('add-box').click()); await p.waitForTimeout(100);
    await p.evaluate(() => window.ed.addAdjustmentLayer({}));
    const id = await imgId(p);
    await p.evaluate(id => { const ed = window.ed; ed.addMask(id); ed.activate(id); }, id);
    await p.waitForTimeout(300);
    return { clip: { x: 56, y: 48, width: 290, height: 420 } };
  },
  async context_menu(p) {
    await p.evaluate(id => window.ed.activate(id), await imgId(p));
    const P = await pt(p, 450, 300); await p.mouse.click(P.x, P.y, { button: 'right' }); await p.waitForTimeout(300);
    return { full: true };
  },
  async command_palette(p) {
    await p.click('#cmdk-open'); await p.waitForTimeout(200); await p.keyboard.type('fill'); await p.waitForTimeout(250);
    return { full: true };
  },
  async export_menu(p) {
    await p.click('#export-btn'); await p.waitForTimeout(250);
    return { clip: { x: 1100, y: 0, width: 340, height: 360 } };
  },
  async canvas_size(p) {
    await p.click('#canvas-size-btn'); await p.waitForTimeout(250);
    return { clip: { x: 700, y: 0, width: 480, height: 300 } };
  },

  // ── worked examples ──
  async group_layers(p) {
    await buildGroup(p);
    return { clip: { x: 56, y: 48, width: 290, height: 420 } };
  },
  async group_enter(p) {
    await buildGroup(p);
    await p.evaluate(() => { window.ed.fc.discardActiveObject(); window.ed.fc.renderAll(); });
    const P = await pt(p, 215, 150);   // the ellipse member of the group
    await p.mouse.dblclick(P.x, P.y); await p.waitForTimeout(400);
    return { full: true };
  },
  async recipe_post(p) {
    await p.evaluate(() => {
      const ed = window.ed, F = ed.fabric;
      const scrim = new F.Rect({ left: 0, top: 340, width: 960, height: 249, fill: '#000000', opacity: 0.55, strokeWidth: 0 });
      scrim.set({ id: 'scrim', role: 'shape', name: 'Scrim' }); ed.fc.add(scrim);
      const t = new F.IText('Light a little calm', { left: 60, top: 395, fontSize: 64, fontWeight: '700', fill: '#ffffff', fontFamily: 'system-ui' });
      t.set({ id: 'title', role: 'text', name: 'Headline' }); ed.fc.add(t);
      ed.commit('scrim');
      ed.addCTA(null, { text: 'Shop the collection' });
      const c = ed.fc.getActiveObject(); c.set({ left: 60, top: 500 }); c.setCoords();
      ed.addBadge(null, { text: 'New' });
      const b = ed.fc.getActiveObject(); b.set({ left: 800, top: 60 }); b.setCoords();
      ed.fc.discardActiveObject(); ed.fc.renderAll(); ed.commit('recipe');
    });
    await p.waitForTimeout(400);
    return { stage: true };
  },
  async slider_reset(p) {
    await p.evaluate(id => { const ed = window.ed; ed.activate(id); ed.setImageFilters({ exposure: 0.8, saturate: 160 }); }, await imgId(p));
    await p.evaluate(() => document.getElementById('adjust-section').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(400);
    return { clip: { x: 1118, y: 48, width: 322, height: 380 } };
  },
  async removebg(p) {
    const id = await imgId(p);
    const r = await p.evaluate(id => window.ed.removeBackground({ method: 'local', id }), id);
    console.log('  removeBackground ->', JSON.stringify(r));
    await p.evaluate(() => {
      const ed = window.ed, F = ed.fabric;
      const bg = new F.Rect({ left: 0, top: 0, width: ed.W, height: ed.H, strokeWidth: 0 });
      bg.set({ id: 'newbg', role: 'shape', name: 'Backdrop' }); ed.fc.add(bg); ed.fc.setActiveObject(bg);
      ed.setShapeGradient([{ offset: 0, color: '#ff9a62' }, { offset: 1, color: '#6a3de8' }], 'linear', 135);
      ed.arrangeSelection('bottom'); ed.fc.discardActiveObject(); ed.fc.renderAll(); ed.commit('bg');
    });
    await p.evaluate(id => window.ed.activate(id), id); await p.waitForTimeout(500);
    return { full: true };
  },
  async removebg_touchup(p) {
    const id = await imgId(p);
    await p.evaluate(id => window.ed.removeBackground({ method: 'local', id }), id);
    await p.evaluate(id => { window.ed.activate(id); window.ed.enterMaskEdit(id); }, id);
    await p.waitForTimeout(500);
    await p.evaluate(() => document.getElementById('maskedit-banner').scrollIntoView({ block: 'start' }));
    return { full: true };
  },
  // ── right-panel tabs ──
  async design_tab(p) { await tab(p, 'design'); await p.waitForTimeout(200); return { panel: true }; },
  async stickers_tab(p) {
    await tab(p, 'stickers'); await p.waitForTimeout(200);
    await p.click('#sticker-grid > *:first-child').catch(() => {}); await p.waitForTimeout(300);
    return { full: true };
  },
  async ai_tab(p) { await tab(p, 'ai'); await p.waitForTimeout(200); return { panel: true }; },
  async ai_vision(p) { await p.click('.lp-tab[data-tab="ai"]'); await p.waitForTimeout(200); return { clip: { x: 56, y: 48, width: 290, height: 812 } }; },
};

for (const [name, fn] of Object.entries(shots)) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  const p = await fresh();
  try {
    const o = await fn(p);
    const path = OUT + name + '.png';
    if (o.full) await p.screenshot({ path });
    else if (o.clip) await p.screenshot({ path, clip: o.clip });
    else if (o.stage && o.panel) await p.screenshot({ path, clip: { x: 346, y: 48, width: 1094, height: 812 } });
    else if (o.stage) await p.locator('#stage').screenshot({ path });
    else if (o.panel) await p.locator('#right-panel').screenshot({ path });
    console.log('✓', name);
  } catch (e) { console.log('✗', name, e.message.split('\n')[0]); }
  await p.context().close();
}
await browser.close();
