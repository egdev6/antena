import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from '../src/interactive.mjs';

async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-vote-recovery-'));
  const instances = [];
  const make = () => {
    const store = { dir, config: { interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) } };
    const s = new Interactive({ store, twitch: {}, meld: {}, log: () => {}, debounceMs: 60000, maxWaitMs: 60000 });
    instances.push(s); return s;
  };
  t.after(async () => {
    for (const s of instances) {
      clearTimeout(s.voteTimer); clearTimeout(s.saveT); clearTimeout(s.maxT);
      await s.chain;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const s = make();
  const list = s.createTierlist({ items: ['Uno', 'Dos'] });
  return { s, list, make };
}
const open = (s, list, seconds = 10) => {
  s.startVote(list.id, list.items[0].id, seconds);
  s.castVote({ user: 'Ana' }, 'S');
  return structuredClone(s.s.vote);
};

test('sello conserva voto y permite continuaciones manuales sin reactivar timer', async t => {
  const { s, list } = await fixture(t); const vote = open(s, list);
  s.quiesceVoteTimer(); s.quiesceVoteTimer();
  assert.equal(s.voteTimer, null);
  t.mock.timers.tick(30000);
  assert.deepEqual(s.s.vote, vote); assert.deepEqual(list.placements, {});
  assert.equal(s.castVote({ user: 'Bea' }, 'A'), true);
  await s.flush();
  const saved = JSON.parse(await readFile(s.file, 'utf8'));
  assert.equal(saved.vote.endsAt, vote.endsAt); assert.deepEqual(saved.vote.votes, { ana: 's', bea: 'a' });
  s.startVote(list.id, list.items[1].id, 10);
  s.castVote({ user: 'Bea' }, 'A');
  assert.equal(s.voteTimer, null);
  t.mock.timers.tick(30000); assert.ok(s.s.vote);
  s.closeVote(); assert.equal(list.placements[list.items[1].id], 'a');
  s.startVote(list.id, list.items[0].id, 10); s.cancelVote();
  assert.equal(s.s.vote, null); assert.equal(s.voteTimer, null);
});

test('load recupera solo plazo restante sin cambiar endsAt ni reiniciar duración', async t => {
  const { s, list, make } = await fixture(t); const vote = open(s, list);
  await s.flush(); s.quiesceVoteTimer(); t.mock.timers.tick(3000);
  const recovered = await make().load();
  assert.equal(recovered.s.vote.endsAt, vote.endsAt); assert.ok(recovered.voteTimer);
  t.mock.timers.tick(6999); assert.ok(recovered.s.vote);
  t.mock.timers.tick(1);
  assert.equal(recovered.s.vote, null); assert.equal(recovered.voteTimer, null);
  assert.equal(recovered.s.tierlists[0].placements[list.items[0].id], 's');
  await recovered.flush();
  assert.equal(JSON.parse(await readFile(s.file, 'utf8')).vote, null);
});

test('voto vencido al recuperar aplica cierre normal, empate tier superior y persiste', async t => {
  const { s, list, make } = await fixture(t);
  open(s, list, 2); s.castVote({ user: 'Bea' }, 'A');
  await s.flush(); s.quiesceVoteTimer(); t.mock.timers.tick(3000);
  const recovered = await make().load();
  assert.equal(recovered.s.vote, null); assert.equal(recovered.voteTimer, null);
  assert.equal(recovered.s.tierlists[0].placements[list.items[0].id], 's');
  await recovered.flush();
  const saved = JSON.parse(await readFile(s.file, 'utf8'));
  assert.equal(saved.vote, null); assert.equal(saved.tierlists[0].placements[list.items[0].id], 's');
});

for (const deadline of [null, 'fecha-invalida']) {
  test(`load sin plazo válido conserva voto manual: ${deadline}`, async t => {
    const { s, list, make } = await fixture(t); open(s, list, 0);
    s.s.vote.endsAt = deadline; await s.flush();
    const recovered = await make().load();
    t.mock.timers.tick(86400000);
    assert.ok(recovered.s.vote); assert.equal(recovered.voteTimer, null);
    assert.deepEqual(recovered.s.tierlists[0].placements, {});
  });
}

test('callbacks obsoletos de reemplazo, close, cancel y sello no alteran otro voto', async t => {
  const { s, list } = await fixture(t);
  const callbacks = []; const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 10000) callbacks.push(fn);
    return timeout(fn, ms, ...args);
  });
  open(s, list); s.startVote(list.id, list.items[1].id, 10);
  callbacks[0](); assert.equal(s.s.vote.itemId, list.items[1].id);
  s.closeVote(); open(s, list); callbacks[1](); assert.ok(s.s.vote);
  s.cancelVote(); open(s, list); callbacks[2](); assert.ok(s.s.vote);
  const vote = structuredClone(s.s.vote);
  s.quiesceVoteTimer(); callbacks[3](); assert.deepEqual(s.s.vote, vote);
});

