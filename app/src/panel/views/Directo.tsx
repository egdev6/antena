import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, post, put, enc } from '../../lib/api';
import { IC } from '../../lib/icons';
import { ViewerChips } from './Espectadores';
import { live, useLive } from '../../lib/live';
import { ConnPill, copy, cx, EmptyState, fmtDateTime, fmtTime, guard, Icon, LazyInput, mmss, PfIcon, Progress, Sec, Status, toast, type Tone } from '../../lib/ui';
import type { AlertType, ChatSendResult, SessionList, SessionSummary, TimelineItem } from '../../lib/types';
import { SendTo, sendResultText } from './Chat';

const NOTE_LABEL: Record<string, string> = { marker: 'Marca de short', highlight: 'Destacado', saved: 'Guardado', question: 'Pregunta', winner: 'Ganador', queue: 'Cola del overlay' };
// eventos que merecen la fila caliente de la cronología (dinero o gente que llega)
const HOT = new Set(['sub', 'resub', 'giftsub', 'raid', 'superchat', 'supersticker', 'member', 'giftmember']);

/** Cronología del directo (Timeline): la más reciente arriba. */
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
  return <div className="goals">{visible.length ? visible.map(g => <article className="goal eg-post" key={g.id}>
    <h3 className="goal-title">{g.title}</h3>
    {g.bars.filter(b => b.visible !== false).map(b => <div className="goal-bar" key={b.id}>
      <div className="goal-top"><span className="goal-platform"><PfIcon platform={b.platform === 'youtube' ? 'youtube' : 'twitch'} />
        {b.platform === 'youtube' ? 'YouTube' : 'Twitch'}
        {g.showMetric !== false && <span className="goal-metric"> · {metrics[b.metric]?.label || b.metric}</span>}</span>
        <b>{b.value ?? 0}/{b.target}</b></div>
      <Progress lg p={b.target ? (b.value ?? 0) / b.target : 0} label={`${g.title} · ${b.platform} · ${b.metric}`} />
    </div>)}
  </article>) : <EmptyState>Sin objetivos visibles.</EmptyState>}</div>;
}

/** Estado de las conexiones en StatusBadge. */
function Connections() {
  const st = useLive(s => s.status);
  const scene = useLive(s => s.meld?.session?.scenes?.find(x => x.current)?.name);
  const tw = st.twitch?.state, yt = st.youtube?.state, ch = st.chat?.state, md = st.meld?.state;
  const twTone: Tone = tw === 'conectado' ? 'success' : tw === 'desconectado' ? 'neutral' : st.twitch?.errors?.length ? 'danger' : 'warning';
  const ytOn = yt === 'escuchando' || yt === 'conectado' || !!st.youtube?.liveChatId;
  const ytTone: Tone = yt === 'error' ? 'danger' : ytOn ? 'success' : 'neutral';
  const mdTone: Tone = md === 'conectado' ? 'success' : md === 'error' ? 'danger' : 'neutral';
  return <div role="group" aria-label="Conexiones" className="row tight" data-tour="directo-status">
    <ConnPill platform="twitch" state={tw} tone={twTone} detail={ch && ch !== 'parado' ? `chat ${ch}` : undefined} />
    <ConnPill platform="youtube" state={yt} tone={ytTone} label={ytOn ? 'leyendo el chat' : undefined} />
    <ConnPill platform="meld" state={md} tone={mdTone} label={md === 'conectado' && scene ? `escena «${scene}»` : undefined} />
    <Status tone={st.overlays ? 'success' : 'warning'} icon={IC.monitor}>{st.overlays === 1 ? '1 overlay' : `${st.overlays || 0} overlays`}</Status>
    <ViewerChips />
  </div>;
}

