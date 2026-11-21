// Shared first-message presence for welcome and YouTube streaks. Identities remain private.
// firstMessageInSession resolves to { id, startedAt } only once per platform/author/session;
// pastSessionsForAuthor returns matching archived metadata oldest first, never the author IDs.
export const firstMessageInSession = (session, platform, observation, target, enabled) =>
  session.firstChat(platform, observation, target, enabled);

// Archives do not change while a session runs, so the index of earlier sessions is built once
// per current session: one read per archive for every platform; lookups then use only the
// in-memory index, which is replaced when the session changes.
const indexes = new WeakMap(); // session → { id, built: Promise<{ byAuthor, byPlatform, complete }> }
const chronological = (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id);

async function buildIndex(session, current) {
  const byAuthor = new Map(), byPlatform = new Map();
  let complete = true;
  const rows = await session.list({ limit: Infinity });
  for (const row of rows) {
    if (row.id === current.id || Date.parse(row.startedAt) > Date.parse(current.startedAt)) continue;
    let stats;
    try {
      const data = await session.get(row.id); // also handles the session pending archival
      stats = data?.chatStats;
    } catch { complete = false; continue; /* an unreadable archive cannot prove continuity */ }
    if (!stats || typeof stats !== 'object') continue;
    const meta = { id: row.id, startedAt: row.startedAt, endedAt: row.endedAt };
    for (const [platform, entry] of Object.entries(stats)) {
      if (!Array.isArray(entry?.authorIds)) continue;
      if (!byPlatform.has(platform)) byPlatform.set(platform, []);
      byPlatform.get(platform).push(meta); // empty authorIds still represent a chat-stats session
      for (const id of new Set(entry.authorIds)) {
        const key = `${platform}\0${id}`;
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key).push(meta);
      }
    }
  }
  for (const list of [...byAuthor.values(), ...byPlatform.values()]) list.sort(chronological);
  return { byAuthor, byPlatform, complete };
}

function historyIndex(session, current) {
  let entry = indexes.get(session);
  if (!entry || entry.id !== current.id) {
    entry = { id: current.id, built: buildIndex(session, current) };
    indexes.set(session, entry);
    const mine = entry;
    mine.built.catch(() => { if (indexes.get(session) === mine) indexes.delete(session); }); // retried next time
  }
  return entry.built;
}

export async function pastSessionsForAuthor(session, platform, authorId, current) {
  const found = (await historyIndex(session, current)).byAuthor.get(`${platform}\0${authorId}`) || [];
  return found.map(row => ({ ...row }));
}

// Small audiences see every first message. A burst (including paused alerts) is capped at five;
// suppressed messages still count as presence and are never replayed later in the session.
export function welcomeChat({ session, engine, msg, observation, enabled, log }) {
  const captured = firstMessageInSession(session, msg.platform, { ...observation, authorId: msg.authorId }, observation.target, enabled);
  return captured.then(async current => {
    if (!current) return;
    const past = await pastSessionsForAuthor(session, msg.platform, msg.authorId, current);
    let type = 'welcome', vars = { user: msg.user, platform: msg.platform, returning: past.length > 0 };
    if (msg.platform === 'youtube') {
      const { byPlatform, complete } = await historyIndex(session, current);
      // La configuración se comprueba tras el await: no lanzar con un interruptor ya apagado.
      if (complete && engine.config.youtube?.streakAlert !== false && engine.config.alerts?.streak?.enabled !== false) {
        const present = new Set(past.map(row => row.id));
        const eligible = byPlatform.get('youtube') || [];
        let count = 1; // el directo actual
        for (let i = eligible.length - 1; i >= 0 && present.has(eligible[i].id); i--) count++;
        if (count >= (engine.config.youtube?.streakMinSessions ?? 3)) {
          type = 'streak'; vars = { user: msg.user, platform: msg.platform, count };
        }
      }
    }
    if (!enabled() || session.data.id !== current.id || session.data.endedAt || engine.config.alerts?.[type]?.enabled === false) return;
    // Sin overlay no hay cola visible: el motor puede conservar ids sin ACK hasta que llegue uno.
    const hasOverlay = engine.bus.overlayCount() > 0;
    const queued = hasOverlay ? engine.queuedAlerts.size : 0;
    if (queued + engine.held.length >= 5) return;
    const alert = engine.handleEvent({ type, vars });
    // Un envío sin overlay no queda pendiente. Reutiliza la misma retirada que un ACK real;
    // las alertas pausadas siguen retenidas y las acciones ya admitidas no se repiten.
    if (!hasOverlay && !engine.paused && alert) engine.alertShown(alert.id);
  }).catch(() => { try { log('[bienvenida] No se pudo comprobar el historial del chat.'); } catch {} });
}
