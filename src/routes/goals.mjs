// Rutas de objetivos por plataforma (#128): cajas con barras (/api/goals*). Cuarto corte
// del patrón de rutas por áreas (#71, #107, #119): sustituye a las rutas inline de
// server.mjs en el mismo punto y orden, sin cambiar la resolución del resto.
//
// Compatibilidad: POST /api/goals crea una caja con UNA barra (como el objetivo antiguo);
// PUT/DELETE /api/goals/:id siguen operando sobre la caja; add/set de caja solo se admite
// cuando tiene exactamente una barra (con varias, 400 pidiendo la barra explícita).
// Las barras viven en /api/goals/:id/bars(/:barId). La validación usa config-schema
// (incluida la comprobación cruzada plataforma↔métrica) ANTES de tocar el store:
// un valor inválido responde 400 sin guardar nada.
import { httpError as httpErrorBase, id8 as id8Base } from '../http-util.mjs';
import { validatePatch } from '../config-schema.mjs';
import { defaultPlatform, platformsFor } from '../goals.mjs';

// pick: copia solo las claves permitidas (mismo helper que usaba server.mjs para alertas)
const pick = (obj, allowed) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => allowed.includes(k)));

export function registerGoalsRoutes({ route, store, session, id8 = id8Base, httpError = httpErrorBase }) {
  const goalsOf = () => (store.config.widgets.goals ||= []);
  const goalOf = id => {
    const g = goalsOf().find(x => x.id === id);
    if (!g) throw httpError(404, `No existe el objetivo «${id}»`);
    return g;
  };
  const barOf = (g, barId) => {
    const b = (g.bars || []).find(x => x.id === barId);
    if (!b) throw httpError(404, `El objetivo «${g.id}» no tiene la barra «${barId}»`);
    return b;
  };
  // Validación por esquema del resultado completo (caja incluida en la lista): cualquier
  // hoja inválida (tipos, rangos, plataforma↔métrica) falla ANTES de mutar el store.
  const validate = box => {
    const errors = validatePatch({ widgets: { goals: [box] } });
    if (errors.length) throw httpError(400, errors.map(e => e.message).join('; '));
    return box;
  };
  const save = () => store.save('widgets');

  // F1: los ids son únicos. Un duplicado se rechaza (400) ANTES de mutar o persistir:
  // ni cajas ni barras repetidas, y el DELETE de barra solo puede quitar la barra indicada.
  const idLibre = id => !goalsOf().some(x => x.id === id);
  const barIdLibre = (g, id) => !(g.bars || []).some(x => x.id === id);

  // ---------- cajas ----------
  route('POST', '/api/goals', async body => {
    if (body.id && !idLibre(body.id)) throw httpError(400, `Ya existe un objetivo con el id «${body.id}».`);
    const metric = body.metric ?? 'follows';
    if (!platformsFor(metric).length) throw httpError(400, `Métrica desconocida: «${metric}».`);
    const box = {
      id: body.id || id8(),
      title: body.title || 'Objetivo',
      visible: true, showMetric: true, css: body.css === undefined ? '' : body.css,
      bars: [{ id: (body.id || id8()) + '-1', platform: body.platform || defaultPlatform(metric), metric, target: Number(body.target) || 10, visible: true }],
    };
    validate(box);
    goalsOf().push(box);
    await save();
    return { goal: box };
  });
  route('PUT', '/api/goals/:id', async ({ id }, body) => {
    const g = goalOf(id);
    const next = { ...structuredClone(g), ...pick(body, ['title', 'visible', 'showMetric', 'css', 'label', 'showLabel', 'showTitle']) };
    if (Object.hasOwn(body, 'metric') || Object.hasOwn(body, 'target')) {
      if (next.bars.length !== 1) throw httpError(400, 'Indica la barra para editar su métrica o meta en una caja con varias barras.');
      Object.assign(next.bars[0], pick(body, ['metric', 'target']));
    }
    validate(next);
    Object.assign(g, next);
    await save();
    return { goal: g };
  });
  route('DELETE', '/api/goals/:id', async ({ id }) => {
    const g = goalOf(id);
    store.config.widgets.goals = goalsOf().filter(x => x !== g);
    await save();
    return { goals: store.config.widgets.goals };
  });

  // ---------- barras ----------
  route('POST', '/api/goals/:id/bars', async ({ id }, body) => {
    const g = goalOf(id);
    if (body.id && !barIdLibre(g, body.id)) throw httpError(400, `El objetivo «${id}» ya tiene una barra con el id «${body.id}».`);
    const metric = body.metric;
    if (!metric || !platformsFor(metric).length) throw httpError(400, `Métrica desconocida: «${metric}».`);
    const bar = {
      id: body.id || id8(),
      platform: body.platform || defaultPlatform(metric),
      metric, target: Number(body.target) || 10, visible: body.visible ?? true,
    };
    const next = { ...structuredClone(g), bars: [...(g.bars || []), bar] };
    validate(next);
    g.bars = next.bars;
    await save();
    return { bar };
  });
  route('PUT', '/api/goals/:id/bars/:barId', async ({ id, barId }, body) => {
    const g = goalOf(id);
    const b = barOf(g, barId);
    const next = { ...structuredClone(g), bars: (g.bars || []).map(x => (x === b ? { ...b, ...pick(body, ['platform', 'metric', 'target', 'visible']) } : x)) };
    validate(next);
    g.bars = next.bars;
    await save();
    return { bar: barOf(g, barId) };
  });
  route('DELETE', '/api/goals/:id/bars/:barId', async ({ id, barId }) => {
    const g = goalOf(id);
    barOf(g, barId);
    if ((g.bars || []).length <= 1) throw httpError(400, 'Una caja necesita al menos una barra: borra la caja si no la quieres.');
    g.bars = g.bars.filter(x => x.id !== barId);
    await save();
    return { bars: g.bars };
  });

  // ---------- ajustes manuales (add/set): por barra, o por caja si solo tiene una ----------
  const targetBar = (g, body, via) => {
    if (body.barId) return barOf(g, body.barId);
    if ((g.bars || []).length === 1) return g.bars[0];
    throw httpError(400, `El objetivo «${g.id}» tiene ${g.bars.length} barras: indica «barId» (o usa ${via} de barra).`);
  };
  const addSet = (g, body, fn) => {
    const b = targetBar(g, body, fn);
    const amount = fn === 'add' && body.amount === undefined ? 1 : (Number(fn === 'add' ? body.amount : body.value) || 0);
    if (fn === 'add') session.addToGoal(b.metric, amount, b.platform);
    else session.setGoalValue(b.metric, Number(body.value) || 0, b.platform);
    return { id: g.id, barId: b.id, value: session.goalValue(b.metric, b.platform), target: b.target };
  };
  route('POST', '/api/goals/:id/add', async ({ id }, body) => addSet(goalOf(id), body, 'add'));
  route('POST', '/api/goals/:id/set', async ({ id }, body) => addSet(goalOf(id), body, 'set'));
  route('POST', '/api/goals/:id/bars/:barId/add', async ({ id, barId }, body) => {
    const g = goalOf(id); const b = barOf(g, barId);
    session.addToGoal(b.metric, Number(body.amount) || 0, b.platform);
    return { id, barId, value: session.goalValue(b.metric, b.platform), target: b.target };
  });
  route('POST', '/api/goals/:id/bars/:barId/set', async ({ id, barId }, body) => {
    const g = goalOf(id); const b = barOf(g, barId);
    session.setGoalValue(b.metric, Number(body.value) || 0, b.platform);
    return { id, barId, value: session.goalValue(b.metric, b.platform), target: b.target };
  });
}
