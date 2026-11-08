import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { evaluateChrome, waitChromeDom, chromeDiagnosticEvent } from './helpers/chrome-dom.mjs';

const expression = '!!document.getElementById("persistBar")';
const clock = () => {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
};

test('CDP conserva valores y distingue excepciones Runtime sin exponer descripción privada', async () => {
  assert.equal(await evaluateChrome({ send: async () => ({ result: { value: false } }) }, expression), false);
  await assert.rejects(evaluateChrome({ send: async () => ({
    exceptionDetails: { text: 'Uncaught', exception: { className: 'TypeError', description: 'PRIVATE_CANARY' } },
  }) }, expression), error => error.name === 'ChromeEvaluationError' && error.runtimeClass === 'TypeError' && !error.message.includes('PRIVATE_CANARY'));
});

test('CDP acota una evaluación sin respuesta y observa el rechazo del transporte', async () => {
  await assert.rejects(evaluateChrome({ send: () => new Promise(() => {}) }, expression, { timeoutMs: 10 }),
    error => error.name === 'ChromeEvaluationError' && error.kind === 'timeout');
  await assert.rejects(evaluateChrome({ send: async () => { throw Object.assign(new Error('PRIVATE_CANARY'), { code: -32000 }); } }, expression),
    error => error.kind === 'protocol' && error.cdpCode === -32000 && !error.message.includes('PRIVATE_CANARY'));
});

test('espera DOM conserva éxito sin capturar diagnósticos ni ampliar deadline', async () => {
  let calls = 0;
  const c = { send: async () => ({ result: { value: ++calls > 1 } }) };
  assert.equal(await waitChromeDom(c, expression, { timeoutMs: 10, intervalMs: 2, ...clock() }), true);
  assert.equal(calls, 2);
});

test('timeout DOM distingue falso de excepción y devuelve estructura, no HTML ni valores', async () => {
  for (const failure of ['false', 'exception']) {
    const c = { chromeStartup: () => ({ closed: false, stderr: 'Chrome fixture warning', stderrTruncated: false }),
      diagnostics: () => [{ kind: 'network', resourceType: 'Script', error: 'net::ERR_FAILED' }],
      send: async (_, params) => {
        if (params.expression !== expression) {
          assert.doesNotMatch(params.expression, /innerHTML|outerHTML|innerText/);
          return { result: { value: { readyState: 'complete', ids: { persistBar: false }, bodyTags: ['MAIN'], titleKind: 'project' } } };
        }
        return failure === 'false' ? { result: { value: false } } : {
          exceptionDetails: { exception: { className: 'ReferenceError', description: 'PRIVATE_CANARY' } },
        };
      } };
    await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 4, intervalMs: 2, ...clock() }), error => {
      assert.match(error.message, /timeout CDP/);
      assert.equal(error.diagnostic.last.kind, failure);
      assert.equal(error.diagnostic.page.readyState, 'complete');
      assert.equal(error.diagnostic.chrome.stderr, 'Chrome fixture warning');
      assert.equal(error.diagnostic.events[0].resourceType, 'Script');
      assert.doesNotMatch(error.message, /PRIVATE_CANARY/);
      return true;
    });
  }
});

test('snapshot distingue about:blank de error de navegador y registra estado sin URL privada', async () => {
  for (const sample of [
    { href: 'about:blank', title: '', location: 'about:blank', kind: 'blank', status: null },
    { href: 'chrome-error://chromewebdata/', title: '127.0.0.1', location: 'chrome-error', kind: 'browser-error', status: 0 },
    { href: 'http://user:PRIVATE_CANARY@127.0.0.1:4321/prompter?token=PRIVATE_CANARY#PRIVATE_CANARY',
      title: '127.0.0.1', location: 'http://127.0.0.1:4321/prompter', kind: 'loopback-error', status: 503 },
    { href: 'https://example.test/PRIVATE_CANARY?token=PRIVATE_CANARY', title: 'example.test',
      location: '[non-loopback]', kind: 'other', status: 200 },
  ]) {
    const context = { URL, location: { href: sample.href }, document: {
      title: sample.title, readyState: 'complete', contentType: 'text/html', body: { children: [] },
      getElementById: () => null,
    }, performance: { getEntriesByType: () => sample.status === null ? [] : [{ responseStatus: sample.status }] } };
    const c = { send: async (_, params) => ({ result: { value: params.expression === expression
      ? false : runInNewContext(params.expression, context) } }) };
    await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 2, intervalMs: 2, ...clock() }), error => {
      assert.equal(error.diagnostic.page.location, sample.location);
      assert.equal(error.diagnostic.page.titleKind, sample.kind);
      assert.equal(error.diagnostic.page.navigationStatus, sample.status);
      assert.doesNotMatch(error.message, /PRIVATE_CANARY/);
      return true;
    });
  }
});

test('a permanently false DOM condition fails at its own deadline', { timeout: 5000 }, async () => {
  let time = 0;
  let polls = 0;
  const sleeps = [];
  const c = { send: async (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression === expression) {
      polls++;
      return { result: { value: false } };
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: {} } };
    if (method === 'Page.getNavigationHistory') return { entries: [] };
    return { result: { value: { readyState: 'complete' } } };
  } };
  const checkTimeout = error => {
    assert.match(error.message, /timeout CDP/);
    assert.equal(error.diagnostic.last.kind, 'false');
    return true;
  };
  await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 40, intervalMs: 15,
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; } }), checkTimeout);
  assert.equal(time, 40);
  assert.equal(polls, 4);
  assert.deepEqual(sleeps, [15, 15, 10]);

  // A real timer must report the DOM deadline rather than the outer test timeout.
  await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 40, intervalMs: 15 }), checkTimeout);
});

