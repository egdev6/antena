// Animaciones del chat en pantalla: fuente única en public/widgets/chat-anims.js.
// Estructural (sin Chrome): esquema, widget y panel cuelgan de la misma lista y no la copian;
// las etiquetas del panel cubren exactamente esos ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rutas del sistema (no .pathname de una URL, que en Windows da «/D:/…»)
const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(path.join(root, p), 'utf8');
const load = () => import(new URL('../public/widgets/chat-anims.js', import.meta.url).href);
// una copia literal de la lista: dos o más ids de animación seguidos entre comillas
const LITERAL_LIST = /\[\s*'(slide|fade|pop|bounce|zoom|flip|blur|drop|none)'\s*,\s*'(slide|fade|pop|bounce|zoom|flip|blur|drop|none)'/;

test('chat-anims.js: ids únicos, «none» incluido y lista congelada', async () => {
  const { CHAT_ANIMS } = await load();
  assert.ok(Array.isArray(CHAT_ANIMS) && CHAT_ANIMS.length > 1);
  assert.equal(new Set(CHAT_ANIMS).size, CHAT_ANIMS.length, 'sin ids repetidos');
  assert.ok(CHAT_ANIMS.includes('none'), '«none» desactiva la animación');
  for (const id of CHAT_ANIMS) assert.match(id, /^[a-z]+$/, `id ${id} válido como sufijo de clase`);
  assert.ok(Object.isFrozen(CHAT_ANIMS));
});

test('esquema: animIn y animOut aceptan exactamente CHAT_ANIMS', async () => {
  const { CHAT_ANIMS } = await load();
  const { schemaAt } = await import('../src/config-schema.mjs');
  for (const f of ['animIn', 'animOut']) assert.deepEqual([...schemaAt(`widgets.chat.${f}`).values], [...CHAT_ANIMS], f);
  const src = read('src/config-schema.mjs');
  assert.match(src, /import \{ CHAT_ANIMS \} from '\.\.\/public\/widgets\/chat-anims\.js'/, 'el esquema importa la fuente única');
});

test('widget: chat.html importa la lista y no la copia', () => {
  const src = read('public/widgets/chat.html');
  assert.match(src, /import \{ CHAT_ANIMS \} from '\/widgets\/chat-anims\.js'/);
  assert.ok(!LITERAL_LIST.test(src), 'chat.html no repite la lista de animaciones');
});

test('panel: Widgets.tsx importa la lista y sus etiquetas cubren exactamente los ids', async () => {
  const { CHAT_ANIMS } = await load();
  const src = read('app/src/panel/views/Widgets.tsx');
  assert.match(src, /import \{ CHAT_ANIMS(, type ChatAnim)? \} from '(\.\.\/){4}public\/widgets\/chat-anims\.js'/);
  assert.ok(!LITERAL_LIST.test(src), 'el panel no repite la lista de animaciones');
  const m = src.match(/const CHAT_ANIM_LABELS[^=]*=\s*\{([^}]*)\}/);
  assert.ok(m, 'etiquetas del panel en CHAT_ANIM_LABELS, por id');
  const keys = [...m[1].matchAll(/(\w+)\s*:/g)].map(k => k[1]);
  assert.deepEqual(keys.slice().sort(), [...CHAT_ANIMS].sort(), 'una etiqueta por id, ni más ni menos');
});
