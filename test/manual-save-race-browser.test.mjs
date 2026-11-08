// S2: compiled panel + real local API. Hold the first actual HTTP 200 with a deferred
// promise, edit again, then release it. No source imports, autosave queue or timed sleeps.
// Each scenario owns its app/browser: one RED must not prevent the other reproductions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const q = JSON.stringify;
const status = `document.querySelector('.lv-sfoot .lv-dirty')`;
const save = `document.querySelector('.lv-sfoot .eg-btn--secondary')`;
const discard = `[...document.querySelectorAll('.lv-sfoot button')].find(b => b.textContent.trim() === 'Descartar')`;
const labelInput = text => `[...document.querySelectorAll('main label')].find(l => l.textContent.trim().startsWith(${q(text)}))?.querySelector('input')`;
const textField = `document.querySelector('[data-field="text"] input')`;
const globalCss = `document.querySelector('#tp-css textarea')`;
const opts = { timeout: 90000 };

const sources = [
  {
    name: 'Editor', endpoint: '/api/alerts/follow', route: '#/alertas/follow', field: textField,
    initial: 'Initial alert', a: 'Alert A', b: 'Alert B',
    extra: { field: `document.querySelector('[data-field="sub"] input')`, a: 'Sent supporting line' },
    seed: call => call('PUT', '/api/alerts/follow', { text: 'Initial alert', sub: 'Initial supporting line' }),
    read: async call => (await call('GET', '/api/config')).alerts.follow.text,
    readExtra: async call => (await call('GET', '/api/config')).alerts.follow.sub,
    sent: body => body.text,
  },
  {
    name: 'Apariencia', endpoint: '/api/theme', route: '#/apariencia/color',
    field: labelInput('Opacidad del fondo'), initial: 40, a: 70, b: 60,
    extra: { field: labelInput('Intensidad del brillo'), a: 120 },
    seed: call => call('PUT', '/api/theme', { surfaceOpacity: 40, glow: 100 }),
    read: async call => (await call('GET', '/api/theme')).theme.surfaceOpacity,
    readExtra: async call => (await call('GET', '/api/theme')).theme.glow,
    sent: body => body.surfaceOpacity,
  },
  {
    name: 'Atajo', field: `document.querySelector('input[aria-label="Nombre del atajo"]')`,
    initial: 'Initial shortcut', a: 'Shortcut A', b: 'Shortcut B',
    extra: { field: labelInput('Texto (con {user}'), a: 'Sent speech' },
    seed: async call => {
      const { shortcut } = await call('POST', '/api/shortcuts', {
        name: 'Initial shortcut', steps: [{ kind: 'say', text: 'Initial speech', delaySec: 0 }],
      });
      return { endpoint: `/api/shortcuts/${shortcut.id}`, route: `#/atajos/${shortcut.id}`, id: shortcut.id };
    },
    read: async (call, s) => (await call('GET', '/api/shortcuts')).custom.find(x => x.id === s.id).name,
    readExtra: async (call, s) => (await call('GET', '/api/shortcuts')).custom.find(x => x.id === s.id).steps[0].text,
    sent: body => body.name,
  },
  {
    name: 'Guion', field: `document.querySelector('input[aria-label="Título del guion"]')`,
    initial: 'Initial script', a: 'Script A', b: 'Script B',
    extra: { field: `document.querySelector('textarea.tp-prose')`, a: 'Sent block words' },
    seed: async call => {
      const { script } = await call('POST', '/api/teleprompter/scripts', {
        title: 'Initial script', blocks: [{ title: 'Initial block', text: 'Initial block words' }],
      });
      return { endpoint: `/api/teleprompter/scripts/${script.id}`, route: `#/teleprompter/guiones/${script.id}` };
    },
    read: async (call, s) => (await call('GET', s.endpoint)).script.title,
    readExtra: async (call, s) => (await call('GET', s.endpoint)).script.blocks[0].text,
    sent: body => body.title,
  },
  {
    name: 'Config', endpoint: '/api/config', route: '#/general/overlay',
    field: labelInput('Tope de la cola del overlay'), initial: 20, a: 30, b: 40,
    extra: { field: labelInput('Volumen general'), a: 70 },
    seed: call => call('PUT', '/api/config', { overlay: { queueMax: 20, volume: 0.6 } }),
    read: async call => (await call('GET', '/api/config')).overlay.queueMax,
    readExtra: async call => Math.round((await call('GET', '/api/config')).overlay.volume * 100),
    sent: body => body.overlay.queueMax,
  },
  {
    name: 'Widget patcher', endpoint: '/api/widgets', route: '#/widgets/chat',
    field: labelInput('Tamaño de letra (px)'), initial: 26, a: 33, b: 41,
    extra: { field: labelInput('Mensajes en pantalla'), a: 7 },
    seed: call => call('PUT', '/api/widgets', { chat: { fontSize: 26, maxMessages: 5 } }),
    read: async call => (await call('GET', '/api/config')).widgets.chat.fontSize,
    readExtra: async call => (await call('GET', '/api/config')).widgets.chat.maxMessages,
    sent: body => body.chat.fontSize,
  },
  {
    name: 'Interactive patcher', endpoint: '/api/interactive/config', route: '#/preguntas/ajustes',
    field: labelInput('Comando'), initial: '!initial', a: '!s2a', b: '!s2b',
    extra: { field: labelInput('Largo mínimo'), a: 15 },
    seed: call => call('PUT', '/api/interactive/config', { questions: { command: '!initial', minLength: 0 } }),
    read: async call => (await call('GET', '/api/state')).interactive.config.questions.command,
    readExtra: async call => (await call('GET', '/api/state')).interactive.config.questions.minLength,
    sent: body => body.questions.command,
  },
];

