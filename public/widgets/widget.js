// Utilidades comunes de los widgets: conexión, modo demo y CSS propio.
export const qs = new URLSearchParams(location.search);
export const DEMO = qs.has('demo');
const THEME_DRAFT = qs.has('themeDraft');
if (qs.has('debug') || DEMO) document.body.classList.add('debug');
document.documentElement.style.setProperty('--scale', Number(qs.get('scale')) || 1);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const style = document.createElement('style');
document.head.append(style);
export function setCss(css) { style.textContent = css || ''; }

/** Conecta con el servidor. handlers: { widgets(state), chat(msg), chatDelete, chatClear, credits, theme }
 *  client: kind de SSE («widget» por defecto; el teleprompter usa su propio kind para no
 *  recibir contenido de otros widgets ni mandárselo). */
export function connect(handlers, client = 'widget') {
  const es = new EventSource('/api/stream?client=' + encodeURIComponent(client) + (THEME_DRAFT ? '&themeDraft=1' : ''));
  // Apariencia: al cambiar el tema se recarga /theme.css (sin recargar la página). Con ?themeDraft
  // (vista previa del panel) se ve también el borrador sin guardar; en Meld, solo lo guardado.
  es.addEventListener('theme', e => {
    const t = JSON.parse(e.data), link = document.getElementById('eg-theme');
    if (t.draft && !THEME_DRAFT) return;
    const href = '/theme.css?' + (THEME_DRAFT ? 'draft=1&' : '') + 'v=' + encodeURIComponent(t.version || '');
    if (link && !link.href.endsWith(href)) link.href = href;
    handlers.theme?.(t);
  });
  for (const [ev, fn] of Object.entries(handlers)) if (ev !== 'theme') es.addEventListener(ev, e => fn(JSON.parse(e.data)));
  return es;
}

const names = ['devconcafe', 'ana_frontend', 'pixelmaria', 'reactivo', 'midudev', 'lucia_codes', 'Carlos Ruiz', 'testing_tom', 'Laura Test', 'Javi Dev'];
const lines = ['¡Buenas tardes!', 'eso del ODD me ha volado la cabeza', '¿qué tal el design system?', 'Engram es una pasada', 'saludos desde Valencia', 'gg', '¿repo en GitHub?', 'construir criterio 🔥'];
export function demoState() {
  const now = Date.now();
  const ev = (type, label, user, sub, ago) => ({ type, label, user, sub, at: new Date(now - ago * 1000).toISOString() });
  return {
    totals: { follows: 14, subs: 6, bits: 1200, raids: 1, superchats: 15, members: 3, events: 25 },
    latest: { follow: { user: 'devconcafe' }, sub: { user: 'pixelmaria' }, cheer: { user: 'reactivo', vars: { amount: 500 } }, raid: { user: 'midudev', vars: { amount: 120 } }, superchat: { user: 'Carlos Ruiz', vars: { amountText: '5,00 €' } }, member: { user: 'Javi Dev' } },
    goals: [{ id: 'principal', title: 'Objetivo de seguidores', metric: 'follows', target: 20, value: 14 }],
    recent: [ev('follow', 'Nuevo seguidor', 'devconcafe', '', 30), ev('cheer', 'Bits', 'reactivo', '500 bits', 90), ev('raid', 'Raid', 'midudev', 'llega con 120 personas', 400), ev('sub', 'Suscripción', 'ana_frontend', 'tier 1', 600), ev('superchat', 'Super Chat', 'Carlos Ruiz', '5,00 €', 900)],
    credits: [
      { title: 'Raids', names: ['midudev'] }, { title: 'Suscripciones', names: ['ana_frontend', 'pixelmaria', 'testing_tom'] },
      { title: 'Bits', names: ['reactivo'] }, { title: 'Super Chats', names: ['Carlos Ruiz'] }, { title: 'Nuevos seguidores', names: ['devconcafe', 'lucia_codes', 'Laura Test', 'Javi Dev'] },
    ],
    session: { title: 'Directo de prueba' },
    chat: [],
  };
}
export function demoChat(i = Math.floor(Math.random() * 1000)) {
  const user = names[i % names.length];
  return { id: 'demo' + i + Math.random(), platform: i % 3 ? 'twitch' : 'youtube', user, color: '', text: lines[i % lines.length], parts: [{ t: lines[i % lines.length] }], mod: i % 7 === 0, member: i % 4 === 0, at: new Date().toISOString() };
}

/** Datos de ejemplo de preguntas, tier list y sorteo para la vista previa. */
export function demoInteractive() {
  const tiers = [['s', 'S', '#FF0036'], ['a', 'A', '#FF6A3D'], ['b', 'B', '#FFB547'], ['c', 'C', '#5ED17A'], ['d', 'D', '#4AA8FF']].map(([id, label, color]) => ({ id, label, color }));
  const items = ['React', 'Vue', 'Svelte', 'Angular', 'Solid', 'Qwik', 'Astro'].map((label, i) => ({ id: 'i' + i, label, image: '' }));
  return {
    questions: { pending: 4, current: { id: 'q1', user: 'pixelmaria', platform: 'twitch', text: '¿Cómo decides cuándo un componente del design system tiene que ser un átomo y cuándo una molécula?', status: 'shown' }, list: [] },
    tierlists: [{ id: 'demo', title: 'Frameworks frontend', tiers, items, placements: { i0: 's', i2: 's', i1: 'a', i6: 'a', i3: 'c' } }],
    shownTierlist: 'demo',
    vote: { listId: 'demo', item: items[4], counts: { s: 9, a: 14, b: 5, c: 2, d: 1 }, total: 31, winner: 'a', endsAt: null },
    giveaway: { open: true, count: 37, entries: ['devconcafe', 'ana_frontend', 'reactivo', 'lucia_codes', 'midudev'].map(user => ({ user })), winners: [], rolling: null },
    config: { questions: { showUser: true }, tierlist: { command: '!tier', acceptBare: true }, giveaway: { command: '!sorteo', title: 'Sorteo', prize: 'una camiseta EGDEV' } },
  };
}
