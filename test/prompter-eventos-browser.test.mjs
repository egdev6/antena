// S7-S9 en navegador: el panel del prompter tiene dos pestañas (Eventos y Preguntas), Eventos
// apila Cronología y Destacados, cada bloque con su cuenta, su scroll y su estado vacío, con
// icono de plataforma y minuto. Se mide la cabecera (~28 px), el botón Enviar (44 px, igual que
// el input) y se comprueba que ya no están la tier list, el sorteo, los filtros ni «Marca de short».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const dom = (cdp, expr) => evaluateChrome(cdp, expr, { timeoutMs: 12000 });
const apiPost = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const json = async (cdp, expr) => JSON.parse(await dom(cdp, `JSON.stringify(${expr})`));

test('prompter: Eventos con Cronología y Destacados, cabecera compacta y sin los controles retirados', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-eventos-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, { timeoutMs: 15000 });

    // S7: dos pestañas, Eventos primero; nada de tier list, sorteo, filtros ni «Por agradecer»
    const tabs = await json(c, `Array.from(document.querySelectorAll('.pr-side .tabs .tab')).map(b => b.textContent.replace(/\\d+/g, '').trim())`);
    assert.deepEqual(tabs, ['Eventos', 'Preguntas']);
    assert.equal(await dom(c, `!!document.querySelector('.pr-filters, .pr-filters-cue')`), false, 'la cronología ya no tiene pestañas de filtro (#5 retirado)');
    assert.equal(await dom(c, `Array.from(document.querySelectorAll('.pr-top button')).length`), 0, 'la cabecera ya no tiene el botón «Por agradecer»');
    assert.equal(await dom(c, `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Marca de short')`), false, 'el botón «Marca de short» ya no está');

    // S5: el estado vacío del chat lleva padding a los lados
    const pad = await dom(c, `getComputedStyle(document.querySelector('.chat .pr-empty')).paddingLeft`);
    assert.ok(parseFloat(pad) >= 12, `el estado vacío del chat lleva padding lateral (${pad})`);

    // S8: dos bloques apilados con su título, su cuenta y su estado vacío
    await waitDom(c, `document.querySelectorAll('.ev-block').length === 2 && document.querySelectorAll('.ev-empty').length === 2`, { timeoutMs: 9000 });
    const headings = await json(c, `Array.from(document.querySelectorAll('.ev-h')).map(h => h.textContent)`);
    assert.match(headings[0], /^Cronología/);
    assert.match(headings[1], /^Destacados/);
    assert.match(headings[1], /0 mensajes/, 'el título de Destacados lleva su cuenta');

    // alerta pendiente de agradecer + marca + destacado + guardado
    assert.equal((await apiPost(base, '/api/simulate', { type: 'raid', vars: { user: 'midudev', amount: 120 } })).ok, true);
    await apiPost(base, '/api/markers', { label: 'la demo del dock' });
    app.engine.handleChat({ id: 'c-hl-1', user: 'pixelmaria', text: 'este dock nuevo es la bomba', platform: 'twitch', highlighted: true });
    await apiPost(base, '/api/timeline', { kind: 'saved', user: 'ana_frontend', text: 'guardado a mano', platform: 'twitch' });

    const cron = `document.querySelectorAll('.ev-block')[0]`;
    const dest = `document.querySelectorAll('.ev-block')[1]`;
    await waitDom(c, `${cron}.textContent.includes('midudev') && ${cron}.textContent.includes('Marca de short') && ${dest}.textContent.includes('pixelmaria') && ${dest}.textContent.includes('ana_frontend')`, { timeoutMs: 9000 });

    // S8: la alerta lleva su minuto, el icono de su plataforma (tipos del estado en vivo) y «por agradecer»
    const alerta = await json(c, `(() => {
      const li = Array.from(${cron}.querySelectorAll('.ev-item')).find(x => x.textContent.includes('midudev'));
      return { cls: li.className, tag: li.querySelector('.ev-tag')?.textContent || '', min: li.querySelector('.ev-min')?.textContent || '',
        pf: li.querySelector('.pf-ico')?.getAttribute('aria-label') || '', txt: li.textContent };
    })()`);
    assert.match(alerta.cls, /is-pending/);
    assert.equal(alerta.tag, 'por agradecer');
    assert.match(alerta.min, /^\d+:\d{2}$/);
    assert.equal(alerta.pf, 'Twitch');
    assert.match(alerta.txt, /Raid/);

    // la marca de short vive en Cronología (sin logo de plataforma: no la tiene)
    const marca = await json(c, `(() => {
      const li = Array.from(${cron}.querySelectorAll('.ev-item')).find(x => x.textContent.includes('Marca de short'));
      return { min: li.querySelector('.ev-min')?.textContent || '', pf: li.querySelector('.pf-ico')?.getAttribute('aria-label') || '',
        tag: li.querySelector('.ev-tag')?.textContent || '', txt: li.textContent };
    })()`);
    assert.match(marca.min, /^\d+:\d{2}$/);
    assert.equal(marca.pf, '', 'una marca no es de plataforma: no pinta logo');
    assert.equal(marca.tag, '', 'una marca no está pendiente de agradecer');
    assert.ok(marca.txt.includes('la demo del dock'));

    // S8/S4: Destacados con icono de plataforma, usuario y minuto
    const destacado = await json(c, `(() => {
      const li = Array.from(${dest}.querySelectorAll('.ev-item')).find(x => x.textContent.includes('pixelmaria'));
      return { pf: li.querySelector('.pf-ico')?.getAttribute('aria-label') || '', min: li.querySelector('.ev-min')?.textContent || '', txt: li.textContent };
    })()`);
    assert.equal(destacado.pf, 'Twitch');
    assert.match(destacado.min, /^\d+:\d{2}$/);
    assert.ok(destacado.txt.includes('este dock nuevo es la bomba'));

    // cada uno en su bloque, sin mezclarse
    assert.equal(await dom(c, `${cron}.textContent.includes('pixelmaria')`), false, 'los destacados no se cuelan en Cronología');
    assert.equal(await dom(c, `${dest}.textContent.includes('midudev')`), false, 'las alertas no se cuelan en Destacados');

    // S8: la cuenta de por agradecer sale en la pestaña Eventos
    assert.equal(await dom(c, `document.querySelector('.pr-side .tabs .tab .eg-tabs__count')?.textContent`), '1');

    // S8: dos bloques con scroll propio que llenan el alto del panel
    const bloques = await json(c, `(() => {
      const pane = document.querySelector('.ev-pane').getBoundingClientRect().height;
      const bs = Array.from(document.querySelectorAll('.ev-block')).map(b => b.getBoundingClientRect().height);
      const scrolls = Array.from(document.querySelectorAll('.ev-list')).map(l => getComputedStyle(l).overflowY);
      return { pane, bs, scrolls };
    })()`);
    assert.deepEqual(bloques.scrolls, ['auto', 'auto']);
    assert.ok(bloques.bs.every(h => h > 20), `los dos bloques tienen alto propio: ${JSON.stringify(bloques.bs)}`);
    assert.ok(Math.abs(bloques.bs[0] + bloques.bs[1] - bloques.pane) <= 2, 'los dos bloques llenan el alto del panel');

    // S9: cabecera compacta (~28 px) y botón Enviar de 44 px, igual que el input
    const medidas = await json(c, `(() => {
      const h = document.querySelector('.pr-top').getBoundingClientRect().height;
      const i = document.querySelector('.pr-send .eg-field__control').getBoundingClientRect().height;
      const b = document.querySelector('.pr-send button[type=submit]').getBoundingClientRect().height;
      return { h, i, b };
    })()`);
    assert.ok(medidas.h <= 34, `la cabecera mide ${medidas.h}px; se esperaba ≤ 34`);
    assert.equal(Math.round(medidas.b), 44);
    assert.equal(Math.round(medidas.i), 44);
    assert.ok(Math.abs(medidas.b - medidas.i) < 0.5, 'el botón Enviar tiene el mismo alto que el input');

    // S7: Preguntas sigue con lo de antes (siguiente, ocultar y cola)
    await apiPost(base, '/api/questions', { user: 'lucia_codes', text: '¿Cómo hiciste el dock?' });
    await clickWhen(c, `Array.from(document.querySelectorAll('.pr-side .tabs .tab')).find(b => b.textContent.includes('Preguntas'))`);
    await waitDom(c, `document.querySelector('.pr-side .tabs .tab[aria-selected="true"]')?.textContent.includes('Preguntas') && document.body.textContent.includes('¿Cómo hiciste el dock?')`, { timeoutMs: 9000 });
    await clickWhen(c, `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Siguiente pregunta'))`);
    await waitDom(c, `document.querySelector('.pr-pane')?.textContent.includes('En pantalla') && document.querySelector('.pr-pane')?.textContent.includes('lucia_codes')`, { timeoutMs: 9000 });
    await clickWhen(c, `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Ocultar'))`);
    await waitDom(c, `document.body.textContent.includes('Ninguna pregunta en pantalla')`, { timeoutMs: 9000 });
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
