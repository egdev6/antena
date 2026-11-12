// Objetivos por plataforma (#128): cada objetivo es una CAJA con título y varias BARRAS,
// cada barra ligada a una plataforma (twitch|youtube) con su métrica y meta propias.
// Conversión legacy idempotente al cargar la config y reparto del offset global de
// «events» por plataforma al cargar la sesión. Funciones puras: fáciles de testear.
import { ALERT_TYPES } from './alerts.mjs';

// Métricas válidas por plataforma. `events` cuenta alertas de su propia plataforma
// (los tipos de ALERT_TYPES ya declaran la plataforma de cada evento).
export const PLATFORM_METRICS = {
  twitch: ['follows', 'subs', 'bits', 'raids', 'events'],
  youtube: ['subscribers', 'superchats', 'members', 'events'],
};

// Clave de marcador en la raíz de session-current.json: registra que el offset legacy
// de «events» ya se repartió (con su origen), para no re-dividir en cargas posteriores.
export const EVENTS_SPLIT = 'goalOffsetsEventsSplit';

const singlePlatform = metric => {
  const platforms = Object.entries(PLATFORM_METRICS).filter(([, list]) => list.includes(metric)).map(([p]) => p);
  return platforms.length === 1 ? platforms[0] : null;
};

/** Plataforma de una barra nueva para una métrica (events exige elegir; twitch por defecto). */
export function defaultPlatform(metric) {
  return singlePlatform(metric) || 'twitch';
}

/** Plataformas válidas para una métrica. */
export function platformsFor(metric) {
  return Object.entries(PLATFORM_METRICS).filter(([, list]) => list.includes(metric)).map(([p]) => p);
}

/** Suma de una métrica limitada a los eventos de una plataforma (aislamiento #128).
 *  valueFor ya es puro; el filtro por tipo usa la plataforma declarada en ALERT_TYPES. */
export function platformValue(metric, platform, events = []) {
  let total = 0;
  for (const ev of events) {
    const t = ALERT_TYPES[ev?.type];
    if (!t || t.platform !== platform || t.system) continue;   // récords de espectadores: no son eventos
    const amount = Number(ev.vars?.amount) || 0;
    if (metric === 'follows') { if (ev.type === 'follow') total++; }
    else if (metric === 'subs') { if (['sub', 'resub', 'giftsub'].includes(ev.type)) total += ev.type === 'giftsub' ? (amount || 1) : 1; }
    else if (metric === 'bits') { if (ev.type === 'cheer') total += amount; }
    else if (metric === 'raids') { if (ev.type === 'raid') total++; }
    else if (metric === 'superchats') { if (['superchat', 'supersticker'].includes(ev.type)) total += amount; }
    else if (metric === 'members') { if (['member', 'giftmember'].includes(ev.type)) total += ev.type === 'giftmember' ? (amount || 1) : 1; }
    else if (metric === 'events') total++;
  }
  return metric === 'superchats' ? Math.round(total * 100) / 100 : total;
}

/** Convierte la lista legacy de objetivos (barra única) en cajas con barras.
 *  - métricas de una sola plataforma → caja con una barra de esa plataforma;
 *  - `events` → caja con DOS barras (twitch y youtube), ambas con el target antiguo:
 *    cada barra se reconfigura/edita por separado después; no se pretende conservar
 *    la suma de metas (decisión de #128).
 *  Idempotente: una caja que ya tiene `bars` se conserva tal cual. */
export function convertLegacyGoals(goals) {
  const list = Array.isArray(goals) ? goals : [];
  return list.map(g => {
    if (g && typeof g === 'object' && Array.isArray(g.bars)) return g;   // ya convertida
    const platforms = g.metric === 'events' ? ['twitch', 'youtube'] : [defaultPlatform(g.metric)];
    const bars = platforms.map(platform => ({
      id: g.metric === 'events' ? `${g.id}-${platform === 'twitch' ? 'tw' : 'yt'}` : `${g.id}-1`,
      platform, metric: g.metric, target: Number(g.target) || 1, visible: true,
    }));
    // ids de barra únicos dentro de la caja (choque teórico con goals legacy repetidos)
    const seen = new Set();
    for (const b of bars) { while (seen.has(b.id)) b.id += '-x'; seen.add(b.id); }
    return { id: g.id, title: g.title, visible: true, showMetric: true, css: g.css || '', bars };
  });
}

