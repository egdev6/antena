import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const q = JSON.stringify;
const input = field => `document.querySelector('[data-field="${field}"] input')`;
const save = `[...document.querySelectorAll('.lv-sfoot button')].find(b=>b.textContent.trim()==='Guardar')`;
const designTab = `[...document.querySelectorAll('.lv-stabs [role="tab"]')].find(b=>b.textContent.trim().startsWith('Diseño'))`;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1, `${actual} ≈ ${expected}`);

test('image/video backgrounds move independently; panel saves and reloads both offsets', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-background-browser-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal(r.status, 200, url); return r.json();
  };
  let chrome;
  try {
    await api('PUT', '/api/config', { panel: { onboardingDone: true } });
    await api('PUT', '/api/theme', { animation: 'none', tilt: false, sound: 'none', decorations: false });
    chrome = await openChromePage(bin, base + '/overlay?still=follow');
    const c = chrome.cdp, ev = expr => evaluateChrome(c, expr);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await waitDom(c, `location.href===${q(base + '/overlay?still=follow')} && document.readyState==='complete'`);
    async function navigate(url, ready, reload = false) {
      // CDP can acknowledge navigation while selectors still match the old document.
      await ev(`document.__backgroundPreviousDocument = true`);
      await c.send(reload ? 'Page.reload' : 'Page.navigate', reload ? {} : { url });
      await waitDom(c, `location.href===${q(url)} && !document.__backgroundPreviousDocument && (${ready})`);
    }
    // Real decodable image and VP8 video, uploaded only to this isolated test app.
    const uploads = await ev(`(async()=>{
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
      const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,160,90);
      const png=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const a=await fetch('/api/media/upload?name=background.png',{method:'POST',body:png});
      const stream=canvas.captureStream(15),chunks=[],rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      const done=new Promise((resolve,reject)=>{rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};rec.onerror=reject;rec.onstop=()=>resolve(new Blob(chunks,{type:'video/webm'}))});
      rec.start();await new Promise(r=>{let n=0;const timer=setInterval(()=>{ctx.fillStyle=n%2?'red':'blue';ctx.fillRect(0,0,160,90);if(++n===8){clearInterval(timer);rec.stop();r()}},75)});
      const clip=await done;stream.getTracks().forEach(t=>t.stop());
      const b=await fetch('/api/media/upload?name=background.webm',{method:'POST',body:clip});return [a.status,b.status];
    })()`);
    assert.deepEqual(uploads, [200, 200]);
    let revision = 0;
    async function render(patch) {
      await api('PUT', '/api/alerts/follow', patch);
      await navigate(base + '/overlay?still=follow&case=' + ++revision,
        `!!document.querySelector('#stage .alert-mixed.on') && (()=>{const m=document.querySelector('#bg .alert-media');return m && (m.naturalWidth>0 || m.videoWidth>0)})()`);
      await ev(`document.fonts.ready.then(()=>true)`);
      return ev(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};return {bg:rect('#bg .alert-media'),card:rect('#stage .card')}})()`);
    }
    for (const media of ['background.png', 'background.webm']) {
      const initial = await render({ layout: 'mixed', media, mediaSize: 50, bgX: 0, bgY: 0, cardX: 0, cardY: 0, textDelayMs: 0 });
      closeTo(initial.bg.x, 480); closeTo(initial.bg.y, 270);
      const moved = await render({ bgX: 120, bgY: -70 });
      closeTo(moved.bg.x - initial.bg.x, 120); closeTo(moved.bg.y - initial.bg.y, -70);
      closeTo(moved.card.x, initial.card.x); closeTo(moved.card.y, initial.card.y);
      const cardMoved = await render({ cardX: -40, cardY: 30 });
      assert.deepEqual(cardMoved.bg, moved.bg);
      closeTo(cardMoved.card.x - moved.card.x, -40); closeTo(cardMoved.card.y - moved.card.y, 30);
      // Actual editor controls, not a direct API substitute for saving the UI.
      await navigate(base + '/#/alertas/follow', `!!(${designTab})`);
      await ev(`(${designTab}).click()`);
      await waitDom(c, `!!${input('bgX')} && !!${input('bgY')}`);
      for (const [field, value] of [['bgX', -160], ['bgY', 90]]) {
        await ev(`(()=>{const i=${input(field)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${value});i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
        await waitDom(c, `${input(field)}?.value===${q(String(value))}`);
      }
      await ev(`(${save}).click()`);
      await waitDom(c, `document.querySelector('.lv-sfoot .lv-dirty')?.textContent.trim()==='Todo guardado'`);
      const look = (await api('GET', '/api/alerts/follow/sample')).alert.look;
      assert.deepEqual([look.bgX, look.bgY, look.cardX, look.cardY], [-160, 90, -40, 30]);
      await navigate(base + '/#/alertas/follow', `!!(${designTab})`, true);
      await ev(`(${designTab}).click()`);
      await waitDom(c, `${input('bgX')}?.value==='-160' && ${input('bgY')}?.value==='90'`);
    }
    // Other layouts do not gain or move a separate background layer.
    for (const layout of ['card', 'media']) {
      await api('PUT', '/api/alerts/follow', { layout });
      await navigate(base + '/overlay?still=follow&case=' + ++revision, `!!document.querySelector('#stage .alert.on')`);
      assert.equal(await ev(`!!document.querySelector('#bg .alert-media')`), false);
    }
  } finally {
    if (chrome) await closeChrome(chrome);
    app.timers.stop(); app.viewers.stop(); app.meld.stop(); await app.closeHttp();
    await rm(root, { recursive: true, force: true });
  }
});
