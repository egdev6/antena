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

/** Only configuration routes can address an inactive look; never admit live actions. */
export function isThemeTargetRequest(method, pathname, body, url) {
  if (pathname === '/api/config') {
    if (method === 'GET') return LOOK_SECTIONS.includes(String(url.searchParams.get('path') || '').split('.').filter(Boolean)[0]);
    return method === 'PUT' && body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => LOOK_SECTIONS.includes(key));
  }
  if (pathname === '/api/config/set' && method === 'POST') {
    const keys = String(body?.path || '').split('.').filter(Boolean);
    return !keys.length || LOOK_SECTIONS.includes(keys[0]);
  }
  if (method === 'GET') return /^\/api\/(?:theme|alerts(?:\/[^/]+)?|widgets|commands|timers|interactive)$/.test(pathname);
  if (pathname === '/api/theme' && method === 'PUT') return true;
  if (method === 'POST' && /^\/api\/theme\/(?:import|reset|preset)$/.test(pathname)) return true;
  if (method === 'PUT' && /^\/api\/alerts\/[^/]+$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/alerts\/[^/]+\/(?:reset|variations|variations-order)$/.test(pathname)) return true;
  if (['PUT', 'DELETE'].includes(method) && /^\/api\/alerts\/[^/]+\/variations\/[^/]+$/.test(pathname)) return true;
  if (method === 'PUT' && (pathname === '/api/widgets' || /^\/api\/widgets\/chat\/variants\/[^/]+$/.test(pathname))) return true;
  if (method === 'POST' && (pathname === '/api/goals' || /^\/api\/goals\/[^/]+\/bars$/.test(pathname))) return true;
  if (['PUT', 'DELETE'].includes(method) && /^\/api\/goals\/[^/]+(?:\/bars\/[^/]+)?$/.test(pathname)) return true;
  if (method === 'POST' && ['/api/commands', '/api/timers'].includes(pathname)) return true;
  if (['PUT', 'DELETE'].includes(method) && /^\/api\/(?:commands|timers)\/[^/]+$/.test(pathname)) return true;
  return method === 'PUT' && pathname === '/api/interactive/config';
}

/** Instantánea aislada, incluido el CSS de los overlays del tema activo. */
export function extractLook(config) {
  return Object.fromEntries(LOOK_SECTIONS.map(key => [key, structuredClone(config[key] ?? (key === 'customOverlayCss' ? {} : config[key]))]));
}

/** Sustituye las secciones completas sin tocar ninguna otra propiedad. */
export function applyLook(config, look) {
  for (const key of LOOK_SECTIONS) config[key] = structuredClone(look[key]);
  return config;
}

/** Identidad pública separada del aspecto y de su hash. */
export function activeTheme(themes) {
  const item = themes?.saved?.find(t => t.id === themes.activeId);
  return item ? { id: item.id, name: item.name } : null;
}

export function publicThemes(themes) {
  return (themes?.saved || []).map(({ id, name, avatar }) => ({ id, name, active: id === themes.activeId, ...(avatar !== undefined && { avatar }) }));
}
