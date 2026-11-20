// antena: servidor local. Panel en /, overlay en /overlay y widgets en /widget/<nombre>.
// Todo lo que hace el panel pasa por esta API REST, que también usa el servidor MCP (src/mcp.mjs).
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readdir, stat, mkdir, unlink, rename, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Store, ROOT, DEFAULT_CONFIG, deepMerge, configPathKeys } from './store.mjs';
import { MIGRATIONS } from './config-migrations.mjs';
import { instanceId } from './instance-id.mjs';
import { validatePatch, validatePath, validateChatVariantsTransition, warnUnknownKeys } from './config-schema.mjs';
import { Bus } from './bus.mjs';
import { acceptWebSocket } from './ws-stream.mjs';
import { Twitch } from './twitch.mjs';
import { YouTube } from './youtube.mjs';
import { RawEventLog } from './raw-events.mjs';
import { YouTubeAutoConnect } from './youtube-auto.mjs';
import { TwitchChat } from './chat.mjs';
import { createProgram, MELD_COMMANDS, MELD_STREAM_EVENTS } from './programs/index.mjs';
import { Session, METRICS } from './session.mjs';
import { Engine, burstCoalesce, SNAPSHOT_COALESCE_MS, SNAPSHOT_MAX_WAIT_MS } from './engine.mjs';
import { createHeldRecovery } from './held-recovery.mjs';
import { registerShortcutRoutes, PROMPTER_LEGACY_TABS } from './routes/shortcuts.mjs';
import { registerSessionRoutes, TIMELINE_MAX } from './routes/sessions.mjs';
import { registerMetricsRoutes } from './routes/metrics.mjs';
import { createPushExport } from './push-export.mjs';
import { registerMediaRoutes, MAX_UPLOAD } from './routes/media.mjs';
import { registerInteractiveRoutes } from './routes/interactive.mjs';
import { registerChatRoutes } from './routes/chat.mjs';
import { registerGoalsRoutes } from './routes/goals.mjs';
import { registerFollowersRoutes } from './routes/followers.mjs';
import { registerChatVariantsRoutes } from './routes/chat-variants.mjs';
import { registerMeldRoutes } from './routes/meld.mjs';
import { registerViewersRoutes } from './routes/viewers.mjs';
import { registerThemeRoutes } from './routes/theme.mjs';
import { registerConfigTransferRoutes } from './routes/config-transfer.mjs';
import { registerAlertRoutes } from './routes/alerts.mjs';
import { registerCommandRoutes } from './routes/commands.mjs';
import { registerTimerRoutes } from './routes/timers.mjs';
import { registerWidgetRoutes } from './routes/widgets.mjs';
import { registerCreditsRoutes } from './routes/credits.mjs';
import { setupAutoSession } from './auto-session.mjs';
import { themeCss, publicTheme } from './theme.mjs';
import { ViewerWatch } from './viewers.mjs';
import { ChannelTotals } from './channel-totals.mjs';
import { FollowerRegistry } from './followers.mjs';
import { registerTeleprompterRoutes } from './routes/teleprompter.mjs';
import { registerInterviewRoutes } from './routes/interviews.mjs';
import { Interviews } from './interviews.mjs';
import { registerCustomOverlayRoutes } from './routes/custom-overlays.mjs';
import { Teleprompter } from './teleprompter.mjs';
import { CustomOverlays, CUSTOM_OVERLAY_ID, FRAME_CSP, shellHtml, frameHtml, publicOverlay } from './custom-overlays.mjs';
import { httpError, id8, safePath, cleanName, freeName } from './http-util.mjs';
import { Interactive } from './interactive.mjs';
import { Timers, TIMER_DESTINATIONS, DEFAULT_TIMER, ANNOUNCE_COLORS } from './timers.mjs';
import {
  ALERT_TYPES, DEFAULT_ALERTS, LOOK_DEFAULTS, EXTRA_DEFAULTS, ALERT_FIELDS, DEFAULT_CONDITIONS, DEFAULT_COMMAND, SAMPLES,
  mediaKind, youtubeAvatarUrl,
} from './alerts.mjs';

const PUBLIC = path.join(ROOT, 'public');
// Interfaz React (app/ → app/dist con `pnpm app:build`). Sin compilar, /, /prompter y /dock
// responden una página mínima que explica cómo compilarla (#115: el panel clásico se retiró).
const APP_DIST = path.join(ROOT, 'app', 'dist');
const APP_PAGES = { '/': 'index.html', '/prompter': 'prompter.html', '/dock': 'dock.html' };
const HELD_MAX_ALERT_BYTES = 256 * 1024;
const HELD_MAX_BATCH_BYTES = 8 * 1024 * 1024;
const HELD_LIST_LIMIT = 100;
// Cierre de admisión: mensaje constante y seguro para toda petición rechazada.
const CLOSING_MESSAGE = 'La app se está cerrando.';
const INTERNAL_ERROR = 'Error interno del servidor';
// Deliberate Spanish errors (e.g. «Falta el Client ID…») stay visible to the panel; system errors
// (fs/net with a code, which may carry paths) and programming errors are hidden behind a generic text.
const PROGRAMMING_ERRORS = [TypeError, ReferenceError, SyntaxError, RangeError];
const publicMessage = err => {
  const system = err?.syscall || err?.path || /^(E[A-Z]+|ERR_[A-Z_]+)$/.test(String(err?.code || ''));
  if (!(err instanceof Error) || system || PROGRAMMING_ERRORS.some(T => err instanceof T) || !err.message) return INTERNAL_ERROR;
  return err.message;
};
const MEDIA_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.apng': 'image/apng', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
};
export const WIDGETS = ['chat', 'goal', 'latest', 'ticker', 'credits', 'question', 'tierlist', 'giveaway', 'teleprompter', 'viewers', 'thanks', 'interview'];

/** Viewer counts for on-screen widgets: only what the widget shows, never settings or errors. */
export function publicViewers(snap) {
  const out = {};
  for (const [p, s] of Object.entries(snap?.platforms || {})) out[p] = { live: !!s.live, current: s.current ?? 0, peak: s.peak ?? 0, record: s.record ?? 0 };
  return out;
}

// Hosts locales de confianza: el panel se sirve por loopback y un navegador ajeno que apunte
// a 127.0.0.1 (DNS rebinding) no debe poder leer ni cambiar nada.
const LOCAL_HOSTS = (() => {
  const set = new Set(['localhost', '127.0.0.1', '::1', String(os.hostname() || '').toLowerCase()]);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i?.address) set.add(String(i.address).toLowerCase());
  set.delete('');
  return set;
})();
const isLoopback = ip => /^(127\.|::1$|::ffff:127\.)/.test(ip || '');
function hostName(host = '') {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  return (m ? m[1] : String(host).replace(/:\d+$/, '')).toLowerCase();
}
function hostTrusted(req) {
  if (!isLoopback(req.socket.remoteAddress || '')) return true;   // desde la red sigue haciendo falta la clave
  const host = hostName(req.headers.host || '');
  return !!host && LOCAL_HOSTS.has(host);
}
// Mutaciones: bloquea CSRF. Sec-Fetch-Site cross-site/same-site y Origin que no sea el propio del Host.
function originAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  let o, expected;
  try { o = new URL(origin); expected = new URL(`http://${req.headers.host || ''}`); }
  catch { return false; }
  return o.origin === expected.origin;   // http, mismo host y puerto exactos (bloquea https y puertos ajenos)
}
// Atajos /sd/*: además del bloqueo de arriba, un GET con Referer de otro origen, o con
// cabeceras de navegador (Sec-Fetch-Dest/User) que no traigan Sec-Fetch-Site, viene de un
// navegador sin esa cabecera (p. ej. un <img> en una web ajena desde un webview antiguo) y
// no del plugin del Stream Deck, que no envía ninguna de esas cabeceras. Se usa Dest (que
// todo navegador envía) y no Mode, porque el fetch de Node (undici) manda sec-fetch-mode
// sin sec-fetch-site y no hay que romper al MCP ni a los tests.
function sdRequestAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (!site && (req.headers['sec-fetch-dest'] || req.headers['sec-fetch-user'])) return false;
  const referer = req.headers.referer;
  if (referer) {
    let r, expected;
    try { r = new URL(referer); expected = new URL(`http://${req.headers.host || ''}`); }
    catch { return false; }
    if (r.origin !== expected.origin) return false;
  }
  return originAllowed(req);
}