// Observe initial stream reload completion and later server events, without disabling delivery.
// Two /api/prompter JSON reads mark the initial load and the stream-open reload. Waiting
// for these prevents an unfinished boot snapshot from contaminating the save experiment.
const bootObserver = `(() => {
  window.__raceBoot = { loads: 0, events: {} };
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (new URL(String(args[0]), location.href).pathname === '/api/prompter') {
      const json = response.json.bind(response);
      response.json = async () => { const value = await json(); window.__raceBoot.loads++; return value; };
    }
    return response;
  };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        const name = typeof event.data === 'string' && event.data.split('\\n', 1)[0].slice(7);
        if (['config', 'theme', 'teleprompter'].includes(name)) {
          window.__raceBoot.events[name] = (window.__raceBoot.events[name] || 0) + 1;
        }
      });
    }
  };
})()`;

// Event-loop/render barrier, not an elapsed-time assumption about HTTP/debounce order.
const rendered = c => evaluateChrome(c, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);

async function setField(c, field, value) {
  await evaluateChrome(c, `(() => {
    const el = ${field};
    if (!el || el.disabled) throw new Error('missing or disabled editable field');
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitDom(c, `(${field})?.value === ${q(String(value))} && ${status}?.classList.contains('is-on')`);
}
const fieldValue = (c, field) => evaluateChrome(c, `(${field})?.value`);
const clickSave = c => evaluateChrome(c, `${save}.click(); true`);
const requests = (c, endpoint) => evaluateChrome(c, `window.__saveRace.writes.filter(w => w.path === ${q(endpoint)})`);
const dirty = c => evaluateChrome(c, `!!${status}?.classList.contains('is-on')`);

async function installGate(c, endpoint, { fail = false } = {}) {
  await evaluateChrome(c, `(() => {
    const originalFetch = window.fetch;
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    const state = window.__saveRace = {
      writes: [], ready: false, heldStatus: null, released: false,
      restore: () => { window.fetch = originalFetch; release(); },
      release: () => { state.released = true; release(); },
    };
    window.fetch = async (url, options) => {
      const path = new URL(String(url), location.href).pathname;
      const method = (options?.method || 'GET').toUpperCase();
      const write = method === 'PUT' ? { path, body: JSON.parse(options.body), status: null } : null;
      if (write) state.writes.push(write);
      const first = path === ${q(endpoint)} && method === 'PUT' && !state.claimed;
      if (first) state.claimed = true;
      const response = first && ${fail}
        ? new Response(JSON.stringify({ error: 'S2 controlled failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
        : await originalFetch(url, options);
      if (write) write.status = response.status;
      if (first) {
        state.heldStatus = response.status;
        state.ready = true;
        await deferred;
      }
      return response;
    };
    return true;
  })()`);
}

async function startA(c, s, options) {
  await installGate(c, s.endpoint, options);
  await setField(c, s.field, s.a);
  await clickSave(c);
  await waitDom(c, 'window.__saveRace.ready');
  assert.equal(await evaluateChrome(c, 'window.__saveRace.heldStatus'), options?.fail ? 500 : 200,
    'the success gate retains a real HTTP 200 after the server has accepted A');
  assert.equal(s.sent((await requests(c, s.endpoint))[0].body), s.a);
}

async function finish(c, { fail = false } = {}) {
  await evaluateChrome(c, `window.__saveRace.release(); true`);
  await waitDom(c, fail
    ? `document.querySelector('.toast.err.on')?.textContent.includes('S2 controlled failure')`
    : `document.querySelector('.toast.on:not(.err)')?.textContent.includes('Guardado')`);
  await rendered(c);
}

async function withPanel(t, template, run) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-save-race-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  let chrome;
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (method, endpoint, body) => {
      const response = await fetch(base + endpoint, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.ok, true, `${method} ${endpoint}: HTTP ${response.status}`);
      return response.json();
    };
    const seeded = await template.seed(call);
    const s = { ...template, ...(seeded?.route ? seeded : {}) };
    chrome = await openChromePage(bin, 'about:blank');
    const c = chrome.cdp;
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: bootObserver });
    await c.send('Page.navigate', { url: base + '/' + s.route });
    await waitDom(c, `window.__raceBoot?.loads >= 2 && !!(${s.field}) && !!${save}`, { timeoutMs: 20000 });
    await rendered(c);
    if (s.name === 'Editor') {
      await evaluateChrome(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'Mensaje').click(); true`);
      await waitDom(c, `document.querySelector('#tp-message')?.hidden === false`);
    }
    assert.equal(await fieldValue(c, s.field), String(s.initial), 'synthetic baseline is visible');
    await run({ c, s, app, call });
  } catch (error) {
    if (chrome) {
      try {
        const diagnostic = await evaluateChrome(chrome.cdp, `({
          footer: ${status}?.textContent,
          dirty: ${status}?.classList.contains('is-on'),
          saveDisabled: ${save}?.disabled,
          discardDisabled: (${discard})?.disabled,
          toast: { text: document.querySelector('.toast')?.textContent, className: document.querySelector('.toast')?.className },
          requests: window.__saveRace?.writes.map(write => ({ path: write.path, status: write.status, fields: Object.keys(write.body) })),
        })`, { timeoutMs: 1000 });
        t.diagnostic(`S2 save state: ${JSON.stringify(diagnostic)}`);
      } catch (diagnosticError) {
        t.diagnostic(`S2 save state unavailable: ${diagnosticError.kind || diagnosticError.name}`);
      }
    }
    throw error;
  } finally {
    try {
      if (chrome) await evaluateChrome(chrome.cdp, 'window.__saveRace?.restore(); true', { timeoutMs: 2000 });
    } catch (error) {
      t.diagnostic(`fetch restoration unavailable: ${error.kind || error.name}; browser is being closed`);
    } finally {
      if (chrome) await closeChrome(chrome);
      app.timers.stop();
      app.teleprompter.stop();
      app.viewers.stop();
      app.meld.stop();
      app.chat.stop();
      app.server.closeAllConnections();
      await app.closeHttp(); // also clears SSE heartbeat timers and destroys remaining sockets
    }
  }
}

for (const source of sources) {
  test(`S2 ${source.name}: confirming A preserves B dirty; Discard B returns to saved A`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
    await startA(c, s);
    await setField(c, s.field, s.b);
    await finish(c);
    assert.equal(await fieldValue(c, s.field), String(s.b), 'late A must not overwrite B');
    assert.equal(await dirty(c), true, 'acknowledging A must not mark B saved');
    assert.equal(await s.read(call, s), s.a, 'B was not implicitly saved');
    assert.equal((await requests(c, s.endpoint)).length, 1, 'no queued autosave B');
    await evaluateChrome(c, `${discard}.click(); true`);
    await rendered(c);
    assert.equal(await fieldValue(c, s.field), String(s.a), 'discard baseline advances to A, not the pre-save value');
    assert.equal(await dirty(c), false);
    assert.equal(await s.read(call, s), s.a);
    assert.equal((await requests(c, s.endpoint)).length, 1, 'discard does not write');
  }));

  test(`S2 ${source.name}: B is persisted only by a second explicit Save`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
    await startA(c, s);
    await setField(c, s.field, s.b);
    await finish(c);
    assert.equal(await fieldValue(c, s.field), String(s.b), 'B survives first acknowledgement');
    assert.equal(await dirty(c), true);
    assert.equal(await s.read(call, s), s.a);
    assert.equal((await requests(c, s.endpoint)).length, 1);
    await clickSave(c);
    // A repeated 'Guardado' toast has the same React className. Never mutate it to
    // manufacture a new notification edge: the second HTTP 200 + clean footer is
    // the completion signal. Keep the success-toast check without forcing animation.
    await waitDom(c, `window.__saveRace.writes.filter(write => write.path === ${q(s.endpoint)})[1]?.status === 200 && ${status}?.textContent === 'Todo guardado' && document.querySelector('.toast.on:not(.err)')?.textContent.includes('Guardado')`);
    const writes = await requests(c, s.endpoint);
    assert.equal(writes.length, 2);
    assert.equal(s.sent(writes[1].body), s.b);
    assert.equal(writes[1].status, 200);
    assert.equal(await s.read(call, s), s.b);
    assert.equal(await fieldValue(c, s.field), String(s.b));
  }));

  test(`S2 ${source.name}: 500 keeps sent fields and newer B; explicit retry recovers both`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
    // An untouched field from the failed snapshot must survive too, not just newer B.
    await setField(c, s.extra.field, s.extra.a);
    await startA(c, s, { fail: true });
    await setField(c, s.field, s.b);
    await finish(c, { fail: true });
    assert.equal(await fieldValue(c, s.field), String(s.b));
    assert.equal(await fieldValue(c, s.extra.field), String(s.extra.a));
    assert.equal(await dirty(c), true);
    assert.equal(await s.read(call, s), s.initial, 'the injected 500 never reached storage');
    assert.equal(await evaluateChrome(c, `${save}.disabled || ${discard}.disabled`), false, 'failure clears busy for explicit retry/discard');
    assert.equal((await requests(c, s.endpoint)).length, 1, 'no implicit retry');
    await clickSave(c);
    await waitDom(c, `${status}?.textContent === 'Todo guardado' && document.querySelector('.toast.on:not(.err)')?.textContent.includes('Guardado')`);
    assert.equal(await s.read(call, s), s.b, 'newer edit wins in the retry');
    assert.equal(await s.readExtra(call, s), s.extra.a, 'non-overwritten sent edit is recoverable');
    assert.equal((await requests(c, s.endpoint)).length, 2);
  }));

  test(`S2 ${source.name}: inputs stay enabled, Save/Discard disabled, double click is single-flight`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
    await installGate(c, s.endpoint);
    await setField(c, s.field, s.a);
    await evaluateChrome(c, `(() => { const button = ${save}; button.click(); button.click(); return true; })()`);
    await waitDom(c, 'window.__saveRace.ready');
    await rendered(c);
    // Capture all observations before asserting so a missing busy indicator cannot hide duplicate sends.
    const observed = await evaluateChrome(c, `({ inputDisabled: (${s.field}).disabled, saveDisabled: ${save}.disabled, discardDisabled: ${discard}.disabled, status: ${status}.textContent })`);
    const writes = await requests(c, s.endpoint);
    assert.equal(writes.length, 1, 'a rapid double click cannot send A twice');
    assert.equal(observed.inputDisabled, false, 'editing remains available while saving');
    assert.equal(observed.saveDisabled, true, 'Save is disabled while a source is saving');
    assert.equal(observed.discardDisabled, true, 'Discard cannot pretend to cancel a request');
    assert.notEqual(observed.status, 'Todo guardado', 'in-flight A is not acknowledged yet');
    await setField(c, s.field, s.b);
    await finish(c);
    assert.equal(await s.read(call, s), s.a);
    assert.equal((await requests(c, s.endpoint)).length, 1);
  }));
}

