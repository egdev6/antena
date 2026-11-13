// La API pública de Meld solo informa booleanos, no la identidad de una grabación.
// Se conserva propiedad únicamente durante la conexión y operación observadas.
const CONFIRM_MS = 20000;
const START_FAILED = 'No se pudo iniciar la grabación en Meld. Comprueba la grabación.';
const STOP_FAILED = 'No se pudo detener la grabación en Meld. Comprueba la grabación.';
const START_TIMEOUT = 'Meld no confirmó el inicio de la grabación. Comprueba la grabación.';
const STOP_TIMEOUT = 'Meld no confirmó el fin de la grabación. Comprueba la grabación.';
const UNKNOWN = 'Meld no informa si está grabando. Comprueba la grabación en Meld.';
const STOP_UNCERTAIN = 'No se pudo comprobar si detener la grabación. Comprueba la grabación en Meld.';

export function createMeldRecording({ meld, enabled, timers = { setTimeout, clearTimeout } }) {
  let operation = null, sendingOwn = false;
  const sendOwn = command => {
    sendingOwn = true;
    try { return meld.command(command); } finally { sendingOwn = false; }
  };
  const clear = () => {
    if (operation?.timer) timers.clearTimeout(operation.timer);
    operation = null;
  };
  const warning = message => {
    if (meld.status.recordingWarning !== message) meld.setStatus({ recordingWarning: message });
  };
  const discard = message => { clear(); if (message) warning(message); };
  const arm = (op, message) => {
    if (op.timer) timers.clearTimeout(op.timer);
    op.timer = timers.setTimeout(() => {
      if (operation === op) discard(message);
    }, CONFIRM_MS);
    op.timer.unref?.();
  };
  const settled = op => {
    if (operation !== op || !op.acknowledged || !op.confirmed) return;
    if (op.phase === 'starting') {
      if (!meld.connected || meld.status.streamingKnown !== true || meld.status.streaming !== true ||
          meld.status.recordingKnown !== true || meld.status.recording !== true) return discard(START_FAILED);
      if (op.timer) timers.clearTimeout(op.timer);
      op.timer = null; op.phase = 'owned';
    } else if (op.phase === 'stopping') clear();
  };
  const command = (op, action) => {
    op.phase = action === 'start' ? 'starting' : 'stopping';
    op.acknowledged = false; op.confirmed = false;
    const failed = action === 'start' ? START_FAILED : STOP_FAILED;
    arm(op, action === 'start' ? START_TIMEOUT : STOP_TIMEOUT);
    try {
      Promise.resolve(sendOwn(action === 'start' ? 'meld.startRecordingAction' : 'meld.stopRecordingAction'))
        .then(() => { if (operation === op) { op.acknowledged = true; settled(op); } },
          () => { if (operation === op) discard(failed); });
    } catch { if (operation === op) discard(failed); }
  };
  const onStatus = st => {
    const op = operation;
    if (!op) return;
    if (st.state !== 'conectado' || st.streamingKnown !== true) {
      return discard(op.phase === 'starting' ? START_FAILED : op.phase === 'stopping' ? STOP_FAILED : op.phase === 'stream-stop' ? STOP_UNCERTAIN : null);
    }
    if (op.phase === 'stream-start') {
      // Una grabación ya activa en cualquier momento previo nunca pasa a ser nuestra.
      if (st.recordingKnown === true && st.recording === true) return discard();
      if (!st.streaming) return;
      if (st.recordingKnown !== true) return discard(UNKNOWN);
      return command(op, 'start');
    }
    if (op.phase === 'starting') {
      if (!st.streaming || st.recordingKnown !== true) return discard(START_FAILED);
      if (op.confirmed && !st.recording) return discard();
      if (st.recording) { op.confirmed = true; settled(op); }
      return;
    }
    if (op.phase === 'owned' || op.phase === 'stream-stop') {
      // El fin externo, una parada manual o un dato desconocido revocan la propiedad.
      if (st.recordingKnown !== true) return discard(op.phase === 'stream-stop' ? STOP_UNCERTAIN : null);
      if (!st.recording) return discard();
      if (!st.streaming) {
        if (op.phase === 'stream-stop') return command(op, 'stop');
        return discard();
      }
      return;
    }
    if (op.phase === 'stopping') {
      if (st.streaming || st.recordingKnown !== true) return discard(STOP_FAILED);
      if (op.confirmed && st.recording) return discard();
      if (!st.recording) { op.confirmed = true; settled(op); }
    }
  };
  meld.on?.('status', onStatus);
  // También pasan por aquí comandos genéricos, atajos y acciones del motor. Se revoca
  // antes del RPC: esperar al cambio booleano dejaría una carrera con el fin del directo.
  meld.on?.('controlCommand', () => { if (!sendingOwn) discard(); });
  return {
    streamCommand: sendOwn,
    // Solo se llama después de validar y reservar la guarda compartida de /stream,
    // antes de esperar el RPC: el evento de Meld puede adelantarse a su respuesta.
    begin(action, streaming) {
      const previous = operation;
      if (action === 'stop' && streaming === true && previous?.phase === 'owned') {
        previous.phase = 'stream-stop';
        arm(previous, STOP_UNCERTAIN); // sin confirmación de emisión no hay permiso para parar la grabación
        return previous;
      }
      discard(previous?.phase === 'starting' ? START_FAILED : previous?.phase === 'stopping' ? STOP_FAILED : null);
      if (action !== 'start' || streaming !== false || !enabled()) return null;
      if (meld.status.recordingKnown === true && meld.status.recording === true) return null;
      const op = { phase: 'stream-start', timer: null };
      operation = op;
      if (meld.status.recordingWarning) warning(null);
      arm(op, null);
      return op;
    },
    streamFailed(op) {
      // Si Meld ya confirmó el fin y se envió la orden de grabación, su RPC y su
      // confirmación siguen siendo independientes del fallo tardío del RPC de emisión.
      if (op && operation === op && op.phase !== 'stopping')
        discard(op.phase === 'starting' ? START_FAILED : op.phase === 'stream-stop' ? STOP_UNCERTAIN : null);
    },
  };
}
