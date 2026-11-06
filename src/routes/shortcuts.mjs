// Rutas de atajos y fuentes: fuentes de navegador para Meld (GET /api/sources),
// atajos personalizados (/api/shortcuts*) y atajos para Stream Deck (/sd/*).
// Extracción de server.mjs (#71, primer corte del patrón de rutas por áreas).
//
// Patrón para los siguientes cortes (src/routes/<area>.mjs con register<Area>Routes):
// - El módulo exporta una única función register<Area>Routes(ctx) que registra sus
//   rutas llamando a route(method, pattern, fn) del ctx. Nada más sale por defecto.
// - ctx recibe: instancias vivas de createApp (store, engine, session, interactive,
//   bus), closures internas de createApp (setPrompterTab, addMarker), helpers que
//   dependen de la app (checkActions) y constantes de createApp (PROMPTER_TABS). Los
//   helpers puros (httpError, id8) se importan de src/http-util.mjs (#107): el ctx
//   ya no tiene que pasarlos, aunque se aceptan por compatibilidad con los tests.
//   Las constantes solo de esta área viven aquí (BROWSER_SOURCES, SHORTCUT_ENGINE_KINDS).
// - El orden de registro importa: server.mjs llama a register en el punto exacto
//   donde estaban las rutas, porque los patrones se resuelven en orden.
// - Handlers con la misma convención del dispatcher: con :vars en el patrón,
//   fn(vars, body, url, req); sin vars, fn(body, null, url, req).
// - Se puede probar sin arrancar la app: construyendo un ctx falso y llamando a los
//   handlers directamente (ver test/routes-shortcuts.test.mjs).
const BROWSER_SOURCES = [
  { id: 'overlay', name: 'Alertas', path: '/overlay', width: 1920, height: 1080, note: 'Activa «Add audio track» para oír sonidos y voz.' },
  { id: 'chat', name: 'Chat en pantalla', path: '/widget/chat', width: 600, height: 900 },
  { id: 'latest', name: 'Últimos apoyos', path: '/widget/latest', width: 1400, height: 200 },
  { id: 'ticker', name: 'Ticker', path: '/widget/ticker', width: 1920, height: 64 },
  { id: 'credits', name: 'Créditos', path: '/widget/credits', width: 1920, height: 1080 },
  { id: 'question', name: 'Pregunta', path: '/widget/question', width: 1920, height: 1080 },
  { id: 'tierlist', name: 'Tier list', path: '/widget/tierlist', width: 1920, height: 1080 },
  { id: 'giveaway', name: 'Sorteo', path: '/widget/giveaway', width: 1920, height: 1080 },
  { id: 'viewers', name: 'Espectadores', path: '/widget/viewers', width: 900, height: 160 },
];
const SHORTCUT_ENGINE_KINDS = ['scene', 'layer', 'hideLayer', 'toggleLayer', 'effect', 'command', 'streamEvent', 'chat', 'say'];

import { httpError as httpErrorBase, id8 as id8Base } from '../http-util.mjs';

