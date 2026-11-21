// First-message presence for welcome now and watch streak later. Identities remain private.
// firstMessageInSession resolves to { id, startedAt } only once per platform/author/session;
// pastSessionsForAuthor returns matching archived metadata oldest first, never the author IDs.
export const firstMessageInSession = (session, platform, observation, target, enabled) =>
  session.firstChat(platform, observation, target, enabled);

// Archives do not change while a session runs, so the index of earlier sessions is built once
// per current session: one read per archive for every platform, then O(1) per new chatter. The
// index lives only in memory and is replaced when the session changes.
const indexes = new WeakMap(); // session → { id, built: Promise<Map<'platform\0authorId', rows[]>> }

async function buildIndex(session, current) {
  const byAuthor = new Map();
  const rows = await session.list({ limit: Infinity });
  for (const row of rows) {
    if (row.id === current.id || Date.parse(row.startedAt) > Date.parse(current.startedAt)) continue;
    let stats;
    try {
      const data = await session.get(row.id); // also handles the session pending archival
      stats = data?.chatStats;
    } catch { continue; /* unavailable archives cannot prove earlier presence */ }
    if (!stats || typeof stats !== 'object') continue;
    const meta = { id: row.id, startedAt: row.startedAt, endedAt: row.endedAt };
    for (const [platform, entry] of Object.entries(stats)) {
      if (!Array.isArray(entry?.authorIds)) continue;
      for (const id of new Set(entry.authorIds)) {
        const key = `${platform}\0${id}`;
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key).push(meta);
      }
    }
  }
  for (const list of byAuthor.values())
    list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.id.localeCompare(b.id));
  return byAuthor;
}

export async function pastSessionsForAuthor(session, platform, authorId, current) {
  let entry = indexes.get(session);
  if (!entry || entry.id !== current.id) {
    entry = { id: current.id, built: buildIndex(session, current) };
    indexes.set(session, entry);
    const mine = entry;
    mine.built.catch(() => { if (indexes.get(session) === mine) indexes.delete(session); }); // retried next time
  }
  const found = (await entry.built).get(`${platform}\0${authorId}`) || [];
  return found.map(row => ({ ...row }));
}

// Small audiences see every first message. A burst (including paused alerts) is capped at five;
// suppressed messages still count as presence and are never replayed later in the session.
export function welcomeChat({ session, engine, msg, observation, enabled, log }) {
  const captured = firstMessageInSession(session, msg.platform, { ...observation, authorId: msg.authorId }, observation.target, enabled);
  return captured.then(async current => {
    if (!current) return;
    const past = await pastSessionsForAuthor(session, msg.platform, msg.authorId, current);
    if (!enabled() || session.data.id !== current.id || session.data.endedAt || engine.config.alerts?.welcome?.enabled === false) return;
    // Sin overlay no hay cola visible: el motor puede conservar ids sin ACK hasta que llegue uno.
    const hasOverlay = engine.bus.overlayCount() > 0;
    const queued = hasOverlay ? engine.queuedAlerts.size : 0;
    if (queued + engine.held.length >= 5) return;
    const alert = engine.handleEvent({ type: 'welcome', vars: { user: msg.user, platform: msg.platform, returning: past.length > 0 } });
    // Un envío sin overlay no queda pendiente. Reutiliza la misma retirada que un ACK real;
    // las alertas pausadas siguen retenidas y las acciones ya admitidas no se repiten.
    if (!hasOverlay && !engine.paused && alert) engine.alertShown(alert.id);
  }).catch(() => { try { log('[bienvenida] No se pudo comprobar el historial del chat.'); } catch {} });
}
