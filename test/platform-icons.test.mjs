// #141: logos de plataforma a color — fuente única en public/platform-icons.js.
// Estructural (sin Chrome): forma de LOGOS, sin código muerto y consumidores colgados de la fuente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rutas del sistema (no .pathname de una URL, que en Windows da «/D:/…»)
const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(path.join(root, p), 'utf8');

test('platform-icons.js: LOGOS tipado, con viewBox y pares [relleno, ruta] para twitch y youtube', async () => {
  const mod = await import(new URL('../public/platform-icons.js', import.meta.url).href);
  for (const p of ['twitch', 'youtube']) {
    const logo = mod.LOGOS[p];
    assert.ok(logo, `falta LOGOS.${p}`);
    assert.match(logo.viewBox, /^0 0 [\d.]+ [\d.]+$/);
    assert.ok(logo.paths.length >= 2, `LOGOS.${p} necesita varias rutas (color de marca + blanco)`);
    for (const [fill, d] of logo.paths) {
      assert.equal(typeof fill, 'string');
      assert.match(d, /^[Mm]/);
    }
  }
  assert.equal(mod.PLATFORM_NAMES.twitch, 'Twitch');
  assert.equal(mod.PLATFORM_NAMES.youtube, 'YouTube');
});

test('platform-icons.js: sin código muerto (pfIcon retirado en #141); los consumidores usan platformSvg/LOGOS', () => {
  const src = read('public/platform-icons.js');
  assert.ok(!/export function pfIcon/.test(src), 'pfIcon quedó sin llamadas: retirar');
  assert.ok(!/egPlatform/.test(src));
  for (const p of ['public/widgets/chat.html', 'public/widgets/goal.html']) {
    assert.match(read(p), /from '\/platform-icons\.js'/, `${p} importa la fuente única`);
    assert.ok(!/M11\.571 4\.714|M23\.498 6\.186/.test(read(p)), `${p} ya no copia rutas`);
  }
});

test('panel React: PfIcon pinta LOGOS a color, sin cast y sin IC.twitch/IC.youtube', () => {
  const ui = read('app/src/lib/ui.tsx');
  assert.match(ui, /import \{ LOGOS \} from '[^']*public\/platform-icons\.js'/);
  assert.ok(!/LOGOS as /.test(ui), 'sin cast TS2352: el tipo viene del JSDoc de platform-icons.js');
  assert.match(ui, /Status\(\{.*icon\?: string \| ReactNode/s, 'Status acepta un nodo como icono');
  assert.ok(!/IC\.twitch|IC\.youtube/.test(read('app/src/lib/icons.ts')), 'fuera IC.twitch/IC.youtube monocromos');
  for (const p of ['app/src/panel/views/Directo.tsx', 'app/src/panel/views/Widgets.tsx', 'app/src/prompter/Prompter.tsx'])
    assert.ok(!/IC\.twitch|IC\.youtube/.test(read(p)), `${p} usa PfIcon`);
});