/** La última alerta y la cola (ModuleCard --wide). */
function AlertsCard() {
  const history = useLive(s => s.history || []);
  const types = useLive(s => s.types);
  const pause = useLive(s => s.status?.pause || { paused: false, held: 0 });
  const last = history[0];
  const t = last ? types[last.type] : undefined;
  return <article className="eg-module-card eg-module-card--wide" data-tour="directo-alerts">
    <div className="eg-module-card__head"><Icon d={IC.bell} className="eg-module-card__icon" /><h2 className="eg-module-card__name">Alertas</h2>
      {pause.paused ? <Status tone="warning" icon={IC.pause}>En pausa{pause.held ? ` · ${pause.held} en cola` : ''}</Status> : <Status tone="success" icon={IC.play}>Activas</Status>}</div>
    <div className="eg-module-card__body">
      {last ? <>
        <span className="eg-module-card__label">Última · {t?.label || (last.type === 'command' ? 'Comando' : last.type)}{last.variation ? ` · variación «${last.variation.name}»` : ''} · {fmtTime(last.at)}</span>
        <span className="eg-module-card__kpi">{last.text || '—'}</span>
        {last.sub ? <span>{last.sub}</span> : null}
      </> : <span>Todavía no ha salido ninguna alerta en este directo.</span>}
    </div>
    <div className="eg-module-card__actions">
      <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/skip'), 'Saltada')}><Icon d={IC.skip} className="eg-btn__icon" />Saltar</button>
      <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/clear'), 'Cola vacía')}>Vaciar cola</button>
      {last && <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/replay', { id: last.id }), 'Repitiendo')}><Icon d={IC.repeat} className="eg-btn__icon" />Repetir</button>}
      <a className="eg-btn eg-btn--secondary eg-btn--sm push" href="#/historial">Historial</a>
    </div>
  </article>;
}

/** Chat compacto (Timeline --chat) con envío. */
function ChatBox() {
  const chat = useLive(s => s.widgets?.chat || []);
  const to = useLive(s => s.config.chat?.sendTo || 'twitch');
  const [text, setText] = useState('');
  const log = useRef<HTMLOListElement>(null);
  const list = chat.slice(-40);
  useLayoutEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [list.length]);
  const send = guard(async (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim(); if (!v) return;
    const r = await post<ChatSendResult>('/api/chat/send', { text: v, to });
    setText(''); toast(sendResultText(r), !!Object.keys(r.errors || {}).length);
  });
  return <Sec title="Chat" id="h-chat" aside={<a className="hint" href="#/chat">Twitch + YouTube · filtrado</a>}>
    {list.length ? <ol className="eg-timeline eg-timeline--chat dir-chat" ref={log} aria-live="polite">{list.map(m => <li key={m.id} className={cx('eg-timeline__item', m.command && 'is-command')}>
      <time className="eg-timeline__time">{fmtTime(m.at)}</time>
      <span className="eg-timeline__pf" title={m.platform === 'youtube' ? 'YouTube' : 'Twitch'}><PfIcon platform={m.platform === 'youtube' ? 'youtube' : 'twitch'} /></span>
      <span><span className={cx('eg-timeline__who', m.mod && 'eg-timeline__who--mod')}>{m.user}</span>{m.owner ? <span className="tagm you">Tú</span> : null} {m.command ? <span className="eg-timeline__cmd">{m.text}</span> : m.text}</span>
    </li>)}</ol> : <EmptyState>Todavía no hay mensajes.</EmptyState>}
    <form className="row tight" onSubmit={send}>
      <SendTo value={to} onChange={v => live.patchConfig({ chat: { sendTo: v } })} />
      <label className="sr-only" htmlFor="dir-say">Escribe en el chat</label>
      <input id="dir-say" className="grow" value={text} onChange={e => setText(e.target.value)} placeholder="Escribe en tu chat…" />
      <button type="submit" className="eg-btn eg-btn--secondary eg-btn--sm">Enviar</button>
    </form>
  </Sec>;
}