export function registerShortcutRoutes({ route, store, engine, session, interactive, bus, setPrompterTab, addMarker, id8 = id8Base, checkActions, httpError = httpErrorBase, PROMPTER_TABS, teleprompter }) {
  // ---------- fuentes de navegador para Meld ----------
  route('GET', '/api/sources', async (_, __, url, req) => {
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    const goals = (store.config.widgets.goals || []).map(g => {
      // Recomendación como en Goals del panel: margen/cabecera + 60 px por barra visible.
      // No redimensiona fuentes ya instaladas; caja oculta o vacía conserva un mínimo útil.
      const n = g.visible === false ? 0 : (g.bars || []).filter(b => b.visible !== false).length;
      return { id: 'goal-' + g.id, name: `Objetivo · ${g.title || g.id}`, path: `/widget/goal?id=${encodeURIComponent(g.id)}`, width: 1000, height: 210 + 60 * n };
    });
    // Overlays propios (src/custom-overlays.mjs): una capa de navegador por overlay, con su URL y
    // su tamaño. Van al final, después de las fuentes fijas, para no mover las de siempre (S8).
    const custom = (store.config.customOverlays || []).map(o => ({
      id: 'custom-' + o.id, name: `Overlay · ${o.name}`, path: `/custom/${o.id}`, width: o.width, height: o.height,
    }));
    const sources = [...BROWSER_SOURCES.slice(0, 2), ...goals, ...BROWSER_SOURCES.slice(2), ...custom].map(x => ({ ...x, url: base + x.path }));
    return {
      base, sources,
      panels: [
        { id: 'dock', name: 'Dock para Meld', path: '/dock', url: base + '/dock', note: 'Pégalo en Meld › File › Preferences › User Interface › panel de chat.' },
        { id: 'prompter', name: 'Prompter (Elgato, 1024×600)', path: '/prompter', url: base + '/prompter', width: 1024, height: 600 },
        { id: 'teleprompter', name: 'Teleprompter (solo para ti)', path: '/widget/teleprompter', url: base + '/widget/teleprompter', width: 1920, height: 1080, note: 'No lo pongas en una escena que se emita: es tu guion.' },
      ],
    };
  });

  // ---------- atajos personalizados (Stream Deck: /sd/custom/<id>) ----------
  const shortcutOf = id => {
    const sc = (store.config.shortcuts || []).find(x => x.id === id || x.name?.toLowerCase() === String(id).toLowerCase());
    if (!sc) throw httpError(404, `No existe el atajo «${id}»`);
    return sc;
  };
  const cleanSteps = steps => {
    if (!Array.isArray(steps)) throw httpError(400, 'steps tiene que ser una lista');
    if (steps.length > 20) throw httpError(400, 'Como mucho 20 pasos por atajo');
    return steps.map(st => {
      if (!st || typeof st !== 'object') throw httpError(400, 'Paso no válido');
      if (st.kind === 'builtin') {
        if (st.action === 'prompter') { if (!PROMPTER_TABS.includes(String(st.arg))) throw httpError(400, `Pestaña del prompter no válida. Pestañas: ${PROMPTER_TABS.join(', ')}`); }
        else if (!SD[st.action]) throw httpError(400, `Acción desconocida: ${st.action}. Acciones: ${Object.keys(SD).join(', ')}, prompter`);
        return { kind: 'builtin', action: st.action, ...(st.arg !== undefined && { arg: String(st.arg) }) };
      }
      if (!SHORTCUT_ENGINE_KINDS.includes(st.kind)) throw httpError(400, `Tipo de paso desconocido: ${st.kind}. Tipos: builtin, ${SHORTCUT_ENGINE_KINDS.join(', ')}`);
      checkActions([st]);
      return { ...st };
    });
  };
  async function runShortcut(sc) {
    const results = [], errors = [];
    for (const st of sc.steps || []) {
      try {
        if (st.kind === 'builtin') results.push(st.action === 'prompter' ? setPrompterTab(st.arg) : await SD[st.action]());
        else { await engine.runActions([st]); results.push({ ok: true }); }
      } catch (e) { errors.push(`${st.kind === 'builtin' ? st.action : st.kind}: ${e.message}`); }
    }
    if (errors.length && !results.length) throw httpError(400, errors.join(' · '));
    return { ok: !errors.length, shortcut: sc.id, results, errors };
  }
  route('POST', '/api/shortcuts', async ({ name, steps = [], color }) => {
    if (!String(name || '').trim()) throw httpError(400, 'Falta el nombre del atajo');
    const sc = { id: id8(), name: String(name).trim().slice(0, 60), color: color ? String(color).slice(0, 20) : '', steps: cleanSteps(steps) };
    await store.patchConfig({ shortcuts: [...(store.config.shortcuts || []), sc] });
    return { shortcut: sc };
  });
  route('PUT', '/api/shortcuts/:id', async ({ id }, { name, steps, color }) => {
    const sc = shortcutOf(decodeURIComponent(id));
    const next = { ...sc, ...(name !== undefined && { name: String(name).trim().slice(0, 60) || sc.name }), ...(color !== undefined && { color: String(color).slice(0, 20) }), ...(steps !== undefined && { steps: cleanSteps(steps) }) };
    await store.patchConfig({ shortcuts: store.config.shortcuts.map(x => (x.id === sc.id ? next : x)) });
    return { shortcut: next };
  });
  route('DELETE', '/api/shortcuts/:id', async ({ id }) => {
    const sc = shortcutOf(decodeURIComponent(id));
    await store.patchConfig({ shortcuts: store.config.shortcuts.filter(x => x.id !== sc.id) });
    return { ok: true };
  });
  route('POST', '/api/shortcuts/:id/run', async ({ id }) => runShortcut(shortcutOf(decodeURIComponent(id))));

  // ---------- atajos para Stream Deck: GET o POST, sin cuerpo ----------
  const SD = {
    'marca': () => addMarker(''),
    'pausa': async () => (engine.pauseState().paused ? { ...(await engine.resume()), ...engine.pauseState() } : (await engine.pause(), engine.pauseState())),
    'saltar': async () => { bus.send('control', { action: 'skip' }, ['overlay']); return { ok: true }; },
    'siguiente-pregunta': async () => ({ question: interactive.showQuestion() }),
    'ocultar-pregunta': async () => { interactive.hideQuestion(); return { ok: true }; },
    'cerrar-votacion': async () => ({ result: interactive.closeVote({ apply: true }) }),
    'abrir-sorteo': async () => interactive.openGiveaway({ reset: true }),
    'cerrar-sorteo': async () => interactive.closeGiveaway(),
    'sortear': async () => interactive.draw(),
    ...(teleprompter && {
      'teleprompter': async () => teleprompter.control('toggle').playback,
      'teleprompter-siguiente': async () => teleprompter.control('next').playback,
      'teleprompter-anterior': async () => teleprompter.control('prev').playback,
      'teleprompter-inicio': async () => teleprompter.control('reset').playback,
    }),
    'agradecido': async () => { const ev = session.data.events.find(e => !e.thanked); if (!ev) return { ok: true, pending: 0 }; session.setThanked(ev.id, true); return { id: ev.id, user: ev.user, pending: session.pendingThanks() }; },
  };
  const sdHandler = async ({ action, arg }) => {
    if (action === 'prompter') return setPrompterTab(decodeURIComponent(arg || ''));
    if (action === 'custom') return runShortcut(shortcutOf(decodeURIComponent(arg || '')));
    const fn = SD[action];
    if (!fn) throw httpError(404, `Atajo desconocido: ${action}. Atajos: ${[...Object.keys(SD), 'prompter/<pestaña>', 'custom/<id>'].join(', ')}`);
    return fn();
  };
  for (const m of ['GET', 'POST']) { route(m, '/sd/:action', p => sdHandler(p)); route(m, '/sd/:action/:arg', p => sdHandler(p)); }
  route('GET', '/api/shortcuts', async () => ({
    actions: [...Object.keys(SD), ...PROMPTER_TABS.map(t => 'prompter/' + t)],
    custom: (store.config.shortcuts || []).map(sc => ({ ...sc, path: `/sd/custom/${sc.id}` })),
    stepKinds: ['builtin', ...SHORTCUT_ENGINE_KINDS], builtins: Object.keys(SD), prompterTabs: PROMPTER_TABS,
  }));
}
