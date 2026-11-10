import { useEffect, useRef, useState } from 'react';
import { get, post, put } from '../../lib/api';
import { ViewerChart, type ViewerSeries } from '../../lib/charts';
import { IC } from '../../lib/icons';
import { live, useLive } from '../../lib/live';
import { ConnPill, copy, cx, EmptyState, fmtDateTime, fmtTime, guard, Icon, LazyInput, mmss, PfIcon, Progress, Sec, Status, toast, type Tone } from '../../lib/ui';
import type { AlertType, AppState, ChatSendResult, Platform, SessionList, SessionSummary, TimelineItem, ViewerPlatform, ViewerSettings } from '../../lib/types';
import { SendTo, sendResultText } from './Chat';
import { formatCoverage, formatNumber, platformNames, platforms, type ChatMetric, type Summary, type ViewerMetric } from './directos/model';

const NOTE_LABEL: Record<string, string> = { marker: 'Marca de short', highlight: 'Destacado', saved: 'Guardado', question: 'Pregunta', winner: 'Ganador', queue: 'Cola del overlay' };
const HOT = new Set(['sub', 'resub', 'giftsub', 'raid', 'superchat', 'supersticker', 'member', 'giftmember']);
const TOTAL_LABELS: Record<string, [string, string]> = {
  follows: ['seguidor', 'seguidores'], subs: ['suscripción', 'suscripciones'], bits: ['bit', 'bits'],
  raids: ['raid', 'raids'], superchats: ['super chat (€)', 'super chats (€)'], members: ['miembro', 'miembros'],
};
type LiveSession = SessionSummary & Pick<Summary, 'viewers' | 'viewerMetrics' | 'chatMetrics' | 'endedAt' | 'meldAutoSession'> & {
  id: string;
  platforms?: Partial<Record<Platform, { streamId?: string; videoId?: string }>>;
};

/** Most recent first, with the same event and note rendering used before the monitor. */
export function Timeline({ items, types, limit = 60 }: { items: TimelineItem[]; types: Record<string, AlertType>; limit?: number }) {
  if (!items.length) return <EmptyState>Todavía no ha pasado nada.</EmptyState>;
  const list = [...items].reverse().slice(0, limit);
  return <ol className="eg-timeline">{list.map((e, i) => e.kind === 'event'
    ? <li key={e.id} className={cx('eg-timeline__item', HOT.has(e.type ?? '') && 'eg-timeline__item--hot', i === 0 && 'is-new')}>
      <time className="eg-timeline__time">{mmss(e.offset)}</time>
      <span className="eg-timeline__type">{HOT.has(e.type ?? '') && <Icon d={IC.star} />}{types[e.type ?? '']?.label || e.type}</span>
      <span className="eg-timeline__body"><b>{e.user}</b>{e.sub ? ' · ' + e.sub : ''}{e.message && !String(e.sub || '').includes(String(e.message)) ? ` · «${e.message}»` : ''}{e.done ? <span className="tagm n" title="Agradecido"> ✔</span> : null}</span></li>
    : <li key={e.id} className="eg-timeline__item">
      <time className="eg-timeline__time">{mmss(e.offset)}</time>
      <span className="eg-timeline__type">{NOTE_LABEL[e.kind] || e.kind}</span>
      <span className="eg-timeline__body">{e.user ? <><b>{e.user}</b> </> : null}{e.label}{e.text ? <span className="hint"> «{e.text}»</span> : null}{!e.label && !e.text && !e.user ? <span className="hint">Sin nombre</span> : null}</span></li>)}</ol>;
}

export function GoalBars() {
  const goals = useLive(s => s.widgets?.goals || []);
  const metrics = useLive(s => s.metrics || {});
  const visible = goals.filter(g => g.visible !== false && g.bars?.some(b => b.visible !== false));
  if (!visible.length) return null;
  return <div className="goals">{visible.map(g => <article className="goal eg-post" key={g.id}>
    <h3 className="goal-title">{g.title}</h3>
    {g.bars.filter(b => b.visible !== false).map(b => <div className="goal-bar" key={b.id}>
      <div className="goal-top"><span className="goal-platform"><PfIcon platform={b.platform === 'youtube' ? 'youtube' : 'twitch'} />
        {b.platform === 'youtube' ? 'YouTube' : 'Twitch'}
        {g.showMetric !== false && <span className="goal-metric"> · {metrics[b.metric]?.label || b.metric}</span>}</span>
        <b>{b.value ?? 0}/{b.target}</b></div>
      <Progress p={b.target ? (b.value ?? 0) / b.target : 0} label={`${g.title} · ${b.platform} · ${b.metric}`} />
    </div>)}
  </article>)}</div>;
}

