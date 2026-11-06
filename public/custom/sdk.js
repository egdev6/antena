/*!
 * antena overlay SDK (live data + approved actions).
 *
 * Custom overlays run inside an opaque-origin sandbox (see /custom/<id>), so their code cannot
 * call the antena API or open the event stream: the trusted shell page owns the connection and
 * forwards the public data over postMessage. The only way out is antena.run: the SDK posts a run
 * request to the shell, which checks it and asks the server. The server runs it only when the
 * USER approved that action kind for this overlay in the panel; otherwise it rejects (403) and
 * nothing happens. A buggy loop cannot flood the stream: 10 actions per 10 s per overlay.
 *
 *   antena.on(event, fn)   Subscribes fn to an event and returns a function that unsubscribes.
 *                          If the event already has a value, fn is called once right away with
 *                          it, so late subscriptions start with data. Each call is independent.
 *   antena.off(event, fn)  Removes one subscription of fn for that event.
 *   antena.state           Latest value per event; every key starts as null.
 *                          { alert, chat, viewers, widgets, interactive, theme }
 *   antena.ready           Promise that resolves once the shell confirms it is connected and has
 *                          pushed the current snapshots. Await it before reading antena.state.
 *   antena.run(kind, p)    Promise that resolves when the approved action ran and rejects with
 *                          the server's error otherwise. Kinds: scene, layer, hideLayer,
 *                          toggleLayer, effect, command, streamEvent, chat, say.
 *
 * Events and payloads (see src/custom-overlays.mjs for the server side):
 *   'alert'        Every alert shown: { type, title, text, sub, platform, icon, durationMs, at, vars }.
 *                  vars carries the public event data (user, amount, message…), never the overlay
 *                  queue, the look/media configuration or the alert actions. Live only: a frame
 *                  that loads later is not sent the previous alert again.
 *   'chat'         Every new chat message, exactly as the chat widgets get it. Live only.
 *   'viewers'      Public viewer counts: { twitch: { live, current, peak, record }, youtube: { ... } }.
 *   'widgets'      Widget state: totals, latest, goals, recent, credits, session…
 *   'interactive'  Live questions, tier list, vote and giveaway state.
 *   'theme'        Public theme (the accents and the other variables of /theme.css).
 *
 * Only messages posted by the parent window (the shell) and marked with `antena: 1` are accepted;
 * anything else in the page (another frame, a stray script, a user event) is ignored.
 */
(function (win) {
  'use strict';

  var EVENTS = ['alert', 'chat', 'viewers', 'widgets', 'interactive', 'theme'];
  var state = {};
  var handlers = {};
  var markReady;
  var ready = new Promise(function (resolve) { markReady = resolve; });
  var RUN_TIMEOUT_MS = 15000;
  var runs = {};        // reqId → responde la promesa de antena.run
  var runSeq = 0;

  for (var i = 0; i < EVENTS.length; i++) {
    state[EVENTS[i]] = null;
    handlers[EVENTS[i]] = [];
  }

  /** Un manejador que falla no puede dejar sin datos al resto de suscripciones. */
  function failLater(err) {
    setTimeout(function () { throw err; }, 0);
  }

  function emit(event, data) {
    var list = handlers[event].slice();
    for (var j = 0; j < list.length; j++) {
      try { list[j](data); } catch (err) { failLater(err); }
    }
  }

  function off(event, fn) {
    var list = handlers[event];
    if (!list) return;
    var index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('antena.on(evento, fn): fn tiene que ser una función');
    var list = handlers[event] || (handlers[event] = []);
    list.push(fn);
    // Suscripción tardía: si ya hay un valor para ese evento, empieza con él.
    if (state[event] !== null && state[event] !== undefined) {
      try { fn(state[event]); } catch (err) { failLater(err); }
    }
    return function unsubscribe() { off(event, fn); };
  }

  /** Pide una acción a la shell. La shell la manda al servidor de antena, que solo la ejecuta si
   *  el usuario aprobó ese tipo para este overlay en el panel; si no, la promesa se rechaza. */
  function run(kind, params) {
    if (typeof kind !== 'string' || !kind) return Promise.reject(new TypeError('antena.run(tipo, params): el tipo de acción tiene que ser un texto'));
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return Promise.reject(new TypeError('antena.run(tipo, params): params tiene que ser un objeto'));
    }
    return new Promise(function (resolve, reject) {
      var reqId = 'a' + (++runSeq) + '-' + Date.now();
      var timer = setTimeout(function () {
        if (!runs[reqId]) return;
        delete runs[reqId];
        reject(new Error('La acción no respondió a tiempo'));
      }, RUN_TIMEOUT_MS);
      runs[reqId] = function (ok, value) {
        clearTimeout(timer);
        if (ok) resolve(value);
        else reject(new Error(value));
      };
      try { win.parent.postMessage({ antena: 1, run: { reqId: reqId, kind: kind, params: params || {} } }, '*'); }
      catch (err) { delete runs[reqId]; clearTimeout(timer); reject(err); }
    });
  }

  win.addEventListener('message', function (msg) {
    if (!msg || msg.source !== win.parent) return;                       // solo la shell
    var data = msg.data;
    if (!data || typeof data !== 'object' || data.antena !== 1) return;  // solo nuestro canal
    if (data.ready === true) { markReady(); return; }                    // fin del snapshot inicial
    if (data.runResult && typeof data.runResult === 'object') {
      var out = data.runResult, waiting = typeof out.reqId === 'string' ? runs[out.reqId] : null;
      if (!waiting) return;                                              // reqId ajeno o ya resuelto
      delete runs[out.reqId];
      waiting(out.ok === true, out.ok === true ? out.result : (typeof out.error === 'string' && out.error ? out.error : 'No se pudo ejecutar la acción'));
      return;
    }
    if (typeof data.event !== 'string' || EVENTS.indexOf(data.event) < 0) return;
    state[data.event] = data.data;
    emit(data.event, data.data);
  });

  win.antena = { on: on, off: off, state: state, ready: ready, run: run };
})(window);
