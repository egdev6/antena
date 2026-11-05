/*!
 * antena overlay SDK (read-only live data).
 *
 * Custom overlays run inside an opaque-origin sandbox (see /custom/<id>), so their code cannot
 * call the antena API or open the event stream: the trusted shell page owns the connection and
 * forwards the public data over postMessage. Everything in this file is inbound — the SDK never
 * sends anything back, so an overlay can never trigger an action through it.
 *
 *   antena.on(event, fn)   Subscribes fn to an event and returns a function that unsubscribes.
 *                          If the event already has a value, fn is called once right away with
 *                          it, so late subscriptions start with data. Each call is independent.
 *   antena.off(event, fn)  Removes one subscription of fn for that event.
 *   antena.state           Latest value per event; every key starts as null.
 *                          { alert, chat, viewers, widgets, interactive, theme }
 *   antena.ready           Promise that resolves once the shell confirms it is connected and has
 *                          pushed the current snapshots. Await it before reading antena.state.
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
 * Only messages posted by the parent window and marked with `antena: 1` are accepted; anything
 * else in the page (another frame, a stray script, a user event) is ignored.
 */
(function (win) {
  'use strict';

  var EVENTS = ['alert', 'chat', 'viewers', 'widgets', 'interactive', 'theme'];
  var state = {};
  var handlers = {};
  var markReady;
  var ready = new Promise(function (resolve) { markReady = resolve; });

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

  win.addEventListener('message', function (msg) {
    if (!msg || msg.source !== win.parent) return;                       // solo la shell
    var data = msg.data;
    if (!data || typeof data !== 'object' || data.antena !== 1) return;  // solo nuestro canal
    if (data.ready === true) { markReady(); return; }                    // fin del snapshot inicial
    if (typeof data.event !== 'string' || EVENTS.indexOf(data.event) < 0) return;
    state[data.event] = data.data;
    emit(data.event, data.data);
  });

  win.antena = { on: on, off: off, state: state, ready: ready };
})(window);