for (const source of sources.slice(0, 2)) {
  for (const navigation of ['hash', 'close', 'beforeunload']) {
    // Apariencia is a page, not a slide; its real exit is covered by hash and unload.
    if (navigation === 'close' && source.name !== 'Editor') continue;
    test(`S2 ${source.name}: ${navigation} cannot discard/unmount an in-flight save`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
      await startA(c, s);
      await setField(c, s.field, s.b);
      await evaluateChrome(c, `window.__leaveConfirms = 0; window.confirm = () => { window.__leaveConfirms++; return true; }; true`);
      if (navigation === 'beforeunload') {
        const prevented = await evaluateChrome(c, `(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event); return event.defaultPrevented;
        })()`);
        assert.equal(prevented, true, 'closing/reloading must be guarded while the request is in flight');
      } else {
        await evaluateChrome(c, `window.__hashObserved = false; window.addEventListener('hashchange', () => { window.__hashObserved = true; }, { once: true }); true`);
        await evaluateChrome(c, navigation === 'hash'
          ? `location.hash = '#/directo'; true`
          : `document.querySelector('.lv-shead a[aria-label="Cerrar"]').click(); true`);
        await waitDom(c, 'window.__hashObserved');
        await rendered(c);
        assert.equal(await evaluateChrome(c, 'location.hash'), s.route, 'a real exit is blocked, even if confirm would accept');
      }
      assert.equal(await evaluateChrome(c, 'window.__leaveConfirms'), 0, 'saving is not a discard-confirmation path');
      assert.equal(await fieldValue(c, s.field), String(s.b));
      await finish(c);
      assert.equal(await fieldValue(c, s.field), String(s.b), 'no late resurrection after attempted leave');
      assert.equal(await dirty(c), true);
      assert.equal(await s.read(call, s), s.a);
      assert.equal((await requests(c, s.endpoint)).length, 1);
    }));
  }

  test(`S2 ${source.name}: internal tabs remain usable during saving without discarding B`, opts, t => withPanel(t, source, async ({ c, s, call }) => {
    await startA(c, s);
    await setField(c, s.field, s.b);
    await evaluateChrome(c, 'window.__leaveConfirms = 0; window.confirm = () => { window.__leaveConfirms++; return true; }; true');
    if (s.name === 'Editor') {
      await evaluateChrome(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'CSS').click(); true`);
      await waitDom(c, `document.querySelector('#tp-css')?.hidden === false`);
      await evaluateChrome(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'Mensaje').click(); true`);
      await waitDom(c, `document.querySelector('#tp-message')?.hidden === false`);
    } else {
      await evaluateChrome(c, `[...document.querySelectorAll('.lv-pagetabs button')].find(b => b.textContent.trim() === 'Tipografía').click(); true`);
      await waitDom(c, `!!document.querySelector('#ap-font')`);
      await evaluateChrome(c, `[...document.querySelectorAll('.lv-pagetabs button')].find(b => b.textContent.trim() === 'Color').click(); true`);
      await waitDom(c, `!!(${s.field})`);
    }
    assert.equal(await evaluateChrome(c, 'window.__leaveConfirms'), 0);
    assert.equal(await fieldValue(c, s.field), String(s.b));
    await finish(c);
    assert.equal(await fieldValue(c, s.field), String(s.b));
    assert.equal(await dirty(c), true);
    assert.equal(await s.read(call, s), s.a);
  }));
}

