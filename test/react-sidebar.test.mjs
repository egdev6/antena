// #125: regresión del commit c873c9e, adaptada al scroll exclusivo de navegación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

// Simula la app de escritorio sin invocar Tauri, cuentas ni hardware reales: ni siquiera ahí hay pie.
const desktopStub = `window.__TAURI__ = { core: { invoke: async cmd => cmd === 'monitors' ? [] : null } }`;

test('barra lateral: activo, grupos y scroll exclusivo bajo el logo, sin pie', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-panel-125-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
    await waitDom(c, `!!document.querySelector('#nav .eg-menu__item[aria-current] .eg-icon')`);
    // sin pie: ni «Crear», ni Prompter/Dock, ni «Pausar alertas», ni el estado de Meld (ya están en el dock)
    assert.equal(await ev(`!!document.querySelector('.side-foot')`), false, 'la barra lateral no tiene pie');
    assert.deepEqual(await ev(`Array.from(document.querySelectorAll('.side button'), b => b.textContent.trim())`), [], 'la barra lateral no tiene botones');

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
        const brand = document.querySelector('.brand');
        nav.scrollTop = 0;
        const desborda = nav.scrollHeight > nav.clientHeight + 1, maximo = nav.scrollHeight - nav.clientHeight;
        const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const antes = { brand: rect(brand), grupo: rect(nav.firstElementChild) };
        nav.scrollTop = nav.scrollHeight;
        side.scrollTop = 120;
        const ultimo = rect([...nav.querySelectorAll('a')].at(-1));
        return { antes, desborda, maximo, ultimo, despues: { brand: rect(brand), grupo: rect(nav.firstElementChild) },
          nav: rect(nav), side: rect(side), sidePad: parseFloat(getComputedStyle(side).paddingBottom),
          scroll: nav.scrollTop, sideScroll: side.scrollTop, height: innerHeight };
      })()`);
      // sin pie el menú gana su espacio: con altura suficiente entra entero; en ventanas bajas hace scroll
      if (height <= 480) assert.equal(posicion.desborda, true, `${width}×${height}: el menú no entra y se desplaza`);
      if (posicion.desborda) {
        assert.ok(posicion.scroll > 0 && Math.abs(posicion.scroll - posicion.maximo) <= 1, `${width}×${height}: la navegación llega al final (${posicion.scroll} / ${posicion.maximo})`);
        assert.ok(Math.abs(posicion.antes.grupo.top - posicion.despues.grupo.top - posicion.scroll) <= 1, 'los grupos se desplazan con el scroll');
      } else {
        assert.equal(posicion.scroll, 0, `${width}×${height}: sin desborde no hay scroll`);
        assert.ok(posicion.ultimo.bottom <= posicion.nav.bottom, `${width}×${height}: la última entrada se ve entera`);
      }
      assert.equal(posicion.sideScroll, 0, 'el aside no es el contenedor desplazable');
      assert.deepEqual(posicion.antes.brand, posicion.despues.brand, 'logo inmóvil');
      assert.ok(posicion.despues.brand.top >= 0 && posicion.despues.brand.bottom <= posicion.nav.top, 'logo encima del área desplazable');
      assert.ok(Math.abs(posicion.nav.bottom - (posicion.side.bottom - posicion.sidePad)) <= 1 && posicion.nav.bottom <= height,
        `el menú ocupa hasta abajo, dentro de la ventana (${posicion.nav.bottom} / ${posicion.side.bottom - posicion.sidePad})`);
      // También al desplazar el documento, la barra permanece dentro de la ventana.
      await ev('window.scrollTo(0, 300)');
      const bordes = await ev(`(() => { const r = document.querySelector('.side').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
      // tolerancia subpíxel: si la página apenas desborda, el sticky se ajusta a su contenedor
      assert.ok(Math.abs(bordes.top) <= 1, `barra pegada arriba (${bordes.top})`);
      assert.ok(Math.abs(bordes.bottom - height) <= 1, `barra hasta abajo (${bordes.bottom} / ${height})`);
      await ev('window.scrollTo(0, 0)');
    }
    // Conserva la navegación horizontal existente por debajo del breakpoint móvil.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 1, mobile: false });
    const movil = await ev(`(() => { const n = document.querySelector('#nav'); n.scrollLeft = n.scrollWidth; return { scroll: n.scrollLeft, direccion: getComputedStyle(n).flexDirection, orden: Array.from(n.querySelectorAll('a'), a => a.hash) }; })()`);
    assert.equal(movil.direccion, 'row');
    assert.ok(movil.scroll > 0, 'navegación horizontal móvil accesible');
    assert.deepEqual(movil.orden, orden, 'sin reordenar ni ocultar destinos');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => {
      app.timers.stop();
      app.server.closeAllConnections();
    }, () => new Promise(r => app.server.close(r)));
  }
});
