// Fusión del chat al aplicar una instantánea (load tras abrir el SSE o tras un corte/gap):
// orden correcto al reconectar y sin resurrección de mensajes borrados en el servidor.
// La función vive en app/src/lib/chat-merge.mjs, compartida por live.ts, prompter y dock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChat } from '../app/src/lib/chat-merge.mjs';

const m = id => ({ id, user: 'u' + id, text: 't' + id, platform: 'twitch', at: 0 });

test('chat-merge: al reconectar, lo local más viejo que la ventana del snapshot no va al final', () => {
  // la lista local guarda más (300) que la ventana del snapshot (~50/120): «viejo» salió de
  // la ventana del servidor y no debe reaparecer abajo desordenando el chat.
  const prev = [m('viejo'), m('a'), m('b')];
  const out = mergeChat(prev, [m('a'), m('b')], new Set());
  assert.deepEqual(out.map(x => x.id), ['a', 'b']);
});

test('chat-merge: un mensaje borrado en el servidor durante un corte no reaparece', () => {
  // el servidor lo quitó con chatDelete/chatClear durante la desconexión; el snapshot
  // ya no lo trae y lo local no debe resucitarlo.
  const prev = [m('a'), m('borrado')];
  const out = mergeChat(prev, [m('a')], new Set());
  assert.deepEqual(out.map(x => x.id), ['a']);
});

test('chat-merge: los recibidos por SSE en plena carga se conservan en orden y sin duplicar', () => {
  const prev = [m('a'), m('en1'), m('en2')];
  const out = mergeChat(prev, [m('a')], new Set(['en1', 'en2']));
  assert.deepEqual(out.map(x => x.id), ['a', 'en1', 'en2']);
});

test('chat-merge: en curso que ya está en el snapshot no se duplica', () => {
  const prev = [m('a'), m('en1')];
  const out = mergeChat(prev, [m('a'), m('en1')], new Set(['en1']));
  assert.deepEqual(out.map(x => x.id), ['a', 'en1']);
});

test('chat-merge: sin local, sin inflight o sin snapshot, el resultado es razonable', () => {
  assert.deepEqual(mergeChat([], [m('a')], new Set(['z'])).map(x => x.id), ['a']);
  assert.deepEqual(mergeChat(undefined, [m('a')], new Set()).map(x => x.id), ['a']);
  assert.deepEqual(mergeChat([m('z')], undefined, new Set()).map(x => x.id), []);
  assert.deepEqual(mergeChat(undefined, undefined, new Set(['z'])), []);
});
