// antena: servidor local. Panel en /, overlay en /overlay y widgets en /widget/<nombre>.
// Todo lo que hace el panel pasa por esta API REST, que también usa el servidor MCP (src/mcp.mjs).
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readdir, stat, mkdir, unlink, rename, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Store, ROOT, deepMerge } from './store.mjs';
import { validatePatch, validatePath, warnUnknownKeys } from './config-schema.mjs';
import { Bus } from './bus.mjs';
import { acceptWebSocket } from './ws-stream.mjs';
import { Twitch } from './twitch.mjs';
import { YouTube } from './youtube.mjs';
import { RawEventLog } from './raw-events.mjs';
import { YouTubeAutoConnect } from './youtube-auto.mjs';
import { TwitchChat } from './chat.mjs';
import { Meld, MELD_COMMANDS, MELD_STREAM_EVENTS } from './meld.mjs';
import { Session, METRICS } from './session.mjs';
import { Engine, burstCoalesce, SNAPSHOT_COALESCE_MS, SNAPSHOT_MAX_WAIT_MS } from './engine.mjs';
import { createHeldRecovery } from './held-recovery.mjs';
import { registerShortcutRoutes, PROMPTER_LEGACY_TABS } from './routes/shortcuts.mjs';
import { registerSessionRoutes, TIMELINE_MAX } from './routes/sessions.mjs';
import { registerMediaRoutes } from './routes/media.mjs';
import { registerInteractiveRoutes } from './routes/interactive.mjs';
import { registerChatRoutes } from './routes/chat.mjs';
import { registerGoalsRoutes } from './routes/goals.mjs';
import { registerMeldRoutes } from './routes/meld.mjs';
import { registerViewersRoutes } from './routes/viewers.mjs';
import { registerThemeRoutes } from './routes/theme.mjs';
import { themeCss, publicTheme } from './theme.mjs';
import { ViewerWatch } from './viewers.mjs';
import { registerTeleprompterRoutes } from './routes/teleprompter.mjs';
import { registerCustomOverlayRoutes } from './routes/custom-overlays.mjs';
import { Teleprompter } from './teleprompter.mjs';
import { CustomOverlays, CUSTOM_OVERLAY_ID, FRAME_CSP, shellHtml, frameHtml, publicOverlay } from './custom-overlays.mjs';
import { httpError, id8, safePath, cleanName, freeName } from './http-util.mjs';
import { Interactive } from './interactive.mjs';
import { Timers, newTimer, alertFields, limitWarnings, TIMER_KEYS, TIMER_DESTINATIONS, DEFAULT_TIMER, ANNOUNCE_COLORS } from './timers.mjs';
import { newCommand, normalizeTrigger } from './commands.mjs';
import {
  ALERT_TYPES, DEFAULT_ALERTS, LOOK_DEFAULTS, EXTRA_DEFAULTS, ALERT_FIELDS, DEFAULT_CONDITIONS, DEFAULT_COMMAND, SAMPLES,
  buildAlert, buildCommandAlert, buildCustomAlert, mediaKind, alertConfig,
} from './alerts.mjs';

const PUBLIC = path.join(ROOT, 'public');
// Interfaz React (app/ → app/dist con `pnpm app:build`). Sin compilar, /, /prompter y /dock
// responden una página mínima que explica cómo compilarla (#115: el panel clásico se retiró).
const APP_DIST = path.join(ROOT, 'app', 'dist');
const APP_PAGES = { '/': 'index.html', '/prompter': 'prompter.html', '/dock': 'dock.html' };
const MAX_UPLOAD = 300 * 1024 * 1024;
const HELD_MAX_ALERT_BYTES = 256 * 1024;
const HELD_MAX_BATCH_BYTES = 8 * 1024 * 1024;
const HELD_LIST_LIMIT = 100;
// Cierre de admisión: mensaje constante y seguro para toda petición rechazada.
const CLOSING_MESSAGE = 'La app se está cerrando.';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.apng': 'image/apng', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
};
export const WIDGETS = ['chat', 'goal', 'latest', 'ticker', 'credits', 'question', 'tierlist', 'giveaway', 'teleprompter', 'viewers'];

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