function Connections() {
  const st = useLive(s => s.status);
  const scene = useLive(s => s.meld?.session?.scenes?.find(x => x.current)?.name);
  const tw = st.twitch?.state, yt = st.youtube?.state, ch = st.chat?.state, md = st.meld?.state;
  const twTone: Tone = tw === 'conectado' ? 'success' : tw === 'desconectado' ? 'neutral' : st.twitch?.errors?.length ? 'danger' : 'warning';
  // An error state is never shown as «leyendo el chat», even if a stale liveChatId remains.
  const ytOn = yt !== 'error' && (yt === 'escuchando' || yt === 'conectado' || !!st.youtube?.liveChatId);
  const ytTone: Tone = yt === 'error' ? 'danger' : ytOn ? 'success' : 'neutral';
  const mdTone: Tone = md === 'conectado' ? 'success' : md === 'error' ? 'danger' : 'neutral';
  return <div role="group" aria-label="Conexiones" className="row tight dir-connections" data-tour="directo-status">
    <ConnPill platform="twitch" state={tw} tone={twTone} detail={ch && ch !== 'parado' ? `chat ${ch}` : undefined} />
    <ConnPill platform="youtube" state={yt} tone={ytTone} label={ytOn ? 'leyendo el chat' : undefined} />
    <ConnPill platform="meld" state={md} tone={mdTone} label={md === 'conectado' && scene ? `escena «${scene}»` : undefined} />
    <Status tone={st.overlays ? 'success' : 'warning'} icon={IC.monitor}>{st.overlays === 1 ? '1 overlay' : `${st.overlays || 0} overlays`}</Status>
  </div>;
}

function Health({ state, session, idleSeconds, endSession }: { state: AppState; session: LiveSession; idleSeconds: number | null; endSession: () => void }) {
  const st = state.status, warnings: string[] = [];
  const isLive = (p: Platform) => !!state.viewers?.platforms?.[p]?.live || (p === 'youtube' && st.youtube?.state === 'escuchando') ||
    (!!st.meld?.streaming && !session.endedAt && !!(p === 'twitch' ? session.platforms?.twitch?.streamId : session.platforms?.youtube?.videoId));
  if (isLive('twitch') && st.chat?.state !== 'conectado') warnings.push('Twitch: chat no conectado');
  if (isLive('youtube') && !['escuchando', 'conectado'].includes(st.youtube?.state || '')) warnings.push('YouTube: chat no conectado');
  for (const p of platforms) if (!session.endedAt && session.viewers?.[p]?.openGap) warnings.push(`${platformNames[p]}: hueco abierto en espectadores`);
  if (st.pause?.paused) warnings.push('Alertas pausadas');
  if (st.pause?.held) warnings.push(`${st.pause.held} ${st.pause.held === 1 ? 'alerta retenida' : 'alertas retenidas'}`);
  if (!st.overlays) warnings.push('0 overlays conectados');
  const count = warnings.length + (idleSeconds !== null ? 1 : 0);
  return <section className="dir-health" aria-label="Salud y conexiones del directo">
    <div className={cx('dir-health-line', count > 0 && 'is-warning')} role="status">
      {count ? <><strong>{count} {count === 1 ? 'aviso' : 'avisos'}</strong>{warnings.length > 0 && <span>{warnings.join(' · ')}</span>}
        {idleSeconds !== null && <span>Sesión abierta sin emisión · empezó hace {mmss(idleSeconds)} · <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={endSession}>Cerrarla</button></span>}</> : <strong>Todo en orden</strong>}
    </div>
    <Connections />
  </section>;
}

/** A value is current only inside its polling interval; gaps never fall back to the watcher. */
function currentViewers(series: ViewerSeries | undefined, now: number, watcher?: ViewerPlatform, settings?: ViewerSettings) {
  if (!series) {
    if (!settings?.enabled || !watcher?.live || watcher.off || watcher.error || watcher.current == null || !Number.isFinite(watcher.current)) return null;
    const at = Date.parse(watcher.updatedAt || '');
    const interval = Math.min(600, Math.max(20, Number.isFinite(settings.pollSec) ? settings.pollSec : 60));
    return Number.isFinite(at) && at <= now && now < at + interval * 1000 ? watcher.current : null;
  }
  const sample = series.samples?.at(-1);
  if (!sample || series.openGap || !Number.isFinite(sample.value)) return null;
  const at = Date.parse(sample.at);
  const interval = (series.intervals || []).filter(i => Date.parse(i.from) <= at).at(-1)?.seconds ?? 60;
  if (!Number.isFinite(at) || at > now || now >= at + interval * 1000) return null;
  if ((series.gaps || []).some(g => Date.parse(g.from) <= now && now < Date.parse(g.to))) return null;
  return sample.value;
}

