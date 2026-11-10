// Contrato de métricas finalizadas v1: sin escrituras ni suma entre plataformas.
import { viewerMetrics, chatMetrics } from './session.mjs';

const PLATFORMS = [
  { platform: 'twitch', id: 'streamId', viewers: 'twitch.helix.streams', chat: 'twitch.irc' },
  { platform: 'youtube', id: 'videoId', viewers: 'youtube.videos.liveStreamingDetails', chat: 'youtube.liveChat.messages' },
];

// The contract always uses UTC with milliseconds, even for legacy offsets.
const iso = value => new Date(Date.parse(value)).toISOString();

export function exportSession(data, now = Date.now()) {
  const startedAt = iso(data.startedAt), endedAt = iso(data.endedAt);
  const seconds = Math.max(0, (Date.parse(data.endedAt) - Date.parse(data.startedAt)) / 1000);
  // Integer seconds never exceed the real duration, and ratios derive from the exported integers.
  const liveSeconds = Math.floor(seconds);
  const viewers = viewerMetrics(data, now) || {}, chats = chatMetrics(data, now, false) || {};
  const platforms = [], metrics = [];
  for (const p of PLATFORMS) {
    const externalId = data.platforms?.[p.platform]?.[p.id] || null;
    const live = externalId !== null;
    platforms.push({ platform: p.platform, externalId, live });
    const viewer = viewers[p.platform];
    const raw = live && viewer?.average != null ? viewer.coverage.coveredSeconds : 0;
    // Less than one covered second is unavailable, never rounded up into a value.
    const covered = raw >= 1 ? Math.min(liveSeconds, Math.round(raw)) : 0;
    const hasViewers = covered > 0;
    const viewerCoverage = { basis: 'viewer_samples', liveSeconds, coveredSeconds: covered,
      ratio: hasViewers ? covered / liveSeconds : 0 };
    const listening = live && (data.chatListeners?.[p.platform] === true || data.chatStats?.[p.platform] !== undefined);
    const chat = chats[p.platform] || { uniqueChatters: 0, messages: 0, messagesPerMinute: seconds ? 0 : null };
    const chatCoverage = { basis: 'platform_presence', liveSeconds, coveredSeconds: null, ratio: listening ? 1 : 0 };
    const add = (metric, value, unit, coverage, source) => metrics.push({
      sessionId: data.id, platform: p.platform, metric, value, unit, capturedAt: endedAt, final: true, coverage, source,
    });
    add('viewers_average', hasViewers ? viewer.average : null, 'count', viewerCoverage, p.viewers);
    add('viewers_peak', hasViewers ? viewer.peak : null, 'count', viewerCoverage, p.viewers);
    add('chat_unique_chatters', listening ? chat.uniqueChatters : null, 'count', chatCoverage, p.chat);
    add('chat_messages', listening ? chat.messages : null, 'count', chatCoverage, p.chat);
    add('chat_messages_per_minute', listening ? chat.messagesPerMinute : null, 'per_minute', chatCoverage, p.chat);
  }
  return { session: { id: data.id, startedAt, endedAt, platforms }, metrics };
}
