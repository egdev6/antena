// Alert configuration, previews and queue controls, registered in their original order.
import { httpError, id8 } from '../http-util.mjs';
import { alertFields } from '../timers.mjs';
import { publicTheme } from '../theme.mjs';
import { activeTheme } from '../theme-looks.mjs';
import {
  ALERT_TYPES, DEFAULT_ALERTS, DEFAULT_CONDITIONS, SAMPLES,
  buildAlert, buildCommandAlert, buildCustomAlert, alertConfig,
} from '../alerts.mjs';

/** Datos de ejemplo que cumplen las condiciones de una variación (para probarla). */
function conditionSample(c = {}) {
  const out = {};
  const n = v => (v === '' || v == null ? null : Number(v));
  if (n(c.minAmount) !== null) out.amount = n(c.minAmount);
  else if (n(c.maxAmount) !== null) out.amount = n(c.maxAmount);
  if (out.amount !== undefined) out.amountText = out.amount + ' €';
  if (n(c.tier) !== null) out.tier = n(c.tier);
  const u = String(c.users || '').split(',')[0].trim(); if (u) out.user = u;
  const w = String(c.messageContains || '').split(',')[0].trim(); if (w) out.message = `mensaje con ${w}`;
  return out;
}

const summary = a => a && ({ id: a.id, type: a.type, title: a.title, text: a.text, sub: a.sub, variation: a.variation, layout: a.look?.layout, at: a.at, tts: a.tts?.text || null, actions: a.actions?.length || 0 });