/** Buckets are aligned to the session start; absent buckets are zero only for an observed series. */
function recentChat(metric: ChatMetric | undefined, start: number, now: number) {
  if (!metric?.minutes || !Number.isFinite(start) || now < start) return null;
  const bucket = Math.floor((now - start) / 60000), first = Math.max(0, bucket - 4);
  const total = metric.minutes.reduce((sum, m) => {
    const i = Math.floor((Date.parse(m.at) - start) / 60000);
    return Number.isFinite(i) && i >= first && i <= bucket && Number.isFinite(m.messages) ? sum + m.messages : sum;
  }, 0);
  return total / 5;
}

function PulseCard({ platform, start, end, now, series, viewers, chat, watcher, settings, disconnected }: { platform: Platform; start: string; end?: string; now: number; series?: ViewerSeries; viewers?: ViewerMetric; chat?: ChatMetric; watcher?: ViewerPlatform; settings?: ViewerSettings; disconnected: boolean }) {
  const current = formatNumber(currentViewers(series, now, watcher, settings));
  const average = formatNumber(viewers?.average, 1), peak = formatNumber(viewers?.peak);
  const rate = formatNumber(recentChat(chat, Date.parse(start), now), 1);
  const unique = formatNumber(chat?.uniqueChatters), coverage = formatCoverage(viewers?.coverage?.ratio);
  const empty = !series && !viewers && current === null && !chat;
  return <article className="panel dir-pulse-card" data-platform-pulse={platform} aria-label={`Pulso de ${platformNames[platform]}`}>
    <div className="dir-pulse-head"><h3 className={`dx-platform dx-${platform}`}>{platformNames[platform]}</h3>{!empty && <span className="hint">Espectadores · desde el inicio</span>}</div>
    {empty ? <p className="dir-pulse-empty">Sin datos de espectadores ni de chat en este directo.{disconnected ? ' · Sin conexión.' : ''}</p> : <>
      <div className="dir-numbers">
        <div className="dir-number now"><b>{current ?? 'no disponible'}</b><span>ahora</span></div>
        <div className="dir-number"><b>{average ?? 'no disponible'}</b><span>media</span></div>
        <div className="dir-number"><b>{peak ?? 'no disponible'}</b><span>pico</span></div>
      </div>
      {series && Number.isFinite(Date.parse(start)) ? <figure className="dx-figure"><ViewerChart start={start} end={end} series={{ [platform]: series }} /></figure> : <p className="hint">Curva de espectadores no disponible.</p>}
      <div className="dir-pulse-foot"><span>Chat · <b>{rate === null ? 'no disponible' : `${rate} msg/min`}</b> últimos 5 min · <b>{unique ?? 'no disponible'}</b> personas únicas</span>
        <span className={cx(series?.openGap && 'dx-warn')}>Cobertura <b>{coverage ?? 'no disponible'}</b>{series?.openGap ? ' · hueco abierto' : ''}</span></div>
    </>}
  </article>;
}

function AlertsCard() {
  const history = useLive(s => s.history || []), types = useLive(s => s.types);
  const pause = useLive(s => s.status?.pause || { paused: false, held: 0 });
  const last = history[0], t = last ? types[last.type] : undefined;
  return <div className="dir-alerts" data-tour="directo-alerts">
    <div className="dir-alert-line"><span><strong>Alertas</strong> · {last ? <>Última: {t?.label || (last.type === 'command' ? 'Comando' : last.type)}{last.text ? ` · ${last.text}` : ''} · {fmtTime(last.at)}</> : 'Todavía no ha salido ninguna alerta en este directo.'}</span>
      <Status tone={pause.paused || pause.held ? 'warning' : 'success'}>{pause.paused ? 'En pausa' : 'Activas'}{pause.held ? ` · ${pause.held} en cola` : ' · cola vacía'}</Status></div>
    <div className="row tight dir-alert-actions">
      <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/skip'), 'Saltada')}><Icon d={IC.skip} className="eg-btn__icon" />Saltar</button>
      <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/clear'), 'Cola vacía')}>Vaciar cola</button>
      {last && <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/replay', { id: last.id }), 'Repitiendo')}><Icon d={IC.repeat} className="eg-btn__icon" />Repetir</button>}
      <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(() => post(pause.paused ? '/api/resume' : '/api/pause'))}>{pause.paused ? 'Reanudar alertas' : 'Pausar alertas'}</button>
      <a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/historial">Historial</a>
    </div>
  </div>;
}

