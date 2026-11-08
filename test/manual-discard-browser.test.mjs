// S1: the first edit must capture the whole unit BEFORE mutating live state.
// Both explicit discard and confirmed navigation restore it; cancelling keeps the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const input = label => `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input')`;
const button = text => `Array.from(document.querySelectorAll('main .lv-sfoot button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const status = `document.querySelector('main .lv-sfoot .lv-dirty')`;
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const units = [
  {
    name: 'widgets', hash: '#/widgets/chat',
    labels: ['Tamaño de letra', 'Mensajes en pantalla'],
    original: ['26', '8'], edited: ['33', '12'],
  },
  {
    name: 'interactivos', hash: '#/preguntas/ajustes',
    labels: ['Comando', 'Texto de confirmación'],
    original: ['!pregunta', 'Recibida {user}'], edited: ['!borrador', 'Borrador {user}'],
  },
];

async function serverState(base) {
  const response = await fetch(`${base}/api/state`);
  assert.equal(response.status, 200, 'server state can be read');
  const state = await response.json();
  return { widgets: state.config.widgets, interactive: state.interactive.config };
}

async function edit(c, unit) {
  for (const [index, label] of unit.labels.entries()) {
    const selector = input(label);
    await dom(c, `(() => { const i = ${selector}; i.focus(); i.select(); return true; })()`);
    await c.send('Input.insertText', { text: unit.edited[index] });
    await waitDom(c, `(${selector})?.value === ${JSON.stringify(unit.edited[index])}`);
  }
}

async function assertForm(c, unit, dirty) {
  const actual = await dom(c, `({
    hash: location.hash,
    values: [${unit.labels.map(label => `(${input(label)})?.value`).join(', ')}],
    dirty: (${status})?.classList.contains('is-on'),
    message: (${status})?.textContent.trim(),
    saveDisabled: (${button('Guardar')})?.disabled,
    discardDisabled: (${button('Descartar')})?.disabled,
  })`);
  assert.equal(actual.hash, unit.hash, 'location still identifies the editing unit');
  assert.equal(actual.dirty, dirty, 'dirty indicator agrees with the draft');
  assert.equal(actual.saveDisabled, !dirty, 'save availability agrees with the draft');
  assert.equal(actual.discardDisabled, !dirty, 'discard availability agrees with the draft');
  assert.equal(actual.message, dirty ? 'Cambios sin guardar' : 'Todo guardado');
  assert.deepEqual(actual.values, dirty ? unit.edited : unit.original, 'BOTH fields agree with the saved state or draft');
}

for (const unit of units) {
  for (const scenario of ['explicit discard', 'cancel then confirm leave']) {
    test(`manual discard ${unit.name}: ${scenario}`, { timeout: 90000 }, async t => {
      const bin = await skipIfNoBrowserOrUi(t);
      if (!bin) return;
      const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-manual-discard-'));
      t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
      const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
      // Synthetic fixtures only: never open or mutate the user's real configuration.
      Object.assign(app.store.config.widgets.chat, { fontSize: 26, maxMessages: 8 });
      Object.assign(app.store.config.interactive.questions, {
        command: '!pregunta', confirmText: 'Recibida {user}',
      });
      const puts = [];
      const handlers = app.server.listeners('request');
      app.server.removeAllListeners('request');
      app.server.on('request', (req, res) => {
        if (req.method === 'PUT') puts.push(req.url.split('?')[0]);
        for (const handler of handlers) handler.call(app.server, req, res);
      });
      let chrome;
      try {
        await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${app.server.address().port}`;
        const original = await serverState(base);
        const unchangedServer = async checkpoint => {
          assert.deepEqual(await serverState(base), original, `${checkpoint}: server retains the entire original configuration`);
          assert.deepEqual(puts, [], `${checkpoint}: no PUT, not even an implicit save`);
        };
        chrome = await openChromePage(bin, `${base}/${unit.hash}`);
        const c = chrome.cdp;
        const ready = `location.hash === ${JSON.stringify(unit.hash)} && ${unit.labels.map(label => `!!(${input(label)})`).join(' && ')} && !!(${status})`;
        await waitDom(c, ready, { timeoutMs: 15000 });
        await assertForm(c, unit, false);
        await edit(c, unit);
        await assertForm(c, unit, true);
        await unchangedServer('two fields edited');

        if (scenario === 'explicit discard') {
          await dom(c, `(${button('Descartar')}).click()`);
          await waitDom(c, `!!(${status}) && !(${status}).classList.contains('is-on')`);
          await unchangedServer('explicit discard');
          await assertForm(c, unit, false);
        } else {
          // Exercise the real router and confirmLeave, but make answers deterministic.
          // #/widgets exits BOTH units; this does not test same-unit tab policy (S3).
          await dom(c, `(() => {
            window.__leavePrompts = [];
            window.__leaveAnswers = [false, true];
            window.confirm = message => {
              window.__leavePrompts.push(message);
              return window.__leaveAnswers.shift() === true;
            };
            location.hash = '#/widgets';
            return true;
          })()`);
          await waitDom(c, `window.__leavePrompts.length === 1 && ${ready}`);
          assert.equal(await dom(c, `window.__leavePrompts[0].includes('cambios sin guardar')`), true, 'leaving asks about unsaved changes');
          await unchangedServer('cancelled leave');
          await assertForm(c, unit, true);

          await dom(c, `location.hash = '#/widgets'`);
          await waitDom(c, `window.__leavePrompts.length === 2 && location.hash === '#/widgets' && !!document.querySelector('[data-tour="widgets-catalog"]') && !(${input(unit.labels[0])})`);
          await unchangedServer('confirmed leave');
          await dom(c, `location.hash = ${JSON.stringify(unit.hash)}`);
          await waitDom(c, ready);
          assert.equal(await dom(c, `window.__leavePrompts.length`), 2, 'reopening has no remaining dirty draft to confirm');
          await unchangedServer('reopened unit');
          await assertForm(c, unit, false);
        }
      } finally {
        if (chrome) await closeChrome(chrome);
        app.timers.stop();
        app.server.closeAllConnections();
        app.server.close();
      }
    });
  }
}
