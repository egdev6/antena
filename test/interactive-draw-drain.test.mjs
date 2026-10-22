import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from '../src/interactive.mjs';

const tick = () => new Promise(r => setImmediate(r));
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const store = { dir: '.', config: { interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) } };
  Object.assign(store.config.interactive.giveaway, { rollSeconds: 2, excludeWinners: false });
  const twitch = { sendChat: async () => { calls.push('chat'); } };
  const meld = { connected: true, streamEvent: async () => { calls.push('confetti'); } };
  const i = new Interactive({ store, twitch, meld, log: () => {}, writer: async () => {} });
  i.giveaway.open = true;
  i.join({ user: 'ana', platform: 'twitch' });
  return { i, twitch, meld, calls };
}

test('registro reentrante, demora real configurada y espera de chat y confeti', async t => {
  const { i, twitch, meld, calls } = fixture(t);
  assert.equal(typeof i.drainDraws, 'function');
  let releaseChat, releaseConfetti, drain;
  twitch.sendChat = () => { calls.push('chat'); return new Promise(r => { releaseChat = r; }); };
  meld.streamEvent = () => { calls.push('confetti'); return new Promise(r => { releaseConfetti = r; }); };
  i.once('draw', () => { drain = i.drainDraws(); });
  assert.deepEqual(await i.draw(), { winner: 'ana', entries: 1, pool: 1 });
  let settled = false;
  drain.then(() => { settled = true; });
  t.mock.timers.tick(1999); await tick();
  assert.deepEqual(calls, []);
  assert.equal(settled, false);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual(calls, ['chat']);
  assert.equal(settled, false);
  releaseChat(); await tick();
  assert.deepEqual(calls, ['chat', 'confetti']);
  assert.equal(settled, false);
  releaseConfetti(); await drain;
  assert.equal(i.giveawayState().history.length, 1);
  assert.equal(i.giveawayState().history[0].winner, 'ana');
});

test('snapshot espera sorteos solapados, excluye raíces tardías y sigue reutilizable', async t => {
  const { i, calls } = fixture(t);
  assert.equal(typeof i.drainDraws, 'function');
  await i.draw(); await i.draw();
  const first = i.drainDraws();
  t.mock.timers.tick(1000);
  await i.draw();
  const second = i.drainDraws();
  assert.notEqual(first, second);
  let lateDone = false;
  second.then(() => { lateDone = true; });
  t.mock.timers.tick(1000); await first; await tick();
  assert.equal(i.giveawayState().history.length, 2);
  assert.equal(lateDone, false);
  t.mock.timers.tick(1000); await second;
  assert.equal(i.giveawayState().history.length, 3);
  assert.equal(calls.length, 6);
  assert.equal(await i.drainDraws(), undefined);
});

test('fallos originales de chat y confeti visibles sin saltar historial ni envenenar futuro', async t => {
  const { i, twitch, meld } = fixture(t);
  assert.equal(typeof i.drainDraws, 'function');
  const chatError = new Error('chat'), meldError = new Error('');
  twitch.sendChat = async () => { throw chatError; };
  meld.streamEvent = () => { throw meldError; };
  await i.draw();
  const drain = i.drainDraws();
  const check = assert.rejects(drain, e => {
    assert.ok(e instanceof AggregateError);
    assert.match(e.message, /sorteos/);
    assert.ok(e.errors.some(c => c instanceof AggregateError && c.errors.includes(chatError) && c.errors.includes(meldError)));
    return true;
  });
  t.mock.timers.tick(2000); await check;
  assert.equal(i.giveawayState().history.length, 1);
  assert.equal(await i.drainDraws(), undefined);
  // Abrir/cerrar conserva el error manejado del anuncio, no hereda el modo estricto.
  assert.equal((await i.openGiveaway()).open, true);
  assert.equal((await i.closeGiveaway()).open, false);
});

test('un listener que lanza no deja trabajo eternamente pendiente', async t => {
  const { i } = fixture(t);
  assert.equal(typeof i.drainDraws, 'function');
  const error = new Error('listener');
  let drain;
  i.once('draw', () => { drain = i.drainDraws(); throw error; });
  await assert.rejects(i.draw(), e => e === error);
  await assert.rejects(drain, e => e instanceof AggregateError && e.errors.includes(error));
  assert.equal(await i.drainDraws(), undefined);
  assert.equal(i.giveawayState().history.length, 0);
});
