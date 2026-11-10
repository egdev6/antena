import { useId } from 'react';
import type { Platform } from './types';
import { fmtTime } from './ui';

export type ViewerSeries = {
  samples: { at: string; value: number }[];
  gaps: { from: string; to: string; reason?: string }[];
  intervals?: { from: string; seconds: number }[];
  openGap?: boolean;
};
export type ChatSeries = { minutes?: { at: string; messages: number }[] };
type Platforms<T> = Partial<Record<Platform, T>>;
const platforms: Platform[] = ['twitch', 'youtube'];
const names: Record<Platform, string> = { twitch: 'Twitch', youtube: 'YouTube' };
const left = 42, right = 478, top = 18, bottom = 130;
const time = (value: number) => fmtTime(new Date(value)) || '—';
const number = (value: number) => value.toLocaleString('es-ES', { maximumFractionDigits: 1 });
export const viewerGapReason = (reason?: string) => ({ error: 'error', offline: 'fuera de directo', disconnected: 'desconexión', restart: 'reinicio' } as Record<string, string>)[reason || ''] || 'motivo desconocido';
const bounds = (start: string, end?: string) => {
  const from = Date.parse(start), parsedEnd = end ? Date.parse(end) : Date.now();
  return { from, to: Number.isFinite(parsedEnd) ? Math.max(from + 1, parsedEnd) : from + 1 };
};
const coordinate = (value: number, from: number, to: number) => left + (right - left) * (value - from) / (to - from);

type Gap = { from: number; to: number; reason?: string };
function seriesGaps(series: ViewerSeries, from: number, to: number): Gap[] {
  return (series.gaps || []).map((g, i) => ({ from: Math.max(from, Date.parse(g.from)),
    to: Math.min(to, series.openGap && i === series.gaps.length - 1 ? to : Date.parse(g.to)), reason: g.reason }))
    .filter(g => Number.isFinite(g.from) && Number.isFinite(g.to) && g.from <= g.to && g.from <= to && g.to >= from);
}

/** A sample is drawn only for its recorded interval, excluding every recorded gap. */
function segments(series: ViewerSeries, from: number, to: number, gaps: Gap[]) {
  const samples = series.samples || [], intervals = series.intervals || [];
  const result: { from: number; to: number; value: number; previous?: number }[] = [];
  let intervalIndex = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i], at = Date.parse(sample.at);
    if (!Number.isFinite(at) || !Number.isFinite(sample.value)) continue;
    while (intervalIndex + 1 < intervals.length && Date.parse(intervals[intervalIndex + 1].from) <= at) intervalIndex++;
    const next = samples[i + 1] ? Date.parse(samples[i + 1].at) : Infinity;
    const limit = Math.min(to, Number.isFinite(next) ? next : Infinity, at + (intervals[intervalIndex]?.seconds ?? 60) * 1000);
    let cursor = Math.max(from, at);
    const append = (end: number) => {
      if (end <= cursor) return;
      const last = result[result.length - 1];
      result.push({ from: cursor, to: end, value: sample.value, ...(last?.to === cursor ? { previous: last.value } : {}) });
    };
    for (const gap of gaps) {
      if (gap.to <= cursor) continue;
      if (gap.from >= limit) break;
      append(Math.min(gap.from, limit));
      cursor = Math.max(cursor, gap.to);
    }
    append(limit);
  }
  return result;
}

