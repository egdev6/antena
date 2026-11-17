// Migraciones puras de config.json y de las configuraciones portables importadas.
import { isDeepStrictEqual } from 'node:util';
import { convertLegacyGoals } from './goals.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROGRAM_SETTINGS = ['autoSession', 'recordOnStart'];

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
