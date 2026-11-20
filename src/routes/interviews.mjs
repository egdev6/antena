// Interview routes (/api/interviews*, #276). Same pattern as the rest of src/routes:
// registerInterviewRoutes(ctx) with route(method, pattern, fn); with :vars in the pattern,
// fn(vars, body, url, req); without vars, fn(body, null, url, req).
// Validation lives in src/interviews.mjs; here only the id is resolved.
import { httpError } from '../http-util.mjs';

/** decodeURIComponent that answers 400 for a malformed id (e.g. «%zz») instead of 500. */
function decodeId(raw) {
  try { return decodeURIComponent(raw); }
  catch { throw httpError(400, 'Id de entrevista no válido'); }
}

export function registerInterviewRoutes({ route, interviews }) {
  route('GET', '/api/interviews', async () => interviews.snapshot());
  route('POST', '/api/interviews', async body => interviews.create(body));
  // Import is strict: the pack must carry `version` and is stored as it came (ids are filled in if missing).
  route('POST', '/api/interviews/import', async body => interviews.import(body));
  route('POST', '/api/interviews/select', async (body = {}) => interviews.select(String(body?.id ?? ''), body?.itemId));
  route('GET', '/api/interviews/:id', async ({ id }) => ({ interview: interviews.get(decodeId(id)) }));
  route('PUT', '/api/interviews/:id', async ({ id }, body) => interviews.update(decodeId(id), body));
  route('DELETE', '/api/interviews/:id', async ({ id }) => interviews.remove(decodeId(id)));
}
