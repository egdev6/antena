// Vista del Elgato Prompter (1024×600): chat a la izquierda, widgets y cronología a la derecha.
// Se lee a ~60 cm mirando a cámara y se maneja con el ratón; lo de un solo botón va al Stream Deck.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, enc, get, post, put } from '../lib/api';
import { live, makeChatLoader, useLive } from '../lib/live';
import { mergeChat } from '../lib/chat-merge.mjs';
import { ConnPill, cx, fmtTime, guard, Icon, mmss, PfIcon, PLATFORM_NAMES, toast, Toaster } from '../lib/ui';
import { IC } from '../lib/icons';
import type { ChatMessage, ChatSendResult, Question, TimelineItem, TierListItem, TierListTier } from '../lib/types';

const TABS: [string, string][] = [['preguntas', 'Preguntas'], ['tierlist', 'Tier list'], ['sorteo', 'Sorteo'], ['cronologia', 'Cronología']];
const P = () => live.state?.config?.prompter || {};

// ---------- barra superior ----------
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}
function Top({ onThanks }: { onThanks: () => void }) {
  const s = useLive(x => x);
  const tl = live.timeline;
  const now = useNow();
  const st = s.status, meldOn = st.meld?.state === 'conectado', streaming = !!st.meld?.streaming;
  const tracks = s.meld?.session?.tracks || [];
  const want = (P().micTrack || '').toLowerCase();
  const mic = want ? tracks.find(t => t.name.toLowerCase() === want || t.id === P().micTrack) : tracks.find(t => /mic/i.test(t.name));
  const pause = st.pause || {};
  const w: ReactNode[] = [];
  if (mic?.muted) w.push(<span key="mic" className="eg-status eg-status--danger pr-mic"><Icon d={IC.micOff} />Micro silenciado</span>);
  if (pause.paused) w.push(<span key="p" className="eg-status eg-status--warning"><Icon d={IC.pause} />Alertas en pausa{pause.held ? ' · ' + pause.held : ''}</span>);
  if (st.twitch && st.twitch.state !== 'conectado') w.push(<ConnPill key="tw" platform="twitch" state={st.twitch.state} />);
  if (st.youtube?.state === 'error') w.push(<ConnPill key="yt" platform="youtube" state="error" />);
  if (st.meld && !meldOn && s.config.meld?.enabled) w.push(<ConnPill key="m" platform="meld" state={st.meld.state} />);
  if (st.overlays === 0) w.push(<span key="o" className="eg-status eg-status--warning"><Icon d={IC.alert} />Sin overlay</span>);
  return <header className="pr-top top">
    <span className={cx('eg-live-label live', streaming && 'on')}>{streaming ? <span className="eg-live-dot is-active" aria-hidden="true" /> : <span className="pr-dot" aria-hidden="true" />}{streaming ? 'En directo' : meldOn ? 'Sin emitir' : 'Sesión'} <b>{tl.startedAt ? mmss((now - +new Date(tl.startedAt)) / 1000) : ''}</b></span>
    <div className="pr-warns">{w}</div>
    <span className="pr-sp" />
    <button type="button" className={cx('eg-btn eg-btn--sm thanks', tl.pending > 0 ? 'eg-btn--secondary has' : 'eg-btn--ghost')} title="Por agradecer: abre la cronología" onClick={onThanks}><Icon d={IC.heart} className="eg-btn__icon" />Por agradecer <span className="eg-tabs__count">{tl.pending || 0}</span></button>
    <span className="pr-clock clock">{fmtTime(now)}</span>
  </header>;
}

