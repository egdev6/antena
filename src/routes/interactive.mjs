// Rutas de interactivos: preguntas, tier lists, votación y sorteo (/api/interactive*,
// /api/questions*, /api/tierlists*, /api/vote*, /api/giveaway*). Tercer corte del
// patrón de rutas por áreas (#71, #107, #119).
//
// El módulo exporta una única función registerInteractiveRoutes(ctx) que registra sus
// rutas llamando a route(method, pattern, fn) del ctx, en el mismo punto y orden donde
// estaban en server.mjs. ctx recibe: la instancia viva de Interactive (interactive) y
// el store. Los helpers puros se importan de sus módulos (se aceptan por ctx por
// compatibilidad con los tests, como en shortcuts.mjs); pick es local.
import { deepMerge as deepMergeBase } from '../store.mjs';
import { httpError as httpErrorBase } from '../http-util.mjs';

export function registerInteractiveRoutes({ route, store, interactive, deepMerge = deepMergeBase, httpError = httpErrorBase }) {
  void httpError; // aceptado por compatibilidad con los tests, como en shortcuts.mjs
  const I = interactive;
  const pick = (obj, allowed) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => allowed.includes(k)));

  route('GET', '/api/interactive', async () => I.snapshot());
  route('PUT', '/api/interactive/config', async body => {
    store.config.interactive = deepMerge(store.config.interactive, pick(body, ['questions', 'tierlist', 'giveaway']));
    await store.save('interactive');
    I.emit('change', 'config');
    return store.config.interactive;
  });

  // preguntas
  route('POST', '/api/questions', async ({ user, text, platform = 'manual' }) => ({ question: I.addQuestion({ user: user || 'Tú', text, platform }) }));
  route('POST', '/api/questions/show', async ({ id } = {}) => ({ question: I.showQuestion(id) }));
  route('POST', '/api/questions/next', async () => ({ question: I.showQuestion() }));
  route('POST', '/api/questions/hide', async () => { I.hideQuestion(); return { ok: true }; });
  route('POST', '/api/questions/clear', async ({ all } = {}) => { I.clearQuestions({ all: !!all }); return I.snapshot().questions; });
  route('POST', '/api/questions/:id/status', async ({ id }, { status }) => ({ question: I.setQuestionStatus(id, status) }));
  route('POST', '/api/questions/:id/move', async ({ id }, { dir = -1 }) => ({ question: I.moveQuestion(id, dir) }));

  // tier lists y votación
  route('POST', '/api/tierlists', async body => ({ tierlist: I.createTierlist(body) }));
  route('PUT', '/api/tierlists/:id', async ({ id }, body) => ({ tierlist: I.updateTierlist(decodeURIComponent(id), body) }));
  route('DELETE', '/api/tierlists/:id', async ({ id }) => { I.deleteTierlist(decodeURIComponent(id)); return { tierlists: I.s.tierlists }; });
  route('POST', '/api/tierlists/:id/items', async ({ id }, body) => {
    const labels = Array.isArray(body.items) ? body.items : [body];
    return { items: labels.map(x => I.addItem(decodeURIComponent(id), typeof x === 'string' ? { label: x } : x)) };
  });
  route('PUT', '/api/tierlists/:id/items/:item', async ({ id, item }, body) => ({ item: I.updateItem(decodeURIComponent(id), decodeURIComponent(item), body) }));
  route('DELETE', '/api/tierlists/:id/items/:item', async ({ id, item }) => { I.removeItem(decodeURIComponent(id), decodeURIComponent(item)); return { ok: true }; });
  route('POST', '/api/tierlists/:id/place', async ({ id }, { item, tier }) => I.place(decodeURIComponent(id), item, tier));
  route('POST', '/api/tierlists/:id/reset', async ({ id }) => { I.resetPlacements(decodeURIComponent(id)); return { ok: true }; });
  route('POST', '/api/tierlists/:id/show', async ({ id }) => { I.showTierlist(decodeURIComponent(id)); return { shown: I.s.shownTierlist }; });
  route('POST', '/api/tierlists/hide', async () => { I.showTierlist(null); return { shown: null }; });
  route('POST', '/api/tierlists/:id/vote', async ({ id }, { item, seconds }) => ({ vote: I.startVote(decodeURIComponent(id), item, seconds) }));
  route('POST', '/api/vote/close', async ({ apply = true } = {}) => ({ result: I.closeVote({ apply }) }));
  route('POST', '/api/vote/cancel', async () => { I.cancelVote(); return { ok: true }; });

  // sorteo
  route('GET', '/api/giveaway', async () => I.giveawayState());
  route('POST', '/api/giveaway/open', async ({ reset = true } = {}) => I.openGiveaway({ reset }));
  route('POST', '/api/giveaway/close', async () => I.closeGiveaway());
  route('POST', '/api/giveaway/draw', async () => I.draw());
  route('POST', '/api/giveaway/join', async ({ user, member }) => ({ added: I.join({ user, member: !!member }) }));
  route('POST', '/api/giveaway/remove', async ({ user }) => { I.removeEntry(user); return I.giveawayState(); });
  route('POST', '/api/giveaway/reset', async () => { I.resetGiveaway(); return I.giveawayState(); });
}
