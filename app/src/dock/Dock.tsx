// Dock: vista estrecha para el panel de chat de Meld (o una ventana flotante de la app).
// Estado del directo, botones de un toque, tus atajos y un chat pequeño para escribir.
import { useEffect, useRef, useState } from 'react';
import { enc, get, post } from '../lib/api';
import { live, makeChatLoader, useLive } from '../lib/live';
import { mergeChat } from '../lib/chat-merge.mjs';
import { cx, guard, mmss, PfIcon, PLATFORM_NAMES, toast, Toaster } from '../lib/ui';
import type { ChatMessage, ChatSendResult, ShortcutConfig, TimelineItem } from '../lib/types';
import { stepText } from '../panel/views/Atajos';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}

function Status() {
  const s = useLive(x => x);
  const now = useNow();
  const tl = live.timeline;
  const st = s.status, meldOn = st.meld?.state === 'conectado', streaming = !!st.meld?.streaming;
  const tracks = s.meld?.session?.tracks || [];
  const want = (s.config.prompter?.micTrack || '').toLowerCase();
  const mic = want ? tracks.find(t => t.name.toLowerCase() === want) : tracks.find(t => /mic/i.test(t.name));
  const pause = st.pause || {};
  return <header className="d-top">
    <div className={cx('d-live', streaming && 'on')}><i />{streaming ? 'En directo' : meldOn ? 'Sin emitir' : 'Sesión'}<b>{tl.startedAt ? mmss((now - +new Date(tl.startedAt)) / 1000) : ''}</b></div>
    <div className="d-warns">
      {mic?.muted && <span className="d-warn big">🎙 Micro silenciado</span>}
      {pause.paused && <span className="d-warn">Alertas en pausa{pause.held ? ` · ${pause.held}` : ''}</span>}
      {!meldOn && <span className="d-warn soft">Meld sin conectar</span>}
      {st.overlays === 0 && <span className="d-warn soft">Sin overlay</span>}
      {st.twitch && st.twitch.state !== 'conectado' && <span className="d-warn soft">Twitch: {st.twitch.state}</span>}
      {st.youtube && (st.youtube.state === 'en espera') && <span className="d-warn">YouTube: {st.youtube.notice || st.youtube.state}</span>}
    </div>
  </header>;
}

function Controls() {
  const s = useLive(x => x);
  const I = s.interactive;
  const pause = s.status.pause || {};
  const q = I?.questions;
  const g = I?.giveaway || {};
  const pend = live.timeline.pending || 0;
  const sd = (a: string, ok?: string) => guard(() => post('/sd/' + a), ok);
  return <section className="d-sec">
    <div className="d-grid">
      <button className={cx('d-btn', pause.paused && 'on')} onClick={sd('pausa')}>{pause.paused ? '▶ Reanudar' : '⏸ Pausar'}<small>alertas{pause.held ? ` · ${pause.held} en cola` : ''}</small></button>
      <button className="d-btn" onClick={sd('saltar', 'Saltada')}>⏭ Saltar<small>la alerta actual</small></button>
      <button className="d-btn pri" onClick={guard(async () => { const { marker } = await post<{ marker: TimelineItem }>('/api/markers', {}); toast(marker.twitchError ? `Marca local (Twitch: ${marker.twitchError})` : 'Marca creada'); })}>🎬 Marca<small>de short</small></button>
      <button className="d-btn" disabled={!pend} onClick={sd('agradecido')}>✔ Agradecido<small>{pend} por agradecer</small></button>
    </div>
    {q && <div className="d-card">
      <div className="d-card-h">Preguntas <span>{q.pending || 0} en cola</span></div>
      {q.current ? <p className="d-q"><b>{q.current.user}</b> {q.current.text}</p> : <p className="d-muted">Ninguna en pantalla</p>}
      <div className="d-row"><button className="d-btn sm grow" disabled={!q.pending} onClick={sd('siguiente-pregunta')}>Siguiente</button><button className="d-btn sm" disabled={!q.current} onClick={sd('ocultar-pregunta')}>Ocultar</button></div>
    </div>}
    {I && (I.vote || g.open || g.count > 0) && <div className="d-card">
      {I.vote && <><div className="d-card-h">Votando <span>{I.vote.item?.label} · {I.vote.total} votos</span></div><div className="d-row"><button className="d-btn sm grow" onClick={sd('cerrar-votacion')}>Cerrar y colocar</button></div></>}
      {(g.open || g.count > 0) && <><div className="d-card-h">Sorteo <span>{g.open ? 'abierto' : 'cerrado'} · {g.count} part.</span></div>
        <div className="d-row">{g.open ? <button className="d-btn sm grow" onClick={sd('cerrar-sorteo')}>Cerrar</button> : <button className="d-btn sm grow" onClick={sd('abrir-sorteo')}>Abrir</button>}<button className="d-btn sm grow pri" disabled={!g.count} onClick={sd('sortear')}>Sortear</button></div></>}
    </div>}
  </section>;
}

