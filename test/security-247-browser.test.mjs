// #247: navegador real para el SVG y los medios como subrecursos de overlay y widget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function wav() {
  const b = Buffer.alloc(844, 128);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(800, 40);
  return b;
}

async function fixture(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-247-browser-'));
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.timers.stop(); app.viewers.stop(); app.meld.stop(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  for (const [name, body] of [['pixel.png', PNG], ['tono.wav', wav()],
    ['script.svg', '<svg xmlns="http://www.w3.org/2000/svg" style="color:rgb(1, 2, 3)"><script>document.documentElement.setAttribute("data-ran", "yes")</script><rect width="1" height="1"/></svg>']]) {
    const response = await fetch(`${base}/api/media/upload?name=${name}`, { method: 'POST', body });
    assert.equal(response.status, 200);
  }
  return { bin, base };
}

test('247 S1: un SVG abierto no ejecuta script y mantiene estilo en línea', { timeout: 30000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const chrome = await openChromePage(f.bin, `${f.base}/media/script.svg`);
  try {
    await waitDom(chrome.cdp, `document.readyState === 'complete' && document.documentElement.localName === 'svg'`, { timeoutMs: 10000 });
    assert.equal(await evaluateChrome(chrome.cdp, `document.documentElement.getAttribute('data-ran')`), null);
    assert.equal(await evaluateChrome(chrome.cdp, `getComputedStyle(document.documentElement).color`), 'rgb(1, 2, 3)');
  } finally { await closeChrome(chrome); }
});

test('247 S1 PRESERVE: overlay y widget cargan imagen y reproducen audio y vídeo como subrecursos', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  for (const page of ['/overlay', '/widget/latest']) {
    const chrome = await openChromePage(f.bin, f.base + page);
    try {
      await waitDom(chrome.cdp, `document.readyState === 'complete'`, { timeoutMs: 10000 });
      // userGesture evita que la política de autoplay de Chrome confunda el resultado CSP.
      const reply = await chrome.cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, userGesture: true, expression: `(async () => {
        try {
          if (${JSON.stringify(page === '/overlay')}) {
            // Un vídeo real con fotogramas, creado por el navegador y subido por la API pública.
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
            const ctx = canvas.getContext('2d'), stream = canvas.captureStream(15), chunks = [];
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
            const recording = new Promise((resolve, reject) => {
              recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
              recorder.onerror = reject; recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
            });
            recorder.start();
            await new Promise(resolve => { let n = 0; const timer = setInterval(() => {
              ctx.fillStyle = n % 2 ? 'red' : 'blue'; ctx.fillRect(0, 0, 16, 16);
              if (++n === 8) { clearInterval(timer); recorder.stop(); resolve(); }
            }, 75); });
            const clip = await recording; stream.getTracks().forEach(track => track.stop());
            const uploaded = await fetch('/api/media/upload?name=clip.webm', { method: 'POST', body: clip });
            if (!uploaded.ok) throw new Error('subida de vídeo');
          }
          const image = document.createElement('img');
          const loaded = new Promise((resolve, reject) => { image.onload = () => resolve(image.naturalWidth); image.onerror = () => reject(new Error('imagen')); });
          image.src = '/media/pixel.png'; document.body.append(image);
          const play = async (tag, src) => {
            const el = document.createElement(tag); el.muted = true; el.src = src; document.body.append(el);
            await el.play(); await new Promise((resolve, reject) => { el.onended = resolve; el.onerror = reject; });
            return el.currentTime > 0 && (tag !== 'video' || el.videoWidth === 16);
          };
          return [await loaded, await play('audio', '/media/tono.wav'), await play('video', '/media/clip.webm')];
        } catch (error) { return { error: String(error) }; }
      })()` });
      assert.deepEqual(reply.result?.value, [1, true, true], page);
    } finally { await closeChrome(chrome); }
  }
});
