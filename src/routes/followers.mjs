import { httpError } from '../http-util.mjs';

export function registerFollowersRoutes({ route, followers }) {
  route('GET', '/api/followers', async (_, __, url) => followers.list({ pending: url.searchParams.get('pending') === 'true' }));
  route('POST', '/api/followers/thank', async body => {
    const object = body && typeof body === 'object' && !Array.isArray(body);
    const all = object && body.all === true && !Object.hasOwn(body, 'ids') && Object.keys(body).length === 1;
    const ids = object && Array.isArray(body.ids) && !Object.hasOwn(body, 'all') && Object.keys(body).length === 1
      && body.ids.every(id => typeof id === 'string' && !!id.trim());
    if (!all && !ids) throw httpError(400, 'Indica «ids» como lista de identificadores o «all»: true.');
    followers.markThanked(all ? 'all' : body.ids);
    await followers.flush();
    return followers.list();
  });
}
