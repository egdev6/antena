// Shared, side-effect-free dock defaults and rendering projection.
export const DOCK_MODULE_IDS = ['stream', 'alerts', 'marks', 'scenes', 'teleprompter', 'credits', 'audio', 'questions', 'tierlist', 'giveaway', 'shortcuts'];
export const DOCK_LAYOUTS = ['auto', 'tabs', 'columns', 'split-v', 'split-h'];
export const DEFAULT_DOCK = {
  modules: DOCK_MODULE_IDS.map(id => ({ id, enabled: id !== 'shortcuts' })),
  layout: 'auto',
  zones: [
    { id: 'control', label: 'Control', modules: ['stream', 'alerts', 'marks', 'scenes', 'teleprompter', 'credits'] },
    { id: 'audio', label: 'Audio', modules: ['audio'] },
    { id: 'interactivos', label: 'Interactivos', modules: ['questions', 'tierlist', 'giveaway'] },
  ],
};

/** Make a rendering projection without mutating the saved editor configuration.
 * Module order is global; zone membership determines placement. First occurrence wins.
 * @param {unknown} value
 * @returns {{modules: {id: string, enabled: boolean}[], layout: string, zones: {id: string, label: string, modules: string[]}[]}}
 */
export function normalizeDock(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const known = new Set(DOCK_MODULE_IDS), seen = new Set();
  const rawModules = Array.isArray(input.modules) ? input.modules : DEFAULT_DOCK.modules;
  const modules = [];
  for (const item of rawModules) {
    if (!item || !known.has(item.id) || seen.has(item.id) || typeof item.enabled !== 'boolean') continue;
    seen.add(item.id);
    modules.push({ id: item.id, enabled: item.enabled });
  }
  const enabled = modules.filter(item => item.enabled).map(item => item.id);
  const rawZones = Array.isArray(input.zones) ? input.zones : DEFAULT_DOCK.zones;
  const zoneIds = new Set(), assigned = new Set(), zones = [];
  for (const zone of rawZones) {
    if (!zone || typeof zone.id !== 'string' || !zone.id.trim() || zoneIds.has(zone.id)) continue;
    zoneIds.add(zone.id);
    const requested = new Set(Array.isArray(zone.modules) ? zone.modules : []);
    const placed = enabled.filter(id => requested.has(id) && !assigned.has(id));
    for (const id of placed) assigned.add(id);
    zones.push({ id: zone.id, label: typeof zone.label === 'string' ? zone.label : zone.id, modules: placed });
  }
  const remaining = enabled.filter(id => !assigned.has(id));
  if (remaining.length && !zones.length) zones.push({ id: 'interactivos', label: 'Interactivos', modules: [] });
  if (remaining.length) zones[zones.length - 1].modules.push(...remaining);
  return {
    modules,
    layout: DOCK_LAYOUTS.includes(input.layout) ? input.layout : 'auto',
    zones: zones.filter(zone => zone.modules.length > 0),
  };
}

/** Apply the effective layout after the viewport fallback has been chosen.
 * @template T
 * @param {T[]} zones
 * @param {string} layout
 * @returns {T[]}
 */
export function visibleDockZones(zones, layout) {
  return layout === 'split-v' || layout === 'split-h' ? zones.slice(0, 2) : zones;
}