// ---------- chat ----------
function bright(c?: string) { // colores de Twitch demasiado oscuros para el cristal
  if (!/^#[0-9a-f]{6}$/i.test(c || '')) return '#fff';
  const n = parseInt(c!.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110 ? `color-mix(in srgb,${c} 45%,#fff)` : c;
}
const Parts = ({ m }: { m: ChatMessage }) => <>{(m.parts?.length ? m.parts : [{ t: m.text }]).map((p: any, i: number) => (p.e ? <img key={i} src={p.e} alt={p.alt} /> : <span key={i}>{p.t}</span>))}</>;

function Chat() {
  const [list, setList] = useState<ChatMessage[]>([]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [text, setText] = useState('');
  const [unseen, setUnseen] = useState(0);
  const box = useRef<HTMLOListElement>(null);
  const stick = useRef(true), hover = useRef(false);
  const cfg = useLive(s => s.config);
  const yt = useLive(s => s.status.youtube || {});
  const pr = cfg.prompter || {};
  useEffect(() => {
    // Carga del chat con guardia de generación (#116, makeChatLoader): una carga más
    // antigua que resuelve al final no pisa el chat ya aplicado; los mensajes recibidos
    // por SSE mientras una carga está en curso se registran en sus ids y no se pierden
    // al aplicar el snapshot (dedup por id, sin duplicados, desorden ni resurrección de
    // borrados al reconectar o tras un gap).
    const { load, inflight } = makeChatLoader(
      () => get<ChatMessage[]>('/api/chat?limit=120'),
      (r, ids) => setList(l => mergeChat(l, r, ids).slice(-300)),
    );
    load();
    const offs = [
      live.on('chat', m => { for (const ids of inflight) ids.add(m.id); setList(l => l.some(x => x.id === m.id) ? l : [...l, m].slice(-300)); }),
      live.onOpen(load),
      live.on('chatDelete', ({ id }) => setList(l => l.filter(x => x.id !== id))),
      live.on('chatClear', ({ login }) => setList(l => l.filter(x => login && x.login !== login))),
      live.on('gap', load),
    ];
    return () => offs.forEach(f => f());
  }, []);
  const visible = list.filter(m => !(pr.hideCommands !== false && (m.command || m.used))).slice(-(Number(pr.chatLines) || 60));
  const lastId = visible.at(-1)?.id;
  const scrollEnd = () => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; setUnseen(0); };
  useLayoutEffect(() => {
    if (stick.current && !hover.current) scrollEnd(); else if (lastId) setUnseen(n => n + 1);
  }, [lastId]);
  const act = (m: any, kind: 'ask' | 'save') => guard(async () => {
    const k = kind + m.id; if (done[k]) return;
    if (kind === 'ask') await post('/api/questions', { user: m.user, text: m.text, platform: m.platform });
    else await post('/api/timeline', { kind: 'saved', user: m.user, text: m.text, platform: m.platform });
    setDone(d => ({ ...d, [k]: true }));
    toast(kind === 'ask' ? 'A la cola de preguntas' : 'Guardado en la cronología');
  });
  const to = cfg.chat?.sendTo || 'twitch';
  const ytOk = !!yt.account && !!yt.liveChatId;
  const placeholder = ({ twitch: 'Escribir en Twitch…', youtube: 'Escribir en YouTube…', both: 'Escribir en Twitch y YouTube…' } as Record<string, string>)[to] || ''
    + (to !== 'twitch' && !ytOk ? (yt.account ? ' (YouTube: pon a escuchar su chat)' : ' (YouTube: conecta tu cuenta)') : '');
  const send = guard(async (e: any) => {
    e.preventDefault(); const t = text.trim(); if (!t) return;
    const r = await post<ChatSendResult>('/api/chat/send', { text: t, to }); setText('');
    const errs = Object.entries(r.errors || {});
    const sent = Object.keys(r.sent || {}).map(k => PLATFORM_NAMES[k]).join(' y ');
    toast(errs.length ? `Enviado a ${sent || 'ninguno'} · ${errs.map(([k, v]) => PLATFORM_NAMES[k] + ': ' + v).join(' · ')}` : 'Enviado a ' + sent, errs.length > 0);
  });
  return <section className="pr-chat chat" aria-label="Chat de Twitch y YouTube">
    <ol className="eg-timeline eg-timeline--chat eg-timeline--lg msgs" ref={box as any} aria-live="polite"
      onScroll={() => { const el = box.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; if (stick.current && !hover.current) setUnseen(0); }}
      onMouseEnter={() => { hover.current = true; }}
      onMouseLeave={() => { hover.current = false; if (stick.current || unseen) { stick.current = true; scrollEnd(); } }}>
      {visible.length ? visible.map(m => <li key={m.id} className={cx('eg-timeline__item msg', m.highlighted && 'eg-timeline__item--hot hl', m.owner && 'is-own own')}>
        <time className="eg-timeline__time">{fmtTime(m.at)}</time>
        <span className="eg-timeline__pf" title={PLATFORM_NAMES[m.platform] || ''}><PfIcon platform={m.platform === 'youtube' ? 'youtube' : 'twitch'} /></span>
        <span className="eg-timeline__body">
          {m.highlighted && <span className="pr-star"><Icon d={IC.star} />Mensaje destacado</span>}
          {m.owner && <span className="eg-tag eg-tag--solid pr-you">Tú</span>}
          <span className={cx('eg-timeline__who', m.mod && 'eg-timeline__who--mod')} style={m.mod ? undefined : { color: bright(m.color) }}>{m.user}</span>{m.mod && <span className="pr-badge pr-badge--mod" title="Moderador">Mod</span>}{m.member && <span className="pr-badge" title="Sub o miembro"><Icon d={IC.star} /></span>}
          <Parts m={m} />
        </span>
        {!m.owner && <span className="eg-timeline__acts acts">
          <button type="button" className={cx('eg-btn eg-btn--secondary eg-btn--sm act', done['ask' + m.id] && 'done')} onClick={act(m, 'ask')}><Icon d={IC.question} className="eg-btn__icon" />Pregunta</button>
          <button type="button" className={cx('eg-btn eg-btn--secondary eg-btn--sm act', done['save' + m.id] && 'done')} onClick={act(m, 'save')}><Icon d={IC.pin} className="eg-btn__icon" />Guardar</button>
        </span>}
      </li>) : <li className="pr-empty">Aún no hay mensajes en el chat</li>}
    </ol>
    {unseen > 0 && <button type="button" className="eg-timeline__more" onClick={() => { stick.current = true; scrollEnd(); }}>{unseen} {unseen === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}</button>}
    <form className="pr-send" onSubmit={send}>
      <div className="eg-tabs" role="radiogroup" aria-label="Escribir en">
        {([['twitch', 'Solo Twitch'], ['youtube', 'Solo YouTube'], ['both', 'Twitch y YouTube']] as const).map(([k, title]) =>
          <button key={k} type="button" role="radio" title={title} aria-label={k === 'both' ? undefined : title} aria-checked={to === k} aria-selected={to === k} className={cx('eg-tabs__item', k !== 'twitch' && !ytOk && 'warn-yt')}
            onClick={guard(async () => { live.update(s => ({ config: { ...s.config, chat: { ...s.config.chat, sendTo: k } } })); await put('/api/config', { chat: { sendTo: k } }); })}>
            {k === 'both' ? 'Ambos' : <PfIcon platform={k} />}</button>)}
      </div>
      <div className="eg-field eg-field--sm"><label className="sr-only" htmlFor="pr-send">Escribir en el chat</label><input id="pr-send" className="eg-field__control" value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} maxLength={500} autoComplete="off" /></div>
      <button type="submit" className="eg-btn eg-btn--primary eg-btn--icon" aria-label="Enviar"><Icon d={IC.send} className="eg-btn__icon" /></button>
    </form>
  </section>;
}

// ---------- preguntas ----------
function Preguntas() {
  const I = useLive(s => s.interactive);
  const q = I?.questions; if (!q) return null;
  const pending = q.list.filter(x => x.status === 'pending');
  const cur = q.current;
  return <>
    <p className="eg-eyebrow pr-eyebrow">En pantalla</p>
    {cur ? <article className="eg-post eg-post--row is-active pr-row"><div className="eg-post__content"><span className="eg-post__meta">{cur.user} · {PLATFORM_NAMES[cur.platform] || 'a mano'}</span><b>{cur.text}</b></div></article>
      : <p className="pr-empty">Ninguna pregunta en pantalla</p>}
    <div className="pr-btns">
      <button type="button" className="eg-btn eg-btn--primary pr-grow" disabled={!pending.length} onClick={guard(() => post('/api/questions/next'))}><Icon d={IC.arrowRight} className="eg-btn__icon" />Siguiente pregunta</button>
      <button type="button" className="eg-btn eg-btn--secondary" disabled={!cur} onClick={guard(() => post('/api/questions/hide'))}><Icon d={IC.eyeOff} className="eg-btn__icon" />Ocultar</button>
    </div>
    <p className="eg-eyebrow pr-eyebrow">En cola · {pending.length}{pending.length ? ' · toca una para sacarla' : ''}</p>
    {pending.length ? pending.map((x: Question) => <article key={x.id} className="eg-post eg-post--row pr-row pr-tap">
      <button type="button" className="pr-row-main" onClick={guard(() => post('/api/questions/show', { id: x.id }), 'En pantalla')}><span className="eg-post__content"><b>{x.text}</b><span className="eg-post__meta">{x.user} · {PLATFORM_NAMES[x.platform] || 'a mano'}</span></span></button>
      <button type="button" className="eg-icon-btn" aria-label="Descartar" title="Descartar" onClick={guard(() => post(`/api/questions/${x.id}/status`, { status: 'discarded' }), 'Descartada')}><Icon d={IC.x} /></button>
    </article>)
      : <p className="pr-empty">Sin preguntas. El chat las manda con <b>{String(I.config?.questions?.command || '!pregunta')}</b> o desde el chat con «Pregunta».</p>}
  </>;
}

// ---------- tier list ----------
function TierList() {
  const I = useLive(s => s.interactive);
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useNow(1000); // cuenta atrás de la votación
  if (!I) return null;
  const lists = I.tierlists || [];
  const v = I.vote;
  let tlId = v ? v.listId : sel;
  if (!lists.find(l => l.id === tlId)) tlId = I.shownTierlist || lists[0]?.id || null;
  const l = lists.find(x => x.id === tlId);
  if (!l) return <p className="pr-empty">No hay tier lists. Créalas en el panel (Widgets › Tier list) o pídeselas a Claude.</p>;
  const id = enc(l.id);
  const shown = I.shownTierlist === l.id;
  const head = <div className="pr-head">
    {lists.length > 1 && !v ? <div className="eg-field eg-field--sm pr-grow"><label className="sr-only" htmlFor="pr-tl">Tier list</label><select id="pr-tl" className="eg-field__control" value={l.id} onChange={e => { setSel(e.target.value); setPicked(null); }}>{lists.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select></div>
      : <h2 className="pr-h">{l.title}</h2>}
    <button type="button" className={cx('eg-btn eg-btn--sm', shown ? 'eg-btn--ghost' : 'eg-btn--secondary')} onClick={guard(() => (shown ? post('/api/tierlists/hide') : post(`/api/tierlists/${id}/show`)))}><Icon d={shown ? IC.eyeOff : IC.eye} className="eg-btn__icon" />{shown ? 'Quitar de pantalla' : 'Mostrar en pantalla'}</button>
  </div>;
  if (v && v.listId === l.id) {
    const max = Math.max(1, ...Object.values<number>(v.counts || {}));
    const left = v.endsAt ? Math.max(0, Math.ceil((+new Date(v.endsAt) - Date.now()) / 1000)) : null;
    return <>{head}
      <article className="eg-post eg-post--row is-active pr-row"><div className="eg-post__content"><span className="eg-post__meta">Votando{left !== null ? ` · quedan ${left} s` : ''} · {v.total} {v.total === 1 ? 'voto' : 'votos'}</span><b className="pr-big">{v.item?.label}</b></div></article>
      <div className="pr-bars">{l.tiers.map((t: TierListTier) => { const n = v.counts[t.id ?? ''] || 0; return <div key={t.id} className="pr-bar">
        <span className="pr-bar__tier" style={{ color: t.color }}>{t.label}</span>
        <span className="eg-progress eg-progress--lg eg-progress--tier" role="img" aria-label={`${t.label}, ${n} votos`} style={{ ['--p' as any]: n / max, ['--bar' as any]: t.color }}><span className="eg-progress__bar" /></span>
        <span className="pr-bar__n">{n}</span></div>; })}</div>
      <div className="pr-btns">
        <button type="button" className="eg-btn eg-btn--primary pr-grow" onClick={guard(async () => { const { result } = await post<{ result?: { winner?: string } }>('/api/vote/close', {}); toast(result?.winner ? 'Colocado en ' + (l.tiers.find(t => t.id === result.winner)?.label || '') : 'Sin votos'); })}><Icon d={IC.check} className="eg-btn__icon" />Cerrar y colocar</button>
        <button type="button" className="eg-btn eg-btn--secondary" onClick={guard(() => post('/api/vote/cancel'))}>Cancelar</button></div></>;
  }
  const free = l.items.filter((it: TierListItem) => !l.placements[it.id]);
  const it = free.find(x => x.id === picked);
  return <>{head}
    <p className="eg-eyebrow pr-eyebrow">Sin colocar · {free.length} · {l.items.length - free.length}/{l.items.length} colocados</p>
    {free.length ? <div className="pr-chips">{free.map((x: TierListItem) => <button key={x.id} type="button" className="eg-chip" aria-pressed={x.id === picked} onClick={() => setPicked(picked === x.id ? null : x.id)}>{x.label}</button>)}</div> : <p className="pr-empty">Todo colocado</p>}
    {it ? <>
      <article className="eg-post eg-post--row is-active pr-row"><div className="eg-post__content"><span className="eg-post__meta">Elegido</span><b className="pr-big">{it.label}</b></div></article>
      <div className="pr-btns"><button type="button" className="eg-btn eg-btn--primary pr-grow" onClick={guard(async () => { await post(`/api/tierlists/${id}/vote`, { item: picked }); setPicked(null); })}><Icon d={IC.play} className="eg-btn__icon" />Abrir votación</button></div>
      <p className="eg-eyebrow pr-eyebrow">O colocar directamente</p>
      <div className="pr-tiers">{l.tiers.map((t: TierListTier) => <button key={t.id} type="button" className="pr-tierbtn" style={{ background: t.color }} onClick={guard(async () => { await post(`/api/tierlists/${id}/place`, { item: picked, tier: t.id }); setPicked(null); }, 'Colocado')}>{t.label}</button>)}</div>
    </> : free.length ? <p className="pr-empty">Elige un elemento para votarlo o colocarlo.</p> : null}
  </>;
}

// ---------- sorteo ----------
function Sorteo() {
  const I = useLive(s => s.interactive);
  if (!I) return null;
  const g = I.giveaway || {}, c = (I.config?.giveaway || {}) as Record<string, string | number | boolean | undefined>;
  const last = (g.winners || []).at(-1);
  const recent = (g.entries || []).slice(-12).reverse().map(e => e.user).join(', ');
  return <>
    <div className="pr-head">
      <div className="eg-stat"><span className="eg-stat__label">Participantes</span><span className="eg-stat__value">{g.count || 0}</span></div>
      <span className={cx('eg-status', g.open ? 'eg-status--success' : 'eg-status--neutral')}>{g.open && <Icon d={IC.check} />}{g.open ? `Abierto · ${String(c.command || '!sorteo')}` : 'Cerrado'}</span>
    </div>
    <div className="pr-btns">
      {g.open ? <button type="button" className="eg-btn eg-btn--secondary pr-grow" onClick={guard(() => post('/api/giveaway/close'), 'Inscripción cerrada')}>Cerrar inscripción</button>
        : <button type="button" className="eg-btn eg-btn--secondary pr-grow" onClick={guard(() => post('/api/giveaway/open', { reset: !g.count }), 'Sorteo abierto')}>Abrir sorteo</button>}
      <button type="button" className="eg-btn eg-btn--primary pr-grow" disabled={!g.count} onClick={guard(() => post('/api/giveaway/draw'), 'Sorteando…')}><Icon d={IC.gift} className="eg-btn__icon" />{last ? 'Sortear otra vez' : 'Sortear'}</button>
    </div>
    {g.open && <p className="pr-prize" data-testid="prize">{c.prize ? <>Premio: <b>{String(c.prize)}</b> · </> : null}Se entra con <b>{String(c.command || '!sorteo')}</b></p>}
    {last && <><p className="eg-eyebrow pr-eyebrow">Ganador{c.prize ? ` · ${String(c.prize)}` : ''}</p>
      <div className="eg-post eg-post--hot pr-winner"><span>{last.user}</span>{last.platform ? <small><PfIcon platform={last.platform === 'youtube' ? 'youtube' : 'twitch'} /> {PLATFORM_NAMES[last.platform] || ''}</small> : null}</div></>}
    {recent && <><p className="eg-eyebrow pr-eyebrow">Últimos en entrar</p><p className="pr-names">{recent}</p></>}
    {!recent && !last && <p className="pr-empty">{g.open ? <>Nadie todavía. Se entra con <b>{String(c.command || '!sorteo')}</b>.</> : 'Abre el sorteo para que el chat pueda entrar.'}</p>}
  </>;
}

// ---------- cronología ----------
const FILTERS: Record<string, string> = { all: 'Todo', pend: 'Por agradecer', marker: 'Marcas', highlight: 'Destacados', saved: 'Guardados' };
const NOTE: Record<string, [string, string]> = { marker: ['Marca de short', IC.clapper], highlight: ['Destacado', IC.star], saved: ['Guardado', IC.pin], question: ['Pregunta', IC.question], winner: ['Ganador', IC.gift], queue: ['Cola', IC.layers] };
const HOT = new Set(['sub', 'resub', 'giftsub', 'raid', 'superchat', 'supersticker', 'member', 'giftmember']);
function Cronologia({ filter, setFilter }: { filter: string; setFilter: (f: string) => void }) {
  useLive(s => s);
  const types = live.state?.types || {};
  const tl = live.timeline;
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const items = (tl.items || []).filter(i => (filter === 'all' ? true : filter === 'pend' ? i.kind === 'event' && !i.done : i.kind === filter)).slice().reverse();
  const startEdit = (i: TimelineItem) => { setEditing(i.id); setLabel(i.label || ''); };
  const saveEdit = async () => { const id = editing; if (!id) return; setEditing(null); try { await put(`/api/timeline/${enc(id)}`, { label }); } catch (e: any) { toast(e.message, true); } };
  const body = (i: TimelineItem) => {
    if (i.kind === 'event') {
      const extra = i.sub || (i.amount ? i.amount : '');
      return <><b>{i.user}</b>{extra ? ` · ${extra}` : ''}{i.message && !String(extra).includes(i.message) ? ` · «${i.message}»` : ''}</>;
    }
    if (editing === i.id) return <input className="eg-field__control pr-edit" autoFocus value={label} onChange={e => setLabel(e.target.value)} onFocus={e => e.target.select()} placeholder="¿Qué ha pasado?" maxLength={120} aria-label="Nombre de la marca"
      onKeyDown={e => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter') saveEdit(); }} onBlur={saveEdit} onClick={e => e.stopPropagation()} />;
    return <>{i.user && <><b>{i.user}</b> · </>}{i.label ? i.label : i.kind === 'marker' ? <span className="pr-muted">Sin nombre · toca para ponérselo</span> : null}{i.text ? `«${i.text}»` : ''}{i.twitchError ? <span className="pr-muted"> · solo local</span> : i.twitchMarker ? <span className="pr-muted"> · también en Twitch</span> : null}</>;
  };
  return <>
    <button type="button" className="eg-btn eg-btn--primary" onClick={guard(async () => {
      const { marker } = await post<{ marker: TimelineItem }>('/api/markers', {});
      if (filter !== 'all' && filter !== 'marker') setFilter('all');
      startEdit(marker);
      toast(marker.twitchError ? 'Marca guardada (Twitch: ' + marker.twitchError + ')' : 'Marca creada');
    })}><Icon d={IC.clapper} className="eg-btn__icon" />Marca de short</button>
    <div className="eg-tabs pr-filters" role="tablist" aria-label="Filtrar cronología">{Object.entries(FILTERS).map(([k, v]) => <button key={k} type="button" role="tab" className="eg-tabs__item" aria-selected={filter === k} onClick={() => setFilter(k)}>{v}{k === 'pend' && tl.pending ? <span className="eg-tabs__count">{tl.pending}</span> : null}</button>)}</div>
    {items.length ? <ol className="eg-timeline eg-timeline--lg pr-tl">{items.slice(0, 150).map((i, _n) => {
      const ev = i.kind === 'event';
      const [noteLabel, noteIcon] = NOTE[i.kind] || [i.kind, IC.bookmark];
      return <li key={i.id} className={cx('eg-timeline__item ev', 'k-' + i.kind, ev && HOT.has(i.type ?? '') && !i.done && 'is-new', i.kind === 'highlight' && 'eg-timeline__item--hot', i.done && 'is-done done')} onClick={() => { if (i.kind === 'marker' && editing !== i.id) startEdit(i); }}>
        <time className="eg-timeline__time">{mmss(i.offset)}</time>
        <span className="eg-timeline__type">{ev ? <><PfIcon platform={types[i.type ?? '']?.platform === 'youtube' ? 'youtube' : 'twitch'} />{types[i.type ?? '']?.label || i.type}</> : <><Icon d={noteIcon} />{noteLabel}</>}</span>
        <span className="eg-timeline__body">{body(i)}</span>
        <span className="eg-timeline__acts tools" onClick={e => e.stopPropagation()}>{ev ? <>
          <button type="button" className={cx('eg-icon-btn act', i.done && 'is-on done')} aria-label="Agradecido" title="Agradecido" aria-pressed={!!i.done} onClick={guard(() => post(`/api/timeline/${enc(i.id)}/done`, { value: !i.done }))}><Icon d={IC.check} /></button>
          <button type="button" className="eg-icon-btn act" aria-label="Repetir alerta" title="Repetir alerta" onClick={guard(() => post('/api/replay', { id: i.id }), 'Repitiendo alerta')}><Icon d={IC.repeat} /></button></> : <>
          {i.kind === 'marker' && <button type="button" className="eg-icon-btn act" aria-label="Poner nombre" title="Poner nombre" onClick={() => startEdit(i)}><Icon d={IC.edit} /></button>}
          <button type="button" className="eg-icon-btn x" aria-label="Borrar" title="Borrar" onClick={guard(() => api('DELETE', `/api/timeline/${enc(i.id)}`), 'Borrada')}><Icon d={IC.trash} /></button></>}</span>
      </li>; })}</ol>
      : <p className="pr-empty">{filter === 'pend' ? 'Nadie pendiente de agradecer' : 'Aún no hay nada en la cronología'}</p>}
  </>;
}

// ---------- vista ----------
export function Prompter() {
  const ready = useLive(s => !!s);
  const offline = useLive(() => live.failed);
  const tab = useLive(() => live.prompter.tab || 'cronologia');
  const I = useLive(s => s?.interactive);
  const pending = useLive(() => live.timeline.pending || 0);
  const pr = useLive(s => s?.config?.prompter || {});
  const [filter, setFilter] = useState('all');
  useEffect(() => { live.load().then(() => live.connect('panel')).catch(e => toast(e.message, true)); }, []);
  useEffect(() => {
    document.documentElement.style.setProperty('--fs', (Number(pr.fontSize) || 22) + 'px');
    document.body.classList.toggle('mirror', !!pr.mirror);
  }, [pr.fontSize, pr.mirror]);
  const setTab = (t: string) => { live.prompter = { ...live.prompter, tab: t }; live.emit(); post('/api/prompter', { tab: t }).catch(() => {}); };
  if (!ready) return <div className="off on">Conectando con antena…</div>;
  const badges: Record<string, ReactNode> = {
    preguntas: I?.questions?.pending || null,
    tierlist: I?.vote ? 'votando' : null,
    sorteo: I?.giveaway?.open ? (I.giveaway.count || '0') : null,
    cronologia: pending || null,
  };
  return <>
    <style>{pr.css || ''}</style>
    <div className="pr">
      <Top onThanks={() => { setTab('cronologia'); setFilter('pend'); }} />
      <div className="pr-main main">
        <Chat />
        <section className="pr-side side" aria-label="Herramientas del directo">
          <div className="eg-tabs eg-tabs--lg tabs" role="tablist" aria-label="Herramientas">{TABS.map(([k, l]) => <button key={k} type="button" role="tab" className={cx('eg-tabs__item tab', tab === k && 'on')} aria-selected={tab === k} onClick={() => setTab(k)}>{l}{badges[k] ? <span className="eg-tabs__count n">{badges[k]}</span> : null}</button>)}</div>
          <div className="pr-pane pane on" role="tabpanel">
            {tab === 'preguntas' && <Preguntas />}
            {tab === 'tierlist' && <TierList />}
            {tab === 'sorteo' && <Sorteo />}
            {tab === 'cronologia' && <Cronologia filter={filter} setFilter={setFilter} />}
          </div>
        </section>
      </div>
    </div>
    <Toaster />
    <div className={cx('off', offline && 'on')}>Sin conexión con antena<br /><small style={{ fontSize: '.6em', color: 'var(--muted)' }}>¿Está arrancado? Reintentando…</small></div>
  </>;
}
