import type { ChatSeries, ViewerSeries } from '../../../lib/charts';
import type { Platform } from '../../../lib/types';

export type ByPlatform<T> = Partial<Record<Platform, T>>;
export type ViewerMetric = { average: number | null; peak: number | null; coverage?: { ratio?: number | null } };
export type ChatMetric = ChatSeries & { uniqueChatters?: number | null; messages?: number; messagesPerMinute?: number | null };
export type Past = {
  id: string; title?: string; startedAt?: string; endedAt?: string; events?: number; pending?: boolean;
  viewerMetrics?: ByPlatform<ViewerMetric>; chatMetrics?: ByPlatform<ChatMetric>;
};
export type SessionEvent = { id?: string; at?: string; ts?: string; type: string; user?: string; sub?: string };
export type SessionNote = { id?: string; at?: string; kind?: string; label?: string };
export type Summary = Omit<Past, 'events'> & {
  meldAutoSession?: boolean; viewers?: ByPlatform<ViewerSeries>; events?: SessionEvent[]; notes?: SessionNote[];
  totals?: Record<string, number>; credits?: { title: string; names: string[] }[];
};
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const platforms: Platform[] = ['twitch', 'youtube'];
export const platformNames: Record<Platform, string> = { twitch: 'Twitch', youtube: 'YouTube' };
export const hasMetrics = (p: Pick<Past, 'viewerMetrics' | 'chatMetrics'>) => platforms.some(platform => !!p.viewerMetrics?.[platform] || !!p.chatMetrics?.[platform]);
export const formatNumber = (n: number | null | undefined, decimals = 0) => n == null || !Number.isFinite(n) ? null :
  n.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const formatCoverage = (ratio: number | null | undefined) => {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const rounded = Math.round(ratio * 100);
  const percent = ratio > 0 && rounded === 0 ? '<1' : ratio < 1 && rounded === 100 ? '<100' : String(rounded);
  return `${percent} %${ratio < 1 ? ' parcial' : ''}`;
};
export const dateTime = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const duration = (start?: string, end?: string) => {
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return '—';
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
};
