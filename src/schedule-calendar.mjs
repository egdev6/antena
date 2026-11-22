// Read-only access to an external stream calendar. Credentials never enter diagnostics.
import http from 'node:http';
import https from 'node:https';

const BAD_URL = 'scheduleCalendar.url: se esperaba la dirección base local (http://localhost:puerto), sin ruta, credenciales, consulta ni fragmento';
const unavailable = () => ({ state: 'calendario no disponible' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = value => value === null || typeof value === 'string';
// Helix expects a digit string even when the calendar sends a JSON number.
const categoryId = value => {
  if (value === null) return null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return BigInt(value).toString();
  return undefined;
};

// Base address only (the API path is fixed): no path can carry the credential. Check the spelling before
// URL normalisation (127.1, empty ?/#, and credentials are not local URLs).
export function validScheduleCalendarUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export { BAD_URL as SCHEDULE_CALENDAR_URL_ERROR };
export const validScheduleCalendarToken = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);

// The remote response is untrusted: don't echo a credential even if a provider returns it as event data.
function containsSecret(value, secret) {
  if (typeof value === 'string') return value.includes(secret);
  return object(value) ? Object.values(value).some(child => containsSecret(child, secret)) :
    Array.isArray(value) && value.some(child => containsSecret(child, secret));
}
// The contract sends epoch milliseconds; an ISO string is also accepted. Returns the ISO date, null when
// absent (adopted events), or undefined when the value is invalid.
function scheduledIso(value) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}
function validEvent(event, token) {
  if (!object(event) || containsSecret(event, token) || !nullableString(event.eventId) || event.eventId === '' || !nullableString(event.criterioEventId)
    || !nullableString(event.title) || scheduledIso(event.scheduledStart) === undefined
    || !(event.durationMin === null || (Number.isFinite(event.durationMin) && event.durationMin >= 0))
    || !(event.state === null || ['scheduled', 'live'].includes(event.state))) return false;
  if (event.youtube !== null && (!object(event.youtube) || !nullableString(event.youtube.broadcastId)
    || (event.youtube.broadcastId !== null && !/^[\w-]{11}$/.test(event.youtube.broadcastId))
    || !nullableString(event.youtube.url))) return false;
  if (event.twitch !== null && (!object(event.twitch) || !nullableString(event.twitch.title)
    || !nullableString(event.twitch.category) || categoryId(event.twitch.categoryId) === undefined)) return false;
  return true;
}

export function createScheduleCalendar({ store, timeoutMs = 3000, onChange = () => {} }) {
  let state = { state: 'sin consultar' };
  const publish = value => { state = { state: value }; try { onChange(); } catch {} };
  const status = () => ({ ...state });
  function current(at) {
    const base = store.config.scheduleCalendar?.url, token = store.secrets.scheduleCalendar?.token;
    if (!validScheduleCalendarUrl(base) || !validScheduleCalendarToken(token) || !Number.isFinite(at)) return Promise.resolve(unavailable());
    const url = new URL(base.replace(/\/$/, '') + '/api/v1/live-events/current');
    url.searchParams.set('at', String(at));
    // No redirect following. localhost is pinned to loopback rather than a mutable hosts-file entry.
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise(resolve => {
      let timer, request, done = false;
      const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
      try {
        request = transport.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` },
          ...(url.hostname.toLowerCase() === 'localhost' ? { family: 4, lookup: (_host, _options, cb) => cb(null, '127.0.0.1', 4) } : {}) }, response => {
          const code = response.statusCode;
          if (code !== 200) {
            response.resume();
            return finish({ state: ({ 404: 'sin evento programado', 401: 'credencial no válida', 403: 'sin permiso de lectura' })[code] || 'calendario no disponible' });
          }
          let size = 0, text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 64 * 1024) { response.destroy(); finish(unavailable()); } else text += chunk; });
          response.on('error', () => finish(unavailable()));
          response.on('aborted', () => finish(unavailable()));
          response.on('end', () => {
            try {
              const event = JSON.parse(text);
              if (validEvent(event, token)) {
                const normalized = { ...event, scheduledStart: scheduledIso(event.scheduledStart),
                  twitch: event.twitch === null ? null : { ...event.twitch, categoryId: categoryId(event.twitch.categoryId) } };
                // Number-to-string normalization must not reveal a numeric credential either.
                if (!containsSecret(normalized, token)) return finish({ state: 'evento programado', event: normalized });
              }
            } catch { /* No raw response or exception is exposed. */ }
            finish(unavailable());
          });
        });
        request.on('error', () => finish(unavailable()));
        timer = setTimeout(() => { request.destroy(); finish(unavailable()); }, timeoutMs);
        timer.unref?.(); request.end();
      } catch { request?.destroy(); finish(unavailable()); }
    });
  }
  async function test() {
    const result = await current(Date.now());
    publish(result.state);
    return result.event ? { state: result.state, event: { title: result.event.title, scheduledStart: result.event.scheduledStart } } : { state: result.state };
  }
  return { current, status, publish, test };
}
