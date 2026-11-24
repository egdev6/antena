// Chat preview in the real sources: while on, every chat widget page plays the demo stream
// instead of the real chat. Ephemeral (never persisted) and stops by itself.

export const CHAT_PREVIEW_DEFAULT_SEC = 120;
export const CHAT_PREVIEW_MAX_SEC = 600;

export function createChatPreview(bus) {
  let until = null, timer = null;
  const snapshot = () => ({ on: until !== null, until });
  const publish = () => bus.send('chatPreview', snapshot(), ['widget', 'panel']);
  function stop() {
    clearTimeout(timer); timer = null;
    const was = until !== null;
    until = null;
    if (was) publish();
    return snapshot();
  }
  function start(seconds = CHAT_PREVIEW_DEFAULT_SEC) {
    clearTimeout(timer);
    until = new Date(Date.now() + seconds * 1000).toISOString();
    timer = setTimeout(stop, seconds * 1000);
    timer.unref?.();
    publish();
    return snapshot();
  }
  return { start, stop, snapshot };
}