function ChatBox() {
  const chat = useLive(s => s.widgets?.chat || []), to = useLive(s => s.config.chat?.sendTo || 'twitch');
  const [text, setText] = useState('');
  const list = chat.slice(-5);
  const send = guard(async (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim(); if (!v) return;
    const r = await post<ChatSendResult>('/api/chat/send', { text: v, to });
    setText(''); toast(sendResultText(r), !!Object.keys(r.errors || {}).length);
  });
  return <div className="dir-chat-box">
    <div className="dir-chat-head"><h3>Chat reciente</h3><a className="hint" href="#/chat">Twitch + YouTube · filtrado</a></div>
    {list.length ? <ol className="eg-timeline eg-timeline--chat dir-chat" aria-live="polite">{list.map(m => <li key={m.id} className={cx('eg-timeline__item', m.command && 'is-command')}>
      <time className="eg-timeline__time">{fmtTime(m.at)}</time>
      <span className="eg-timeline__pf" title={m.platform === 'youtube' ? 'YouTube' : 'Twitch'}><PfIcon platform={m.platform === 'youtube' ? 'youtube' : 'twitch'} /></span>
      <span><span className={cx('eg-timeline__who', m.mod && 'eg-timeline__who--mod')}>{m.user}</span>{m.owner ? <span className="tagm you">Tú</span> : null} {m.command ? <span className="eg-timeline__cmd">{m.text}</span> : m.text}</span>
    </li>)}</ol> : <EmptyState>Todavía no hay mensajes.</EmptyState>}
    <form className="row tight dir-send" onSubmit={send}>
      <SendTo value={to} onChange={v => live.patchConfig({ chat: { sendTo: v } })} />
      <label className="sr-only" htmlFor="dir-say">Escribe en el chat</label>
      <input id="dir-say" className="grow" value={text} onChange={e => setText(e.target.value)} placeholder="Escribe en tu chat…" />
      <button type="submit" className="eg-btn eg-btn--secondary eg-btn--sm">Enviar</button>
    </form>
  </div>;
}

