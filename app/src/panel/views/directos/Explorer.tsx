import { ChatChart, ViewerChart, viewerGapReason } from '../../../lib/charts';
import { enc } from '../../../lib/api';
import { EmptyState, fmtTime } from '../../../lib/ui';
import type { AlertType, Platform } from '../../../lib/types';
import { dateTime, duration, formatCoverage, formatNumber, hasMetrics, platformNames, platforms, plural, type Past, type Summary } from './model';

export type SummaryState = { id: string | null; data: Summary | null; loading: boolean; error: boolean };
const Missing = () => <span aria-label="sin dato">—</span>;
const Value = ({ value }: { value: string | null }) => value === null ? <Missing /> : <>{value}</>;
function Coverage({ ratio }: { ratio?: number | null }) {
  const value = formatCoverage(ratio);
  return value === null ? <Missing /> : <span className={ratio != null && ratio < 1 ? 'dx-warn' : undefined}>{value}</span>;
}
function PlatformLabel({ platform }: { platform: Platform }) {
  return <span className={`dx-platform dx-${platform}`}>{platformNames[platform]}</span>;
}
function MetricsTable({ session }: { session: Past }) {
  if (!hasMetrics(session)) return <p className="dx-no-metrics">Sin métricas</p>;
  return <table className="dx-stats">
    <caption className="sr-only">Métricas por plataforma de {session.title || 'este directo'}</caption>
    <thead><tr><th scope="col">Canal</th><th scope="col">Media</th><th scope="col">Pico</th><th scope="col">Únicos</th><th scope="col">Msg/min</th><th scope="col">Cobertura</th></tr></thead>
    <tbody>{platforms.map(p => <tr key={p}><th scope="row"><PlatformLabel platform={p} /></th>
      <td><Value value={formatNumber(session.viewerMetrics?.[p]?.average, 1)} /></td>
      <td><Value value={formatNumber(session.viewerMetrics?.[p]?.peak)} /></td>
      <td><Value value={formatNumber(session.chatMetrics?.[p]?.uniqueChatters)} /></td>
      <td><Value value={formatNumber(session.chatMetrics?.[p]?.messagesPerMinute, 1)} /></td>
      <td><Coverage ratio={session.viewerMetrics?.[p]?.coverage?.ratio} /></td></tr>)}</tbody>
  </table>;
}

export function SessionList({ past, filtered, query, onQuery, selected, onSelect, loading, error, retry }: {
  past: Past[]; filtered: Past[]; query: string; onQuery: (q: string) => void; selected: string | null;
  onSelect: (id: string) => void; loading: boolean; error: boolean; retry: () => void;
}) {
  return <section className="lv-panel dx-list" aria-labelledby="dx-list-title">
    <div className="lv-panel-h"><h2 id="dx-list-title">Directos recientes</h2><p>{plural(past.length, 'directo', 'directos')} · más recientes primero</p></div>
    <div className="lv-tools"><label className="lv-search"><span className="sr-only">Buscar por título o fecha</span>
      <input type="search" placeholder="Buscar por título o fecha" value={query} onChange={e => onQuery(e.target.value)} /></label></div>
    <p className="dx-intro">Media y pico de espectadores; chat por plataforma.</p>
    <div className="dx-scroll" role="region" aria-label="Lista de directos, desplazable" tabIndex={0}>
      {loading ? <p className="dx-state" role="status">Cargando directos…</p> : error ? <div className="dx-state" role="alert">No se pudieron cargar los directos. <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={retry}>Reintentar</button></div> :
        !filtered.length ? <div className="dx-state"><EmptyState>{past.length ? 'Ningún directo coincide.' : 'Todavía no hay directos archivados.'}</EmptyState></div> :
        filtered.map(p => <article key={p.id} className={`dx-session${p.id === selected ? ' is-selected' : ''}`}>
          <div className="dx-session-head"><div><span className="dx-caption">{dateTime(p.startedAt)} · {duration(p.startedAt, p.endedAt)}</span>
            <h3>{p.title || 'Sin título'}</h3><span className="dx-caption">{plural(p.events ?? 0, 'evento', 'eventos')}{p.pending ? ' · Archivándose' : ''}</span></div>
            <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" aria-pressed={p.id === selected} aria-controls="detalle" onClick={() => onSelect(p.id)}>
              {p.id === selected ? 'Seleccionado' : 'Ver análisis'}<span className="sr-only"> · {p.title || 'Sin título'}</span></button></div>
          <MetricsTable session={p} />
        </article>)}
    </div>
  </section>;
}