export function Directo() {
  const s = useLive(x => x);
  const tl = live.timeline;
  const [ses, setSes] = useState<SessionSummary | null>(null);
  const [past, setPast] = useState<SessionList['past']>([]);
  const [now, setNow] = useState(Date.now());
  const goalsKey = JSON.stringify(s.widgets?.goals || []);
  const load = guard(async () => {
    const [a, b] = await Promise.all([get<SessionSummary>('/api/session'), get<SessionList>('/api/sessions')]);
    setSes(a); setPast(b.past || []);
  });
  useEffect(() => { load(); }, [tl.items.length, goalsKey]);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  if (!ses) return null;
  const t: Record<string, number> = ses.totals || {};
  const streaming = !!s.status?.meld?.streaming;
  const started = ses.startedAt ? +new Date(ses.startedAt) : 0;
  // de qué plataforma sale cada métrica (para la línea de apoyo del Stat)
  const source = (types: string[] = []) => {
    const pf = new Set(types.map(x => s.types[x]?.platform).filter(Boolean));
    return pf.size === 1 ? (pf.has('youtube') ? 'YouTube' : 'Twitch') : 'Twitch y YouTube';
  };
  return <>
    <header className="view-head" data-tour="directo-head"><div>
      <span className={cx('crumb', streaming && 'onair')}>{streaming ? <span className="eg-live-dot is-active" aria-hidden="true" /> : null}{streaming ? 'En directo' : 'Sesión'} · desde las {fmtTime(started)}{started ? ` · ${mmss((now - started) / 1000)}` : ''}</span>
      <LazyInput className="title-input" value={ses.title ?? ''} placeholder="Título del directo" aria-label="Título del directo" onCommit={guard((v: string) => put('/api/session', { title: v }))} /></div>
      <div className="actions">
        <a className="eg-btn eg-btn--ghost eg-btn--sm" href="/api/session/summary.md" target="_blank">Resumen (.md)</a>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => copy((await get<{ markdown: string }>('/api/session/summary')).markdown))}>Copiar resumen</button>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/credits/play'), 'Créditos en marcha')}>Lanzar créditos</button>
        <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(async () => { if (!confirm('Se archiva el directo actual y todo vuelve a cero (objetivos, créditos, últimos). ¿Seguir?')) return; await post('/api/session/new', { title: '' }); await load(); })}>Nuevo directo</button>
      </div></header>
    <Connections />
    <div className="stats stats--directo" data-tour="directo-stats">{Object.entries(s.metrics || {}).filter(([k]) => k !== 'events').map(([k, m]) => <div className="eg-stat" key={k}>
      <span className="eg-stat__label">{m.label}</span><span className="eg-stat__value">{(t[k] ?? 0).toLocaleString('es-ES')}</span><span className="eg-stat__delta">{source(m.types as string[])}</span></div>)}</div>
    <div className="cols">
      <div className="stack">
        <AlertsCard />
        <Sec title="Cronología" id="h-crono" tour="directo-timeline" aside={<>
          <span className="hint">{ses.eventCount} eventos{tl.pending ? ` · ${tl.pending} por agradecer` : ''}</span>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { const { marker } = await post<{ marker: { twitchError?: string } }>('/api/markers', {}); toast(marker?.twitchError ? `Marca guardada (Twitch: ${marker.twitchError})` : 'Momento marcado'); })}><Icon d={IC.bookmark} className="eg-btn__icon" />Marcar momento</button></>}>
          <Timeline items={tl.items} types={s.types} />
        </Sec>
      </div>
      <div className="stack">
        <ChatBox />
        <Sec title="Objetivos" id="h-goals" aside={<a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/widgets/objetivos">Editar</a>}><GoalBars /></Sec>
        <Sec title="Directos anteriores" id="h-past">
          {(past || []).length ? <div className="rows">{(past || []).map(p => <article className="eg-post eg-post--row" key={p!.id}>
            <div className="eg-post__content"><b>{p!.title || 'Sin título'}</b><span className="eg-post__meta">{fmtDateTime(p!.startedAt)} · {p!.events} eventos</span></div>
            <a className="eg-btn eg-btn--ghost eg-btn--sm" href={`/api/session/summary.md?id=${enc(p!.id)}`} target="_blank">Resumen</a></article>)}</div>
            : <EmptyState>Todavía no hay directos archivados.</EmptyState>}
        </Sec>
      </div>
    </div>
  </>;
}
