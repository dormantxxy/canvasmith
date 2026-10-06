import { chromium } from 'playwright';
const SP = '/private/tmp/claude-502/-Users-rizwan1-Desktop-canvasmith/8cb1c793-4a36-4e54-b730-ceedc091151c/scratchpad/parity3';
const TOOLS = ['select','brush','eraser','clone','heal','dodge','marquee','lasso','wand','magicwand','objectselect','rect','type','bucket','gradient','eyedropper','crop','pen','aiinsert'];
const b = await chromium.launch();
async function shell(name, url, getEd, clicks) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 860 } });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await p.waitForTimeout(6000);
  await p.screenshot({ path: SP + '/' + name + '-00-initial.png' });
  for (const t of TOOLS) {
    await p.evaluate(([g, t]) => { const ed = eval(g); ed.setTool(t); }, [getEd, t]); await p.waitForTimeout(250);
    await p.screenshot({ path: SP + '/' + name + '-tool-' + t + '.png' });
  }
  await p.evaluate(([g]) => { const ed = eval(g); ed.setTool('select'); }, [getEd]);
  for (const [label, sel] of clicks) { try { await p.click(sel, { timeout: 3000 }); await p.waitForTimeout(350); await p.screenshot({ path: SP + '/' + name + '-ui-' + label + '.png' }); } catch (e) { errs.push('click ' + label + ': ' + String(e).slice(0, 80)); } }
  console.log(name, errs); await ctx.close();
}
await shell('react', 'http://localhost:8931/_parity_react.html', 'window.__mounted.editor()', [
  ['design', '.cm-tabs button:nth-child(2)'], ['stickers', '.cm-tabs button:nth-child(3)'], ['ai', '.cm-tab-ai'],
  ['aivision', '.cm-lp-tab-ai'], ['properties', '.cm-tabs button:nth-child(1)']]);
await b.close();