export async function createApp({ dataDir, mediaDir = process.env.ANTENA_MEDIA || path.join(ROOT, 'media'), log = console.log, heldRecoveryWindows, heldRecoveryIO, appDist, recordingTimers,
  push = { url: process.env.ANTENA_PUSH_URL, token: process.env.ANTENA_PUSH_TOKEN }, pushTimers, pushNow, pushTimeoutMs, configTransferIO, zipUploadLimit, zipExportLimit } = {}) {
  let notifyPushStatus = () => {}, requestPushReconciliation = () => {}, notifyPushCheckpoint = () => {};
  // Validate private process settings before loading or changing any application state.
  const pushExport = createPushExport({ config: push, timers: pushTimers, now: pushNow, timeoutMs: pushTimeoutMs,
    onChange: () => notifyPushStatus(), onSpace: () => requestPushReconciliation(), onCheckpoint: () => notifyPushCheckpoint() });
  const store = await new Store(dataDir).load();
  const id = await instanceId(store.dir);
  // la interfaz React si está compilada; si no, la página mínima de las páginas de app
  // (appDist inyectable solo para pruebas: un directorio vacío simula «sin compilar»)
  const dist = appDist || APP_DIST;
  const useApp = existsSync(path.join(dist, 'index.html'));
  // Un único descubrimiento de solo lectura al arrancar, esperado antes de status/listen.
  // Nunca se reconstruyen ni se reinsertan alertas. Las entradas de confianza de Windows son
  // explícitas; sin repliegue a un modo privado del entorno.
  let heldRecovery = { state: 'unavailable', batches: [], limited: false, complete: false };
  try {
    const recovery = createHeldRecovery({
      dir: store.dir, maxAlertBytes: HELD_MAX_ALERT_BYTES, maxBatchBytes: HELD_MAX_BATCH_BYTES,
      windows: heldRecoveryWindows, io: heldRecoveryIO,
    });
    heldRecovery.state = 'blocked';
    const listed = await recovery.list({ limit: HELD_LIST_LIMIT });
    const complete = listed.state === 'ok' && !listed.limited;
    heldRecovery = {
      state: complete ? (listed.batches.length ? 'pending' : 'empty') : 'blocked',
      // Lista blanca solo de metadatos: nunca payload, errores de IO ni salida del helper.
      batches: listed.batches.map(({ batchId, createdAt, count, state }) => Object.freeze({ batchId, createdAt, count, state })),
      limited: listed.limited, complete,
    };
  } catch { /* Constructor no disponible o listado bloqueado: ninguna de las dos cosas significa vacío. */ }
  Object.freeze(heldRecovery.batches);
  Object.freeze(heldRecovery);
  if (heldRecovery.state !== 'empty') {
    try {
      log(heldRecovery.state === 'pending'
        ? '[recuperación] Alertas retenidas pendientes de revisión; sin ejecución automática.'
        : '[recuperación] Revisión de alertas retenidas bloqueada o no disponible; sin ejecución automática.');
    } catch { /* Un diagnóstico nunca debe impedir el arranque. */ }
  }
  const bus = new Bus();
  const twitch = new Twitch(store, log);
  const youtube = new YouTube(store, log);
  // Registro en bruto de todo lo que envían las plataformas (data/raw-events.jsonl).
  youtube.rawLog = twitch.rawLog = new RawEventLog(store.dir, { log });
  const chat = new TwitchChat(log);
  // A stable facade keeps all consumer subscriptions and their ordering on kind changes.
  const program = createProgram('meld', { log });
  const meld = program.raw; // tests and diagnostics retain the underlying Meld instance
  const obs = createProgram('obs', { getPassword: () => store.secrets.obs?.password });
  let selectedProgram = store.config.program.kind;
  if (selectedProgram === 'obs') program.select(obs);
  // GET /api/stream?client=dock-meters opts into meter demand. On that dedicated
  // client kind the replaceable 'meters' event contains { tracks: [{ id, level, clipping }] };
  // ordinary panel snapshots and all other SSE clients remain unchanged.
  const meterWatchers = new Set();
  let meterTimer = null, meterTracks = [];
  const updateMeterInterest = () => {
    const wanted = selectedProgram === 'obs' && meterWatchers.size > 0;
    obs.watchMeters(wanted);
    if (!wanted) { clearTimeout(meterTimer); meterTimer = null; meterTracks = []; }
  };
  const pushMeters = tracks => {
    if (selectedProgram !== 'obs' || !meterWatchers.size) return;
    meterTracks = tracks;
    if (meterTimer) return;
    meterTimer = setTimeout(() => {
      meterTimer = null;
      if (selectedProgram === 'obs' && meterWatchers.size) bus.send('meters', { tracks: meterTracks }, ['dock-meters']);
    }, 100);
    meterTimer.unref?.();
  };
  obs.on('meters', pushMeters);
  obs.on('status', status => { if (status.state !== 'conectado') pushMeters([]); });
  // #68: la retención de archivados sale de la configuración (0 = sin límite); se lee
  // en vivo para que un cambio en config.json valga sin reiniciar.
  const protectedArchives = new Set();
  let retentionReady = false;
  const protectPushArchives = () => pushExport.status().enabled || pushExport.status().pending > 0;
  const session = await new Session(store.dir, { report: log, maxArchived: () => store.config.sessions?.retention,
    pushExportEnabled: pushExport.status().enabled,
    preserveArchived: id => !retentionReady || (protectedArchives.has(id) && !pushExport.isDurable(id)) }).load();
  await pushExport.load(store.dir);
  notifyPushCheckpoint = () => {
    for (const id of protectedArchives) if (pushExport.isDurable(id)) protectedArchives.delete(id);
    session._applyRetention().catch(() => {});
  };
  session._applyRetention().catch(() => {});   // unclassified archives stay protected until reconciliation
  const engine = new Engine({ store, bus, session, meld: program, twitch, youtube, log });
  // #132: barras de objetivo con el total real del canal (persisten entre directos)
  const channelTotals = await new ChannelTotals({ dir: store.dir, twitch, youtube, log }).load();
  const followers = await new FollowerRegistry({ dir: store.dir, twitch, youtube, log }).load();
  // Session.list is asynchronous; snapshots stay synchronous and only use this cached cutoff.
  let lastStreamCutoff = null, cutoffGeneration = 0;
  const refreshLastStream = async () => {
    const generation = ++cutoffGeneration;
    // Every archive, not the history view's 50 id-sorted entries: legacy ids are not chronological.
    const sessions = await session.list({ limit: Infinity });
    let newest = null;
    for (const archived of sessions) {
      const end = Date.parse(archived.endedAt), start = Date.parse(archived.startedAt);
      const at = Number.isFinite(end) ? end : start;
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    }
    if (generation === cutoffGeneration) lastStreamCutoff = newest;
  };
  await refreshLastStream();
  const thanksSelection = () => followers.thanksSelection(deepMerge(DEFAULT_CONFIG.widgets.thanks, store.config.widgets?.thanks || {}), lastStreamCutoff);
  engine.thanksState = () => {
    const selected = thanksSelection();
    return { names: selected.entries.map(({ name, platform }) => ({ name, platform })), anonymous: selected.anonymous.reduce((sum, a) => sum + a.count, 0) };
  };
  session.channelTotals = channelTotals;
  const timers = new Timers({ store, engine, twitch, youtube, meld: program, session, log });
  engine.timers = timers;
  const interactive = await new Interactive({ store, twitch, meld: program, log }).load();
  engine.interactive = interactive;
  // Ráfagas: cada voto recalcula `changed`, pero el snapshot completo solo sale una vez por ventana.
  const pushInteractive = burstCoalesce(SNAPSHOT_COALESCE_MS, () => bus.send('interactive', interactive.snapshot(), ['widget', 'panel']));
  interactive.on('change', () => pushInteractive());
  // récord de espectadores por plataforma (alertas viewers/ytviewers con anti-spam, #142)
  const viewers = new ViewerWatch({ store, twitch, youtube, engine, log });
  // Widgets and custom overlays (S6) get only the public counts, never settings or errors.
  viewers.on('change', snap => {
    bus.send('viewers', snap, ['panel']);
    bus.send('viewers', publicViewers(snap), ['widget']);
  });
  // teleprompter: guion y avance compartidos por panel y su ventana dedicada (kind propio SSE)
  const teleprompter = new Teleprompter({ store, log });
  // entrevistas (#276): paquetes validados y la activa; sin estado vivo, solo configuración
  // el widget `interview` recibe solo el ítem activo y aprobado, sin notas privadas (activeItem()).
  // `interviewControl` is the presenter view WITH private notes: panel clients only (#278).
  const interviews = new Interviews({
    store, log,
    onChange: () => { bus.send('interview', { item: interviews.activeItem() }, ['widget']); bus.send('interviewControl', interviews.control(), ['panel']); },
    // each question shown is marked in the live timeline (the notes never go there)
    onShow: q => session.addNote({ kind: 'question', text: q.question, label: 'Entrevista', interviewId: q.interviewId, itemId: q.id }),
  });
  // kind propio de SSE: el guion es contenido privado, nunca va a los widgets genéricos.
  teleprompter.on('change', snap => bus.send('teleprompter', snap, ['teleprompter', 'panel']));
  // Overlays propios (src/custom-overlays.mjs): el panel recibe la lista completa (editor y
  // vista previa) y los widgets solo el mapa de versiones, para recargar su capa sin tocar Meld.
  const customOverlays = new CustomOverlays({
    store,
    onChange: list => {
      // El panel recibe la lista con las aprobaciones normalizadas; los widgets solo el mapa de
      // versiones para recargar su capa sin tocar Meld.
      bus.send('customOverlays', list.map(publicOverlay), ['panel']);
      bus.send('customOverlayVersions', customOverlays.versions(), ['widget']);
    },
  });
  await mkdir(mediaDir, { recursive: true });
  if (!store.config.access.key) await store.patchConfig({ access: { key: randomBytes(9).toString('base64url') } });

  // ---------- estado ----------
  const status = () => ({
    twitch: twitch.status, youtube: youtube.status, chat: chat.status, meld: program.status,
    program: { kind: selectedProgram, capabilities: [...program.capabilities].sort() },
    overlays: bus.overlayCount(), pause: engine.pauseState(),
    persistence: store.persistenceState(),
    channelTotals: channelTotals.snapshot(),
    followers: followers.snapshot(),
    sessionRecovery: session.recoveryState(),
    sessionArchive: session.archiveState(),
    heldRecovery,
    push: pushExport.status(),
  });
  const pushStatus = () => bus.send('status', status(), ['panel']);
  notifyPushStatus = pushStatus;
  for (const src of [twitch, youtube, chat, program]) src.on('status', pushStatus);

  // eventos de plataforma → motor
  // #132: el total del canal se complementa con el evento real de la plataforma, aunque su
  // alerta esté desactivada o el usuario filtrado (es el número real del canal)
  twitch.on('event', e => channelTotals.onEvent(e));
  twitch.on('event', e => {
    if (e.type === 'follow') followers.onLiveFollow({ platform: 'twitch', id: e.followerId, name: e.vars?.user, at: e.followedAt });
  });
  twitch.on('event', e => engine.handleEvent(e));
  youtube.on('event', e => engine.handleEvent(e));
  chat.on('delete', ({ id }) => engine.deleteChat(id));
  chat.on('clearUser', ({ login }) => engine.clearChatUser(login));
  session.on('change', change => {
    engine.pushWidgets(); pushTimeline();
    if (change?.reset) refreshLastStream().then(() => engine.pushWidgets()).catch(() => {});
  });
  // Only the current session loaded at startup, or one whose finalization was
  // confirmed durable, is eligible. An in-flight failed checkpoint is not.
  const durableFinished = new Set();
  if (session.data.meldAutoSession && session.data.endedAt) durableFinished.add(session.data.id);
  const enqueueFinished = async data => {
    if (!pushExport.status().enabled || !data?.meldAutoSession || !data.endedAt || pushExport.has(data.id)) return;
    protectedArchives.add(data.id);
    try {
      const marked = await session.checkpointPushOwed(data.id, data);
      if (marked && pushExport.hasCapacity() && !pushExport.has(data.id)) pushExport.enqueue(marked);
    } catch { protectedArchives.add(data.id); pushExport.reconciliationError(); }
  };
  let reconciling = null, reconcileAgain = false;
  requestPushReconciliation = () => {
    // Even with push disabled, the first scan discovers obligations recorded in
    // session checkpoints before an initial queue write failed.
    if (!protectPushArchives() && retentionReady && !protectedArchives.size) return;
    reconcileAgain = true;
    if (reconciling) return;
    reconciling = (async () => {
      do {
        reconcileAgain = false;
        const current = session.data;
        if (durableFinished.has(current.id)) await enqueueFinished(current);
        let names;
        try { names = await readdir(session.dir); }
        catch (error) { if (error?.code === 'ENOENT') names = []; else throw error; }
        // Classify every archive even when the bounded queue is full; retention
        // must not remove a session merely because it has not been enqueued yet.
        for (const name of names.sort().reverse()) {
          if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue;
          const id = name.slice(0, -5);
          if (!/^[\w-]+$/.test(id)) continue;
          if (pushExport.isDurable(id)) { protectedArchives.delete(id); continue; }
          if (session.getPending()?.id === id) { protectedArchives.add(id); continue; }
          try {
            const data = await session.getArchived(id);
            if (data?.meldAutoSession && data.endedAt && (protectPushArchives() || data._pushExportOwed === true)) {
              protectedArchives.add(id);
              await enqueueFinished(data);
            } else protectedArchives.delete(id);
          } catch { protectedArchives.add(id); pushExport.reconciliationError(); }
        }
        retentionReady = true;
        session._applyRetention().catch(() => {});
      } while (reconcileAgain);
    })().catch(() => pushExport.reconciliationError()).finally(() => {
      reconciling = null;
      if (reconcileAgain) requestPushReconciliation();
    });
  };
  session.on('finalized', data => {
    durableFinished.add(data.id);
    if ((protectPushArchives() || data._pushExportOwed === true) && data.meldAutoSession && data.endedAt && !pushExport.isDurable(data.id)) protectedArchives.add(data.id);
    void enqueueFinished(data);
    requestPushReconciliation();
  });
  requestPushReconciliation();
  channelTotals.on('change', () => { engine.pushWidgets(); pushStatus(); });
  followers.on('change', () => { pushStatus(); engine.pushWidgets(); });
  followers.on('liveFollow', ({ id, name, avatar, ownerChannelId }) => {
    const safeAvatar = youtubeAvatarUrl(avatar);
    const event = { externalId: `ytsub:${id}`, type: 'ytsub', vars: { user: name, ...(safeAvatar ? { avatar: safeAvatar } : {}) } };
    const goalChannel = youtube.cfg.channelId;
    // An explicit channel may differ from the OAuth account that owns the subscriber list.
    if (!goalChannel || (ownerChannelId && ownerChannelId === goalChannel)) channelTotals.onEvent(event);
    engine.handleEvent(event);
  });
  followers.on('liveAnonymous', ({ count }) => {
    if (store.config.youtube.subscriberCountAlert !== false)
      engine.handleEvent({ externalId: `ytsubcount:${randomUUID()}`, type: 'ytsubcount', vars: { amount: count } });
  });
  // Capture YouTube ownership before the total read: that read can outlive a listening period.
  const refreshFollowers = (platform, options) => {
    const owner = platform === 'youtube' ? followers.captureYouTubeActivity() : () => true;
    const active = () => owner() && (!options?.active || options.active());
    return channelTotals.refresh(platform).then(() => {
      if (!active()) return;
      return followers.sync(platform, platform === 'youtube' ? { ...options, active } : options);
    }).catch(() => {});
  };
  let twitchState = twitch.status.state, youtubeState = youtube.status.state, youtubeAccount = youtube.status.account;
  twitch.on('status', st => {
    if (st.state === 'conectado' && twitchState !== 'conectado') refreshFollowers('twitch');
    twitchState = st.state;
  });
  youtube.on('status', st => {
    const entered = st.state === 'escuchando' && youtubeState !== 'escuchando';
    const left = st.state !== 'escuchando' && youtubeState === 'escuchando';
    const accountChanged = st.account && st.account !== youtubeAccount;
    youtubeState = st.state; youtubeAccount = st.account;
    if (left) followers.endYouTubeListening();
    if (entered) followers.beginYouTubeListening(active => refreshFollowers('youtube', { active, live: false, establish: true }));
    else if (accountChanged) refreshFollowers('youtube', { live: false });
  });
  // la cronología apunta también lo que pasa en los interactivos
  interactive.on('questionShown', q => session.addNote({ kind: 'question', text: q.text, user: q.user, platform: q.platform }));
  interactive.on('draw', r => session.addNote({ kind: 'winner', user: r.winner, label: store.config.interactive?.giveaway?.prize || '' }));

  // ---------- prompter ----------
  // S10: dos pestañas («Eventos» = cronologia y «Preguntas»). Las retiradas (tierlist, sorteo)
  // se aceptan como no-op registrado para que los atajos guardados y /sd/prompter/<tab> sigan
  // funcionando; lo desconocido sigue siendo 400. Ya no hay salto automático al abrir votación
  // o sorteo (viven en el dock y en su vista del panel).
  const PROMPTER_TABS = ['cronologia', 'preguntas', 'entrevista'];
  const prompter = { tab: 'cronologia', at: Date.now() };
  const setPrompterTab = tab => {
    const t = String(tab || '').toLowerCase().replace('cronología', 'cronologia').replace('tier list', 'tierlist').replace('preguntas', 'preguntas');
    if (PROMPTER_LEGACY_TABS.includes(t)) {
      try { log(`[prompter] Pestaña retirada «${t}»: se queda en ${prompter.tab}`); } catch { /* el aviso nunca debe tumbar la petición */ }
      return prompter;
    }
    if (!PROMPTER_TABS.includes(t)) throw httpError(400, `Pestaña desconocida: ${tab}. Pestañas: ${PROMPTER_TABS.join(', ')}`);
    Object.assign(prompter, { tab: t, at: Date.now() });
    bus.send('prompter', prompter, ['panel']);
    return prompter;
  };
  // #68: tope común de cronología (TIMELINE_MAX, importado de routes/sessions.mjs), también al filtrar por kinds.
  const timelinePayload = () => ({ items: session.timeline().slice(-TIMELINE_MAX), pending: session.pendingThanks(), startedAt: session.data.startedAt, title: session.data.title });
  // #65: mismo patrón que history/widgets/interactive (debounce 120 ms + techo de 500 ms).
  const pushTimeline = burstCoalesce(SNAPSHOT_COALESCE_MS, () => bus.send('timeline', timelinePayload(), ['panel']), SNAPSHOT_MAX_WAIT_MS);

  async function addMarker(label = '') {
    const n = session.addNote({ kind: 'marker', label });
    if (twitch.status.state === 'conectado') {
      try {
        const m = await Promise.race([twitch.createMarker(label || 'antena'), new Promise((_, rej) => setTimeout(() => rej(new Error('Twitch no respondió a tiempo')), 4000).unref())]);
        if (m) Object.assign(n, { twitchMarker: m.id, twitchSeconds: m.position_seconds });
      } catch (e) { n.twitchError = e.message; }
      session.save(); pushTimeline();
    }
    return n;
  }
  // Confirmed rendering inputs only: never the panel's optimistic/draft config.
  // Per-type content hashes avoid reloading all thumbnails for one alert change.
  const alertPreviews = () => {
    const common = [store.config.overlay?.css || '', publicTheme(store.config.theme).version];
    return Object.fromEntries(Object.keys(ALERT_TYPES).map(type => [type, {
      version: createHash('sha256').update(JSON.stringify([store.config.alerts[type], ...common])).digest('hex').slice(0, 16),
      media: store.config.alerts[type]?.media || '',
    }]));
  };
  // Once program settings change, include their public snapshot in every config event:
  // the bus coalesces by event type, so a later chat/alert update must not erase it.
  let includeProgramConfig = false;
  // #39: an open dock follows saved layout/module and shortcut changes without reloading.
  let includeDockConfig = false;
  const pushPanelConfig = () => {
    const config = store.publicConfig();
    bus.send('config', {
      prompter: store.config.prompter, chat: store.config.chat, alerts: config.alerts,
      ...(includeProgramConfig ? { program: config.program, obs: config.obs } : {}),
      ...(includeDockConfig ? { dock: config.dock, shortcuts: config.shortcuts } : {}),
    }, ['panel']);
  };
  store.on('change', patch => {
    if (patch.youtube || patch.all) followers.updateYouTubePolling();
    if (patch.theme || patch.all) bus.send('theme', publicTheme(store.config.theme), ['overlay', 'preview', 'widget']);
    // The replace-by-type Bus needs a COMPLETE panel rendering snapshot, including
    // after common CSS changes. Keep the three-section config contract unchanged.
    if (patch.theme || patch.alerts || patch.all || patch.overlay === true || Object.hasOwn(patch.overlay || {}, 'css')) {
      bus.send('theme', { ...publicTheme(store.config.theme), alertPreviews: alertPreviews() }, ['panel']);
    }
    if (patch.widgets || patch.all) engine.pushWidgets();
    // Overlays editados fuera de sus rutas (PUT /api/config, config/set o el MCP genérico):
    // mismo par de eventos que onChange, para que la vista previa y las capas se recarguen.
    if (patch.customOverlays || patch.all) {
      bus.send('customOverlays', customOverlays.list(), ['panel']);
      bus.send('customOverlayVersions', customOverlays.versions(), ['widget']);
    }
    // El Bus sustituye config por tipo: cada envío debe conservar todas sus secciones.
    // Incluye alertas editadas fuera de este panel (MCP, otra ventana, el móvil).
    if (patch.dock || patch.shortcuts) includeDockConfig = true;
    if (patch.prompter || patch.chat || patch.alerts || patch.dock || patch.shortcuts || patch.all) pushPanelConfig();
  });
  // la persistencia puede fallar sin emitir 'change' (o estar en vuelo): el panel necesita su propio canal
  store.on('persistence', state => bus.send('persistence', state, ['panel']));
  program.on('session', s => bus.send('meld', s, ['panel']));
  // S2/S12: el panel ve qué acción de chat falló (total o parcialmente) y en qué plataforma; los éxitos no se reenvían.
  engine.on('chatResult', r => { if (!r.ok) bus.send('chatResult', r, ['panel']); });
  const { beginAutoSessionDrain, drainAutoSession, drainChatMetrics, endSession } = setupAutoSession({
    store, program, session, youtube, viewers, chat, twitch, engine, log,
  });
  // #73: al empezar el directo se conecta sola la lectura del chat de YouTube, también si
  // antena arranca con el directo ya en marcha (onInit no emite «streaming»).
  const youtubeAuto = new YouTubeAutoConnect(youtube, { log });
  program.on('streaming', live => { if (live) youtubeAuto.begin(); else youtubeAuto.end().catch(() => {}); });
  program.on('status', st => { if (st.state === 'conectado' && st.streaming) youtubeAuto.begin(); });
  // al conectar Twitch se lee su chat (o el canal indicado)
  twitch.on('status', st => {
    const ch = store.config.chat.twitchChannel || st.user;
    if (ch && st.state === 'conectado' && chat.channel !== ch.toLowerCase()) chat.join(ch);
  });

  async function listMedia() {
    try {
      const files = (await readdir(mediaDir, { withFileTypes: true })).filter(e => !(e.isDirectory() && e.name.startsWith('.backup-')) && mediaKind(e.name)).map(e => e.name).sort((a, b) => a.localeCompare(b));
      // #68: tamaño en bytes de cada archivo, para el panel.
      return await Promise.all(files.map(async name => {
        const st = await stat(path.join(mediaDir, name)).catch(() => null);
        return { name, kind: mediaKind(name), size: st?.size ?? 0 };
      }));
    } catch { return []; }
  }

  // ---------- helpers de edición compartidos ----------
  const pick = (obj, allowed) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => allowed.includes(k)));
  const ALERT_KEYS = Object.keys(ALERT_FIELDS);
  // Acciones de chat: sin destino siguen yendo a Twitch; un destino desconocido no se guarda.
  const checkActions = (...lists) => {
    for (const list of lists) {
      if (Array.isArray(list) && list.some(a => a?.kind === 'chat' && a.destination !== undefined && !TIMER_DESTINATIONS.includes(a.destination)))
        throw httpError(400, 'Destino de la acción de chat no válido. Usa twitch, youtube o both.');
    }
  };
  const COMMAND_KEYS = [...ALERT_KEYS, 'trigger', 'permission', 'cooldownSec', 'userCooldownSec', 'platforms', 'outputMode', 'chatReply'];

  // ---------- ocultado diferido de capas Meld ----------
  // El horario aceptado por POST /api/meld/layer no se toca: el temporizador original sigue
  // referenciado y el await completo de program.setLayer se sigue como una única tarea. La captura
  // empieza SÍNCRONA en la primera señal: solo entran las tareas vivas en ese instante y las que
  // programen handlers ya admitidos hasta sellar. Un fallo terminado antes de la señal no envenena.
  const pendingLayerHides = new Set();
  const capturedLayerHides = new Set();
  let layerCapturing = false;
  let layerSealed = false;
  let layerDrainPromise = null;
  const trackLayerHide = task => {
    const record = { promise: task, settled: false };
    const settle = () => { record.settled = true; pendingLayerHides.delete(record); };
    task.then(settle, settle);
    task.catch(() => {});   // evita unhandledRejection sin ocultar el rechazo a allSettled
    (layerCapturing ? capturedLayerHides : pendingLayerHides).add(record);
    return task;
  };
  const scheduleLayerHide = (sceneId, layerId, ms) => {
    let fire;
    const timer = new Promise(resolve => { fire = resolve; });
    setTimeout(fire, ms);   // temporizador ORIGINAL, referenciado, ni adelantado ni cancelado
    return trackLayerHide(timer.then(() => Promise.resolve().then(() => program.setLayer(sceneId, layerId, false))));
  };
  // Inicio idempotente: sella el snapshot de tareas vivas; después del sello no revive.
  const beginLayerHideDrain = () => {
    if (!layerSealed) {
      layerCapturing = true;
      for (const record of pendingLayerHides) capturedLayerHides.add(record);
    }
    return layerCapturing;
  };
  // Drenado cacheado (mismo resultado en éxito o rechazo): sella y espera lo capturado.
  const drainLayerHides = () => {
    if (layerDrainPromise) return layerDrainPromise;
    layerSealed = true;
    for (const record of pendingLayerHides) capturedLayerHides.add(record);
    const tasks = [...capturedLayerHides].map(r => r.promise);
    layerDrainPromise = Promise.allSettled(tasks).then(results => {
      const failure = results.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
    });
    layerDrainPromise.catch(() => {});
    return layerDrainPromise;
  };

  // ---------- rutas ----------
  const R = [];
  const route = (method, pattern, fn) => R.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  route('GET', '/api/state', async () => ({
    config: store.publicConfig(), types: ALERT_TYPES, defaults: DEFAULT_ALERTS, lookDefaults: { ...LOOK_DEFAULTS, ...EXTRA_DEFAULTS },
    fields: ALERT_FIELDS, conditionDefaults: DEFAULT_CONDITIONS, commandDefaults: DEFAULT_COMMAND, samples: SAMPLES,
    status: status(), history: bus.history.slice(0, 50), media: await listMedia(), metrics: METRICS,
    meld: { session: program.session(), commands: MELD_COMMANDS, events: MELD_STREAM_EVENTS },
    widgets: engine.widgetState(), access: accessInfo(), widgetNames: WIDGETS,
    timers: timers.snapshot(), timerDefaults: DEFAULT_TIMER, announceColors: ANNOUNCE_COLORS,
    interactive: interactive.snapshot(),
    viewers: viewers.snapshot(),
    teleprompter: teleprompter.snapshot(),
    customOverlays: customOverlays.list().map(publicOverlay),
    theme: publicTheme(store.config.theme), alertPreviews: alertPreviews(),
  }));
  route('GET', '/api/status', async () => ({ ...status(), instance: { app: 'antena', id } }));

  // Los clientes antiguos pueden seguir usando las rutas de Meld para estas dos hojas.
  const configAliasPath = dotted => {
    const keys = configPathKeys(dotted);
    return keys[0] === 'meld' && ['autoSession', 'recordOnStart'].includes(keys[1])
      ? ['program', ...keys.slice(1)].join('.') : dotted;
  };
  // config completa
  route('GET', '/api/config', async (_, __, url) => {
    const p = url.searchParams.get('path');
    return p ? { path: p, value: store.getPath(configAliasPath(p), store.publicConfig()) } : store.publicConfig();
  });
  const setObsPassword = value => store.setSecret('obs', value ? { password: value } : undefined);
  route('PUT', '/api/config', async body => {
    let patch = { ...body };
    if (patch.obs && typeof patch.obs === 'object' && !Array.isArray(patch.obs)) patch.obs = { ...patch.obs };
    if (patch.youtube && (patch.youtube.apiKey === undefined || String(patch.youtube.apiKey).startsWith('••••'))) delete patch.youtube?.apiKey;
    // Igual que con apiKey: la máscara que devuelve publicConfig() no puede pisar el secreto real.
    if (patch.youtube && String(patch.youtube.clientSecret ?? '').startsWith('••••')) delete patch.youtube.clientSecret;
    // Igual con la clave LAN enmascarada: la máscara nunca pisa la clave real (issue #59).
    if (patch.access && String(patch.access.key ?? '').startsWith('••••')) delete patch.access.key;
    if (patch.alerts) for (const k of Object.keys(patch.alerts)) if (!ALERT_TYPES[k]) delete patch.alerts[k];
    // Custom overlays always go through their own rules (ids, sizes, versions for live reload).
    const hasOverlays = Object.hasOwn(patch, 'customOverlays');
    const overlaysInput = patch.customOverlays;
    delete patch.customOverlays;
    // Interviews (#276) only change through /api/interviews or MCP: they need the strict pack validation.
    if (Object.hasOwn(patch, 'interviews')) throw httpError(400, 'interviews: se gestionan con /api/interviews (o las herramientas MCP), no con la configuración genérica');
    // El panel puede devolver la proyección pública, pero no modificar el indicador.
    if (patch.obs && typeof patch.obs === 'object' && !Array.isArray(patch.obs) &&
        Object.hasOwn(patch.obs, 'passwordSet') && patch.obs.passwordSet !== !!store.secrets.obs?.password)
      throw httpError(400, 'obs.passwordSet: es de solo lectura');
    // #106: validación por esquema antes de guardar nada; las claves desconocidas se aceptan y se avisan.
    const errors = validatePatch(patch);
    if (errors.length) throw httpError(400, errors.map(e => e.message).join('; '));
    // La validación anterior conserva las rutas y mensajes históricos de los alias.
    const onlyRecording = patch.meld && typeof patch.meld === 'object' && !Array.isArray(patch.meld)
      && Object.keys(patch.meld).length === 1 && Object.hasOwn(patch.meld, 'recordOnStart');
    patch = MIGRATIONS[1].up(patch);
    const hasPassword = patch.obs && Object.hasOwn(patch.obs, 'password');
    const password = hasPassword ? patch.obs.password : undefined;
    if (patch.obs && typeof patch.obs === 'object') { delete patch.obs.password; delete patch.obs.passwordSet; }
    const hasVariants = patch.widgets && Object.hasOwn(patch.widgets, 'chatVariants');
    if (hasVariants) {
      const [error] = validateChatVariantsTransition(store.config.widgets?.chatVariants, patch.widgets.chatVariants, store.config.widgets?.chat);
      if (error) throw httpError(400, error.message);
    }
    warnUnknownKeys(patch);
    if (hasOverlays && hasVariants) {
      // Preparar ambos y aceptarlos juntos antes del primer await: ninguna otra petición
      // puede cambiar las variantes entre la validación y la mutación del store.
      const overlays = customOverlays.prepareReplacement(overlaysInput);
      await store.patchConfig({ ...patch, customOverlays: overlays });
      customOverlays.notify(overlays); // la segunda notificación es la de replaceAll
    } else {
      if (hasOverlays) await customOverlays.replaceAll(overlaysInput);
      await store.patchConfig(patch);
    }
    if (hasPassword) await setObsPassword(password);
    // El borrador puede incluir otras secciones. Solo este campo de Meld no exige reconectar;
    // cualquier otra entrada de Meld conserva la semántica histórica, incluso si no cambia.
    afterConfig(onlyRecording ? { ...patch, meld: false } : patch);
    return { config: store.publicConfig() };
  });
  route('POST', '/api/config/set', async ({ path: p, value }) => {
    if (!p) throw httpError(400, 'Falta «path»');
    const keys = configPathKeys(p);
    if (keys[0] === 'interviews') throw httpError(400, 'interviews: se gestionan con /api/interviews (o las herramientas MCP), no con la configuración genérica');
    if (keys[0] === 'customOverlays') {
      await customOverlays.setPath(keys.join('.'), value);
      return { path: p, value: store.getPath(p, store.publicConfig()) };
    }
    const clearObs = keys.length === 1 && keys[0] === 'obs' && value == null;
    if (clearObs) value = undefined; // null y ausencia borran la sección por igual
    // #106: el valor se valida contra el esquema en su ruta; las rutas nuevas se aceptan.
    const [error] = validatePath(p, value);
    if (error) throw httpError(400, error.message);
    if (keys[0] === 'obs' && keys[1] === 'passwordSet') throw httpError(400, 'obs.passwordSet: es de solo lectura');
    if (keys.length === 2 && keys[0] === 'obs' && keys[1] === 'password') {
      await setObsPassword(value);
      afterConfig({ obs: true });
      return { path: p, passwordSet: store.publicConfig().obs.passwordSet };
    }
    const hasPassword = keys.length === 1 && keys[0] === 'obs' && value && typeof value === 'object' && Object.hasOwn(value, 'password');
    const password = hasPassword ? value.password : undefined;
    if (keys.length === 1 && ['obs', 'program'].includes(keys[0]) && value && typeof value === 'object') {
      value = deepMerge(DEFAULT_CONFIG[keys[0]], value);
      if (keys[0] === 'obs') { delete value.password; delete value.passwordSet; }
    }
    // Sustituir la sección Meld también puede traer los nombres antiguos: guardar
    // ambas secciones en una sola escritura sin perder la retención privada de URL.
    let programPatch;
    if (keys.length === 1 && keys[0] === 'meld' && value && typeof value === 'object' && !Array.isArray(value)) {
      const migrated = MIGRATIONS[1].up({ meld: value });
      if (migrated.program) { value = migrated.meld; programPatch = migrated.program; }
    }
    const target = configAliasPath(p);
    await store.setPath(target, value, { programPatch });
    if (hasPassword || (clearObs && store.secrets.obs !== undefined)) await setObsPassword(password);
    const onlyRecording = keys.length === 2 && keys[0] === 'meld' && keys[1] === 'recordOnStart';
    afterConfig({ [p.split('.')[0]]: !onlyRecording, ...(target !== p || programPatch ? { program: true } : {}) });
    return { path: p, value: store.getPath(target, store.publicConfig()) };
  });

  // Export v1 excludes credentials; import previews the same strict schema before a local backup.
  const configTransfer = registerConfigTransferRoutes({ route, store, customOverlays, afterConfig, mediaDir, configTransferIO, zipUploadLimit, zipExportLimit,
    session, retention: () => Number(store.config.sessions?.retention) || 0,
    afterSessions: () => refreshLastStream().then(() => engine.pushWidgets()).catch(() => {}) });
  let mediaQueue = Promise.resolve();
  const withMediaLock = async fn => {
    const previous = mediaQueue; let release; mediaQueue = new Promise(resolve => { release = resolve; });
    await previous; try { return await fn(); } finally { release(); }
  };

  // Deferred lookups keep previews and ACK admission bound to the same instances,
  // while each group registers at its original position in the route table.
  registerAlertRoutes({ route, store, engine, bus, timers, checkActions, pick, ALERT_KEYS,
    commandOf: id => commandOf(id), timerOf: id => timerOf(id), ackAdmits: id => ackAdmits(id), CLOSING_MESSAGE });
  const commandOf = registerCommandRoutes({ route, store, checkActions, pick, COMMAND_KEYS });
  const timerOf = registerTimerRoutes({ route, store, timers, checkActions, pick, COMMAND_KEYS });

  // ---------- interactivos, chat y Meld: módulos propios (patrón de rutas por áreas, #71/#107/#119) ----------
  // Registra /api/chat* (anuncios incluidos), los interactivos (preguntas, tier lists,
  // votación y sorteo) y /api/meld*. Cada módulo se llama en el punto exacto donde
  // estaban sus rutas: los patrones son coincidencia exacta, así que el orden relativo
  // del resto de rutas se conserva. /api/chat/announce estaba antes de los interactivos
  // y las rutas de Meld después de las de sesión: el orden de resolución no cambia.
  registerChatRoutes({ route, store, engine, twitch, youtube, chat, id8 });
  registerInteractiveRoutes({ route, store, interactive });
  registerViewersRoutes({ route, store, viewers });
  registerTeleprompterRoutes({ route, teleprompter });
  registerInterviewRoutes({ route, interviews });
  registerCustomOverlayRoutes({ route, customOverlays, bus, engine, checkActions, log });
  // Apariencia: tema de todo lo que sale en pantalla (overlay, widgets y créditos)
  const themeRoutes = registerThemeRoutes({ route, store, listMedia, onChange: () => {},   // el aviso sale de store 'change' (también vale para cambiar_config)
    onDraft: t => bus.send('theme', t, ['overlay', 'preview', 'widget']) });


  // ---------- archivos: módulo propio (patrón de rutas por áreas, #71/#107) ----------
  // Registra /api/media, /api/media/delete y /api/media/import (con la validación de
  // origen de #58). La subida por cuerpo (/api/media/upload) sigue en el dispatcher de
  // abajo porque el cuerpo es el propio archivo. El orden de registro se conserva.
  registerMediaRoutes({ route, store, mediaDir, listMedia, MAX_UPLOAD });

  // chat

  // widgets y objetivos
  registerWidgetRoutes({ route, store, engine });
  // widgets y objetivos (#128: rutas de cajas/barras en módulo propio, mismo punto y orden)
  registerChatVariantsRoutes({ route, store });
  registerGoalsRoutes({ route, store, session, id8 });
  registerFollowersRoutes({ route, followers, thanksSelection });
  registerCreditsRoutes({ route, bus });

  // ---------- sesión y cronología: módulo propio (patrón de rutas por áreas, #71/#107) ----------
  // Registra /api/session*, /api/sessions, /api/timeline* y /api/markers. Los patrones
  // del dispatcher son coincidencia exacta, así que reunir aquí las rutas de sesión y
  // cronología (antes separadas por los bloques de Meld y conexiones) no cambia ninguna
  // resolución; el orden relativo del resto se conserva.
  registerSessionRoutes({ route, session, timelinePayload, addMarker, endSession });
  registerMetricsRoutes({ route, session });

  // Meld
  registerMeldRoutes({ route, store, meld: program, scheduleLayerHide, recordingTimers });
  route('POST', '/api/actions/run', async ({ actions = [], vars = {} }) => { checkActions(actions); await engine.runActions(actions, vars); return { ok: true }; });

  // conexiones
  route('POST', '/api/twitch/connect', async () => ({ device: await twitch.startDeviceLogin() }));
  route('POST', '/api/twitch/disconnect', async () => { await twitch.stop({ forget: true }); chat.stop(); return { ok: true }; });
  route('POST', '/api/twitch/restart', async () => { await twitch.stop(); await twitch.start(); return { ok: true }; });
  route('POST', '/api/youtube/start', async ({ video } = {}) => { await youtube.start(video); return youtube.status; });
  route('POST', '/api/youtube/stop', async () => { await youtube.stop(); return { ok: true }; });
  // tu cuenta de YouTube (para escribir): Google vuelve a /oauth/youtube en este mismo servidor
  route('POST', '/api/youtube/auth', async (_, __, _url, req) => ({ url: youtube.authUrl(`http://127.0.0.1:${req.socket.localPort}/oauth/youtube`) }));
  route('POST', '/api/youtube/logout', async () => { await youtube.logout(); return youtube.status; });

  // ---------- prompter ----------
  route('GET', '/api/prompter', async () => ({ ...prompter, tabs: PROMPTER_TABS, config: store.config.prompter }));
  route('POST', '/api/prompter', async ({ tab }) => setPrompterTab(tab));

  // ---------- atajos y fuentes: módulo propio (patrón de rutas por áreas, #71) ----------
  // Registra /api/sources, /api/shortcuts* y /sd/*. Se llama en el punto exacto donde
  // estaban esas rutas: el orden de registro importa (ver cabecera de src/routes/shortcuts.mjs).
  registerShortcutRoutes({ route, store, engine, session, interactive, bus, setPrompterTab, addMarker, checkActions, PROMPTER_TABS, teleprompter, interviews });

  // ---------- apagado ordenado (lo usa la app de escritorio al cerrar) ----------
  route('POST', '/api/shutdown', async (_, __, ___, req) => {
    if (!isLoopback(req.socket.remoteAddress || '')) throw httpError(403, 'Solo desde este PC');
    if (typeof app.requestShutdown !== 'function') throw httpError(409, 'Este proceso no se puede apagar desde la API');
    setTimeout(() => app.requestShutdown(), 50).unref?.();
    return { ok: true };
  });

  // prueba de compatibilidad (/probe): qué permite el navegador donde se abre (dock de Meld, ventana de Chrome…)
  // #62: tamaño máximo y esquema mínimo (solo pares texto/número/booleano/nulo).
  const PROBE_MAX_BYTES = 64 * 1024;
  route('POST', '/api/probe', async report => {
    if (JSON.stringify(report ?? null).length > PROBE_MAX_BYTES) throw httpError(413, 'Informe demasiado grande');
    if (typeof report !== 'object' || report === null || Array.isArray(report)) throw httpError(400, 'El informe debe ser un objeto de campos simples');
    if (report.id !== undefined && typeof report.id !== 'string') throw httpError(400, 'El campo id debe ser texto');
    const entries = Object.entries(report);
    if (entries.length > 50) throw httpError(400, 'El informe tiene demasiados campos');
    for (const [k, v] of entries) {
      if (k.length > 60) throw httpError(400, 'Campo demasiado largo');
      const simple = v === null || typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 1000);
      if (!simple) throw httpError(400, 'El informe debe ser un objeto de campos simples');
    }
    const file = path.join(store.dir, 'probe.json');
    let all = {};
    try { all = JSON.parse(await readFile(file, 'utf8')); } catch {}
    const id = String(report?.id || 'sin-id').slice(0, 40);
    all[id] = { ...report, savedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(all, null, 2));
    return { ok: true };
  });

  // acceso desde el móvil
  route('GET', '/api/access', async () => accessInfo());
  route('POST', '/api/access', async ({ lan, regenerate }) => {
    const patch = {};
    if (lan !== undefined) patch.lan = !!lan;
    if (regenerate) patch.key = randomBytes(9).toString('base64url');
    await store.patchConfig({ access: patch });
    app.emit?.('relisten');
    return accessInfo();
  });

  function accessInfo() {
    const port = app.port || store.config.port;
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    return { lan: !!store.config.access.lan, key: store.config.access.key, urls: ips.map(ip => `http://${ip}:${port}/?key=${store.config.access.key}`) };
  }

  function afterConfig(patch) {
    if (store.config.program.kind !== selectedProgram) {
      program.stop();
      selectedProgram = store.config.program.kind;
      updateMeterInterest();
      program.select(selectedProgram === 'obs' ? obs : meld);
      if (selectedProgram === 'obs') program.start(store.config.obs.url);
      else if (store.config.meld.enabled) program.start(store.config.meld.url);
    } else if (selectedProgram === 'obs' && patch.obs) {
      program.stop(); program.start(store.config.obs.url);
    } else if (selectedProgram === 'meld' && patch.meld) {
      if (store.config.meld.enabled) { program.stop(); program.start(store.config.meld.url); } else program.stop();
    }
    if (patch.chat && store.config.chat.twitchChannel) chat.join(store.config.chat.twitchChannel);
    if (patch.paused !== undefined) engine.pushPause();
    // A config import may replace the interviews and the active item.
    if (patch.interviews) { bus.send('interview', { item: interviews.activeItem() }, ['widget']); bus.send('interviewControl', interviews.control(), ['panel']); }
    // Publish only after password changes have completed; publicConfig masks the value.
    if (patch.program || patch.obs) { includeProgramConfig = true; pushPanelConfig(); }
  }

  // ---------- subida de archivos (cuerpo = archivo; nombre en ?name=) ----------
  async function upload(req, url) {
    const name = cleanName(url.searchParams.get('name'));
    if (!name || !mediaKind(name)) throw httpError(400, 'Formato no admitido. Usa webm, mp4, gif, png, jpg, jpeg, webp, mp3, ogg, wav o una fuente (woff2, woff, ttf, otf).');
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD) throw httpError(413, 'El archivo pasa de 300 MB.');
    const final = await freeName(mediaDir, name);
    const tmp = final + '.part';
    let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_UPLOAD) req.destroy(new Error('too big')); });
    try {
      await pipeline(req, createWriteStream(tmp));
      await rename(tmp, final);
    } catch {
      await unlink(tmp).catch(() => {});
      throw httpError(400, 'No se pudo guardar el archivo.');
    }
    return { name: path.basename(final), media: await listMedia() };
  }

  // ---------- overlays propios: shell de confianza y marco en origen opaco (S5) ----------
  // /custom/<id> sirve la shell (mismo origen: mantiene el SSE) y /custom/<id>/frame el HTML/CSS/JS
  // del usuario con `Content-Security-Policy: sandbox allow-scripts`: aunque se abra directamente,
  // no tiene nuestro origen, así que no puede leer ni cambiar la API. Un id raro o desconocido
  // responde el mismo 404 JSON que el resto de páginas.
  const serveCustomOverlay = (res, rawId, frame) => {
    let id;
    try {
      id = decodeURIComponent(rawId);
      if (!CUSTOM_OVERLAY_ID.test(id)) throw httpError(404, 'No encontrado');
    } catch { return json(res, 404, { error: 'No encontrado' }); }
    const overlay = customOverlays.list().find(o => o.id === id);
    if (!overlay) return json(res, 404, { error: 'No encontrado' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(frame ? { 'Content-Security-Policy': FRAME_CSP } : {}),
    });
    res.end(frame ? frameHtml(overlay) : shellHtml(overlay));
  };

  // ---------- acceso: en local todo; desde la red, con la clave ----------
  // Comparación en tiempo constante (issue #59): no filtra la longitud por el
  // camino corto de ===; distinta longitud falla sin revelar cuánto coincidió.
  function keyMatches(provided, expected) {
    if (expected === '') return false;
    try {
      const a = Buffer.from(String(provided ?? ''));
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  }

  function authorized(req, url, res) {
    const ip = req.socket.remoteAddress || '';
    if (/^(127\.|::1$|::ffff:127\.)/.test(ip)) return true;
    if (!store.config.access.lan) return false;
    const key = store.config.access.key;
    const cookie = /(?:^|;\s*)egk=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (keyMatches(cookie, key) || keyMatches(req.headers['x-egdev-key'], key)) return true;
    if (keyMatches(url.searchParams.get('key'), key)) {
      // Cookie HttpOnly (issue #59): el JS de la página no necesita la clave.
      res.setHeader('Set-Cookie', `egk=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
      // Canje: en las páginas se redirige a la misma URL sin la clave; en la API
      // se responde normal (el móvil ya lleva la cookie a partir de ahora).
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/sd/')) {
        const clean = new URL(url);
        clean.searchParams.delete('key');
        res.statusCode = 302;
        res.setHeader('Location', clean.pathname + clean.search);
        res.end();
        return 'redirect';
      }
      return true;
    }
    return false;
  }

  // ---------- admisión HTTP ----------
  // stopAdmission conserva una única promesa de idle para llamadas repetidas y rechaza peticiones
  // nuevas antes de leer cuerpo o emitir cookie. Solo el coordinador puede abrir la excepción ACK:
  // valida pendientes de su generación; al sellarla, espera un idle fresco de handlers admitidos.
  let closing = false;
  let activeHandlers = 0;
  let idlePromise = null;
  let idleWaiters = [];
  // Promesa SIEMPRE nueva que resuelve cuando no queda ningún handler admitido. El idle cacheado
  // de `stopAdmission` no sirve para ACKs admitidos después de que ya hubiera resuelto.
  const whenIdle = () => new Promise(resolve => {
    if (activeHandlers === 0) { resolve(); return; }
    idleWaiters.push(resolve);
  });
  // pings SSE propios: se limpian al cerrar la respuesta y al cerrar el transporte HTTP
  const ssePings = new Set();
  const stopAdmission = () => {
    closing = true;
    if (!idlePromise) idlePromise = whenIdle();
    return idlePromise;
  };

  // ---------- ventana de ACK de cierre ----------
  // Solo el coordinador de parada la abre. El corte ordinario (`stopAdmission`) NO la abre: fuera
  // de la parada, la ruta ACK conserva su comportamiento HTTP ordinario.
  let ackPhase = 'closed';
  let ackCapsule = null;
  let ackSealed = false;
  const ackWindowActive = () => ackPhase === 'open' || ackPhase === 'captured';
  const ackAdmits = id => {
    if (!closing) return true;                              // operación normal intacta
    if (ackPhase === 'open') return engine.hasPendingAck(id);
    if (ackPhase === 'captured') return !!ackCapsule?.isCurrent(id);
    return false;                                           // cerrado antes de persistir
  };
  const beginAckWindow = () => { if (!ackSealed && ackPhase === 'closed') ackPhase = 'open'; return ackPhase; };
  const captureAckWindow = () => {
    if (ackPhase === 'open') { ackCapsule = engine.capturePendingAcks(); ackPhase = 'captured'; }
    return ackCapsule;
  };
  const closeAckWindow = () => { ackPhase = 'closed'; ackCapsule = null; ackSealed = true; return ackPhase; };
  const ackWindowPhase = () => ackPhase;

  // Ambos transportes comparten el alta, las instantáneas y la limpieza del ping.
  const stream = (res, url) => {
    const c = url.searchParams.get('client');
    const kind = ['panel', 'preview', 'widget', 'teleprompter', 'dock-meters'].includes(c) ? c : 'overlay';
    bus.addClient(res, kind);
    if (kind === 'dock-meters') {
      meterWatchers.add(res);
      updateMeterInterest();
      res.on('close', () => { meterWatchers.delete(res); updateMeterInterest(); });
    }
    res.on('close', pushStatus);
    const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
    const pingEntry = { res, timer: ping };
    ssePings.add(pingEntry);
    res.on('close', () => { clearInterval(ping); ssePings.delete(pingEntry); });
    if (kind === 'panel') res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    if (kind === 'widget') res.write(`event: widgets\ndata: ${JSON.stringify(engine.widgetState())}\n\n`);
    if (kind === 'widget') res.write(`event: interactive\ndata: ${JSON.stringify(interactive.snapshot())}\n\n`);
    if (kind === 'widget') res.write(`event: interview\ndata: ${JSON.stringify({ item: interviews.activeItem() })}\n\n`);
    // Espectadores: solo las cifras públicas, para los widgets y los overlays propios que cargan tarde (S6).
    if (kind === 'widget') res.write(`event: viewers\ndata: ${JSON.stringify(publicViewers(viewers.snapshot()))}\n\n`);
    // Versiones de los overlays propios: la shell recarga su iframe al cambiar la suya.
    if (kind === 'widget') res.write(`event: customOverlayVersions\ndata: ${JSON.stringify(customOverlays.versions())}\n\n`);
    if (kind === 'teleprompter') res.write(`event: teleprompter\ndata: ${JSON.stringify(teleprompter.snapshot())}\n\n`);
    if (kind === 'overlay') res.write(`event: pause\ndata: ${JSON.stringify(engine.pauseState())}\n\n`);
    if (kind !== 'panel' && kind !== 'dock-meters') {
      const d = url.searchParams.has('themeDraft') ? themeRoutes.getDraft() : null;
      res.write(`event: theme\ndata: ${JSON.stringify(d ? { ...publicTheme(d), draft: true } : publicTheme(store.config.theme))}\n\n`);
    }
    pushStatus();
  };

  const reportServerError = err => {
    // El cierre esperado también se registra, pero no es un fallo del drenaje del servidor.
    const label = (err?.message || err) === CLOSING_MESSAGE ? '[cierre]' : '[error]';
    try { log(label, err); } catch { /* El registro no impide responder. */ }
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/media/')) res.setHeader('Content-Security-Policy', MEDIA_CSP);
    if (closing) {
      // La ventana ACK solo deja pasar la ruta exacta POST /api/overlay/shown en open/captured.
      let allowed = false;
      if (ackWindowActive() && req.method === 'POST') {
        try { allowed = new URL(req.url, 'http://localhost').pathname === '/api/overlay/shown'; } catch { allowed = false; }
      }
      if (!allowed) { reportServerError(CLOSING_MESSAGE); return json(res, 503, { error: CLOSING_MESSAGE }); }
    }
    activeHandlers += 1;
    try {
      if (!hostTrusted(req)) return json(res, 403, { error: 'Host no permitido: usa localhost, 127.0.0.1 o la IP del panel.' });
      const isSd = url.pathname.startsWith('/sd/');
      const mutating = (req.method !== 'GET' && req.method !== 'HEAD') || isSd;
      if (mutating && !(isSd ? sdRequestAllowed(req) : originAllowed(req))) return json(res, 403, { error: 'Origen no permitido para acciones que cambian el directo.' });
      const auth = authorized(req, url, res);
      if (auth === 'redirect') return; // canje de clave: ya respondimos con la redirección
      if (!auth) return json(res, 401, { error: 'Acceso desde la red: abre el enlace con la clave que aparece en el panel (General › Acceso desde el móvil).' });
      if (req.method === 'POST' && url.pathname === '/api/media/import' && !isLoopback(req.socket.remoteAddress || '')) {
        throw httpError(403, 'Solo desde este PC');
      }
      if (url.pathname === '/oauth/youtube') {
        let html;
        try {
          if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error') === 'access_denied' ? 'Has cancelado el permiso.' : url.searchParams.get('error'));
          const ch = await youtube.finishAuth(url.searchParams.get('code'), url.searchParams.get('state'));
          html = `<h1>YouTube conectado</h1><p>${ch ? 'Cuenta: <b>' + escapeHtml(ch) + '</b>. ' : ''}Ya puedes cerrar esta pestaña y volver a antena.</p>`;
        } catch (e) { html = `<h1>No se pudo conectar</h1><p>${escapeHtml(e.message)}</p>`; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>antena · YouTube</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#141518;color:#fff;font:16px system-ui;text-align:center">${html}</body>`);
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        stream(res, url);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/media/upload') return json(res, 200, await withMediaLock(() => upload(req, url)));
      if (req.method === 'GET' && url.pathname === '/api/config/export') {
        const file = configTransfer.exportFile();
        // #223: past streams carry chat names and messages, so they are opt-in.
        const exportOptions = { sessions: url.searchParams.get('sessions') === '1' };
        if (url.searchParams.get('skipped') === '1') {
          res.setHeader('Cache-Control', 'no-store');
          return json(res, 200, { skipped: await configTransfer.exportSkipped(file, exportOptions) });
        }
        if (url.searchParams.get('format') !== 'json') return await configTransfer.exportZip(res, file, exportOptions);
        res.setHeader('Content-Disposition', `attachment; filename="antena-config-${file.exportedAt.slice(0, 10)}.json"`);
        res.setHeader('Cache-Control', 'no-store');
        return json(res, 200, file);
      }
      if (url.pathname === '/theme.css') {
        res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-store' });
        return res.end(themeCss((url.searchParams.has('draft') && themeRoutes.getDraft()) || store.config.theme));
      }
      if (url.pathname === '/api/session/summary.md') {
        const d = await session.get(url.searchParams.get('id'));
        res.writeHead(200, { 'Content-Type': MIME['.md'], 'Content-Disposition': `inline; filename="directo-${d.id}.md"` });
        return res.end(session.summaryMarkdown(d));
      }
      for (const r of R) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        // A portable config includes up to 2.5M overlay characters plus scripts and other sections.
        // Allow 8M JSON characters here only; existing routes retain their 2M limit.
        const transfer = req.method === 'POST' && (url.pathname === '/api/config/import' || url.pathname === '/api/config/import/preview');
        if (transfer && /^application\/zip(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          const applying = url.pathname === '/api/config/import', run = () => configTransfer.importZip(req, applying);
          return json(res, 200, await (applying ? withMediaLock(run) : run()));
        }
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, url.pathname === '/api/meld/stream' || url.pathname === '/api/program/stream', transfer ? 8e6 : 2e6) : {};
        // rutas con parámetros: fn(params, body, url) · sin parámetros: fn(body, _, url)
        const mediaWrite = req.method === 'POST' && ['/api/media/import', '/api/media/delete'].includes(url.pathname);
        if (mediaWrite) return json(res, 200, await withMediaLock(() => r.fn(body, null, url, req)));
        return json(res, 200, await (m.groups ? r.fn(m.groups, body, url, req) : r.fn(body, null, url, req)));
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No existe' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido' });
      if (url.pathname.startsWith('/media/')) return serveFile(req, res, mediaDir, url.pathname.slice('/media/'.length));
      const w = /^\/widget\/(\w+)$/.exec(url.pathname);
      if (w && WIDGETS.includes(w[1])) return serveFile(req, res, PUBLIC, `widgets/${w[1]}.html`);
      // Overlays propios (S5): la shell es nuestra y el marco es del usuario, en origen opaco.
      // El SDK va antes para que la ruta de overlays no se coma /custom/sdk.js (no es un id válido).
      if (url.pathname === '/custom/sdk.js') return serveFile(req, res, PUBLIC, 'custom/sdk.js');
      const custom = /^\/custom\/([^/]+)(\/frame)?$/.exec(url.pathname);
      if (custom) return serveCustomOverlay(res, custom[1], !!custom[2]);
      if (useApp && APP_PAGES[url.pathname]) return serveFile(req, res, dist, APP_PAGES[url.pathname]);
      if (useApp && url.pathname.startsWith('/assets/')) return serveFile(req, res, dist, url.pathname.slice(1));
      if (url.pathname === '/' || url.pathname === '/prompter' || url.pathname === '/dock') return serveFile(req, res, PUBLIC, 'index.html');
      const page = { '/overlay': 'overlay.html', '/probe': 'probe.html' }[url.pathname] || url.pathname.slice(1);
      return serveFile(req, res, PUBLIC, page);
    } catch (err) {
      const status = err?.status || 500;
      if (status >= 500) reportServerError(err);
      if (!res.headersSent) {
        try { json(res, status, { error: status >= 500 ? publicMessage(err) : err.message }); } catch { /* la conexión pudo cerrarse antes de responder */ }
      }
    } finally {
      activeHandlers -= 1;
      if (activeHandlers === 0 && idleWaiters.length) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const done of waiters) done();
      }
    }
  });

  // sockets crudos/idle propios: closeAllConnections no cubre siempre conexiones sin petición
  const sockets = new Set(), upgraded = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const closeUpgradedConnections = () => { for (const socket of upgraded) socket.destroy(); };
  // Node's HTTP close/closeAllConnections do not include upgraded sockets; close them
  // as the listener stops, rather than waiting for its 'close' event (which needs them gone).
  const closeServer = server.close;
  server.close = function (...args) {
    const result = closeServer.apply(this, args);
    closeUpgradedConnections();
    return result;
  };
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* el cliente puede irse antes de completar el upgrade */ });
    const reject = (code, message) => {
      if (code >= 500) reportServerError(message);
      const body = JSON.stringify({ error: message });
      let media = false;
      try { media = new URL(req.url, 'http://localhost').pathname.startsWith('/media/'); } catch { /* ruta inválida */ }
      const csp = media ? `Content-Security-Policy: ${MEDIA_CSP}\r\n` : '';
      socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nContent-Type: application/json; charset=utf-8\r\n${csp}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`, () => socket.destroy());
    };
    if (closing || !server.listening) return reject(503, CLOSING_MESSAGE);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return reject(400, 'Petición no válida'); }
    // Evita que authorized intente redirigir una página sobre el socket del upgrade.
    if (url.pathname !== '/api/stream') return reject(404, 'No existe');
    if (!hostTrusted(req)) return reject(403, 'Host no permitido: usa localhost, 127.0.0.1 o la IP del panel.');
    // WebSocket no tiene CORS: el origen debe coincidir con el host y puerto HTTP reales.
    if (req.headers.origin !== undefined) {
      try {
        const origin = new URL(req.headers.origin);
        const expected = new URL(`http://${req.headers.host || ''}`);
        if (origin.protocol !== 'http:' || origin.hostname !== expected.hostname || (origin.port || '80') !== (expected.port || '80') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
      } catch { return reject(403, 'Origen no permitido'); }
    }
    const headers = {};
    if (!authorized(req, url, { setHeader: (name, value) => { headers[name] = value; } })) return reject(401, 'Acceso desde la red: abre el enlace con la clave que aparece en el panel (General › Acceso desde el móvil).');
    if (req.method !== 'GET') return reject(405, 'Método no permitido');
    const res = acceptWebSocket(req, socket, head, headers);
    if (!res) return;
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    res.write('retry: 2000\n\n');
    stream(res, url);
  });

  // ---------- cierre del transporte HTTP ----------
  // Corta la admisión de forma síncrona (igual que stopAdmission), espera a los handlers ya
  // admitidos y DESPUÉS cierra listener, sockets idle/keepalive y pings SSE. Devuelve la MISMA
  // promesa en llamadas repetidas, incluso si rechaza. No reclama app.close global, productores
  // ni MCP: esa propiedad sigue siendo 08b.2b/08c.
  let httpClosePromise = null;
  const isHttpClosing = () => closing;
  const closeHttp = () => {
    if (httpClosePromise) return httpClosePromise;
    let idle, pushClose;
    try {
      pushClose = pushExport.close(); // finish accepted queue writes, never wait for network retries
      closeAckWindow();          // terminal: la ventana no revive
      stopAdmission();
      idle = whenIdle();         // idle fresca: incluye handlers ACK admitidos en la ventana
    } catch (err) { httpClosePromise = Promise.reject(err); return httpClosePromise; }
    httpClosePromise = Promise.all([idle, pushClose]).then(() => new Promise((resolve, reject) => {
      try {
        for (const { timer } of ssePings) clearInterval(timer);
        ssePings.clear();
        let done = false;
        const finish = err => {
          if (done) return;
          done = true;
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
          else resolve();
        };
        // listener primero para no aceptar conexiones; si ya cerró o nunca escuchó, el callback
        // llega con ERR_SERVER_NOT_RUNNING y se acepta como cierre correcto (relisten encolado).
        server.close(finish);
        try { server.closeAllConnections(); } catch { /* versión sin el método: bastan los sockets */ }
        for (const socket of sockets) { try { socket.destroy(); } catch { /* ya cerrado */ } }
      } catch (err) { reject(err); }
    }));
    return httpClosePromise;
  };

  const app = { server, store, bus, twitch, youtube, chat, meld, program, session, engine, timers, interactive, viewers, channelTotals, followers, refreshFollowers, teleprompter, interviews, customOverlays, mediaDir, port: null, stopAdmission, closeHttp, isHttpClosing, closeUpgradedConnections, beginAckWindow, captureAckWindow, closeAckWindow, ackWindowPhase, waitIdle: whenIdle, beginLayerHideDrain, drainLayerHides, beginAutoSessionDrain, drainAutoSession, drainChatMetrics };
  return app;
}