export async function createApp({ dataDir, mediaDir = process.env.ANTENA_MEDIA || path.join(ROOT, 'media'), log = console.log, heldRecoveryWindows, heldRecoveryIO, appDist } = {}) {
  const store = await new Store(dataDir).load();
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
  const meld = new Meld(log);
  // #68: la retención de archivados sale de la configuración (0 = sin límite); se lee
  // en vivo para que un cambio en config.json valga sin reiniciar.
  const session = await new Session(store.dir, { report: log, maxArchived: () => store.config.sessions?.retention }).load();
  session._applyRetention().catch(() => {});   // aplica la retención configurada al arrancar
  const engine = new Engine({ store, bus, session, meld, twitch, youtube, log });
  const timers = new Timers({ store, engine, twitch, youtube, meld, session, log });
  engine.timers = timers;
  const interactive = await new Interactive({ store, twitch, meld, log }).load();
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
    twitch: twitch.status, youtube: youtube.status, chat: chat.status, meld: meld.status,
    overlays: bus.overlayCount(), pause: engine.pauseState(),
    persistence: store.persistenceState(),
    sessionRecovery: session.recoveryState(),
    sessionArchive: session.archiveState(),
    heldRecovery,
  });
  const pushStatus = () => bus.send('status', status(), ['panel']);
  for (const src of [twitch, youtube, chat, meld]) src.on('status', pushStatus);

  // eventos de plataforma → motor
  twitch.on('event', e => engine.handleEvent(e));
  youtube.on('event', e => engine.handleEvent(e));
  youtube.on('chat', m => engine.handleChat(m));
  chat.on('message', m => engine.handleChat(m));
  chat.on('delete', ({ id }) => engine.deleteChat(id));
  chat.on('clearUser', ({ login }) => engine.clearChatUser(login));
  session.on('change', () => { engine.pushWidgets(); pushTimeline(); });
  // la cronología apunta también lo que pasa en los interactivos
  interactive.on('questionShown', q => session.addNote({ kind: 'question', text: q.text, user: q.user, platform: q.platform }));
  interactive.on('draw', r => session.addNote({ kind: 'winner', user: r.winner, label: store.config.interactive?.giveaway?.prize || '' }));

  // ---------- prompter ----------
  // S10: dos pestañas («Eventos» = cronologia y «Preguntas»). Las retiradas (tierlist, sorteo)
  // se aceptan como no-op registrado para que los atajos guardados y /sd/prompter/<tab> sigan
  // funcionando; lo desconocido sigue siendo 400. Ya no hay salto automático al abrir votación
  // o sorteo (viven en el dock y en su vista del panel).
  const PROMPTER_TABS = ['cronologia', 'preguntas'];
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
  store.on('change', patch => {
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
    if (patch.prompter || patch.chat || patch.alerts || patch.all) bus.send('config', {
      prompter: store.config.prompter, chat: store.config.chat, alerts: store.publicConfig().alerts,
    }, ['panel']);
  });
  // la persistencia puede fallar sin emitir 'change' (o estar en vuelo): el panel necesita su propio canal
  store.on('persistence', state => bus.send('persistence', state, ['panel']));
  meld.on('session', s => bus.send('meld', s, ['panel']));
  // S2/S12: el panel ve qué acción de chat falló (total o parcialmente) y en qué plataforma; los éxitos no se reenvían.
  engine.on('chatResult', r => { if (!r.ok) bus.send('chatResult', r, ['panel']); });
  // Capturar antes de invocar startNew: sus listeners síncronos pueden iniciar el cierre.
  const autoSessionWork = new Set();
  let autoSessionClosed = false;
  let autoSessionCaptured = [];
  let autoSessionDrain = null;
  const autoSessionLog = message => { try { log(message); } catch {} };
  const beginAutoSessionDrain = () => {
    if (autoSessionClosed) return;
    autoSessionClosed = true;
    autoSessionCaptured = [...autoSessionWork];
  };
  const drainAutoSession = () => {
    if (autoSessionDrain) return autoSessionDrain;
    beginAutoSessionDrain();
    autoSessionDrain = Promise.allSettled(autoSessionCaptured).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
    return autoSessionDrain;
  };
  // Una desconexión de Meld no es por sí sola un fin: tras reconectar se contrastan
  // las observaciones de cada plataforma con la sesión abierta.
  let autoLive = false, pendingAutoStart = null, pendingAutoClose = null, reconnectCheck = null, meldConnected = false, identityEpoch = 0;
  youtube.identityEpoch = () => ({ epoch: identityEpoch, target: pendingAutoStart || session.data.id, requestedAt: process.hrtime.bigint() });
  // YouTube no admite identidad en este sondeo: espera las identidades previas
  // sin cambiar el contexto original con que Twitch decide su propia admisión.
  viewers.identityEpoch = platform => {
    const observation = youtube.identityEpoch();
    if (platform === 'youtube') observation.target = pendingAutoStart || session.captureIdentity();
    return observation;
  };
  viewers.identityEnabled = () => !!store.config.meld.autoSession && autoLive && !autoSessionClosed;
  const trackAutoSession = (operation, success, failure) => {
    let resolve, reject;
    const work = new Promise((yes, no) => { resolve = yes; reject = no; });
    autoSessionWork.add(work);
    work.then(() => {
      autoSessionWork.delete(work);
      if (success) autoSessionLog(success);
    }, () => {
      autoSessionWork.delete(work);
      if (failure) autoSessionLog(failure);
    });
    try { Promise.resolve(operation()).then(resolve, reject); }
    catch (err) { reject(err); }
    return work;
  };
  const startAutoSession = () => {
    // Si el chat ya se escucha, confirmar solo después de crear la sesión nueva.
    const listening = youtube.running && youtube.status.state === 'escuchando' && youtube.status.videoId && youtube.status.liveChatId;
    autoLive = true; reconnectCheck = null; identityEpoch++;
    const work = trackAutoSession(() => session.startNew('', { meldAuto: true }),
      '[meld] directo en marcha: nueva sesión', '[meld] No se pudo iniciar la sesión automática.');
    pendingAutoStart = work;
    work.then(() => { if (pendingAutoStart === work) pendingAutoStart = null; }, () => {
      if (pendingAutoStart === work) { pendingAutoStart = null; autoLive = false; }
    });
    if (listening) trackAutoSession(() => work.then(started => {
      if (!started || session.data.id !== started.id || !store.config.meld.autoSession || !autoLive) return;
      return youtube.confirmListeningIdentity();
    }), null, '[youtube] No se pudo confirmar la identidad del directo.');
    return work;
  };
  const checkReconnectedSession = () => {
    // El checkpoint espera el corte y las identidades aceptadas antes de reconectar.
    reconnectCheck = trackAutoSession(() => session.captureIdentity(), null, '[sesión] No se pudo comprobar la identidad.');
  };
  const recordIdentity = (platform, data, observation, discovery = true) => {
    if (autoSessionClosed || !store.config.meld.autoSession || !observation?.target || !data) return;
    const key = platform === 'youtube' ? 'videoId' : 'streamId';
    if (typeof data[key] !== 'string' || !data[key]) return;
    const target = observation.target, after = typeof target === 'string' ? null : target;
    const reconnect = reconnectCheck, expectedId = after ? null : target;
    let work;
    const onRollover = () => {
      // La sesión decide si cada petición anterior demuestra una identidad nueva.
      identityEpoch++; reconnectCheck = null; pendingAutoStart = work;
      work.then(() => { if (pendingAutoStart === work) pendingAutoStart = null; }, () => {
        if (pendingAutoStart === work) { pendingAutoStart = null; autoLive = false; }
      });
    };
    work = trackAutoSession(() => session.recordPlatform(platform, data, after, {
      reconnect, expectedId, requestedAt: observation.requestedAt, discovery, onRollover, enabled: () => !!store.config.meld.autoSession,
    }), null, '[sesión] No se pudo registrar la identidad de la plataforma.');
    return work;
  };
  // Cada resultado lleva la sesión capturada antes de iniciar su petición.
  youtube.on('status', (st, observation, discovery) => { if (st.state === 'escuchando') recordIdentity('youtube', st, observation, discovery); });
  viewers.on('streamIdentity', (identity, observation) => {
    const admission = recordIdentity('twitch', identity, observation);
    if (observation) observation.viewerAdmission = admission;
  });
  viewers.on('seriesObservation', (platform, sample, observation) => {
    if (autoSessionClosed || !store.config.meld.autoSession || !autoLive || !observation?.target) return;
    trackAutoSession(() => session.recordViewer(platform, sample, observation.target, observation.viewerAdmission,
      () => !!store.config.meld.autoSession), null, '[sesión] No se pudo registrar la muestra de espectadores.');
  });
  const closeAutoSession = () => {
    autoLive = false; pendingAutoStart = null; reconnectCheck = null; identityEpoch++;
    const work = trackAutoSession(() => session.endCurrent(), null, '[meld] No se pudo cerrar la sesión automática.');
    pendingAutoClose = work;
    work.then(() => { if (pendingAutoClose === work) pendingAutoClose = null; }, () => { if (pendingAutoClose === work) pendingAutoClose = null; });
  };
  meld.on('streaming', live => {
    if (!store.config.meld.autoSession || autoSessionClosed) return;
    if (live) { startAutoSession(); return; }
    closeAutoSession();
  });
  meld.on('status', st => {
    const connectedNow = st.state === 'conectado';
    const reconnected = connectedNow && !meldConnected;
    meldConnected = connectedNow;
    if (!connectedNow || !store.config.meld.autoSession || autoSessionClosed) return;
    if (st.streaming) {
      if (autoLive) {
        if (reconnected) checkReconnectedSession();
        return;
      }
      autoLive = true;
      // Si hay un fin aceptado pero aún no durable, el siguiente live va detrás de él.
      if (pendingAutoClose || !session.data.meldAutoSession || session.data.endedAt) startAutoSession();
      else { identityEpoch++; checkReconnectedSession(); }
    } else if (!pendingAutoClose && (autoLive || (session.data.meldAutoSession && !session.data.endedAt))) {
      closeAutoSession();
    }
  });
  // #73: al empezar el directo se conecta sola la lectura del chat de YouTube, también si
  // antena arranca con el directo ya en marcha (onInit no emite «streaming»).
  const youtubeAuto = new YouTubeAutoConnect(youtube, { log });
  meld.on('streaming', live => { if (live) youtubeAuto.begin(); else youtubeAuto.end().catch(() => {}); });
  meld.on('status', st => { if (st.state === 'conectado' && st.streaming) youtubeAuto.begin(); });
  // al conectar Twitch se lee su chat (o el canal indicado)
  twitch.on('status', st => {
    const ch = store.config.chat.twitchChannel || st.user;
    if (ch && st.state === 'conectado' && chat.channel !== ch.toLowerCase()) chat.join(ch);
  });

  async function listMedia() {
    try {
      const files = (await readdir(mediaDir)).filter(f => mediaKind(f)).sort((a, b) => a.localeCompare(b));
      // #68: tamaño en bytes de cada archivo, para el panel.
      return await Promise.all(files.map(async name => {
        const st = await stat(path.join(mediaDir, name)).catch(() => null);
        return { name, kind: mediaKind(name), size: st?.size ?? 0 };
      }));
    } catch { return []; }
  }

  // ---------- helpers de edición ----------
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
  const commandOf = id => {
    const c = (store.config.commands ||= []).find(x => x.id === id || normalizeTrigger(x.trigger) === normalizeTrigger(id));
    if (!c) throw httpError(404, `No existe el comando «${id}»`);
    return c;
  };
  // overrides de una variación: null borra el campo (vuelve a heredar de la alerta)
  const mergeOverrides = (cur = {}, patch = {}) => {
    const out = { ...cur };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
    return out;
  };
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
  const commandFields = body => {
    const fields = pick(body, COMMAND_KEYS);
    for (const key of ['outputMode', 'chatReply']) {
      const [error] = validatePath(`commands.0.${key}`, fields[key]);
      if (error) throw httpError(400, error.message);
    }
    checkActions(fields.actions);
    return fields;
  };

  // ---------- ocultado diferido de capas Meld ----------
  // El horario aceptado por POST /api/meld/layer no se toca: el temporizador original sigue
  // referenciado y el await completo de meld.setLayer se sigue como una única tarea. La captura
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
    return trackLayerHide(timer.then(() => Promise.resolve().then(() => meld.setLayer(sceneId, layerId, false))));
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
    meld: { session: meld.session(), commands: MELD_COMMANDS, events: MELD_STREAM_EVENTS },
    widgets: engine.widgetState(), access: accessInfo(), widgetNames: WIDGETS,
    timers: timers.snapshot(), timerDefaults: DEFAULT_TIMER, announceColors: ANNOUNCE_COLORS,
    interactive: interactive.snapshot(),
    viewers: viewers.snapshot(),
    teleprompter: teleprompter.snapshot(),
    customOverlays: customOverlays.list().map(publicOverlay),
    theme: publicTheme(store.config.theme), alertPreviews: alertPreviews(),
  }));
  route('GET', '/api/status', async () => status());

  // config completa
  route('GET', '/api/config', async (_, __, url) => {
    const p = url.searchParams.get('path');
    return p ? { path: p, value: store.getPath(p, store.publicConfig()) } : store.publicConfig();
  });
  route('PUT', '/api/config', async body => {
    const patch = { ...body };
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
    // #106: validación por esquema antes de guardar nada; las claves desconocidas se aceptan y se avisan.
    const errors = validatePatch(patch);
    if (errors.length) throw httpError(400, errors.map(e => e.message).join('; '));
    warnUnknownKeys(patch);
    if (hasOverlays) await customOverlays.replaceAll(overlaysInput);
    await store.patchConfig(patch);
    afterConfig(patch);
    return { config: store.publicConfig() };
  });
  route('POST', '/api/config/set', async ({ path: p, value }) => {
    if (!p) throw httpError(400, 'Falta «path»');
    if (String(p).split('.')[0] === 'customOverlays') {
      await customOverlays.setPath(p, value);
      return { path: p, value: store.getPath(p) };
    }
    // #106: el valor se valida contra el esquema en su ruta; las rutas nuevas se aceptan.
    const [error] = validatePath(p, value);
    if (error) throw httpError(400, error.message);
    await store.setPath(p, value);
    afterConfig({ [p.split('.')[0]]: true });
    return { path: p, value: store.getPath(p) };
  });

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
    return { alert: buildAlert(type, { ...SAMPLES[type] }, store.config, { test: true }), theme: publicTheme(store.config.theme) };
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

  // comandos de chat
  route('GET', '/api/commands', async () => store.config.commands || []);
  route('POST', '/api/commands', async body => {
    const c = newCommand(commandFields(body));
    if ((store.config.commands || []).some(x => normalizeTrigger(x.trigger) === c.trigger)) throw httpError(409, `Ya existe el comando ${c.trigger}`);
    (store.config.commands ||= []).push(c);
    await store.save('commands');
    return { command: c };
  });
  route('PUT', '/api/commands/:id', async ({ id }, body) => {
    const c = commandOf(decodeURIComponent(id));
    Object.assign(c, commandFields(body));
    if (body.trigger) c.trigger = normalizeTrigger(body.trigger);
    await store.save('commands');
    return { command: c };
  });
  route('DELETE', '/api/commands/:id', async ({ id }) => {
    const c = commandOf(decodeURIComponent(id));
    store.config.commands = store.config.commands.filter(x => x !== c);
    await store.save('commands');
    return { commands: store.config.commands };
  });

  // mensajes programados
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
  route('GET', '/api/timers', async () => timers.snapshot());
  route('POST', '/api/timers', async body => {
    const t = newTimer(timerFields(body));
    (store.config.timers ||= []).push(t);
    await store.save('timers');
    return { timer: t, warnings: limitWarnings(t) };
  });
  route('PUT', '/api/timers/:id', async ({ id }, body) => {
    const t = timerOf(decodeURIComponent(id));
    Object.assign(t, timerFields(body));
    if (body.intervalMin !== undefined) timers.reset(t.id);
    await store.save('timers');
    return { timer: t, warnings: limitWarnings(t) };
  });
  route('DELETE', '/api/timers/:id', async ({ id }) => {
    const t = timerOf(decodeURIComponent(id));
    store.config.timers = store.config.timers.filter(x => x !== t);
    timers.reset(t.id);
    await store.save('timers');
    return { timers: store.config.timers };
  });
  route('POST', '/api/timers/:id/fire', async ({ id }) => timers.fire(timerOf(decodeURIComponent(id)).id));

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
  route('GET', '/api/widgets', async () => engine.widgetState());
  route('PUT', '/api/widgets', async body => {
    const patch = { ...body }; delete patch.goals;
    store.config.widgets = deepMerge(store.config.widgets, patch);
    if (Array.isArray(body.goals)) store.config.widgets.goals = body.goals;
    await store.save('widgets');
    return { widgets: store.config.widgets };
  });
  // widgets y objetivos (#128: rutas de cajas/barras en módulo propio, mismo punto y orden)
  registerGoalsRoutes({ route, store, session, id8 });
  route('POST', '/api/credits/play', async () => { bus.send('credits', { action: 'play' }, ['widget']); return { ok: true }; });
  route('POST', '/api/credits/stop', async () => { bus.send('credits', { action: 'stop' }, ['widget']); return { ok: true }; });

  // ---------- sesión y cronología: módulo propio (patrón de rutas por áreas, #71/#107) ----------
  // Registra /api/session*, /api/sessions, /api/timeline* y /api/markers. Los patrones
  // del dispatcher son coincidencia exacta, así que reunir aquí las rutas de sesión y
  // cronología (antes separadas por los bloques de Meld y conexiones) no cambia ninguna
  // resolución; el orden relativo del resto se conserva.
  registerSessionRoutes({ route, session, timelinePayload, addMarker });

  // Meld
  registerMeldRoutes({ route, store, meld, scheduleLayerHide });
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
  registerShortcutRoutes({ route, store, engine, session, interactive, bus, setPrompterTab, addMarker, checkActions, PROMPTER_TABS, teleprompter });

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
    if (patch.meld) { if (store.config.meld.enabled) { meld.stop(); meld.start(store.config.meld.url); } else meld.stop(); }
    if (patch.chat && store.config.chat.twitchChannel) chat.join(store.config.chat.twitchChannel);
    if (patch.paused !== undefined) engine.pushPause();
  }

  // ---------- subida de archivos (cuerpo = archivo; nombre en ?name=) ----------
  async function upload(req, url) {
    const name = cleanName(url.searchParams.get('name'));
    if (!name || !mediaKind(name)) throw httpError(400, 'Formato no admitido. Usa webm, mp4, gif, png, webp, mp3, ogg, wav o una fuente (woff2, woff, ttf, otf).');
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
    const kind = ['panel', 'preview', 'widget', 'teleprompter'].includes(c) ? c : 'overlay';
    bus.addClient(res, kind);
    res.on('close', pushStatus);
    const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
    const pingEntry = { res, timer: ping };
    ssePings.add(pingEntry);
    res.on('close', () => { clearInterval(ping); ssePings.delete(pingEntry); });
    if (kind === 'panel') res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    if (kind === 'widget') res.write(`event: widgets\ndata: ${JSON.stringify(engine.widgetState())}\n\n`);
    if (kind === 'widget') res.write(`event: interactive\ndata: ${JSON.stringify(interactive.snapshot())}\n\n`);
    // Espectadores: solo las cifras públicas, para los widgets y los overlays propios que cargan tarde (S6).
    if (kind === 'widget') res.write(`event: viewers\ndata: ${JSON.stringify(publicViewers(viewers.snapshot()))}\n\n`);
    // Versiones de los overlays propios: la shell recarga su iframe al cambiar la suya.
    if (kind === 'widget') res.write(`event: customOverlayVersions\ndata: ${JSON.stringify(customOverlays.versions())}\n\n`);
    if (kind === 'teleprompter') res.write(`event: teleprompter\ndata: ${JSON.stringify(teleprompter.snapshot())}\n\n`);
    if (kind === 'overlay') res.write(`event: pause\ndata: ${JSON.stringify(engine.pauseState())}\n\n`);
    if (kind !== 'panel') {
      const d = url.searchParams.has('themeDraft') ? themeRoutes.getDraft() : null;
      res.write(`event: theme\ndata: ${JSON.stringify(d ? { ...publicTheme(d), draft: true } : publicTheme(store.config.theme))}\n\n`);
    }
    pushStatus();
  };

  const server = http.createServer(async (req, res) => {
    if (closing) {
      // La ventana ACK solo deja pasar la ruta exacta POST /api/overlay/shown en open/captured.
      let allowed = false;
      if (ackWindowActive() && req.method === 'POST') {
        try { allowed = new URL(req.url, 'http://localhost').pathname === '/api/overlay/shown'; } catch { allowed = false; }
      }
      if (!allowed) return json(res, 503, { error: CLOSING_MESSAGE });
    }
    const url = new URL(req.url, 'http://localhost');
    activeHandlers += 1;
    try {
      if (!hostTrusted(req)) return json(res, 403, { error: 'Host no permitido: usa localhost, 127.0.0.1 o la IP del panel.' });
      const isSd = url.pathname.startsWith('/sd/');
      const mutating = (req.method !== 'GET' && req.method !== 'HEAD') || isSd;
      if (mutating && !(isSd ? sdRequestAllowed(req) : originAllowed(req))) return json(res, 403, { error: 'Origen no permitido para acciones que cambian el directo.' });
      const auth = authorized(req, url, res);
      if (auth === 'redirect') return; // canje de clave: ya respondimos con la redirección
      if (!auth) return json(res, 401, { error: 'Acceso desde la red: abre el enlace con la clave que aparece en el panel (General › Acceso desde el móvil).' });
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
      if (req.method === 'POST' && url.pathname === '/api/media/upload') return json(res, 200, await upload(req, url));
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
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        // rutas con parámetros: fn(params, body, url) · sin parámetros: fn(body, _, url)
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
      if (!res.headersSent) {
        try { json(res, err.status || 500, { error: err.message }); } catch { /* la conexión pudo cerrarse antes de responder */ }
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
      const body = JSON.stringify({ error: message });
      socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`, () => socket.destroy());
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
    let idle;
    try {
      closeAckWindow();          // terminal: la ventana no revive
      stopAdmission();
      idle = whenIdle();         // idle fresca: incluye handlers ACK admitidos en la ventana
    } catch (err) { httpClosePromise = Promise.reject(err); return httpClosePromise; }
    httpClosePromise = idle.then(() => new Promise((resolve, reject) => {
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

  const app = { server, store, bus, twitch, youtube, chat, meld, session, engine, timers, interactive, viewers, teleprompter, customOverlays, mediaDir, port: null, stopAdmission, closeHttp, isHttpClosing, closeUpgradedConnections, beginAckWindow, captureAckWindow, closeAckWindow, ackWindowPhase, waitIdle: whenIdle, beginLayerHideDrain, drainLayerHides, beginAutoSessionDrain, drainAutoSession };
  return app;
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '', done = false;
    // El cierre/interrupción del socket también finaliza: nunca deja la promesa colgada ni el
    // contador de handlers sin bajar. El motivo es constante y no expone error crudo ni stack.
    const fail = () => { if (done) return; done = true; reject(httpError(400, 'Petición interrumpida')); };
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'JSON no válido')); }
    });
    req.on('error', fail);
    req.on('aborted', fail);
    req.on('close', fail);
  });
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Arranca el servidor (lo usan `pnpm start` y el MCP cuando no hay ninguno en marcha). */
export async function startServer({ log = console.log, quiet = false, shutdownTimeoutMs = 5000, handleSignals = true, heldRecoveryWindows, heldRecoveryIO } = {}) {
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
    log(`  Overlay: http://127.0.0.1:${port}/overlay   ← pégalo en Meld como capa de navegador`);
    log(`  Widgets: http://127.0.0.1:${port}/widget/{chat,goal,latest,ticker,credits}`);
    log(`  Prompter: http://127.0.0.1:${port}/prompter`);
    log(`  Media:   ${app.mediaDir}\n`);
  }
  app.twitch.start();
  app.timers.start();
  app.viewers.start();
  if (app.store.config.chat.twitchChannel) app.chat.join(app.store.config.chat.twitchChannel);
  if (app.store.config.meld.enabled) app.meld.start(app.store.config.meld.url);
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
      clearTimeout(deadline);
      process.removeListener('unhandledRejection', onUnhandledRejection);
      resolveClose(code);
    };
    try {
      deadline = setTimeout(() => { safeLog('[parada] drenado agotado'); process.exit(1); }, shutdownTimeoutMs);
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
        // Start all independent attempts NOW: a failed/hung journal never gates either flush.
        Promise.allSettled([journal, queued, sessionFlush(), interactiveFlush()]).then(results => {
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
              attemptDrain(() => app.meld.quiesceClose()).then(
                () => drain(failed),
                () => {
                  safeLog('[parada] No se pudo cerrar Meld.');
                  drain(true);
                }
              );
            };
            const autoSessionCut = failed => {
              attemptDrain(() => app.drainAutoSession()).then(
                () => meldCut(failed),
                () => {
                  safeLog('[parada] No se pudo completar el inicio automático de sesión de Meld.');
                  meldCut(true);
                }
              );
            };
            const layerCut = failed => {
              attemptDrain(() => app.drainLayerHides()).then(
                () => autoSessionCut(failed),
                () => {
                  safeLog('[parada] No se pudo completar el ocultado diferido de capas de Meld.');
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