// config is registered before editor. Sequential dispatch must not mean sequential
// capture: every source's save intent belongs to the instant the user presses Save.
for (const editorInitiallyDirty of [true, false]) {
  test(`S2 saveAll freezes all sources at click: later Editor ${editorInitiallyDirty ? 'sends A, never B' : 'does not silently join the save'}`, opts, t => withPanel(t, sources[0], async ({ c, s, call }) => {
    if (editorInitiallyDirty) await setField(c, s.field, s.a);
    await evaluateChrome(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'CSS').click(); true`);
    await waitDom(c, `document.querySelector('#tp-css')?.hidden === false`);
    await evaluateChrome(c, `[...document.querySelectorAll('#tp-css button')].find(b => b.textContent.trim() === 'Todas las alertas').click(); true`);
    await waitDom(c, `!!(${globalCss})`);
    const cssA = '/* S2 frozen config A */';
    const cssB = '/* S2 newer config B */';
    await setField(c, globalCss, cssA);
    await installGate(c, '/api/config');
    await clickSave(c);
    await waitDom(c, 'window.__saveRace.ready');
    assert.equal(await evaluateChrome(c, 'window.__saveRace.heldStatus'), 200);
    assert.equal((await requests(c, s.endpoint)).length, 0, 'requests remain sequential, not Promise.all');
    await setField(c, globalCss, cssB);
    await setField(c, s.field, s.b);
    await finish(c);
    const writes = await requests(c, s.endpoint);
    assert.equal(writes.length, editorInitiallyDirty ? 1 : 0, 'later newly-dirty sources require a new explicit Save');
    if (editorInitiallyDirty) assert.equal(s.sent(writes[0].body), s.a, 'later source uses its click-time snapshot');
    assert.equal(await fieldValue(c, s.field), String(s.b));
    assert.equal(await fieldValue(c, globalCss), cssB, 'config response cannot erase its newer patch');
    assert.equal(await dirty(c), true);
    assert.equal(await s.read(call, s), editorInitiallyDirty ? s.a : s.initial);
    assert.equal((await call('GET', '/api/config')).overlay.css, cssA);
    assert.equal((await requests(c, '/api/config')).length, 1);
  }));
}

test('S2 saveAll rollback: failed config restores unsent Editor intent; newer B wins on explicit retry', opts, t => withPanel(t, sources[0], async ({ c, s, call }) => {
  await setField(c, s.extra.field, s.extra.a);
  await setField(c, s.field, s.a);
  await evaluateChrome(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'CSS').click(); true`);
  await waitDom(c, `document.querySelector('#tp-css')?.hidden === false`);
  await evaluateChrome(c, `[...document.querySelectorAll('#tp-css button')].find(b => b.textContent.trim() === 'Todas las alertas').click(); true`);
  await waitDom(c, `!!(${globalCss})`);
  const cssA = '/* S2 retry config A */';
  await setField(c, globalCss, cssA);
  await installGate(c, '/api/config', { fail: true });
  await clickSave(c);
  await waitDom(c, 'window.__saveRace.ready');
  assert.equal(await evaluateChrome(c, 'window.__saveRace.heldStatus'), 500);
  await setField(c, s.field, s.b);
  await finish(c, { fail: true });
  assert.equal((await requests(c, s.endpoint)).length, 0, 'failed first source never sends prepared later jobs');
  assert.equal(await fieldValue(c, s.field), String(s.b));
  assert.equal(await fieldValue(c, s.extra.field), String(s.extra.a), 'unsent A fields remain recoverable');
  assert.equal(await fieldValue(c, globalCss), cssA);
  assert.equal(await dirty(c), true);
  assert.equal(await s.read(call, s), s.initial);
  assert.equal(await evaluateChrome(c, `${save}.disabled || ${discard}.disabled`), false);
  await clickSave(c);
  await waitDom(c, `${status}?.textContent === 'Todo guardado' && document.querySelector('.toast.on:not(.err)')?.textContent.includes('Guardado')`);
  const writes = await requests(c, s.endpoint);
  assert.equal(writes.length, 1, 'only explicit retry sends the editor');
  assert.equal(s.sent(writes[0].body), s.b);
  assert.equal(await s.read(call, s), s.b);
  assert.equal(await s.readExtra(call, s), s.extra.a);
  assert.equal((await call('GET', '/api/config')).overlay.css, cssA);
  assert.equal((await requests(c, '/api/config')).length, 2);
}));