for (const [name, timeoutMs] of [
  ['NaN', NaN], ['an options object', { timeoutMs: 10 }], ['a string', '10'],
  ['null', null], ['Infinity', Infinity], ['negative Infinity', -Infinity],
]) {
  test(`DOM wait rejects ${name} as a timeout before evaluating`, async () => {
    let evaluations = 0;
    const c = { send: async () => { evaluations++; return { result: { value: false } }; } };
    await assert.rejects(waitChromeDom(c, expression, { timeoutMs, now: () => 0,
      sleep: async () => { throw new Error('invalid timeout reached sleep'); } }),
    { name: 'TypeError', message: 'timeoutMs must be a finite number' });
    assert.equal(evaluations, 0);
  });
}

for (const [name, now, timeoutMs] of [
  ['NaN', () => NaN, 10], ['a string', () => '0', 10],
  ['overflow', () => Number.MAX_VALUE, Number.MAX_VALUE],
]) {
  test(`DOM wait rejects ${name} as a deadline before evaluating`, async () => {
    let evaluations = 0;
    const c = { send: async () => { evaluations++; return { result: { value: false } }; } };
    await assert.rejects(waitChromeDom(c, expression, { timeoutMs, now,
      sleep: async () => { throw new Error('invalid deadline reached sleep'); } }),
    { name: 'TypeError', message: 'DOM wait deadline must be a finite number' });
    assert.equal(evaluations, 0);
  });
}

test('eventos Chrome retienen clase/línea/código de red pero nunca argumentos ni mensajes crudos', () => {
  assert.deepEqual(chromeDiagnosticEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: {
    lineNumber: 17, columnNumber: 4, exception: { className: 'SyntaxError', description: 'PRIVATE_CANARY' },
  } } }), { kind: 'exception', className: 'SyntaxError', line: 17, column: 4 });
  assert.deepEqual(chromeDiagnosticEvent({ method: 'Network.loadingFailed', params: {
    type: 'Script', errorText: 'net::ERR_CONNECTION_REFUSED PRIVATE_CANARY',
  } }), { kind: 'network', resourceType: 'Script', error: 'net::ERR_CONNECTION_REFUSED' });
  assert.equal(chromeDiagnosticEvent({ method: 'Runtime.consoleAPICalled', params: { args: ['PRIVATE_CANARY'] } }), null);
});

test('timeout DOM registra frame y targets actuales antes del stderr, sin URL privada', async () => {
  const pending = 'http://user:PRIVATE_CANARY@127.0.0.1:4321/prompter?token=PRIVATE_CANARY#PRIVATE_CANARY';
  const c = {
    chromeStartup: () => ({ stderr: 'x'.repeat(3000) }),
    chromeTargetsNow: async () => [{ available: true, location: 'http://127.0.0.1:4321/prompter' }],
    send: async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { url: 'about:blank', loaderId: 'L1', unreachableUrl: pending } } };
      }
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ url: 'about:blank' }, { url: pending }] };
      }
      return { result: { value: params.expression === expression ? false : { readyState: 'complete' } } };
    },
  };
  await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 2, intervalMs: 2, ...clock() }), error => {
    assert.deepEqual(error.diagnostic.frames, {
      main: 'about:blank', loader: true, unreachable: 'http://127.0.0.1:4321/prompter',
      history: { currentIndex: 0, entries: ['about:blank', 'http://127.0.0.1:4321/prompter'] },
    });
    assert.deepEqual(error.diagnostic.targetsNow, [{ available: true, location: 'http://127.0.0.1:4321/prompter' }]);
    assert.deepEqual(Object.keys(error.diagnostic), ['last', 'page', 'frames', 'targetsNow', 'events', 'chrome']);
    // El stderr largo se recorta después: frame y targets deben sobrevivir al límite del mensaje.
    assert.match(error.message, /"frames":\{"main":"about:blank"/);
    assert.match(error.message, /"targetsNow":\[/);
    assert.doesNotMatch(error.message, /PRIVATE_CANARY/);
    return true;
  });
});

test('timeout DOM conserva el diagnóstico si Page o targets no responden', async () => {
  const c = {
    chromeTargetsNow: () => new Promise(() => {}),
    send: async (method, params) => {
      if (method === 'Page.getFrameTree') throw Object.assign(new Error('PRIVATE_CANARY'), { code: -32601 });
      if (method === 'Page.getNavigationHistory') return new Promise(() => {});
      return { result: { value: params.expression === expression ? false : { readyState: 'loading' } } };
    },
  };
  const started = Date.now();
  await assert.rejects(waitChromeDom(c, expression, { timeoutMs: 2, intervalMs: 2, ...clock() }), error => {
    assert.deepEqual(error.diagnostic.frames, { unavailable: true, cdpCode: -32601 });
    assert.deepEqual(error.diagnostic.targetsNow, { unavailable: true });
    assert.equal(error.diagnostic.page.readyState, 'loading');
    assert.doesNotMatch(error.message, /PRIVATE_CANARY/);
    return true;
  });
  assert.ok(Date.now() - started < 3500, 'diagnóstico acotado');
});
