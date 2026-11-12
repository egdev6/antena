// Shared setup for the goal browser tests (#132): Chrome + built panel, and a seeded Twitch
// channel total so default follower bars start at a known value instead of «—».
import { skipIfNoBrowserOrUi } from './react-browser.mjs';

export async function goalsBrowserUi(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  return bin ? { bin, dist: undefined } : null;
}

export async function seedTwitchTotals(app) {
  app.channelTotals.readers = { 'follows@twitch': async () => 0, 'subs@twitch': async () => 0 };
  await app.channelTotals.poll();
}
