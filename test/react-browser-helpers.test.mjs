// #47: clickWhen must not report success for a click on a disabled element. A disabled
// button ignores .click(); reporting success there made react-shortcuts wait 9 s for a
// message the ignored click never produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickWhen } from './helpers/react-browser.mjs';

// Fake CDP: evaluates the expression in Node against globalThis.__btn instead of a page.
const fakeCdp = () => ({
  send: async (method, { expression }) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: new Function(`return ${expression}`)() } };
  },
});

function button({ enabledAfter }) {
  let evaluations = 0;
  const btn = { clicks: 0, ignoredClicks: 0, click() { if (this.disabled) this.ignoredClicks++; else this.clicks++; } };
  Object.defineProperty(btn, 'disabled', { get: () => evaluations <= enabledAfter });
  return { btn, tick: () => { evaluations++; return btn; } };
}

test('clickWhen waits for a disabled element to become enabled before clicking', async t => {
  const { btn, tick } = button({ enabledAfter: 2 });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  assert.equal(await clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 10, ms: 1 }), true);
  assert.equal(btn.ignoredClicks, 0, 'no click lands on the disabled button');
  assert.equal(btn.clicks, 1, 'exactly one click once enabled');
});

test('clickWhen fails when the element never becomes enabled', async t => {
  const { btn, tick } = button({ enabledAfter: Infinity });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  await assert.rejects(clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 3, ms: 1 }), /no se pudo hacer clic en: globalThis\.__tick\(\)/);
  assert.equal(btn.clicks + btn.ignoredClicks, 0, 'never clicked');
});

test('clickWhen clicks an enabled element on the first try', async t => {
  const { btn, tick } = button({ enabledAfter: 0 });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  assert.equal(await clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 3, ms: 1 }), true);
  assert.equal(btn.clicks, 1);
});
