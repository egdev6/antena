// Migraciones puras de config.json y de las configuraciones portables importadas.
import { isDeepStrictEqual } from 'node:util';
import { convertLegacyGoals } from './goals.mjs';
import { DEFAULT_CONFIG, deepMerge } from './store.mjs';
import { extractLook } from './theme-looks.mjs';
import { ALERT_FIELDS, DEFAULT_COMMAND, DEFAULT_CONDITIONS, DEFAULT_CUSTOM_ALERT } from './alerts.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROGRAM_SETTINGS = ['autoSession', 'recordOnStart'];
// Solo campos consumidos al construir la alerta; añadir defaults de permisos, cooldown o
// programación cambiaría el comportamiento histórico de entradas antiguas incompletas.
const RENDER_KEYS = Object.keys(ALERT_FIELDS).filter(key => key !== 'enabled' && key !== 'minAmount');
function freezeRenderDefaults(item, defaults) {
  if (!object(item)) return item;
  const resolved = Object.fromEntries(RENDER_KEYS.filter(key => Object.hasOwn(defaults, key))
    .map(key => [key, structuredClone(defaults[key])]));
  return { ...resolved, ...item };
}

export const MIGRATIONS = [
  { to: 1, up(config) {
    const goals = config.widgets?.goals;
    if (!Array.isArray(goals)) return config;
    const converted = convertLegacyGoals(goals);
    if (converted.every((goal, i) => goal === goals[i])) return config;
    return { ...config, widgets: { ...config.widgets, goals: converted } };
  } },
  { to: 2, up(config) {
    if (!object(config.meld) || !PROGRAM_SETTINGS.some(key => Object.hasOwn(config.meld, key))) return config;
    const meld = { ...config.meld }, program = object(config.program) ? { ...config.program } : {};
    for (const key of PROGRAM_SETTINGS) if (Object.hasOwn(meld, key)) {
      // Si ya existen ambos nombres, el ajuste nuevo es el que manda.
      if (!Object.hasOwn(program, key)) program[key] = meld[key];
      delete meld[key];
    }
    return { ...config, meld, program };
  } },
  { to: 3, up(config) {
    // Resolver con los defaults vigentes ANTES de que cambien: el tema activo vive
    // en las secciones originales. No se copia ningún dato global al look.
    const effective = deepMerge(structuredClone(DEFAULT_CONFIG), config);
    // matchesConditions resuelve los defaults por variación; persistirlos impide que
    // un cambio futuro de chance, users u otra condición altere las reglas existentes.
    if (object(effective.alerts)) effective.alerts = Object.fromEntries(Object.entries(effective.alerts).map(([type, alert]) => [type,
      object(alert) && Array.isArray(alert.variations) ? { ...alert, variations: alert.variations.map(variation => object(variation)
        ? { ...variation, conditions: { ...structuredClone(DEFAULT_CONDITIONS), ...variation.conditions } } : variation) } : alert,
    ]));
    if (Array.isArray(effective.commands)) effective.commands = effective.commands.map(item => freezeRenderDefaults(item, DEFAULT_COMMAND));
    if (Array.isArray(effective.timers)) effective.timers = effective.timers.map(item => freezeRenderDefaults(item, DEFAULT_CUSTOM_ALERT));
    return { ...config, ...extractLook(effective), themes: config.themes ?? { activeId: 'normal', saved: [{ id: 'normal', name: 'Normal' }] } };
  } },
];

export const CURRENT_CONFIG_VERSION = MIGRATIONS.at(-1).to;

/** Añadir la versión por sí solo no exige reescribir un archivo antiguo. */
export function migrateConfig(config) {
  const input = object(config) ? config : {};
  const version = Number.isInteger(input.configVersion) && input.configVersion >= 0 ? input.configVersion : 0;
  if (version > CURRENT_CONFIG_VERSION) return { config: input, changed: false, future: true };
  let next = input, changed = false;
  for (const migration of MIGRATIONS) if (migration.to > version) {
    const result = migration.up(next);
    if (!isDeepStrictEqual(result, next)) changed = true;
    next = result;
  }
  return { config: { ...next, configVersion: CURRENT_CONFIG_VERSION }, changed, future: false };
}