test('load repetido retira timer anterior y una lectura supersedida no rearma tras sello', async t => {
  const { s, list, make } = await fixture(t); open(s, list); await s.flush(); s.quiesceVoteTimer();
  const recovered = make(); await recovered.load();
  t.mock.timers.tick(1000); await recovered.load();
  t.mock.timers.tick(8999); assert.ok(recovered.s.vote);
  t.mock.timers.tick(1); assert.equal(recovered.s.vote, null);
  const pending = recovered.load(); recovered.quiesceVoteTimer(); await pending;
  assert.equal(recovered.voteTimer, null); assert.equal(recovered.s.vote, null);
  const sealed = make(); sealed.quiesceVoteTimer(); await sealed.load();
  assert.equal(sealed.voteTimer, null);
  assert.ok(sealed.s.vote, 'load sellado no aplica vencimiento');
});

test('lectura fallida conserva voto vivo y retira timer obsoleto sin duplicar cierre', async t => {
  const { s, list } = await fixture(t);
  const callbacks = []; const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 10000) callbacks.push(fn);
    return timeout(fn, ms, ...args);
  });
  const vote = open(s, list); t.mock.timers.tick(3000);
  await assert.rejects(readFile(s.file), { code: 'ENOENT' });
  await s.load(); assert.deepEqual(s.s.vote, vote); assert.ok(s.voteTimer);
  callbacks[0](); assert.deepEqual(s.s.vote, vote);
  let closed = 0; s.on('change', () => { if (!s.s.vote) closed++; });
  t.mock.timers.tick(6999); assert.ok(s.s.vote);
  t.mock.timers.tick(1); assert.equal(s.s.vote, null); assert.equal(closed, 1);
});

test('load mantiene carga previa de null y no falla al recuperar voto huérfano', async t => {
  const { s, list, make } = await fixture(t); open(s, list);
  const saved = structuredClone(s.s);
  saved.tierlists = []; saved.vote.endsAt = new Date(Date.now() - 1).toISOString();
  await writeFile(s.file, JSON.stringify(saved));
  const recovered = await make().load();
  assert.deepEqual(recovered.s.vote, saved.vote);
  assert.equal(recovered.voteTimer, null);
  await writeFile(s.file, 'null');
  await recovered.load();
  assert.equal(recovered.s.vote, null); assert.deepEqual(recovered.s.tierlists, []);
});

test('plazo mayor que timer Node se espera por tramos sin cierre anticipado', async t => {
  const { s, list, make } = await fixture(t); open(s, list, 0);
  const max = 2147483647;
  s.s.vote.endsAt = new Date(Date.now() + max + 1000).toISOString();
  await s.flush();
  const recovered = await make().load();
  t.mock.timers.tick(max); assert.ok(recovered.s.vote);
  t.mock.timers.tick(999); assert.ok(recovered.s.vote);
  t.mock.timers.tick(1); assert.equal(recovered.s.vote, null);
});