test('S2 Apariencia: immediate preset/import/reset actions are blocked during saving', opts, t => withPanel(t, sources[1], async ({ c, s, call }) => {
  await startA(c, s);
  await setField(c, s.field, s.b);
  const controls = await evaluateChrome(c, `({
    preset: document.querySelector('#ap-preset').disabled,
    import: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Importar').disabled,
    reset: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restaurar EGDEV').disabled,
  })`);
  assert.deepEqual(controls, { preset: true, import: true, reset: true });
  await evaluateChrome(c, `window.__destructivePrompts = 0; window.confirm = window.prompt = () => { window.__destructivePrompts++; return true; };
    document.querySelector('#ap-preset').value = 'cian'; document.querySelector('#ap-preset').dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Importar').click();
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restaurar EGDEV').click(); true`);
  assert.equal(await evaluateChrome(c, 'window.__destructivePrompts'), 0);
  await finish(c);
  assert.equal(await fieldValue(c, s.field), String(s.b));
  assert.equal(await dirty(c), true);
  assert.equal(await s.read(call, s), s.a);
  assert.equal((await requests(c, s.endpoint)).length, 1);
}));

for (const source of sources.slice(0, 2)) {
  test(`S2 ${source.name}: a server SSE snapshot cannot overwrite pending B`, opts, t => withPanel(t, source, async ({ c, s, app, call }) => {
    await startA(c, s);
    await setField(c, s.field, s.b);
    const event = s.name === 'Editor' ? 'config' : 'theme';
    const before = await evaluateChrome(c, `window.__raceBoot.events[${q(event)}] || 0`);
    const snapshot = s.name === 'Editor'
      ? { alerts: (await call('GET', '/api/config')).alerts }
      : (await call('GET', '/api/theme')).theme;
    app.bus.send(event, snapshot, ['panel']);
    await waitDom(c, `(window.__raceBoot.events[${q(event)}] || 0) > ${before}`);
    await rendered(c);
    assert.equal(await fieldValue(c, s.field), String(s.b), 'real SSE received A but B remains the editable overlay');
    assert.equal(await dirty(c), true);
    await finish(c);
    assert.equal(await fieldValue(c, s.field), String(s.b));
    assert.equal(await s.read(call, s), s.a);
    assert.equal((await requests(c, s.endpoint)).length, 1);
  }));
}