/** Reparto del offset global legacy de «events» (session data) en claves por plataforma.
 *  - Sin marker y sin claves @: twitch = O/2, youtube = O − O/2 (mitades exactas, sin
 *    ceil/floor para no inventar ajustes de signos opuestos en fracciones).
 *  - Con claves @ preexistentes sin marker: NO se sobreescriben; solo se completa la que
 *    falte como resto (legacy − la que hay), conservando el total; el marcador registra
 *    que hubo claves preexistentes.
 *  - Con marker: no se hace nada, aunque la clave legacy cambie después (el marcador
 *    registra la migración, no el estado actual de los ajustes).
 *  - La clave legacy `events` nunca se borra ni se usa después para events.
 *  Devuelve { changed, error? }. Persistir es responsabilidad del que llama: los datos
 *  nuevos y el marcador viven en el mismo objeto, así que un flush los escribe juntos. */
export function splitEventsOffsets(data) {
  const off = data.goalOffsets;
  if (!off || typeof off !== 'object') return { changed: false };
  if (data[EVENTS_SPLIT] !== undefined) {
    // Contrato con marcador presente (#128, acordado tras verificación): exige AMBAS claves
    // propias, typeof 'number' y finitas. Ausentes o inválidas → error explícito ANTES de
    // servir: ni se escribe, ni se repara desde el marcador (valores iniciales, puede estar
    // obsoleto tras add/set legítimos) ni desde la legacy (congelada). La recuperación es
    // decisión humana o el backup coherente del mecanismo existente. 0/negativos/fracciones
    // son ajustes válidos; se distingue ausente (Object.hasOwn) de presente-inválido.
    for (const key of ['events@twitch', 'events@youtube']) {
      if (!Object.hasOwn(off, key)) {
        throw new Error(`Sesión inconsistente: falta «${key}» con marcador de migración de events presente. No se reparte ni se repara automáticamente: restaura un backup coherente de la sesión o corrige a mano «events@twitch» y «events@youtube» a números finitos manteniendo el marcador.`);
      }
      const v = off[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Sesión inconsistente: «${key}» no es un número finito (${String(v)}) con marcador de migración de events presente. No se repara automáticamente: restaura un backup coherente de la sesión o corrige a mano «events@twitch» y «events@youtube» a números finitos manteniendo el marcador.`);
      }
    }
    return { changed: false };
  }
  const legacy = off.events;
  const tw = off['events@twitch'], yt = off['events@youtube'];
  if (legacy === undefined && tw === undefined && yt === undefined) return { changed: false };
  const result = { changed: true };
  if (tw === undefined && yt === undefined) {
    off['events@twitch'] = legacy / 2;
    off['events@youtube'] = legacy - legacy / 2;
    data[EVENTS_SPLIT] = { from: legacy, twitch: off['events@twitch'], youtube: off['events@youtube'] };
  } else {
    // Sin total legacy son ajustes nuevos independientes: la plataforma ausente vale 0.
    // Con total legacy, conservar el resto y no sobrescribir la clave ya existente.
    if (tw === undefined) off['events@twitch'] = legacy === undefined ? 0 : legacy - yt;
    if (yt === undefined) off['events@youtube'] = legacy === undefined ? 0 : legacy - tw;
    data[EVENTS_SPLIT] = { preexisting: true, twitch: off['events@twitch'], youtube: off['events@youtube'], from: legacy };
    result.preexisting = true;
  }
  return result;
}