function Shortcuts() {
  const list: ShortcutConfig[] = useLive(s => s.config.shortcuts || []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.length) return <section className="d-sec"><p className="d-muted">Crea tus atajos en el panel (Meld y Stream Deck › Atajos) y salen aquí como botones.</p></section>;
  return <section className="d-sec">
    <div className="d-card-h">Mis atajos</div>
    <div className="d-grid">{list.map(sc => <button key={sc.id} className={cx('d-btn sc', busy === sc.id && 'busy')} style={{ ['--sc' as any]: sc.color || 'var(--line2)' }} title={(sc.steps || []).map(stepText).join(' → ')}
      onClick={guard(async () => {
        setBusy(sc.id);
        try { const r = await post<{ errors?: string[] }>(`/api/shortcuts/${enc(sc.id)}/run`); toast(r.errors?.length ? `${sc.name}: ${r.errors.join(' · ')}` : sc.name, !!r.errors?.length); }
        finally { setBusy(null); }
      })}>{sc.name}<small>{(sc.steps || []).length} {(sc.steps || []).length === 1 ? 'paso' : 'pasos'}</small></button>)}</div>
  </section>;
}

function MiniChat() {
  const [list, setList] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const to = useLive(s => s.config.chat?.sendTo || 'twitch');
  useEffect(() => {
    // Igual que en el prompter (makeChatLoader, #116): el snapshot reemplaza la lista y
    // solo se conservan los mensajes recibidos por SSE mientras ESA petición estaba en
    // curso; una carga más antigua que resuelve al final no pisa el chat ya aplicado.
    const { load, inflight } = makeChatLoader(
      () => get<ChatMessage[]>('/api/chat?limit=40'),
      (r, ids) => setList(l => mergeChat(l, r, ids).slice(-60)),
    );
    load();
    const offs = [live.on('chat', m => { for (const ids of inflight) ids.add(m.id); setList(l => l.some(x => x.id === m.id) ? l : [...l, m].slice(-60)); }), live.onOpen(load), live.on('chatDelete', ({ id }) => setList(l => l.filter(x => x.id !== id))), live.on('gap', load)];
    return () => offs.forEach(f => f());
  }, []);
  useEffect(() => { const el = box.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight; }, [list.length]);
  const send = guard(async (e: any) => {
    e.preventDefault(); const t = text.trim(); if (!t) return;
    const r = await post<ChatSendResult>('/api/chat/send', { text: t, to }); setText('');
    const errs = Object.entries(r.errors || {});
    if (errs.length) toast(errs.map(([k, v]) => `${PLATFORM_NAMES[k]}: ${v}`).join(' · '), true);
  });
  const setTo = (k: string) => live.patchConfig({ chat: { sendTo: k } });
  return <section className="d-chat">
    <div className="d-msgs" ref={box}>{list.length ? list.filter(m => !(m.command || m.used)).map(m => <p key={m.id} className={cx('d-msg', m.owner && 'own', m.highlighted && 'hl')}>
      <PfIcon platform={m.platform} /><b>{m.user}</b> {m.text}
      <button className="d-mini" title="A preguntas" onClick={guard(() => post('/api/questions', { user: m.user, text: m.text, platform: m.platform }), 'A la cola de preguntas')}>❓</button></p>) : <p className="d-muted">Sin mensajes todavía</p>}</div>
    <form className="d-send" onSubmit={send}>
      <div className="d-to" role="radiogroup" aria-label="Escribir en">{(['twitch', 'youtube', 'both'] as const).map(k => <button key={k} type="button" role="radio" aria-checked={to === k} title={k === 'both' ? 'Twitch y YouTube' : PLATFORM_NAMES[k]} onClick={() => setTo(k)}>{k === 'both' ? '2' : <PfIcon platform={k} />}</button>)}</div>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Escribir en el chat…" maxLength={500} /><button className="d-btn sm pri" type="submit">↵</button>
    </form>
  </section>;
}

export function Dock() {
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const [tab, setTab] = useState<'control' | 'chat'>(() => (localStorage.getItem('egdev.dock.tab') as any) || 'control');
  useEffect(() => { live.load().then(() => live.connect('panel')).catch(e => toast(e.message, true)); }, []);
  useEffect(() => { try { localStorage.setItem('egdev.dock.tab', tab); } catch { /* almacenamiento no disponible: se ignora */ } }, [tab]);
  if (!ready) return <div className="d-boot">Conectando con antena…</div>;
  return <div className="dock">
    <Status />
    <nav className="d-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'control'} className={cx(tab === 'control' && 'on')} onClick={() => setTab('control')}>Control</button>
      <button role="tab" aria-selected={tab === 'chat'} className={cx(tab === 'chat' && 'on')} onClick={() => setTab('chat')}>Chat</button>
      <a className="d-open" href="/" target="_blank" rel="noopener" title="Abrir el panel completo">Panel ↗</a>
    </nav>
    {tab === 'control' ? <div className="d-body"><Controls /><Shortcuts /></div> : <MiniChat />}
    {offline && <div className="d-off">Sin conexión con antena. Reintentando…</div>}
    <Toaster />
  </div>;
}
