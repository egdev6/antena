// Rutas del tema de pantalla (Apariencia): /api/theme* y la hoja /theme.css (esta va en el
// dispatcher de server.mjs porque no es JSON). Mismo patrón que el resto de src/routes.
import { DEFAULT_THEME, PRESETS, FONTS, ICON_NAMES, cleanTheme, publicTheme, themeRangeError } from '../theme.mjs';
import { httpError as httpErrorBase } from '../http-util.mjs';

export function registerThemeRoutes({ route, store, listMedia, onChange, onDraft = () => {}, httpError = httpErrorBase }) {
  const current = () => ({ ...DEFAULT_THEME, ...(store.config.theme || {}) });
  // Borrador (guardado manual de Apariencia): solo lo ven las vistas previas (?themeDraft); Meld sigue con lo guardado.
  let draft = null;
  const save = async next => {
    store.config.theme = next;
    draft = null;
    await store.save('theme');
    onChange(publicTheme(next));
    onDraft({ ...publicTheme(next), draft: true });
    return info();
  };
  const info = async () => {
    const media = listMedia ? await listMedia() : [];
    return {
      theme: publicTheme(current()), defaults: DEFAULT_THEME,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, theme: p.theme })),
      fonts: [...Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label, css: f.css })), ...media.filter(m => m.kind === 'font').map(m => ({ id: 'media:' + m.name, label: m.name + ' (subida)', css: '' }))],
      icons: ICON_NAMES,
      sounds: media.filter(m => m.kind === 'audio').map(m => m.name),
      images: media.filter(m => m.kind === 'image').map(m => m.name),
    };
  };
  route('GET', '/api/theme', async () => info());
  // borrador de la vista previa del panel: solo lo ven las capas con ?themeDraft; «Guardar» lo aplica
  route('PUT', '/api/theme/draft', async (body = {}) => {
    const src = body?.theme ?? body;
    for (const k of Object.keys(src || {})) {
      const fuera = themeRangeError(k, src[k]);
      if (fuera) throw httpError(400, fuera);
    }
    draft = cleanTheme(src, current());
    const t = { ...publicTheme(draft), draft: true };
    onDraft(t);
    return { theme: t };
  });
  route('DELETE', '/api/theme/draft', async () => { draft = null; const t = { ...publicTheme(current()), draft: true }; onDraft(t); return { theme: t }; });
  // fuera de rango se rechaza con el mensaje del esquema (igual que PUT /api/config); solo
  // la importación de temas antiguos recorta (#158). Lo demás lo valida cleanTheme.
  route('PUT', '/api/theme', async (body = {}) => {
    for (const k of Object.keys(body || {})) {
      const fuera = themeRangeError(k, body[k]);
      if (fuera) throw httpError(400, fuera);
    }
    return save(cleanTheme(body, current()));
  });
  // importar: sustituye el tema entero (lo que falte vuelve al de serie)
  route('POST', '/api/theme/import', async (body = {}) => save(cleanTheme(body?.theme ?? body, DEFAULT_THEME)));
  route('POST', '/api/theme/reset', async () => save({ ...DEFAULT_THEME, icons: {} }));
  route('POST', '/api/theme/preset', async ({ id } = {}) => {
    const p = Object.hasOwn(PRESETS, id) ? PRESETS[id] : null;   // nunca constructor, toString…
    if (!p) throw httpError(404, `No existe el punto de partida «${id}». Hay: ${Object.keys(PRESETS).join(', ')}`);
    return save(cleanTheme(p.theme, { ...DEFAULT_THEME, icons: {} }));
  });
  // para /theme.css?draft=1 y el estado inicial del SSE de las vistas previas
  return { getDraft: () => draft };
}
