// Playback controls target widget subscribers only.
export function registerCreditsRoutes({ route, bus }) {
  route('POST', '/api/credits/play', async () => { bus.send('credits', { action: 'play' }, ['widget']); return { ok: true }; });
  route('POST', '/api/credits/stop', async () => { bus.send('credits', { action: 'stop' }, ['widget']); return { ok: true }; });
}
