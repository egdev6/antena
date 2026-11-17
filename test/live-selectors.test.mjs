import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

// Real React, un SSE falso y el live.ts actual: no depende de app/dist ni lo escribe.
test('useLive selecciona cambios, conserva selectores con props y eventos fuera del estado', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH');
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { live, useLive, useLiveVersion } from './app/src/lib/live.ts';
    live.state = { config: { name: 'uno', alternate: 'dos' }, widgets: { chat: [] } };
    live.connect('test');
    const counts = { config: 0, chat: 0, projection: 0, array: 0, whole: 0, outside: 0, props: 0, version: 0 };
    function Config() { const value = useLive(s => s.config); counts.config++; return <span id="config">{value.name}</span>; }
    function Chat() { const value = useLive(s => s.widgets.chat); counts.chat++; return <span id="chat">{value.length}</span>; }
    function Projection() { const value = useLive(s => ({ name: s.config.name })); counts.projection++; return <span id="projection">{value.name}</span>; }
    function ArraySelection() { const value = useLive(s => s.config.items || []); counts.array++; return <span id="array">{value.length}</span>; }
    function Whole() { useLive(s => s); counts.whole++; return <span id="timeline">{live.timeline.pending}</span>; }
    function Outside() { const value = useLive(() => live.failed); counts.outside++; return <span id="outside">{String(value)}</span>; }
    function Props({ field }) { const value = useLive(s => s.config[field]); counts.props++; return <span id="props">{value}</span>; }
    function Version() { useLiveVersion(); counts.version++; return null; }
    const roots = {};
    for (const [key, Component] of Object.entries({ config: Config, chat: Chat, projection: Projection, array: ArraySelection, whole: Whole, outside: Outside, version: Version })) {
      const el = document.createElement('div'); document.body.appendChild(el); roots[key] = createRoot(el);
      flushSync(() => roots[key].render(<Component />));
    }
    const el = document.createElement('div'); document.body.appendChild(el); roots.props = createRoot(el);
    const setProp = field => flushSync(() => roots.props.render(<Props field={field} />));
    setProp('name');
    window.__liveTest = {
      counts, setProp,
      emit: (event, data) => flushSync(() => window.__fakeStream.emit(event, data)),
      fail: value => flushSync(() => { live.failed = value; live.emit(); }),
      setItems: value => flushSync(() => live.update(s => ({ config: { ...s.config, items: value } }))),
      editProgram: () => flushSync(() => live.patchProgram({ program: { kind: 'obs' } })),
      text: id => document.getElementById(id).textContent,
      chatIds: () => live.state.widgets.chat.map(x => x.id),
      program: () => live.state.config.program?.kind,
    };`;
  const bundled = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'fake-stream', setup(b) {
      b.onResolve({ filter: /stream-client\.js$/ }, () => ({ path: 'stream', namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export class AntenaStream {
        constructor() { this.listeners = {}; globalThis.__fakeStream = this; }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
      }`, loader: 'js' }));
    } }], logLevel: 'silent' });
  const page = await openChromePage(bin, 'about:blank');
  t.after(() => closeChrome(page));
  const evalPage = expression => evaluateChrome(page.cdp, expression);
  await evalPage(bundled.outputFiles[0].text);
  const before = await evalPage('({...window.__liveTest.counts})');
  await evalPage(`window.__liveTest.emit('chat', { id: 'c1', text: 'hola' })`);
  const afterChat = await evalPage('({...window.__liveTest.counts})');
  assert.deepEqual(await evalPage('window.__liveTest.chatIds()'), ['c1']);
  assert.equal(await evalPage(`window.__liveTest.text('chat')`), '1');
  assert.equal(afterChat.config, before.config, 'el suscriptor de config no se vuelve a dibujar por chat');
  assert.equal(afterChat.projection, before.projection, 'una proyección superficial igual mantiene la referencia');
  assert.equal(afterChat.array, before.array, 'un array vacío creado por el selector tampoco vuelve a dibujar');
  assert.equal(afterChat.chat, before.chat + 1, 'el chat sí recibe el mensaje');
  assert.equal(afterChat.whole, before.whole + 1, 'el selector del estado completo sigue viendo los cambios');
  await evalPage('window.__liveTest.setItems(Array(1))');
  assert.equal(await evalPage(`window.__liveTest.text('array')`), '1', 'un array disperso de distinta longitud sí cambia');
  await evalPage('window.__liveTest.setItems([])');
  assert.equal(await evalPage(`window.__liveTest.text('array')`), '0');
  await evalPage(`window.__liveTest.setProp('alternate')`);
  assert.equal(await evalPage(`window.__liveTest.text('props')`), 'dos', 'un selector con props usa el selector nuevo');
  await evalPage(`window.__liveTest.emit('config', { alternate: 'tres', name: 'nuevo' })`);
  assert.equal(await evalPage(`window.__liveTest.text('props')`), 'tres');
  assert.equal(await evalPage(`window.__liveTest.text('config')`), 'nuevo');
  assert.equal(await evalPage(`window.__liveTest.text('projection')`), 'nuevo');
  const beforeTimeline = await evalPage('({...window.__liveTest.counts})');
  await evalPage(`window.__liveTest.emit('timeline', { items: [], pending: 3 })`);
  const afterTimeline = await evalPage('({...window.__liveTest.counts})');
  assert.equal(await evalPage(`window.__liveTest.text('timeline')`), '3', 'los consumidores de estado completo leen la cronología externa');
  assert.equal(afterTimeline.config, beforeTimeline.config);
  assert.equal(afterTimeline.version, beforeTimeline.version + 1);
  await evalPage('window.__liveTest.fail(true)');
  assert.equal(await evalPage(`window.__liveTest.text('outside')`), 'true', 'un selector externo sigue reaccionando a emit');
  await evalPage('window.__liveTest.editProgram()');
  const beforeDirtyChat = await evalPage('({...window.__liveTest.counts})');
  await evalPage(`window.__liveTest.emit('chat', { id: 'c2', text: 'hola otra vez' })`);
  assert.deepEqual(await evalPage('window.__liveTest.chatIds()'), ['c1', 'c2']);
  const afterDirtyChat = await evalPage('({...window.__liveTest.counts})');
  assert.equal(afterDirtyChat.config, beforeDirtyChat.config, 'un borrador de configuración no debe volver a dibujarse por chat');
  assert.equal(await evalPage('window.__liveTest.program()'), 'obs');
  await evalPage(`window.__liveTest.emit('config', { name: 'servidor', program: { kind: 'meld' } })`);
  assert.equal(await evalPage(`window.__liveTest.text('config')`), 'servidor');
  assert.equal(await evalPage('window.__liveTest.program()'), 'obs', 'la protección del borrador sigue ganando al evento de config');
});
