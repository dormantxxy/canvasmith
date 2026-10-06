import { chromium } from 'playwright';
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 860 } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 300)));
await p.goto('http://localhost:8931/_parity_react.html', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000);
await p.screenshot({ path: '/private/tmp/claude-502/-Users-rizwan1-Desktop-canvasmith/8cb1c793-4a36-4e54-b730-ceedc091151c/scratchpad/parity2/initial.png' });
for (const t of ['clone', 'crop', 'marquee', 'magicwand']) { await p.evaluate(t => window.__mounted.editor().setTool(t), t); await p.waitForTimeout(300); await p.screenshot({ path: '/private/tmp/claude-502/-Users-rizwan1-Desktop-canvasmith/8cb1c793-4a36-4e54-b730-ceedc091151c/scratchpad/parity2/' + t + '.png' }); }
console.log(errs); await b.close();
