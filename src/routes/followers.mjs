import { httpError } from '../http-util.mjs';

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
      const validAt = at => at === null || (typeof at === 'string' && Number.isFinite(Date.parse(at)));
      if (Object.keys(body).some(k => !['entries', 'anonymous'].includes(k))
        || (Object.hasOwn(body, 'entries') && (!Array.isArray(body.entries) || !body.entries.every(validEntry)))
        || (Object.hasOwn(body, 'anonymous') && (!Array.isArray(body.anonymous) || !body.anonymous.every(validAt))))
        throw httpError(400, 'Indica «entries» y/o «anonymous» con selecciones válidas.');
      followers.markSelected(body);
    } else {
      if (!all && !ids) throw httpError(400, 'Indica «ids» como lista de identificadores o «all»: true.');
      followers.markThanked(all ? 'all' : body.ids);
    }
    await followers.flush();
    return followers.list();
  });
}
