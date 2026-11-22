// Temas guardados: la configuración en activo sigue en sus secciones originales.
import { DEFAULT_CONFIG, deepMerge } from '../store.mjs';
import { PRESETS } from '../theme.mjs';
import { extractLook, applyLook, publicThemes } from '../theme-looks.mjs';
import { validateLook, validatePatch } from '../config-schema.mjs';
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
  route('POST', '/api/themes/duplicate', async ({ from, name } = {}) => {
    const source = find(from);
    return add(name, source.id === store.config.themes.activeId ? extractLook(store.config) : source.look);
  });
  route('POST', '/api/themes/from-default', async ({ name } = {}) => {
    const defaults = structuredClone(DEFAULT_CONFIG);
    defaults.theme = deepMerge(defaults.theme, PRESETS.plataforma.theme);
    return add(name, extractLook(defaults));
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
  route('POST', '/api/themes/:id/activate', async ({ id }) => {
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
  });
}
