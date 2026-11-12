import { httpError } from '../http-util.mjs';
import { matchesFollowerSelection } from '../followers.mjs';

export function registerFollowersRoutes({ route, followers, thanksSelection }) {
  route('GET', '/api/followers', async (_, __, url) => ({
    ...followers.list({ pending: url.searchParams.get('pending') === 'true' }),
    ...(url.searchParams.get('shown') === 'true' && thanksSelection ? { shown: thanksSelection() } : {}),
  }));
  route('POST', '/api/followers/thank', async body => {
    const object = body && typeof body === 'object' && !Array.isArray(body);
    const all = object && body.all === true && !Object.hasOwn(body, 'ids') && Object.keys(body).length === 1;
    const ids = object && Array.isArray(body.ids) && !Object.hasOwn(body, 'all') && Object.keys(body).length === 1
      && body.ids.every(id => typeof id === 'string' && !!id.trim());
    const selected = object && (Object.hasOwn(body, 'entries') || Object.hasOwn(body, 'anonymous'));
    if (selected) {
      const validEntry = e => e && typeof e === 'object' && !Array.isArray(e)
        && ['twitch', 'youtube'].includes(e.platform) && Object.keys(e).length === 2
        && ((Object.hasOwn(e, 'id') && typeof e.id === 'string' && !!e.id.trim())
          || (Object.hasOwn(e, 'name') && typeof e.name === 'string' && !!e.name.trim()));
      const validAt = at => {
        if (at === null) return true;
        if (typeof at !== 'string') return false;
        const time = Date.parse(at);
        return Number.isFinite(time) && new Date(time).toISOString() === at;
      };
      if (Object.keys(body).some(k => !['entries', 'anonymous', 'onlyShown'].includes(k))
        || (Object.hasOwn(body, 'entries') && (!Array.isArray(body.entries) || !body.entries.every(validEntry)))
        || (Object.hasOwn(body, 'anonymous') && (!Array.isArray(body.anonymous) || !body.anonymous.every(validAt)))
        || (Object.hasOwn(body, 'onlyShown') && body.onlyShown !== true))
        throw httpError(400, 'Indica «entries» y/o «anonymous» con selecciones válidas.');
      // Validate and mark synchronously: no configuration or follower change can slip between them.
      // In read-only mode let markSelected retain its existing 503 response.
      if (body.onlyShown && !followers.readOnly) {
        const shown = thanksSelection();
        const hiddenEntry = (body.entries || []).some(selected =>
          !shown.entries.some(entry => matchesFollowerSelection(entry.platform, entry, selected)));
        const hiddenAnonymous = (body.anonymous || []).some(at => !shown.anonymous.some(record => record.at === at));
        if (hiddenEntry || hiddenAnonymous) throw httpError(409, 'La selección del widget ha cambiado. Actualiza la lista antes de agradecer.');
      }
      followers.markSelected(body);
    } else {
      if (!all && !ids) throw httpError(400, 'Indica «ids» como lista de identificadores o «all»: true.');
      followers.markThanked(all ? 'all' : body.ids);
    }
    await followers.flush();
    return followers.list();
  });
}
