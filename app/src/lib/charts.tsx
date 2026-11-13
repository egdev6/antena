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

type Gap = { from: number; to: number; reason?: string; open: boolean };
type Point = { at: number; value: number; interval: number };
function seriesGaps(series: ViewerSeries, from: number, to: number): Gap[] {
  return (series.gaps || []).map((g, i) => {
    const open = !!series.openGap && i === series.gaps.length - 1;
    return { from: Math.max(from, Date.parse(g.from)), to: Math.min(to, open ? to : Date.parse(g.to)), reason: g.reason, open };
  }).filter(g => Number.isFinite(g.from) && Number.isFinite(g.to) && g.from <= g.to && g.from <= to && g.to >= from);
}

/** Only recorded samples outside gaps are points; an interval never extends a line by itself. */
function seriesPoints(series: ViewerSeries, from: number, to: number, gaps: Gap[]): Point[] {
  const intervals = series.intervals || [], result: Point[] = [];
  let intervalIndex = 0;
  for (const sample of series.samples || []) {
    const at = Date.parse(sample.at);
    if (!Number.isFinite(at) || !Number.isFinite(sample.value)) continue;
    while (intervalIndex + 1 < intervals.length && Date.parse(intervals[intervalIndex + 1].from) <= at) intervalIndex++;
    if (at < from || at > to || gaps.some(g => g.from <= at && (at < g.to || (g.open && at === g.to)))) continue;
    result.push({ at, value: sample.value, interval: (intervals[intervalIndex]?.seconds ?? 60) * 1000 });
  }
  return result;
}

function ChartAxes({ max }: { max: number }) {
  return <>
    {[0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = bottom - (bottom - top) * f;
      return <g key={f}><line className="dx-gridline" x1={left} x2={right} y1={y} y2={y} />
        <text className="dx-axis dx-axis-y" x={left - 6} y={y + 3} textAnchor="end">{number(max * f)}</text></g>;
    })}
    <line className="dx-axis-line" x1={left} x2={left} y1={top} y2={bottom} />
    <line className="dx-axis-line" x1={left} x2={right} y1={bottom} y2={bottom} />
  </>;
}

export function ViewerChart({ start, end, series }: { start: string; end?: string; series: Platforms<ViewerSeries> }) {
  const id = useId().replace(/:/g, ''), { from, to } = bounds(start, end);
  const plots = platforms.flatMap(platform => {
    const data = series[platform]; if (!data) return [];
    const gaps = seriesGaps(data, from, to);
    return [{ platform, gaps, points: seriesPoints(data, from, to, gaps) }];
  });
  const max = plots.reduce((highest, plot) => plot.points.reduce((n, point) => Math.max(n, point.value), highest), 1);
  const x = (value: number) => coordinate(value, from, to);
  const y = (value: number) => bottom - (bottom - top) * value / max;
  const description = platforms.map(p => {
    const plot = plots.find(item => item.platform === p);
    if (!plot) return `${names[p]}: sin datos de espectadores.`;
    const values = plot.points.slice(0, 12).map(v => number(v.value)).join(', ');
    const gapText = plot.gaps.map(g => `hueco ${time(g.from)}–${time(g.to)} (${viewerGapReason(g.reason)})`).join(', ');
    return `${names[p]}: ${values || 'sin muestras'}${plot.points.length > 12 ? ` y ${plot.points.length - 12} muestras más` : ''}; ${gapText || 'sin huecos registrados'}.`;
  }).join(' ') + ' Los huecos no son valores cero.';
  return <svg className={`dx-chart dx-viewer-chart${plots.length > 1 ? ' dx-compare' : ''}`} viewBox="0 0 500 155" role="img" aria-label="Evolución de espectadores">
    <title>Evolución de espectadores</title><desc>{description}</desc>
    <defs><pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" className="dx-hatch-line" /></pattern></defs>
    <ChartAxes max={max} />
    {plots.flatMap(({ platform, gaps }) => gaps.map((gap, i) => <rect key={`${platform}-gap-${i}`} data-gap={platform}
      data-from={new Date(gap.from).toISOString()} data-to={new Date(gap.to).toISOString()}
      x={x(gap.from)} y={top} width={Math.max(1, x(gap.to) - x(gap.from))} height={bottom - top} fill={`url(#${id})`} />))}
    {plots.flatMap(({ platform, points, gaps }) => points.slice(1).flatMap((point, i) => {
      const previous = points[i];
      if (point.at <= previous.at || point.at > previous.at + previous.interval || gaps.some(g => g.from < point.at && g.to > previous.at)) return [];
      return [<path key={`${platform}-${i}`} className={`dx-curve dx-${platform}`} data-series={platform}
        data-from={new Date(previous.at).toISOString()} data-to={new Date(point.at).toISOString()}
        d={`M ${x(previous.at)} ${y(previous.value)} L ${x(point.at)} ${y(point.value)}`} />];
    }))}
    {plots.flatMap(({ platform, points }) => points.map((point, i) => <circle key={`${platform}-point-${i}`} className={`dx-point dx-${platform}`}
      data-at={new Date(point.at).toISOString()} data-value={point.value} cx={x(point.at)} cy={y(point.value)} r="3" />))}
    {[from, (from + to) / 2, to].map((t, i) => <text key={i} className="dx-axis" x={x(t)} y="150" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{time(t)}</text>)}
  </svg>;
}

/** Missing minutes are zero only for a platform with an observed chat series. */
export function ChatChart({ start, end, series }: { start: string; end?: string; series: Platforms<ChatSeries> }) {
  const { from, to } = bounds(start, end);
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
    <ChartAxes max={max} />
    {present.flatMap((p, index) => (values[p] || []).map((value, i) => {
      const height = (bottom - top) * value / max;
      return <rect key={`${p}-${i}`} data-chat-bar={p} data-value={value} className={`dx-bar dx-${p}`}
        x={left + i * groupWidth + index * barWidth} y={bottom - height} width={Math.max(0, barWidth - 0.6)} height={height} />;
    }))}
    <text className="dx-axis" x={left} y="150">{time(from)}</text><text className="dx-axis" x={right} y="150" textAnchor="end">{time(to)}</text>
  </svg>;
}
