// #125: regresión del commit c873c9e, adaptada al scroll exclusivo de navegación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

// Incluye el pie de escritorio sin invocar Tauri, cuentas ni hardware reales.
const desktopStub = `window.__TAURI__ = { core: { invoke: async cmd => cmd === 'monitors' ? [] : null } }`;

test('barra lateral: activo, grupos y scroll exclusivo entre logo y pie', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-panel-125-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, 'about:blank');
    const c = chrome.cdp;
    const ev = expr => evaluateChrome(c, expr);
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: desktopStub });
    await c.send('Page.navigate', { url: `${base}/#/directo` });
    await waitDom(c, `!!document.querySelector('#nav .eg-menu__item[aria-current] .eg-icon') && document.querySelectorAll('.side-foot .row button').length === 2`);

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
    // como en el lienzo (v2): el icono sigue el color del texto y la entrada activa se marca con una
    // barra roja a la izquierda; el rótulo del grupo queda alineado con los iconos
    const activo = await ev(`(() => {
      const a = document.querySelector('#nav [aria-current]');
      return { icono: getComputedStyle(a.querySelector('.eg-icon')).color, texto: getComputedStyle(a).color, sombra: getComputedStyle(a).boxShadow };
    })()`);
    assert.equal(activo.icono, activo.texto, 'el icono activo usa el color del texto');
    assert.match(activo.sombra, /2px 0px 0px 0px inset/, 'la entrada activa lleva la barra roja a la izquierda');
    const alineacion = await ev(`(() => {
      const grp = document.querySelector('#nav .nav-grp .grp');
      const item = document.querySelector('#nav .nav-grp .eg-menu__item');
      const gs = getComputedStyle(grp);
      return { texto: gs.textAlign, distribucion: gs.justifyContent, rotulo: grp.querySelector('.grp-l').getBoundingClientRect().left, icono: item.querySelector('.eg-icon').getBoundingClientRect().left };
    })()`);
    assert.equal(alineacion.texto, 'left');
    assert.notEqual(alineacion.distribucion, 'center');
    assert.ok(Math.abs(alineacion.rotulo - alineacion.icono) <= 1, `rótulo e iconos alineados (${alineacion.rotulo} / ${alineacion.icono})`);
    // sin grupos plegables: todas las entradas a la vista, cada una con su icono
    assert.equal(await ev(`document.querySelectorAll('#nav .eg-menu__item').length === document.querySelectorAll('#nav .eg-menu__item > .eg-icon').length`), true);
    assert.equal(await ev(`document.querySelectorAll('#nav button').length`), 0);

    const orden = await ev(`Array.from(document.querySelectorAll('#nav a'), a => a.hash)`);
    for (const [width, height] of [[1360, 860], [900, 600], [1360, 480], [900, 360]]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const posicion = await ev(`(() => {
        const side = document.querySelector('.side'), nav = document.querySelector('#nav');
        const brand = document.querySelector('.brand'), foot = document.querySelector('.side-foot');
        nav.scrollTop = 0;
        const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const antes = { brand: rect(brand), foot: rect(foot), grupo: rect(nav.firstElementChild) };
        nav.scrollTop = nav.scrollHeight;
        side.scrollTop = 120;
        return { antes, despues: { brand: rect(brand), foot: rect(foot), grupo: rect(nav.firstElementChild) },
          nav: rect(nav), scroll: nav.scrollTop, sideScroll: side.scrollTop, height: innerHeight,
          botones: Array.from(foot.querySelectorAll('button'), b => ({ texto: b.textContent.trim(), ...rect(b) })) };
      })()`);
      assert.ok(posicion.scroll > 40, `${width}×${height}: la navegación hace scroll`);
      assert.equal(posicion.sideScroll, 0, 'el aside no es el contenedor desplazable');
      assert.deepEqual(posicion.antes.brand, posicion.despues.brand, 'logo inmóvil');
      assert.deepEqual(posicion.antes.foot, posicion.despues.foot, 'pie inmóvil');
      assert.ok(posicion.antes.grupo.top - posicion.despues.grupo.top > 40, 'los grupos sí se desplazan');
      assert.ok(posicion.despues.brand.top >= 0 && posicion.despues.brand.bottom <= posicion.nav.top, 'logo encima del área desplazable');
      assert.ok(posicion.nav.bottom <= posicion.despues.foot.top && posicion.despues.foot.bottom <= height, 'pie debajo del área desplazable y dentro de la ventana');
      assert.deepEqual(posicion.botones.map(b => b.texto), ['Crear', 'Prompter', 'Dock', 'Pausar alertas']);
      assert.ok(posicion.botones.every(b => b.top >= 0 && b.bottom <= height), 'todos los botones del pie visibles');
      // También al desplazar el documento, la barra permanece dentro de la ventana.
      await ev('window.scrollTo(0, 300)');
      const bordes = await ev(`(() => { const r = document.querySelector('.side').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
      assert.equal(bordes.top, 0);
      assert.equal(bordes.bottom, height);
      await ev('window.scrollTo(0, 0)');
    }
    // Conserva la navegación horizontal existente por debajo del breakpoint móvil.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 1, mobile: false });
    const movil = await ev(`(() => { const n = document.querySelector('#nav'); n.scrollLeft = n.scrollWidth; return { scroll: n.scrollLeft, direccion: getComputedStyle(n).flexDirection, orden: Array.from(n.querySelectorAll('a'), a => a.hash) }; })()`);
    assert.equal(movil.direccion, 'row');
    assert.ok(movil.scroll > 0, 'navegación horizontal móvil accesible');
    assert.deepEqual(movil.orden, orden, 'sin reordenar ni ocultar destinos');
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    app.timers.stop();
    app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
  }
});