export function Directo() {
  const s = useLive(x => x), tl = live.timeline;
  const [ses, setSes] = useState<LiveSession | null>(null);
  const [endRetryId, setEndRetryId] = useState<string | null>(null);
  const [past, setPast] = useState<SessionList['past']>([]);
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0), goalsKey = JSON.stringify(s.widgets?.goals || []);
  // Only measure the time without a signal that this view has actually observed.
  const idleSince = useRef<{ id: string; at: number } | null>(null);
  const streaming = s.status?.meld?.state === 'conectado' && !!s.status.meld.streaming;
  const monitoring = streaming || platforms.some(p => !!s.viewers?.platforms?.[p]?.live) || s.status?.youtube?.state === 'escuchando';
  const load = guard(async () => {
    const generation = ++sequence.current;
    const [a, b] = await Promise.all([get<LiveSession>('/api/session'), get<SessionList>('/api/sessions')]);
    if (generation === sequence.current) { setSes(a); setPast(b.past || []); }
  });
  useEffect(() => { load(); }, [tl, goalsKey]);
  useEffect(() => { if (!monitoring) return; const h = setInterval(load, 30000); return () => clearInterval(h); }, [monitoring]);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(h); sequence.current++; }; }, []);
  if (!ses) return null;
  const open = !!ses.startedAt && !ses.endedAt;
  const idle = open && !monitoring;
  if (!idle) idleSince.current = null;
  else if (idleSince.current?.id !== ses.id) idleSince.current = { id: ses.id, at: now };
  // We cannot know when broadcasting stopped, so the warning reports the session age.
  const startedMs = Date.parse(String(ses.startedAt ?? ''));
  const idleSeconds = idle && idleSince.current ? (now - (Number.isFinite(startedMs) ? startedMs : idleSince.current.at)) / 1000 : null;
  const started = ses.startedAt ? +new Date(ses.startedAt) : 0;
  const start = started ? new Date(started).toISOString() : '';
  const end = ses.endedAt || new Date(now).toISOString();
  const totals = Object.entries(s.metrics || {}).filter(([key]) => key !== 'events' && typeof ses.totals?.[key] === 'number' && ses.totals[key] !== 0);
  // The archive list is ordered by id; the footer needs the most recent start.
  const last = [...(past || [])].sort((x, y) => (Date.parse(String(y?.startedAt ?? '')) || 0) - (Date.parse(String(x?.startedAt ?? '')) || 0))[0];
  const mark = guard(async () => { const { marker } = await post<{ marker: { twitchError?: string } }>('/api/markers', {}); toast(marker?.twitchError ? `Marca guardada (Twitch: ${marker.twitchError})` : 'Momento marcado'); });
  const endSession = guard(async () => {
    if (!confirm('¿Terminar el directo? Se marcará la hora de fin; el archivado y la puesta a cero ocurrirán al empezar el siguiente.')) return;
    try { await post('/api/session/end', { id: ses.id }); setEndRetryId(null); await load(); }
    catch (error) { setEndRetryId(ses.id); await load(); throw error; }
  });
  const startSession = guard(async () => {
    if (!confirm('Se archiva el directo actual y todo vuelve a cero (objetivos, créditos, últimos). ¿Seguir?')) return;
    await post('/api/session/new', { title: '' }); await load();
  });
  return <>
    <header className="view-head" data-tour="directo-head" data-tour-view-ready="directo"><div>
      <span className={cx('crumb', streaming && 'onair')}>{streaming ? <span className="eg-live-dot is-active" aria-hidden="true" /> : null}{streaming ? 'En directo' : 'Sesión'} · desde las {fmtTime(started)}{started ? ` · ${mmss((now - started) / 1000)}` : ''}</span>
      <LazyInput className="title-input" value={ses.title ?? ''} placeholder="Título del directo" aria-label="Título del directo" onCommit={guard((v: string) => put('/api/session', { title: v }))} /></div>
      <div className="actions">
        <a className="eg-btn eg-btn--ghost eg-btn--sm" href="/api/session/summary.md" target="_blank">Resumen (.md)</a>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => copy((await get<{ markdown: string }>('/api/session/summary')).markdown))}>Copiar resumen</button>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/credits/play'), 'Créditos en marcha')}>Lanzar créditos</button>
        {!open && (endRetryId !== ses.id || streaming) ? <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={startSession}>Empezar directo</button>
          : streaming ? <Status tone="success">{ses.meldAutoSession ? 'En directo · automático con Meld' : 'En directo · Meld emitiendo'}</Status>
          : <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={endSession}>Terminar directo</button>}
      </div></header>
    <Health state={s} session={ses} idleSeconds={idleSeconds} endSession={endSession} />
    <section className="dir-pulse" aria-labelledby="dir-pulse-title"><div className="dir-section-head"><h2 id="dir-pulse-title">Pulso del directo</h2><span className="hint">Desde el inicio · plataformas separadas · escala independiente</span></div>
      <div className="dir-pulse-grid">{platforms.map(p => <PulseCard key={p} platform={p} start={start} end={end} now={now} series={ses.viewers?.[p]} viewers={ses.viewerMetrics?.[p]} chat={ses.chatMetrics?.[p]} watcher={s.viewers?.platforms?.[p]} settings={s.viewers?.settings}
        disconnected={p === 'twitch' ? s.status.twitch?.state === 'desconectado' && s.status.chat?.state !== 'conectado' : ['desconectado', 'parado'].includes(s.status.youtube?.state || '')} />)}</div>
    </section>
    <div className="cols dir-lower">
      <Sec title="Cronología" id="h-crono" tour="directo-timeline" className="dir-timeline" aside={<span className="hint">La historia del directo</span>}>
        <div className="dir-summary" data-tour="directo-stats"><span>{totals.length ? totals.map(([key, metric]) => {
          const value = ses.totals![key], label = TOTAL_LABELS[key]?.[value === 1 ? 0 : 1] ?? metric.label.toLocaleLowerCase('es-ES');
          return `${value.toLocaleString('es-ES')} ${label}`;
        }).join(' · ') : 'Todavía no hay totales.'}</span>{' '}<strong>{tl.pending || 0} por agradecer</strong></div>
        <Timeline items={tl.items} types={s.types} />
      </Sec>
      <Sec title="Control de respaldo" id="h-backup" aside={<button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={mark}><Icon d={IC.bookmark} className="eg-btn__icon" />Marcar momento</button>}>
        <AlertsCard /><ChatBox />
      </Sec>
    </div>
    <div className="dir-extras"><GoalBars />
      <section className="dir-past"><span id="h-past">Último directo: </span>{last ? <><b>{fmtDateTime(last.startedAt)} · {last.title || 'Sin título'}</b> — </> : <>Todavía no hay directos archivados. </>}<a href="#/directos">ver historial</a></section>
    </div>
  </>;
}
