// Temas guardados: la configuración en activo sigue en sus secciones originales.
import { DEFAULT_CONFIG } from '../store.mjs';
import { DEFAULT_THEME, publicTheme, themeCss } from '../theme.mjs';
import { buildAlert, SAMPLES } from '../alerts.mjs';
import { extractLook, applyLook, publicThemes } from '../theme-looks.mjs';
import { CONFIG_SCHEMA, validateLook, validatePatch } from '../config-schema.mjs';
import { httpError } from '../http-util.mjs';

const MAX_THEMES = 10;
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40)
    throw httpError(400, 'El nombre del tema es obligatorio y admite hasta 40 caracteres');
  return value.trim();
};
const checkLook = look => {
  const [error] = validateLook(look);
  if (error) throw httpError(400, error.message);
};
const uniqueName = (name, saved, except) => {
  if (saved.some(t => t.id !== except && t.name.toLowerCase() === name.toLowerCase()))
    throw httpError(409, 'Ya existe un tema con ese nombre');
};
const slugOf = (name, saved) => {
  const root = (name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tema').slice(0, 40).replace(/-+$/g, '');
  const used = new Set(saved.map(t => t.id));
  let id = root;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = root.slice(0, 40 - suffix.length).replace(/-+$/g, '') + suffix;
  }
  return id;
};

export function registerThemesRoutes({ route, store, onActivated = () => {} }) {
  const list = () => publicThemes(store.config.themes);
  const find = id => {
    let decoded;
    try { decoded = decodeURIComponent(id); } catch { throw httpError(400, 'Id de tema no válido'); }
    const item = store.config.themes.saved.find(t => t.id === decoded);
    if (!item) throw httpError(404, `No existe el tema «${decoded}»`);
    return item;
  };
  const lookOf = item => item.id === store.config.themes.activeId ? extractLook(store.config) : item.look;
  const pick = (value, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(value || {}, k)).map(k => [k, value[k]]));
  const validate = themes => {
    const [error] = validatePatch({ themes });
    if (error) throw httpError(400, error.message);
  };
  const add = async (name, look) => {
    const themes = store.config.themes;
    if (themes.saved.length >= MAX_THEMES) throw httpError(409, 'Como máximo se pueden guardar 10 temas');
    name = nameOf(name);
    uniqueName(name, themes.saved);
    checkLook(look);
    const id = slugOf(name, themes.saved);
    const next = { ...themes, saved: [...themes.saved, { id, name, look: structuredClone(look) }] };
    validate(next);
    await store.patchConfig({ themes: next });
    return { theme: list().find(t => t.id === id) };
  };

  route('GET', '/api/themes', async () => ({ themes: list() }));
  // Solo datos de muestra; no entregar acciones, comandos, CSS arbitrario ni secciones operativas.
  route('GET', '/api/themes/:id/look', async ({ id }) => {
    const item = find(id);
    const source = lookOf(item);
    return { look: {
      theme: pick(source.theme, Object.keys(DEFAULT_THEME)),
      alert: pick(source.alerts?.follow, ['title', 'text', 'sub', 'layout', 'textColor', 'accentColor', 'fontSize']),
      goal: pick(source.widgets?.goals?.[0], ['title', 'showMetric', 'visible']),
      chat: pick(source.widgets?.chat, ['fontSize', 'layout', 'showPlatform', 'reverse']),
    } };
  });
  // Preview-only projection: real renderer inputs, never the operational actions or global config.
  route('GET', '/api/themes/:id/preview', async ({ id }) => {
    const look = lookOf(find(id));
    const built = buildAlert('follow', { ...SAMPLES.follow }, look, { test: true });
    const { actions: _actions, tts: _tts, ...alert } = built;
    const goals = (look.widgets?.goals || []).map(goal => ({
      ...pick(goal, ['id', 'title', 'label', 'visible', 'showMetric', 'showLabel', 'showTitle', 'css']),
      bars: (goal.bars || []).map(bar => pick(bar, ['id', 'platform', 'metric', 'target', 'visible'])),
    }));
    return { theme: publicTheme(pick(look.theme, Object.keys(DEFAULT_THEME))), css: themeCss(look.theme), alert,
      widgets: { chat: pick(look.widgets?.chat, Object.keys(CONFIG_SCHEMA.widgets.chat)) }, goals };
  });
  route('POST', '/api/themes/duplicate', async ({ from, name } = {}) => {
    const source = find(from);
    return add(name, lookOf(source));
  });
  route('POST', '/api/themes/from-default', async ({ name } = {}) => {
    return add(name, extractLook(structuredClone(DEFAULT_CONFIG)));
  });
  route('PUT', '/api/themes/:id', async ({ id }, body = {}) => {
    const item = find(id), name = nameOf(body.name), themes = store.config.themes;
    uniqueName(name, themes.saved, item.id);
    const next = { ...themes, saved: themes.saved.map(t => t.id === item.id ? { ...t, name } : t) };
    validate(next);
    await store.patchConfig({ themes: next });
    return { theme: list().find(t => t.id === item.id) };
  });
  route('DELETE', '/api/themes/:id', async ({ id }) => {
    const item = find(id), themes = store.config.themes;
    if (item.id === themes.activeId) throw httpError(409, 'Activa otro tema antes de borrar este');
    const next = { ...themes, saved: themes.saved.filter(t => t.id !== item.id) };
    validate(next);
    await store.patchConfig({ themes: next });
    return { themes: list() };
  });
  const activate = async ({ id }) => {
    const item = find(id);
    if (item.id === store.config.themes.activeId) return { theme: list().find(t => t.id === item.id) };
    const before = structuredClone(store.config), current = extractLook(before);
    const target = before.themes.saved.find(t => t.id === item.id);
    checkLook(current); checkLook(target.look);
    const next = structuredClone(before);
    applyLook(next, target.look);
    next.themes = { activeId: target.id, saved: before.themes.saved.map(t => t.id === before.themes.activeId
      ? { id: t.id, name: t.name, look: current }
      : t.id === target.id ? { id: t.id, name: t.name } : t) };
    validate(next.themes);
    await store.replaceConfigWithBackup(next, before, { themes: true, theme: true, alerts: true, overlay: true,
      widgets: true, interactive: true, commands: true, timers: true, customOverlays: true }, onActivated);
    return { theme: list().find(t => t.id === item.id) };
  };
  route('POST', '/api/themes/:id/activate', activate);
  // Stream Deck uses the same activation transaction and errors as the panel and MCP.
  route('GET', '/sd/tema/:id', activate);
  route('POST', '/sd/tema/:id', activate);
}
