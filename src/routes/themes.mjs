// Temas guardados: la configuración en activo sigue en sus secciones originales.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../store.mjs';
import { DEFAULT_THEME, publicTheme, themeCss } from '../theme.mjs';
import { ALERT_TYPES, buildAlert, SAMPLES } from '../alerts.mjs';
import { extractLook, applyLook, publicThemes } from '../theme-looks.mjs';
import { CONFIG_SCHEMA, themeAvatarError, validateLook, validatePatch } from '../config-schema.mjs';
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

export function registerThemesRoutes({ route, store, mediaDir, onActivated = () => {} }) {
  const avatarOf = async value => {
    if (value === undefined || value === null) return value;
    const error = themeAvatarError(value, { allowEmpty: true });
    if (error) throw httpError(400, error);
    if (value.image) {
      // lstat: a symlink in the media folder could point outside it, so only regular files count.
      const file = await lstat(path.join(mediaDir, value.image)).catch(() => null);
      if (!file?.isFile()) throw httpError(400, `No existe la imagen «${value.image}» en la carpeta de media`);
    }
    return value;
  };
  const mergeAvatar = (previous, value) => {
    if (value === undefined) return previous;
    if (value === null) return undefined;
    const next = { ...previous };
    for (const key of ['image', 'color']) if (Object.hasOwn(value, key)) {
      if (value[key] === '') delete next[key]; else next[key] = value[key];
    }
    return Object.keys(next).length ? next : undefined;
  };
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
  const add = async (name, look, avatarInput, options = {}) => {
    if (store.config.themes.saved.length >= MAX_THEMES) throw httpError(409, 'Como máximo se pueden guardar 10 temas');
    name = nameOf(name);
    checkLook(look);
    const patch = await avatarOf(avatarInput);
    // stat can yield to another write: use the latest theme list before building the update.
    const themes = store.config.themes;
    if (themes.saved.length >= MAX_THEMES) throw httpError(409, 'Como máximo se pueden guardar 10 temas');
    uniqueName(name, themes.saved);
    const avatar = mergeAvatar(undefined, patch);
    const id = slugOf(name, themes.saved);
    const next = { ...themes, saved: [...themes.saved, { id, name, look: structuredClone(look), ...(avatar && { avatar }) }] };
    validate(next);
    if (options.transactional) {
      const before = options.expected || structuredClone(store.config);
      await store.replaceConfigWithBackup({ ...before, themes: next }, before, { themes: true }, options.onCommit);
    } else await store.patchConfig({ themes: next });
    return { theme: list().find(t => t.id === id) };
  };
  const ensureCapacity = () => {
    if (store.config.themes.saved.length >= MAX_THEMES) throw httpError(409, 'Como máximo se pueden guardar 10 temas');
  };
  const suggestName = value => {
    const name = nameOf(value), used = new Set(store.config.themes.saved.map(item => item.name.toLowerCase()));
    if (!used.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`, candidate = name.slice(0, 40 - suffix.length).trimEnd() + suffix;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
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
  route('GET', '/api/themes/:id/preview', async ({ id }, _body, url) => {
    const item = find(id), look = lookOf(item);
    const type = url.searchParams.get('type') || 'follow';
    if (!Object.hasOwn(ALERT_TYPES, type)) throw httpError(404, 'Tipo desconocido');
    const built = buildAlert(type, { ...SAMPLES[type] }, look, { test: true });
    const { actions: _actions, tts: _tts, ...alert } = built;
    const goals = (look.widgets?.goals || []).map(goal => ({
      ...pick(goal, ['id', 'title', 'label', 'visible', 'showMetric', 'showLabel', 'showTitle', 'css']),
      bars: (goal.bars || []).map(bar => pick(bar, ['id', 'platform', 'metric', 'target', 'visible'])),
    }));
    return { activeTheme: { id: item.id, name: item.name }, theme: publicTheme(pick(look.theme, Object.keys(DEFAULT_THEME))), css: themeCss(look.theme), alert,
      widgets: { chat: pick(look.widgets?.chat, Object.keys(CONFIG_SCHEMA.widgets.chat)) }, goals };
  });
  route('POST', '/api/themes/duplicate', async ({ from, name, avatar } = {}) => {
    const source = find(from);
    return add(name, lookOf(source), avatar);
  });
  route('POST', '/api/themes/from-default', async ({ name, avatar } = {}) => {
    return add(name, extractLook(structuredClone(DEFAULT_CONFIG)), avatar);
  });
  route('PUT', '/api/themes/:id', async ({ id }, body = {}) => {
    find(id);
    if (!Object.hasOwn(body, 'name') && !Object.hasOwn(body, 'avatar')) nameOf(undefined);
    const requestedName = Object.hasOwn(body, 'name') ? nameOf(body.name) : undefined;
    const patch = await avatarOf(body.avatar);
    const item = find(id), themes = store.config.themes;
    const name = requestedName ?? item.name;
    uniqueName(name, themes.saved, item.id);
    const avatar = mergeAvatar(item.avatar, patch);
    const next = { ...themes, saved: themes.saved.map(t => {
      if (t.id !== item.id) return t;
      const { avatar: _avatar, ...rest } = t;
      return { ...rest, name, ...(avatar && { avatar }) };
    }) };
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
    next.themes = { activeId: target.id, saved: before.themes.saved.map(t => {
      if (t.id === before.themes.activeId) return { ...t, look: current };
      if (t.id === target.id) { const { look: _look, ...rest } = t; return rest; }
      return t;
    }) };
    validate(next.themes);
    await store.replaceConfigWithBackup(next, before, { themes: true, theme: true, alerts: true, overlay: true,
      widgets: true, interactive: true, commands: true, timers: true, customOverlays: true, customOverlayCss: true }, onActivated);
    return { theme: list().find(t => t.id === item.id) };
  };
  route('POST', '/api/themes/:id/activate', activate);
  // Stream Deck uses the same activation transaction and errors as the panel and MCP.
  route('GET', '/sd/tema/:id', activate);
  route('POST', '/sd/tema/:id', activate);
  return { find, lookOf, add, ensureCapacity, suggestName, nameOf };
}
