// Automatic session transitions and their shutdown drains, wired in listener order by createApp.
import { httpError } from './http-util.mjs';

export function setupAutoSession({ store, program, session, youtube, viewers, chat, twitch, engine, log }) {
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
  let autoLive = false, pendingAutoStart = null, pendingAutoStartFrom = null, pendingAutoClose = null, pendingAutoCloseId = null, reconnectCheck = null, meldConnected = false, identityEpoch = 0;
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
    const { videoId, liveChatId } = youtube.status;
    const listening = youtube.running && youtube.status.state === 'escuchando' && videoId && liveChatId;
    const fromId = session.data.id;
    autoLive = true; reconnectCheck = null; identityEpoch++;
    const work = trackAutoSession(() => session.startNew('', { meldAuto: true }),
      '[programa de emisión] directo en marcha: nueva sesión', '[programa de emisión] No se pudo iniciar la sesión automática.');
    pendingAutoStart = work; pendingAutoStartFrom = fromId;
    if (ownTwitchListening()) recordListener('twitch', {}, chatTarget());
    work.then(() => { if (pendingAutoStart === work) { pendingAutoStart = null; pendingAutoStartFrom = null; } }, () => {
      if (pendingAutoStart === work) { pendingAutoStart = null; pendingAutoStartFrom = null; autoLive = false; }
    });
    if (listening) trackAutoSession(() => work.then(started => {
      if (!started || session.data.id !== started.id || !store.config.meld.autoSession || !autoLive) return;
      return youtube.confirmListeningIdentity().then(() => {
        if (youtube.status.polls > 0 && youtube.status.videoId === videoId && youtube.status.liveChatId === liveChatId)
          recordListener('youtube', { videoId, liveChatId }, started.id);
      });
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
      identityEpoch++; reconnectCheck = null; pendingAutoStart = work; pendingAutoStartFrom = session.data.id;
      if (ownTwitchListening()) recordListener('twitch', {}, chatTarget());
      work.then(() => { if (pendingAutoStart === work) { pendingAutoStart = null; pendingAutoStartFrom = null; } }, () => {
        if (pendingAutoStart === work) { pendingAutoStart = null; pendingAutoStartFrom = null; autoLive = false; }
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
  // La contabilidad sigue admitiendo el poll ya aceptado hasta que sus productores
  // cierren. El corte de identidad de Meld se sella antes y no sirve para ese drenaje.
  let chatMetricsClosed = false, chatMetricsDrain = null, chatMetricsFailed = false;
  const chatMetricsWork = new Set();
  const chatTarget = () => pendingAutoStart || session.captureIdentity();
  youtube.chatEpoch = () => ({ target: chatTarget() });
  youtube.on('chat', (m, observation) => engine.handleChat(m, { ...observation, source: 'youtube', at: new Date().toISOString() }));
  chat.on('message', m => engine.handleChat(m, { source: 'twitch', target: chatTarget(), at: new Date().toISOString() }));
  const chatMetricError = () => {
    chatMetricsFailed = true;
    autoSessionLog('[sesión] No se pudieron registrar las métricas del chat.');
  };
  const trackChatMetrics = operation => {
    let work;
    try { work = operation(); } catch { chatMetricError(); return; }
    chatMetricsWork.add(work);
    work.then(() => chatMetricsWork.delete(work), () => { chatMetricsWork.delete(work); chatMetricError(); });
  };
  const ownTwitchListening = () => chat.status.state === 'conectado' && !!chat.channel
    && chat.channel === String(twitch.status.user || '').toLowerCase();
  const recordListener = (platform, observation, target) => {
    if (chatMetricsClosed || !store.config.meld.autoSession || !autoLive || !target) return;
    trackChatMetrics(() => session.recordChatListener(platform, observation, target, () => !!store.config.meld.autoSession));
  };
  chat.on('status', () => { if (ownTwitchListening()) recordListener('twitch', {}, chatTarget()); });
  youtube.on('chatListening', observation => recordListener('youtube', observation, observation.target));
  engine.on('chatMetric', (m, observation) => {
    if (chatMetricsClosed || !store.config.meld.autoSession || !autoLive || observation.source !== m.platform || !observation.target || m.owner) return;
    if (m.platform === 'twitch' && (!twitch.userId || m.roomId !== twitch.userId || m.authorId === twitch.userId)) return;
    trackChatMetrics(() => session.recordChat(m.platform, { at: observation.at, authorId: m.authorId,
      videoId: observation.videoId, liveChatId: observation.liveChatId }, observation.target, () => !!store.config.meld.autoSession));
  });
  const drainChatMetrics = () => {
    if (chatMetricsDrain) return chatMetricsDrain;
    chatMetricsClosed = true;
    chatMetricsDrain = Promise.allSettled([...chatMetricsWork]).then(results => {
      if (chatMetricsFailed || results.some(r => r.status === 'rejected')) throw new Error('No se pudieron completar las métricas del chat.');
    });
    return chatMetricsDrain;
  };
  const resetAutoSession = () => { autoLive = false; pendingAutoStart = null; pendingAutoStartFrom = null; reconnectCheck = null; identityEpoch++; };
  const closeAutoSession = ({ expectedId } = {}) => {
    const manual = expectedId !== undefined, epoch = identityEpoch;
    // Meld's own stop keeps its existing immediate cut. A manual request cuts only
    // after success, so an unsuccessful pre-cut flush cannot discard live metrics.
    if (!manual) resetAutoSession();
    const work = trackAutoSession(() => session.endCurrent(undefined, { expectedId }).then(closed => closed || structuredClone(session.data)), null, '[programa de emisión] No se pudo cerrar la sesión automática.');
    pendingAutoClose = work; pendingAutoCloseId = expectedId ?? session.data.id;
    const settle = () => {
      // Do not roll back a newer start or a different session. An ended session must
      // also be cut on a failed final checkpoint so the next Meld live can start.
      if (manual && identityEpoch === epoch && session.data.id === expectedId && session.data.endedAt) resetAutoSession();
      if (pendingAutoClose === work) { pendingAutoClose = null; pendingAutoCloseId = null; }
    };
    work.then(settle, settle);
    return work;
  };
  const endSession = id => {
    if (id !== undefined && (typeof id !== 'string' || !id)) throw httpError(400, 'Identificador de sesión no válido.');
    const expectedId = id ?? session.data.id;
    if (expectedId !== session.data.id) throw httpError(409, 'La sesión actual ha cambiado. Actualiza antes de terminar el directo.');
    // Check and enqueue without an await: a live observation cannot slip between them.
    if (program.status.state === 'conectado' && program.status.streaming)
      throw httpError(409, 'No se puede terminar el directo mientras el programa de emisión está emitiendo.');
    return closeAutoSession({ expectedId }).then(async closed => {
      // An idempotent retry after a failed checkpoint must be durable before success.
      if (session.lastSaveError) await session.flush();
      // The checkpoint may have recovered in the background before this retry.
      session._notifyFinalized(closed);
      return closed;
    });
  };
  program.on('streaming', live => {
    if (!store.config.meld.autoSession || autoSessionClosed) return;
    if (live) { startAutoSession(); return; }
    closeAutoSession();
  });
  program.on('status', st => {
    const connectedNow = st.state === 'conectado';
    const reconnected = connectedNow && !meldConnected;
    meldConnected = connectedNow;
    if (!connectedNow || !store.config.meld.autoSession || autoSessionClosed) return;
    if (st.streaming) {
      // A manual end leaves accounting live until its cut succeeds. A confirmed new
      // broadcast still queues its start behind that pending end, exactly once.
      if (pendingAutoClose) {
        // A pending start for the session being closed is not the next broadcast.
        if (!pendingAutoStart || pendingAutoStartFrom !== pendingAutoCloseId) startAutoSession();
        return;
      }
      if (autoLive) {
        if (reconnected) checkReconnectedSession();
        return;
      }
      autoLive = true;
      // Si hay un fin aceptado pero aún no durable, el siguiente live va detrás de él.
      if (pendingAutoClose || !session.data.meldAutoSession || session.data.endedAt) startAutoSession();
      else {
        identityEpoch++; checkReconnectedSession();
        if (ownTwitchListening()) recordListener('twitch', {}, chatTarget());
      }
    } else if (!pendingAutoClose && (autoLive || (session.data.meldAutoSession && !session.data.endedAt))) {
      closeAutoSession();
    }
  });

  return { beginAutoSessionDrain, drainAutoSession, drainChatMetrics, endSession };
}
