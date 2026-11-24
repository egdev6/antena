import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('embedded alert and interview audio follows simulated page visibility', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-slot-audio-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, body) => { const r = await fetch(base + url, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); assert.equal(r.ok, true); return r.json(); };
  let chrome;
  try {
    const pack = {version:1,id:'sound',title:'Sound',guest:{name:'Ana'},rounds:[{id:'r',title:'R',items:[
      {id:'video',question:'Video?',aprobado:true,media:{type:'video',file:'test.mp4'}},
      {id:'youtube',question:'YouTube?',aprobado:true,media:{type:'youtube',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}}
    ]}]};
    await post('/api/interviews/import', pack);
    const overlay = (await post('/api/custom-overlays', {name:'Audio',js:`antena.slots.place({
      alerts:{widget:'alerts',fit:'canvas',rect:[0,0,100,100]},
      interview:{widget:'interview',fit:'canvas',rect:[0,0,100,100]}
    },{duration:0})`})).overlay;
    chrome = await openChromePage(bin, base + '/custom/' + overlay.id);
    const c = chrome.cdp;
    const a = `document.querySelector('iframe[src^="/overlay"]')?.contentWindow`;
    const i = `document.querySelector('iframe[src^="/widget/interview"]')?.contentWindow`;
    await waitDom(c, `${a}?.document?.readyState === 'complete' && ${i}?.document?.readyState === 'complete'`);
    await evaluateChrome(c, `(() => {for (const w of [${a},${i}]) {w.__hidden=false; Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>w.__hidden});}
      const w=${a}; w.__spoken=0; w.__cancelled=0; w.speechSynthesis.speak=()=>w.__spoken++; w.speechSynthesis.cancel=()=>w.__cancelled++; })()`);
    await post('/api/interviews/select', {id:'sound',itemId:'video'});
    await waitDom(c, `!!${i}.document.querySelector('video.fg')`);
    assert.equal(await evaluateChrome(c, `${i}.document.querySelector('video.fg').muted`), false);
    app.bus.send('say', {text:'visible'}, ['overlay']);
    await waitDom(c, `${a}.__spoken === 1`);
    await evaluateChrome(c, `for(const w of [${a},${i}]) {w.__hidden=true; w.document.dispatchEvent(new Event('visibilitychange'));}`);
    // If the interview frame reloads under load it loses the simulated visibility: re-apply it, then expect the muted video.
    await waitDom(c, `(() => { const w = ${i}; if (!w) return false; if (w.__hidden !== true) { w.__hidden = true;
      Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => w.__hidden }); w.document.dispatchEvent(new Event('visibilitychange')); }
      return w.document.querySelector('video.fg')?.muted === true; })()`);
    assert.equal(await evaluateChrome(c, `${a}.__cancelled`), 1);
    app.bus.send('say', {text:'hidden'}, ['overlay']);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(await evaluateChrome(c, `${a}.__spoken`), 1);
    await post('/api/interviews/select', {id:'sound',itemId:'youtube'});
    await waitDom(c, `${i}.document.getElementById('text').textContent === 'YouTube?'`);
    assert.equal(await evaluateChrome(c, `!!${i}.document.querySelector('#full iframe')`), false);
    await evaluateChrome(c, `for(const w of [${a},${i}]) {w.__hidden=false; w.document.dispatchEvent(new Event('visibilitychange'));}`);
    await waitDom(c, `!!${i}.document.querySelector('#full iframe')`);
    app.bus.send('say', {text:'visible again'}, ['overlay']);
    await waitDom(c, `${a}.__spoken === 2`);
    await evaluateChrome(c, `(() => {const w=${i}; w.__hidden=true; w.document.dispatchEvent(new Event('visibilitychange'));})()`);
    await waitDom(c, `(() => { const w = ${i}; if (!w) return false; if (w.__hidden !== true) { w.__hidden = true;
      Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => w.__hidden }); w.document.dispatchEvent(new Event('visibilitychange')); }
      return !w.document.querySelector('#full iframe'); })()`);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => {app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close();});
  }
});

test('slot=1 fills the iframe over user root positioning; ordinary widget positioning is unchanged', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-slot-mode-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/widget/chat?slot=1');
    await waitDom(chrome.cdp, "document.body.classList.contains('slot') && !!document.querySelector('.root') && getComputedStyle(document.querySelector('.root')).boxSizing === 'border-box'");
    const evaluate = () => evaluateChrome(chrome.cdp, `(() => {
      const style = document.createElement('style'); style.textContent = '.root{position:absolute;top:42px;left:37px;width:200px;height:100px;color:rgb(1,2,3)}'; document.head.append(style);
      const r = document.querySelector('.root').getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height, viewport:[innerWidth,innerHeight], color:getComputedStyle(document.querySelector('.root')).color, slot:document.body.classList.contains('slot') };
    })()`);
    const slotted = await evaluate();
    assert.deepEqual([slotted.x, slotted.y, slotted.width, slotted.height], [0, 0, ...slotted.viewport]);
    assert.equal(slotted.color, 'rgb(1, 2, 3)');
    assert.equal(slotted.slot, true);
    await chrome.cdp.send('Page.navigate', { url: base + '/widget/chat' });
    await waitDom(chrome.cdp, "location.pathname === '/widget/chat' && !location.search && !!document.querySelector('.root') && getComputedStyle(document.querySelector('.root')).boxSizing === 'border-box'");
    const normal = await evaluate();
    assert.deepEqual([normal.x, normal.y, normal.width, normal.height], [37, 42, 200, 100]);
    assert.equal(normal.color, 'rgb(1, 2, 3)');
    assert.equal(normal.slot, false);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
