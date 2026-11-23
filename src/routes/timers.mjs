// Scheduled message routes; the returned lookup is also used by alert previews.
import { httpError } from '../http-util.mjs';
import { newTimer, limitWarnings, TIMER_KEYS, TIMER_DESTINATIONS } from '../timers.mjs';

export function registerTimerRoutes({ route, store, timers, checkActions, pick, COMMAND_KEYS, isProjection = () => false }) {
  const timerOf = id => {
    const t = (store.config.timers ||= []).find(x => x.id === id || x.name?.toLowerCase() === String(id).toLowerCase());
    if (!t) throw httpError(404, `No existe el mensaje programado «${id}»`);
    return t;
  };
  const TIMER_FIELDS = [...COMMAND_KEYS.filter(k => !['trigger', 'permission', 'cooldownSec', 'userCooldownSec', 'platforms', 'outputMode', 'chatReply'].includes(k)), ...TIMER_KEYS];
  // Ausente = Twitch; cualquier otro valor se rechaza sin guardar nada.
  const timerFields = body => {
    const fields = pick(body, TIMER_FIELDS);
    if ('destination' in fields && !TIMER_DESTINATIONS.includes(fields.destination)) throw httpError(400, 'Destino de mensaje no válido. Usa twitch, youtube o both.');
    checkActions(fields.actions);
    return fields;
  };
  route('GET', '/api/timers', async () => {
    if (!isProjection()) return timers.snapshot();
    // Never allocate or reset the live scheduler's runtime state for an inactive look.
    const detached = Object.assign(Object.create(Object.getPrototypeOf(timers)), timers, { state: new Map() });
    return detached.snapshot();
  });
  route('POST', '/api/timers', async body => {
    const t = newTimer(timerFields(body));
    (store.config.timers ||= []).push(t);
    await store.save('timers');
    return { timer: t, warnings: limitWarnings(t) };
  });
  route('PUT', '/api/timers/:id', async ({ id }, body) => {
    const t = timerOf(decodeURIComponent(id));
    Object.assign(t, timerFields(body));
    if (body.intervalMin !== undefined && !isProjection()) timers.reset(t.id);
    await store.save('timers');
    return { timer: t, warnings: limitWarnings(t) };
  });
  route('DELETE', '/api/timers/:id', async ({ id }) => {
    const t = timerOf(decodeURIComponent(id));
    store.config.timers = store.config.timers.filter(x => x !== t);
    if (!isProjection()) timers.reset(t.id);
    await store.save('timers');
    return { timers: store.config.timers };
  });
  route('POST', '/api/timers/:id/fire', async ({ id }) => timers.fire(timerOf(decodeURIComponent(id)).id));
  return timerOf;
}