// Archivos estáticos con soporte de Range (los vídeos lo necesitan para leer la duración y saltar).
async function serveFile(req, res, dir, rel) {
  let file;
  try { file = safePath(dir, rel); } catch (e) { return json(res, 403, { error: e.message }); }
  let st;
  try { st = await stat(file); if (!st.isFile()) throw 0; } catch { return json(res, 404, { error: 'No encontrado' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'X-Content-Type-Options': 'nosniff' }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data ?? null));
}

function readBody(req, retainRaw = false, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let raw = '', done = false;
    // Preserve split UTF-8 characters in the larger portable config body.
    if (limit > 2e6) req.setEncoding('utf8');
    // El cierre/interrupción del socket también finaliza: nunca deja la promesa colgada ni el
    // contador de handlers sin bajar. El motivo es constante y no expone error crudo ni stack.
    const fail = () => { if (done) return; done = true; reject(httpError(400, 'Petición interrumpida')); };
    req.on('data', c => {
      if (done) return;
      raw += c;
      if (raw.length <= limit) return;
      // Existing routes keep their previous behavior (connection reset); only the larger
      // portable-config limit answers with a readable 413.
      if (limit <= 2e6) { req.destroy(); return; }
      done = true; raw = ''; reject(httpError(413, 'El cuerpo de la petición es demasiado grande')); req.resume();
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (retainRaw) req.rawBody = raw;
        resolve(body);
      } catch { reject(httpError(400, 'JSON no válido')); }
    });
    req.on('error', fail);
    req.on('aborted', fail);
    req.on('close', fail);
  });
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Arranca el servidor (lo usan `pnpm start` y el MCP cuando no hay ninguno en marcha). */
export async function startServer({ log = console.log, quiet = false, shutdownTimeoutMs = 5000, handleSignals = true, heldRecoveryWindows, heldRecoveryIO, followersDelayMs = 3000,
  // Test seam for the one global shutdown deadline; all other timers remain real.
  shutdownDeadlineTimers = { setTimeout, clearTimeout } } = {}) {
  const app = await createApp({ log, heldRecoveryWindows, heldRecoveryIO });
  // Precedencia del puerto (documentada aquí, es el sitio de referencia):
  // - Servidor (aquí): PORT del entorno, luego "port" de data/config.json, luego 4500.
  // - MCP (src/mcp.mjs): "port" del config.json de ANTENA_DATA o ./data, luego 4500;
  //   si ANTENA_URL está definida, se usa esa URL tal cual sin resolver puerto.
  // - App de escritorio (src-tauri/src/main.rs, read_port): ANTENA_PORT, luego "port"
  //   del config.json de la carpeta de datos que va a usar el servidor, luego 4500.
  // El resultado debe coincidir entre los tres: el servidor es quien publica el puerto real.
  const port = Number(process.env.PORT) || app.store.config.port || 4500;
  app.port = port;
  const listen = () => new Promise((resolve, reject) => {
    // tras closeHttp el listener no puede resucitar ni desde una llamada ya encolada
    if (app.isHttpClosing()) return resolve(null);
    const host = app.store.config.access.lan ? '0.0.0.0' : '127.0.0.1';
    let settled = false;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      app.server.off('error', onError);
      app.server.off('listening', onListening);
      app.server.off('close', onClose);
      if (err) reject(err); else resolve(value);
    };
    const onError = err => settle(err);
    const onListening = () => settle(null, app.isHttpClosing() ? null : host);
    const onClose = () => settle(null, null);  // Node cancela el bind sin emitir listening.
    try {
      app.server.once('error', onError);
      app.server.once('close', onClose);
      app.server.listen(port, host, onListening);
    } catch (err) { settle(err); }
  });
  const host = await listen();
  app.emit = (ev) => {
    if (ev !== 'relisten' || app.isHttpClosing()) return;
    const want = app.store.config.access.lan ? '0.0.0.0' : '127.0.0.1';
    if (app.server.address()?.address === want) return;
    app.server.closeAllConnections();
    app.closeUpgradedConnections();
    app.server.close(() => {
      if (app.isHttpClosing()) return;
      listen().then(h => {
        if (h && !app.isHttpClosing()) {
          try { log(`[acceso] escuchando en ${h}:${port}`); } catch { /* aviso no esencial */ }
        }
      }, () => {
        try { log('[acceso] No se pudo volver a escuchar.'); } catch { /* no crear otro rechazo */ }
      });
    });
  };
  if (!quiet) {
    log(`\n  antena en marcha${host === '0.0.0.0' ? ' (también desde la red local)' : ''}`);
    log(`  Panel:   http://127.0.0.1:${port}/`);
    log(`  Overlay: http://127.0.0.1:${port}/overlay   ← añádelo como fuente de navegador en tu programa de emisión`);
    log(`  Widgets: http://127.0.0.1:${port}/widget/{chat,goal,latest,ticker,credits}`);
    log(`  Prompter: http://127.0.0.1:${port}/prompter`);
    log(`  Media:   ${app.mediaDir}\n`);
  }
  app.twitch.start();
  app.timers.start();
  app.viewers.start();
  app.channelTotals.start();
  // #128: first sync shortly after startup, like the first channel-total read (cancelled by halt)
  app.followersStartup = setTimeout(() => { app.refreshFollowers('twitch'); app.refreshFollowers('youtube'); }, followersDelayMs);
  app.followersStartup.unref?.();
  if (app.store.config.chat.twitchChannel) app.chat.join(app.store.config.chat.twitchChannel);
  if (app.store.config.program.kind === 'obs') app.program.start(app.store.config.obs.url);
  else if (app.store.config.meld.enabled) app.program.start(app.store.config.meld.url);
  const onUnhandledRejection = e => log('[error]', e?.message || e);
  process.on('unhandledRejection', onUnhandledRejection);
  // Parada acotada: el primer cierre corta admisión HTTP general y abre solo continuaciones ACK.
  // Tras handlers admitidos, EventSub, Device Flow, IRC, Timers y productor YouTube, drena ambos snapshots
  // de Engine. Sella ACK y espera su idle fresco ANTES de capturar Store y flushar Session/Interactive.
  // Auth/envíos independientes y EOF de MCP siguen fuera: no es cierre global.
  // Después de persistir se cierra el transporte HTTP con el deadline todavía activo. Las señales
  // repetidas comparten una transición y un flush; cualquier fallo capturado, dirty o pending sale 1.
  // El timeout conserva aviso constante, sin rutas ni valores; un log que lance no tumba la parada.
  const safeLog = msg => { try { log(msg); } catch { /* el aviso nunca debe tumbar la parada */ } };
  // Un throw SÍNCRONO de un drenaje no debe impedir el intento del otro.
  const attemptDrain = fn => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
  // Internal trust inputs only: Windows callers must provision trusted systemRoot and an
  // existing PRIVATE tempDir. No ambient TEMP/process.env fallback. Native bootstrap and
  // ACL/deadline validation remain pending. Boot discovery reports missing inputs;
  // lazy SAVE creation keeps an empty held shutdown usable without claiming Windows support.
  app.heldRecoveryState = { state: 'idle' };
  app.captureHeldRecovery = () => createHeldRecovery({
    dir: app.store.dir, maxAlertBytes: HELD_MAX_ALERT_BYTES, maxBatchBytes: HELD_MAX_BATCH_BYTES,
    windows: heldRecoveryWindows, io: app.recoveryIO,
  }).save(app.engine.held); // consumer clones the COMPLETE snapshot synchronously before its first await
  const recoveryResult = state => {
    app.heldRecoveryState = { state }; // internal status only; no payload/HTTP/MCP/replay
    safeLog({
      preserved: '[parada] Alertas retenidas preservadas.',
      'preserved-cleanup-pending': '[parada] Alertas retenidas preservadas; limpieza pendiente.',
      unknown: '[parada] Conservación de alertas retenidas incierta.',
      failed: '[parada] No se pudieron preservar las alertas retenidas.',
    }[state]);
  };
  const recoveryFailure = error => {
    try {
      // Only unlink follows ALL successful verifications. Publication alone proves nothing.
      if (error?.publication === 'published' && error?.phase === 'unlink') return 'preserved-cleanup-pending';
      if (error?.publication === 'published' || error?.publication === 'unknown') return 'unknown';
    } catch { /* Untrusted error properties are never diagnostics. */ }
    return 'failed';
  };
  let heldNoticed = false;
  const noticeHeld = () => {
    if (heldNoticed) return;
    heldNoticed = true;
    try { process.stderr.write('[parada] alertas retenidas\n'); } catch { /* aviso constante */ }
  };
  let closePromise, resolveClose;
  const beginClose = () => {
    let deadline;
    const finish = code => {
      shutdownDeadlineTimers.clearTimeout(deadline);
      process.removeListener('unhandledRejection', onUnhandledRejection);
      resolveClose(code);
    };
    try {
      deadline = shutdownDeadlineTimers.setTimeout(() => { safeLog('[parada] drenado agotado'); process.exit(1); }, shutdownTimeoutMs);
      // Timers fallido no debe saltar el corte de Engine ni la persistencia independiente.
      let timersFailed = false;
      let youtubeFailed = false;
      // EventSub fallido no debe saltar los cortes posteriores ni la persistencia independiente.
      let eventSubFailed = false;
      // Captura la cola de Store vigente y flusha Session/Interactive; el fallo de Engine ya
      // observado se agrega al código. La persistencia se decide ANTES de cerrar el transporte.
      const unsaved = () => {
        try {
          const state = app.store.persistenceState();
          return state.dirty.config || state.dirty.secrets || state.pending.config > 0 || state.pending.secrets > 0;
        } catch { return true; }
      };
      const drain = engineFailed => {
        // FINAL held capture, after every drain (including Meld), before final persistence.
        // No clearing, dispatch, config reconstruction, retry, or deadline reset. A deadline
        // may interrupt publication and leave ambiguous files for manual disposition.
        let heldFailed = false, journal = Promise.resolve();
        try {
          if (app.engine.held.length > 0) {
            heldFailed = true; noticeHeld();
            app.heldRecoveryState = { state: 'saving' };
            journal = attemptDrain(() => app.captureHeldRecovery()).then(
              () => recoveryResult('preserved'),
              error => recoveryResult(recoveryFailure(error))
            );
          }
        } catch { heldFailed = true; recoveryResult('failed'); }
        let queued;
        try { queued = app.store.chain; } catch { queued = Promise.reject(new Error('Store unavailable')); }
        const sessionFlush = () => Promise.resolve().then(() => app.session.flush());
        const interactiveFlush = () => Promise.resolve().then(() => app.interactive.flush());
        const totalsFlush = () => Promise.resolve().then(() => app.channelTotals.flush());   // #132: correcciones y último total
        const followersFlush = () => Promise.resolve().then(() => app.followers.flush());
        // Start all independent attempts NOW: a failed/hung journal never gates either flush.
        Promise.allSettled([journal, queued, sessionFlush(), interactiveFlush(), totalsFlush(), followersFlush()]).then(results => {
          let code = engineFailed || heldFailed || results.some(r => r.status === 'rejected') || unsaved() ? 1 : 0;
          // La persistencia ya está decidida; ahora sí, con el deadline todavía ACTIVO, se cierra el
          // transporte HTTP real. Un cierre HTTP fallido o colgado también sale 1.
          let httpClose;
          try { httpClose = Promise.resolve(app.closeHttp()); }
          catch { code = 1; httpClose = Promise.resolve(); }
          // Trabajo tardío (S13): una escritura encolada tras la comprobación anterior y aún sin
          // guardar al salir no se pierde en silencio con 0.
          httpClose.then(
            () => { finish(code || (unsaved() ? 1 : 0)); },
            () => { finish(1); }
          );
        }, () => { finish(1); });
      };
      // Corte final de Engine: captura SÍNCRONA de la generación pendiente y AMBOS drenajes
      // públicos; un throw/rechazo de uno no impide el intento del otro (allSettled). Solo después
      // se cierra la ventana ACK y se espera el idle FRESCO de los handlers ACK admitidos.
      const engineCut = () => {
        let drains;
        try {
          app.captureAckWindow();
          const first = attemptDrain(() => app.engine.drainActions());
          const second = attemptDrain(() => app.engine.drainSentActions());
          drains = Promise.allSettled([first, second]);
        } catch { finish(1); return; }
        drains.then(results => {
          const engineFailed = results.some(r => r.status === 'rejected');
          let windowIdle;
          try {
            app.closeAckWindow();
            windowIdle = Promise.resolve(app.waitIdle());
          } catch { finish(1); return; }
          windowIdle.then(() => {
            // Solo held observado: no libera la pausa ni dispone de alertas; otros productores
            // aún pueden admitir continuaciones. La persistencia aceptada se drena incluso con fallo.
            let heldFailed = false;
            try {
              heldFailed = app.engine.pauseState().held > 0;
              if (heldFailed) noticeHeld();
            } catch { heldFailed = true; }
            // Ocultado diferido de capas: tras Engine/sorteos/auth y antes de Store. Un rechazo o
            // throw capturado sale 1 sin omitir la persistencia independiente ni otros ocultados.
            // Meld sigue disponible para las acciones anteriores. Su corte terminal espera RPC y
            // cierre físico bajo el mismo deadline; un fallo no omite la persistencia independiente.
            const meldCut = failed => {
              attemptDrain(() => app.program.quiesceClose()).then(
                () => { app.program.dispose(); drain(failed); },
                () => {
                  app.program.dispose();
                  safeLog('[parada] No se pudo cerrar el programa de emisión.');
                  drain(true);
                }
              );
            };
            const chatMetricsCut = failed => {
              attemptDrain(() => app.drainChatMetrics()).then(
                () => meldCut(failed),
                () => {
                  safeLog('[parada] No se pudieron completar las métricas del chat.');
                  meldCut(true);
                }
              );
            };
            const autoSessionCut = failed => {
              attemptDrain(() => app.drainAutoSession()).then(
                () => chatMetricsCut(failed),
                () => {
                  safeLog('[parada] No se pudo completar el inicio automático de sesión del programa de emisión.');
                  chatMetricsCut(true);
                }
              );
            };
            const layerCut = failed => {
              attemptDrain(() => app.drainLayerHides()).then(
                () => autoSessionCut(failed),
                () => {
                  safeLog('[parada] No se pudo completar el ocultado diferido de capas del programa de emisión.');
                  autoSessionCut(true);
                }
              );
            };
            // Snapshot auth después de sorteos y antes de capturar Store. No cierra admisión:
            // auth/envíos independientes de YouTube siguen fuera, no su productor ya drenado.
            const authCut = failed => {
              attemptDrain(() => app.twitch.drainAuth()).then(
                () => layerCut(failed),
                () => {
                  safeLog('[parada] No se pudo drenar la autenticación de Twitch.');
                  layerCut(true);
                }
              );
            };
            // Snapshot de chat tras sorteos y antes de capturar auth: espera confirmaciones y envíos
            // ya registrados sin sellar admisión. Un fallo es aviso constante, no un sorteo fallido.
            const chatCut = failed => {
              attemptDrain(() => app.interactive.drainChat()).then(
                () => authCut(failed),
                () => {
                  safeLog('[parada] No se pudieron completar los mensajes del chat.');
                  authCut(true);
                }
              );
            };
            // El deadline global sigue activo; ningún rechazo omite los flush independientes.
            attemptDrain(() => app.interactive.drainDraws()).then(
              () => chatCut(engineFailed || heldFailed || timersFailed || youtubeFailed || eventSubFailed),
              () => {
                safeLog('[parada] No se pudieron completar los sorteos.');
                chatCut(true);
              }
            );
          }, () => { finish(1); });
        }, () => { finish(1); });
      };
      // La respuesta YouTube pendiente aún puede emitir eventos/chat: esperar antes de
      // capturar Engine, manteniendo abierta la ventana ACK y el deadline global.
      const youtubeCut = () => {
        attemptDrain(() => app.youtube.quiescePoll()).then(engineCut, () => {
          youtubeFailed = true;
          safeLog('[parada] No se pudo cerrar YouTube.');
          engineCut();
        });
      };
      // La ventana ACK y la captura del ocultado diferido se abren SÍNCRONAMENTE, antes de esperar
      // la admisión: las tareas vivas en la primera señal quedan retenidas desde ya.
      // Conservar voto/plazo: suspender solo auto-cierre, antes de esperar continuaciones.
      try { app.interactive.quiesceVoteTimer(); } catch { finish(1); return; }
      // Récord de espectadores: sin más lecturas ni alertas al cerrar la app (#142).
      try { app.viewers.halt(); } catch { /* sin temporizadores vivos */ }
      try { app.channelTotals.halt(); } catch { /* sin temporizadores vivos */ }
      try { clearTimeout(app.followersStartup); app.followers.halt(); } catch { /* sin nuevas sincronizaciones */ }
      // teleprompter: sin temporizadores vivos más allá de su ancla programada
      try { app.teleprompter.stop(); } catch { /* sin temporizadores vivos */ }
      try { app.beginAckWindow(); } catch { finish(1); return; }
      try { app.beginLayerHideDrain(); } catch { finish(1); return; }
      try { app.beginAutoSessionDrain(); } catch { finish(1); return; }
      let idle;
      try { idle = Promise.resolve(app.stopAdmission()); }
      catch { finish(1); return; }
      // EventSub y después Device Flow (seams públicos dinámicos) antes de capturar Store.
      // Device Flow cancela esperas pero drena tokens/escrituras ya en vuelo; no corta HELIX-refresh
      // ni acciones salientes. Un rechazo o throw de EventSub sigue los cortes y persiste lo
      // aceptado, pero sale 1; el deadline sigue activo.
      idle.then(() => {
        const deviceCut = () => {
          let device;
          try { device = Promise.resolve(app.twitch.quiesceDeviceFlow()); }
          catch { finish(1); return; }
          device.then(() => {
            // IRC deja de admitir callbacks y cierra físicamente antes del flush.
            let chat;
            try { chat = Promise.resolve(app.chat.quiesceChat()); }
            catch { finish(1); return; }
            chat.then(() => {
              let timers;
              try { timers = Promise.resolve(app.timers.quiesceFires()); }
              catch { timersFailed = true; youtubeCut(); return; }
              timers.then(youtubeCut, () => { timersFailed = true; youtubeCut(); });
            }, () => { finish(1); });
          }, () => { finish(1); });
        };
        let q;
        try { q = Promise.resolve(app.twitch.quiesceEventSub()); }
        catch { eventSubFailed = true; deviceCut(); return; }
        q.then(deviceCut, () => { eventSubFailed = true; deviceCut(); });
      }, () => { finish(1); });
    } catch { finish(1); }
  };
  // Publicar la promesa ANTES del primer corte protege llamadas síncronas reentrantes.
  // API process-owned: completar devuelve código; agotar el plazo termina el proceso.
  app.close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise(resolve => { resolveClose = resolve; });
    beginClose();
    return closePromise;
  };
  let signalClosing = false;
  const shutdown = () => {
    if (signalClosing) return;
    signalClosing = true;
    app.close().then(code => process.exit(code));
  };
  // El MCP coordina sus solicitudes antes de cerrar la app; quiet no implica otro propietario.
  app.requestShutdown = shutdown;  // POST /api/shutdown (la app de escritorio cierra así, sin matar el proceso)
  if (handleSignals) { process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); }
  // #88: la app de escritorio mantiene la entrada estándar del sidecar abierta; si la app muere
  // de golpe (cuelgue, Administrador de tareas, recompilación del modo desarrollo), el sistema
  // cierra la tubería y ese fin de stdin provoca el mismo apagado ordenado que las señales.
  // Solo con ANTENA_DESKTOP=1 y stdin en tubería: `pnpm start` y el MCP no cambian.
  if (process.env.ANTENA_DESKTOP === '1' && process.stdin && process.stdin.readable && !process.stdin.isTTY) {
    process.stdin.on('error', () => { /* un error de la tubería no debe tumbar el servidor */ });
    process.stdin.resume(); // sin leer, el fin de la tubería no emite «end»
    const finDeEntrada = () => {
      if (signalClosing) return; // misma transición que las señales: un solo flush
      safeLog('[parada] la app de escritorio ya no está: fin de la entrada estándar.');
      shutdown();
    };
    process.stdin.on('end', finDeEntrada);
    process.stdin.on('close', finDeEntrada);
  }
  return app;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'server.mjs') await startServer();
