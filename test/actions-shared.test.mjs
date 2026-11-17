import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CUSTOM_OVERLAY_ACTION_KINDS } from '../src/custom-overlays.mjs';
import { registerShortcutRoutes } from '../src/routes/shortcuts.mjs';
import { CONFIG_SCHEMA } from '../src/config-schema.mjs';
import { TOOLS } from '../src/mcp.mjs';

const kinds = ['scene', 'layer', 'hideLayer', 'toggleLayer', 'effect', 'command', 'streamEvent', 'chat', 'say'];
const editorLabels = ['Cambiar a escena', 'Mostrar capa unos segundos', 'Ocultar capa', 'Alternar capa', 'Alternar efecto', 'Comando de Meld', 'Evento de widget de Meld', 'Escribir en el chat', 'Decir en voz alta'];
const permissionLabels = ['Cambiar de escena', 'Mostrar una capa', 'Ocultar una capa', 'Alternar una capa', 'Activar un efecto', 'Lanzar un comando de Meld', 'Disparar un evento de Meld', 'Escribir en el chat', 'Leer en voz alta'];
const obs = ['meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction', 'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction'];

test('catálogo de acciones único: overlays, atajos, esquema, panel y MCP conservan orden y textos', async () => {
  const { ACTION_KINDS, ACTION_LABELS, OVERLAY_ACTION_LABELS, OBS_COMMANDS } = await import('../src/actions.mjs');
  assert.deepEqual(ACTION_KINDS, kinds);
  assert.deepEqual(Object.keys(ACTION_LABELS), kinds);
  assert.deepEqual(Object.values(ACTION_LABELS), editorLabels);
  assert.deepEqual(Object.keys(OVERLAY_ACTION_LABELS), kinds);
  assert.deepEqual(Object.values(OVERLAY_ACTION_LABELS), permissionLabels);
  assert.deepEqual(OBS_COMMANDS, obs);
  assert.strictEqual(CUSTOM_OVERLAY_ACTION_KINDS, ACTION_KINDS);
  assert.strictEqual(CONFIG_SCHEMA.alerts.follow.actions.item.kind.values, ACTION_KINDS);
  assert.strictEqual(CONFIG_SCHEMA.customOverlays.item.requestedPermissions.values, ACTION_KINDS);
  const routes = new Map();
  registerShortcutRoutes({ route: (method, route, fn) => routes.set(`${method} ${route}`, fn), store: { config: { shortcuts: [] } }, PROMPTER_TABS: [] });
  const shortcuts = await routes.get('GET /api/shortcuts')();
  assert.deepEqual(shortcuts.stepKinds, ['builtin', ...ACTION_KINDS]);
  for (const name of ['crear_overlay', 'editar_overlay']) {
    const tool = TOOLS.find(t => t.name === name);
    assert.strictEqual(tool.inputSchema.properties.permisos.items.enum, ACTION_KINDS, name);
  }
  // Comprueba la vinculación de los TSX reales, además de los valores públicos de arriba.
  const editor = await readFile(new URL('../app/src/panel/views/Editor.tsx', import.meta.url), 'utf8');
  const overlays = await readFile(new URL('../app/src/panel/views/Overlays.tsx', import.meta.url), 'utf8');
  assert.match(editor, /import\s*\{[^}]*ACTION_LABELS[^}]*OBS_COMMANDS[^}]*\}\s*from\s*['"][^'"]*src\/actions\.mjs['"]/);
  assert.match(overlays, /import\s*\{[^}]*OVERLAY_ACTION_LABELS[^}]*\}\s*from\s*['"][^'"]*src\/actions\.mjs['"]/);
  assert.match(editor, /ACTIONS[^\n=]*=\s*ACTION_LABELS/);
  assert.match(overlays, /PERMISOS[^\n=]*=\s*OVERLAY_ACTION_LABELS/);
});

test('MCP conserva exactamente los tipos de alerta publicados antes', () => {
  const expected = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'superchat', 'supersticker', 'member', 'milestone', 'giftmember', 'viewers', 'ytviewers'];
  for (const name of ['ver_alerta', 'editar_alerta', 'restaurar_alerta', 'crear_variacion', 'editar_variacion', 'borrar_variacion', 'ordenar_variaciones', 'probar_alerta', 'simular_evento']) {
    assert.deepEqual(TOOLS.find(t => t.name === name).inputSchema.properties.tipo.enum, expected, name);
  }
});
