// Un tema contiene secciones completas de elementos, nunca conexiones ni estado vivo.
export const LOOK_SECTIONS = Object.freeze([
  'theme', 'alerts', 'overlay', 'widgets', 'interactive', 'commands', 'timers', 'customOverlayCss',
]);

/** The panel and HTTP dispatcher share the same boundary for theme-owned writes.
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 */
export function isThemedWrite(method, path, body) {
  if (method === 'GET' || method === 'HEAD') return false;
  const pathname = path.split('?')[0];
  if (/^\/api\/(?:theme(?:\/|$)|alerts(?:\/|$)|widgets(?:\/|$)|goals(?:\/|$)|commands(?:\/|$)|timers(?:\/|$)|interactive\/config(?:\/|$))/.test(pathname)) return true;
  if (pathname === '/api/config' && body && typeof body === 'object') return LOOK_SECTIONS.some(k => Object.hasOwn(body, k));
  if (pathname === '/api/config/set' && body && typeof body === 'object' && 'path' in body) return LOOK_SECTIONS.includes(String(body.path).split('.')[0]);
  return false;
}

/** Instantánea aislada; el mapa de CSS de overlays queda reservado para una fase posterior. */
export function extractLook(config) {
  return Object.fromEntries(LOOK_SECTIONS.map(key => [key, structuredClone(config[key] ?? (key === 'customOverlayCss' ? {} : config[key]))]));
}

/** Sustituye las secciones completas sin tocar ninguna otra propiedad. */
export function applyLook(config, look) {
  for (const key of LOOK_SECTIONS) config[key] = structuredClone(look[key]);
  return config;
}

export function publicThemes(themes) {
  return (themes?.saved || []).map(({ id, name }) => ({ id, name, active: id === themes.activeId }));
}