export function SessionDetail({ selected, session, summary, retry, types }: { selected: string | null; session?: Past; summary: SummaryState; retry: () => void; types: Record<string, AlertType> }) {
  const data = summary.id === selected ? summary.data : null;
  const loading = selected && (summary.id !== selected || summary.loading);
  const error = summary.id === selected && summary.error;
  const title = data?.title || session?.title || 'Sin título';
  const events = data?.events || [];
  const validStart = !!data?.startedAt && Number.isFinite(Date.parse(data.startedAt));
  const viewerPresent = platforms.some(p => data?.viewers?.[p]);
  const chatPresent = platforms.some(p => data?.chatMetrics?.[p]);
  const gaps = platforms.flatMap(p => {
    const series = data?.viewers?.[p];
    return (series?.gaps || []).map((gap, i) => {
      const end = series?.openGap && i === series.gaps.length - 1 ? data?.endedAt || new Date().toISOString() : gap.to;
      return `${platformNames[p]}: sin muestras ${fmtTime(gap.from) || '—'}–${fmtTime(end) || '—'} (${viewerGapReason(gap.reason)}).`;
    });
  });
  return <section className="lv-panel dx-detail" id="detalle" aria-labelledby="dx-detail-title">
    {!selected ? <div className="dx-detail-head"><h2 id="dx-detail-title">Selecciona un directo</h2><p>Elige un directo de la lista para ver su análisis.</p></div> : <>
      <div className="dx-detail-head"><div className="dx-detail-title"><div><span className="dx-eyebrow">Directo seleccionado · solo lectura</span>
        <h2 id="dx-detail-title">{title}</h2><p>{dateTime(data?.startedAt || session?.startedAt)} · {duration(data?.startedAt || session?.startedAt, data?.endedAt || session?.endedAt)} · {plural(data ? events.length : (session?.events ?? 0), 'evento', 'eventos')}</p></div>
        <a className="eg-btn eg-btn--secondary eg-btn--sm" href={`#/directos/${enc(selected)}/resumen`}>Resumen completo</a></div>
        {data && hasMetrics(data) ? <div className="dx-coverage">{platforms.map(p => <span key={p} className="dx-badge">{platformNames[p]} · espectadores <Coverage ratio={data.viewerMetrics?.[p]?.coverage?.ratio} /></span>)}</div> : null}
      </div>
      {loading ? <p className="dx-state" role="status">Cargando resumen…</p> : error ? <div className="dx-state" role="alert">No se pudo cargar el resumen de este directo. <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={retry}>Reintentar</button></div> : data ? <div className="dx-detail-body">
        {!hasMetrics(data) ? <p className="dx-no-metrics">{data.meldAutoSession === true ? 'Sin métricas — no se registraron métricas; no son valores cero' : 'Sin métricas — iniciado manualmente o anterior a las métricas; no son valores cero'}</p> : <>
          <figure className="dx-figure"><div className="dx-chart-title"><h3>Espectadores durante el directo</h3><span className="dx-caption">Muestras · no se suman</span></div>
            {validStart && viewerPresent ? <ViewerChart start={data.startedAt!} end={data.endedAt} series={data.viewers || {}} /> : <p className="dx-caption">Sin datos de espectadores.</p>}
            <figcaption className="dx-chart-caption">{platforms.map(p => <span key={p}><PlatformLabel platform={p} />{data.viewers?.[p] ? '' : ' · sin datos'} </span>)} · {gaps.length ? gaps.join(' ') : 'Sin huecos registrados.'} Un hueco no es cero.</figcaption>
          </figure>
          <div className="dx-lower"><figure className="dx-figure"><h3>Actividad del chat</h3>
            {validStart && chatPresent ? <ChatChart start={data.startedAt!} end={data.endedAt} series={data.chatMetrics || {}} /> : null}
            <figcaption className="dx-chart-caption">{platforms.map(p => <div key={p}><PlatformLabel platform={p} /> · {data.chatMetrics?.[p] ? <><Value value={formatNumber(data.chatMetrics[p]?.messages)} /> {data.chatMetrics[p]?.messages === 1 ? 'mensaje' : 'mensajes'} · <Value value={formatNumber(data.chatMetrics[p]?.uniqueChatters)} /> {data.chatMetrics[p]?.uniqueChatters === 1 ? 'persona' : 'personas'} · <Value value={formatNumber(data.chatMetrics[p]?.messagesPerMinute, 1)} />/min</> : 'sin datos de chat'}</div>)}</figcaption>
          </figure><Moments events={events} types={types} /></div>
        </>}
        {!hasMetrics(data) ? <Moments events={events} types={types} /> : null}
      </div> : null}
    </>}
  </section>;
}
function Moments({ events, types }: { events: NonNullable<Summary['events']>; types: Record<string, AlertType> }) {
  return <section className="dx-moments" aria-labelledby="dx-moments-title"><h3 id="dx-moments-title">Momentos del directo</h3><p className="dx-caption">Selección de la cronología</p>
    {events.length ? <ol>{events.slice(0, 5).map((event, index) => {
      const meta = types?.[event.type], platform = meta?.platform;
      return <li key={event.id || index}><b>{fmtTime(event.at || event.ts) || '—'}</b> · {platform === 'twitch' || platform === 'youtube' ? `${platformNames[platform]} · ` : ''}{meta?.label || event.type || 'Evento'}</li>;
    })}</ol> : <p className="dx-caption">Sin eventos.</p>}
  </section>;
}