export function ViewerChart({ start, end, series }: { start: string; end?: string; series: Platforms<ViewerSeries> }) {
  const id = useId().replace(/:/g, ''), { from, to } = bounds(start, end);
  const max = platforms.reduce((highest, p) => (series[p]?.samples || []).reduce((n, s) => Number.isFinite(s.value) ? Math.max(n, s.value) : n, highest), 1);
  const x = (value: number) => coordinate(value, from, to);
  const y = (value: number) => bottom - (bottom - top) * value / max;
  const description = platforms.map(p => {
    const s = series[p];
    if (!s) return `${names[p]}: sin datos de espectadores.`;
    const samples = s.samples || [], values = samples.slice(0, 12).map(v => number(v.value)).join(', ');
    const gapText = seriesGaps(s, from, to).map(g => `hueco ${time(g.from)}–${time(g.to)} (${viewerGapReason(g.reason)})`).join(', ');
    return `${names[p]}: ${values || 'sin muestras'}${samples.length > 12 ? ` y ${samples.length - 12} muestras más` : ''}; ${gapText || 'sin huecos registrados'}.`;
  }).join(' ') + ' Los huecos no son valores cero.';
  return <svg className="dx-chart dx-viewer-chart" viewBox="0 0 500 155" role="img" aria-label="Evolución de espectadores">
    <title>Evolución de espectadores</title><desc>{description}</desc>
    <defs><pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" className="dx-hatch-line" /></pattern></defs>
    {[0, 0.5, 1].map(f => <g key={f}><line className="dx-gridline" x1={left} x2={right} y1={y(max * f)} y2={y(max * f)} /><text className="dx-axis" x="4" y={y(max * f) + 3}>{number(max * f)}</text></g>)}
    {platforms.flatMap(p => {
      const s = series[p]; if (!s) return [];
      const gaps = seriesGaps(s, from, to);
      return gaps.map((gap, i) => <rect key={`${p}-gap-${i}`} data-gap={p} data-from={new Date(gap.from).toISOString()} data-to={new Date(gap.to).toISOString()}
        x={x(gap.from)} y={top} width={Math.max(1, x(gap.to) - x(gap.from))} height={bottom - top} fill={`url(#${id})`} />);
    })}
    {platforms.flatMap(p => {
      const s = series[p]; if (!s) return [];
      return segments(s, from, to, seriesGaps(s, from, to)).map((segment, i) => <path key={`${p}-${i}`} className={`dx-curve dx-${p}`}
        data-series={p} data-from={new Date(segment.from).toISOString()} data-to={new Date(segment.to).toISOString()}
        d={`M ${x(segment.from)} ${y(segment.previous ?? segment.value)} V ${y(segment.value)} H ${x(segment.to)}`} />);
    })}
    {[from, (from + to) / 2, to].map((t, i) => <text key={i} className="dx-axis" x={x(t)} y="150" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{time(t)}</text>)}
  </svg>;
}

/** Missing minutes are zero only for a platform with an observed chat series. */
export function ChatChart({ start, end, series }: { start: string; end?: string; series: Platforms<ChatSeries> }) {
  const id = useId().replace(/:/g, ''), { from, to } = bounds(start, end);
  const count = Math.max(1, Math.ceil((to - from) / 60000));
  const present = platforms.filter(p => series[p]);
  const values = Object.fromEntries(present.map(p => {
    const byMinute = new Map<number, number>();
    for (const m of series[p]?.minutes || []) {
      const i = Math.floor((Date.parse(m.at) - from) / 60000);
      if (i >= 0 && i < count) byMinute.set(i, m.messages);
    }
    return [p, Array.from({ length: count }, (_, i) => byMinute.get(i) ?? 0)];
  })) as Partial<Record<Platform, number[]>>;
  const max = present.reduce((highest, p) => (values[p] || []).reduce((n, value) => Math.max(n, value), highest), 1);
  const description = platforms.map(p => values[p] ? `${names[p]}: ${(values[p] || []).slice(0, 24).join(', ')} mensajes por minuto${count > 24 ? ` y ${count - 24} minutos más` : ''}.` : `${names[p]}: sin datos de chat.`).join(' ');
  const groupWidth = (right - left) / count, barWidth = groupWidth / Math.max(1, present.length);
  return <svg className="dx-chart dx-chat-chart" viewBox="0 0 500 155" role="img" aria-label="Mensajes por minuto">
    <title>Mensajes por minuto</title><desc>{description}</desc>
    <defs><pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" className="dx-hatch-bg" /><line x1="0" y1="0" x2="0" y2="6" className="dx-chat-hatch-line" /></pattern></defs>
    {[0, 0.5, 1].map(f => <g key={f}><line className="dx-gridline" x1={left} x2={right} y1={bottom - (bottom - top) * f} y2={bottom - (bottom - top) * f} /><text className="dx-axis" x="4" y={bottom - (bottom - top) * f + 3}>{number(max * f)}</text></g>)}
    {present.flatMap((p, index) => (values[p] || []).map((value, i) => {
      const height = (bottom - top) * value / max;
      return <rect key={`${p}-${i}`} data-chat-bar={p} data-value={value} className={`dx-bar dx-${p}`}
        x={left + i * groupWidth + index * barWidth} y={bottom - height} width={Math.max(0, barWidth - 0.6)} height={height}
        fill={p === 'youtube' ? `url(#${id})` : undefined} />;
    }))}
    <text className="dx-axis" x={left} y="150">{time(from)}</text><text className="dx-axis" x={right} y="150" textAnchor="end">{time(to)}</text>
  </svg>;
}
