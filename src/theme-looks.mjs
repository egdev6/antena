// Un tema contiene secciones completas de elementos, nunca conexiones ni estado vivo.
export const LOOK_SECTIONS = Object.freeze([
  'theme', 'alerts', 'overlay', 'widgets', 'interactive', 'commands', 'timers', 'customOverlayCss',
]);

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
