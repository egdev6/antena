// SDK settings (#344): antena.settings and the 'settings' event, from the shell's snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SDK_SOURCE = await readFile(new URL('../public/custom/sdk.js', import.meta.url), 'utf8');

function loadSdk() {
  const parent = { postMessage() {} };
  const listeners = [];
  const win = { parent, addEventListener(type, fn) { if (type === 'message') listeners.push(fn); }, removeEventListener() {} };
  win.window = win;
  vm.runInContext(SDK_SOURCE, vm.createContext({ window: win, console, setTimeout, clearTimeout, Promise }), { filename: 'public/custom/sdk.js' });
  const deliver = (data, source = parent) => { for (const fn of [...listeners]) fn({ source, data }); };
  return { antena: win.antena, deliver };
}

test('the SDK exposes the overlay settings and notifies changes; only the shell can send them', () => {
  const { antena, deliver } = loadSdk();
  assert.equal(antena.settings, null, 'no settings before the shell sends them');
  const seen = [];
  antena.on('settings', s => seen.push(s.title));
  deliver({ antena: 1, event: 'settings', data: { title: 'Hola' } }, { postMessage() {} });   // not the shell
  assert.deepEqual(seen, []);
  deliver({ antena: 1, event: 'settings', data: { title: 'Hola' } });
  deliver({ antena: 1, event: 'settings', data: { title: 'Adiós' } });
  assert.deepEqual(seen, ['Hola', 'Adiós']);
  assert.equal(antena.settings.title, 'Adiós');
  assert.equal(antena.state.settings.title, 'Adiós');
  const late = [];
  antena.on('settings', s => late.push(s.title));
  assert.deepEqual(late, ['Adiós'], 'a late subscription gets the current settings at once');
});