export function registerAlertRoutes({ route, store, engine, bus, timers, checkActions, pick, ALERT_KEYS, commandOf, timerOf, ackAdmits, CLOSING_MESSAGE }) {
  const alertOf = type => {
    if (!ALERT_TYPES[type]) throw httpError(404, `No existe la alerta «${type}». Tipos: ${Object.keys(ALERT_TYPES).join(', ')}`);
    store.config.alerts[type] = { ...structuredClone(DEFAULT_ALERTS[type]), ...store.config.alerts[type] };
    return store.config.alerts[type];
  };
  const variationOf = (type, id) => {
    const a = alertOf(type);
    const v = (a.variations ||= []).find(x => x.id === id || x.name?.toLowerCase() === String(id).toLowerCase());
    if (!v) throw httpError(404, `La alerta «${type}» no tiene la variación «${id}»`);
    return v;
  };
  // overrides de una variación: null borra el campo (vuelve a heredar de la alerta)
  const mergeOverrides = (cur = {}, patch = {}) => {
    const out = { ...cur };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
    return out;
  };

  // alertas
  route('GET', '/api/alerts', async () => Object.fromEntries(Object.keys(ALERT_TYPES).map(t => [t, alertConfig(t, store.config)])));
  route('GET', '/api/alerts/:type', async ({ type }) => ({ type, ...ALERT_TYPES[type], config: alertOf(type) }));
  route('PUT', '/api/alerts/:type', async ({ type }, body) => {
    const a = alertOf(type);
    checkActions(body?.actions, ...(Array.isArray(body?.variations) ? body.variations.map(v => v?.overrides?.actions) : []));
    Object.assign(a, pick(body, [...ALERT_KEYS, 'variations']));
    await store.save('alerts');
    return { type, config: a };
  });
  route('POST', '/api/alerts/:type/reset', async ({ type }) => {
    alertOf(type);
    store.config.alerts[type] = structuredClone(DEFAULT_ALERTS[type]);
    await store.save('alerts');
    return { config: store.publicConfig() };
  });
  route('POST', '/api/alerts/:type/variations', async ({ type }, body) => {
    const a = alertOf(type);
    checkActions(body.overrides?.actions);
    const v = { id: id8(), name: body.name || `Variación ${(a.variations?.length || 0) + 1}`, enabled: body.enabled !== false,
      conditions: { ...DEFAULT_CONDITIONS, ...(body.conditions || {}) }, overrides: pick(body.overrides, ALERT_KEYS) };
    (a.variations ||= []).push(v);
    await store.save('alerts');
    return { type, variation: v };
  });
  route('PUT', '/api/alerts/:type/variations/:id', async ({ type, id }, body) => {
    const v = variationOf(type, decodeURIComponent(id));
    checkActions(body.overrides?.actions);
    if (body.name !== undefined) v.name = String(body.name);
    if (body.enabled !== undefined) v.enabled = !!body.enabled;
    if (body.conditions) v.conditions = { ...DEFAULT_CONDITIONS, ...v.conditions, ...body.conditions };
    if (body.overrides) v.overrides = mergeOverrides(v.overrides, pick(body.overrides, ALERT_KEYS));
    await store.save('alerts');
    return { type, variation: v };
  });
  route('DELETE', '/api/alerts/:type/variations/:id', async ({ type, id }) => {
    const v = variationOf(type, decodeURIComponent(id));
    const a = alertOf(type); a.variations = a.variations.filter(x => x !== v);
    await store.save('alerts');
    return { type, variations: a.variations };
  });
  route('POST', '/api/alerts/:type/variations-order', async ({ type }, { ids = [] }) => {
    const a = alertOf(type);
    const byId = new Map(a.variations.map(v => [v.id, v]));
    a.variations = [...ids.map(i => byId.get(i)).filter(Boolean), ...a.variations.filter(v => !ids.includes(v.id))];
    await store.save('alerts');
    return { type, variations: a.variations };
  });

  // probar, alertas libres, cola
  // `draft` (guardado manual del panel): la alerta, variación, comando o mensaje SIN guardar, solo para
  // la vista previa. Se construye sobre una copia de la configuración; nada se guarda.
  route('POST', '/api/test', async ({ type, vars, target = 'live', variationId, commandId, timerId, draft, globalCss }) => {
    let a;
    const useDraft = draft && typeof draft === 'object' && !Array.isArray(draft) && target === 'preview';
    const cfg = useDraft ? structuredClone(store.config) : store.config;
    if (timerId) a = { ...buildCustomAlert(alertFields(useDraft ? { ...timerOf(timerId), ...draft } : timerOf(timerId)), { ...timers.vars(), ...(vars || {}) }, cfg), test: true };
    else if (commandId) {
      const command = useDraft ? { ...commandOf(commandId), ...draft } : commandOf(commandId);
      if (command.outputMode === 'chat') throw httpError(400, 'Los comandos de solo chat se prueban desde el simulador del chat.');
      a = buildCommandAlert(command, { ...SAMPLES.command, ...(vars || {}) }, cfg, { test: true });
    }
    else {
      if (!ALERT_TYPES[type]) throw httpError(400, 'Tipo desconocido');
      if (useDraft && !variationId) cfg.alerts[type] = { ...cfg.alerts[type], ...draft };
      if (useDraft && variationId) cfg.alerts[type] = { ...cfg.alerts[type], variations: (cfg.alerts[type]?.variations || []).map(x => (x.id === variationId ? { ...x, ...draft } : x)) };
      const v = variationId ? (cfg.alerts[type]?.variations || []).find(x => x.id === variationId) || variationOf(type, variationId) : null;
      const sample = { ...SAMPLES[type], ...(v ? conditionSample(v.conditions) : {}), ...(vars || {}) };
      a = buildAlert(type, sample, cfg, { test: true, variationId: v?.id });
    }
    // vista previa con el CSS común sin guardar (borrador del panel)
    if (target === 'preview' && typeof globalCss === 'string' && a) a.globalCss = globalCss;
    engine.deliver(a, { target: target === 'preview' ? 'preview' : 'live' });
    return { ok: true, overlays: bus.overlayCount(), alert: summary(a) };
  });
  // miniatura de una alerta en el panel (/overlay?still=<tipo>): la alerta de ejemplo tal y como saldría
  // con la configuración y el tema guardados, sin entregarla a nadie
  route('GET', '/api/alerts/:type/sample', async ({ type }) => {
    if (!ALERT_TYPES[type]) throw httpError(404, 'Tipo desconocido');
    return { alert: buildAlert(type, { ...SAMPLES[type] }, store.config, { test: true }), theme: publicTheme(store.config.theme), activeTheme: activeTheme(store.config.themes) };
  });
  route('POST', '/api/simulate', async ({ type, vars = {} }) => {
    if (!ALERT_TYPES[type]) throw httpError(400, 'Tipo desconocido');
    const a = engine.handleEvent({ externalId: 'sim:' + id8(), type, vars: { ...SAMPLES[type], ...vars } });
    return { ok: !!a, alert: a ? summary(a) : null, note: a ? undefined : 'No ha generado alerta (desactivada, bajo el mínimo o usuario bloqueado).' };
  });
  route('POST', '/api/alert/custom', async ({ vars, ...fields }) => ({ alert: summary(engine.custom(fields, vars)) }));
  route('POST', '/api/replay', async ({ id }) => {
    const a = bus.history.find(h => h.id === id);
    if (!a) throw httpError(404, 'No está en el historial');
    engine.send({ ...a, replay: true, id: a.id + ':' + Date.now() });
    return { ok: true };
  });
  route('GET', '/api/history', async () => bus.history.slice(0, 100).map(summary));
  route('POST', '/api/skip', async () => { bus.send('control', { action: 'skip' }, ['overlay']); return { ok: true }; });
  route('POST', '/api/clear', async () => { bus.send('control', { action: 'clear' }, ['overlay']); return { ok: true }; });
  route('POST', '/api/pause', async () => { await engine.pause(); return engine.pauseState(); });
  route('POST', '/api/resume', async ({ discard } = {}) => ({ ...(await engine.resume({ discard })), ...engine.pauseState() }));
  route('POST', '/api/say', async ({ text, ...opts }) => { if (!text) throw httpError(400, 'Falta «text»'); return engine.say(text, opts); });
  route('POST', '/api/overlay/shown', async ({ id }) => {
    // Tras el await del cuerpo y en la MISMA continuación síncrona: solo el id de una generación
    // pendiente genuina inicia acciones; desconocido/stale/no pendiente recibe el 503 constante.
    if (!ackAdmits(id)) throw httpError(503, CLOSING_MESSAGE);
    engine.alertShown(id);
    return { ok: true };
  });
}
