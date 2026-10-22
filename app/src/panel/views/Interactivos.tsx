// Preguntas, tier list y sorteo: lo que maneja el chat y se ve en pantalla.
import { useState, type ReactNode } from 'react';
import { del, enc, post, put } from '../../lib/api';
import { useLive } from '../../lib/live';
import { patchIx } from '../../lib/patch';
import { codeTab, cx, EmptyState, fmtDate, fmtTime, guard, Icon, IconBtn, ItemTabs, LazyInput, Sec, Stage, Status, Switch, toast, UrlSec } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { PERMS } from './Editor';
import type { Question, TierListItem, TierListTier } from '../../lib/types';
import { origin } from './Widgets';

function IxField({ k, label, type = 'text', ...rest }: { k: string; label: ReactNode; type?: string; [x: string]: any }) {
  const [sec, f] = k.split('.');
  const val = useLive(s => s.interactive?.config?.[sec]?.[f] as string | number | boolean | undefined);
  const set = (v: string | number | boolean) => patchIx(sec, { [f]: v });
  if (type === 'checkbox') return <label className="check"><input type="checkbox" checked={!!val} onChange={e => set(e.target.checked)} /> {label}</label>;
  if (type === 'switch') return <Switch checked={!!val} onChange={set}>{label}</Switch>;
  if (type === 'range') { const n = Number(val ?? 0), min = Number(rest.min ?? 0), max = Number(rest.max ?? 100); return <label>{label}<span className="val">{n}</span><input type="range" min={min} max={max} value={n} style={{ ['--v' as any]: ((n - min) / ((max - min) || 1)) * 100 + '%' }} onChange={e => set(Number(e.target.value))} /></label>; }
  if (type === 'perm') return <label>{label}<select value={String(val ?? '')} onChange={e => set(e.target.value)}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  if (type === 'css') return <label>{label}<textarea className="code" spellCheck={false} style={{ minHeight: 70 }} value={val === undefined ? '' : String(val)} onKeyDown={codeTab} {...rest} onChange={e => set(e.target.value)} /></label>;
  if (type === 'number') return <label>{label}<input type="number" value={val === undefined ? '' : String(val)} {...rest} onChange={e => set(Number(e.target.value))} /></label>;
  return <label>{label}<input value={val === undefined ? '' : String(val)} {...rest} onChange={e => set(e.target.value)} /></label>;
}
const Head = ({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) =>
  <header className="view-head"><div><span className="crumb">Widgets › {title}</span><h1>{title}</h1><p className="hint">{desc}</p></div><div className="actions">{children}</div></header>;
function AddRow({ placeholder, onAdd, children }: { placeholder: string; onAdd: (v: string) => Promise<unknown>; children?: ReactNode }) {
  const [v, setV] = useState('');
  const go = guard(async () => { if (!v.trim()) return; await onAdd(v.trim()); setV(''); });
  return <form className="row tight" onSubmit={e => { e.preventDefault(); go(); }}><input aria-label={placeholder} value={v} onChange={e => setV(e.target.value)} placeholder={placeholder} className="grow" style={{ margin: 0 }} />{children}<button type="submit" className="eg-btn eg-btn--secondary eg-btn--sm">Añadir</button></form>;
}

// ---------- Preguntas ----------
const PF: Record<string, string> = { manual: 'a mano', youtube: 'YouTube', twitch: 'Twitch' };
const ago = (at: string | number) => { const s = Math.max(0, (Date.now() - +new Date(at)) / 1000); return s < 60 ? `hace ${Math.round(s)} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `a las ${fmtTime(at)}`; };
export function Preguntas() {
  const I = useLive(s => s.interactive);
  const c = I.config.questions as Record<string, string>, qs = I.questions;
  const pend = qs.list.filter(q => q.status === 'pending');
  const done = qs.list.filter(q => q.status === 'answered' || q.status === 'discarded').reverse();
  return <>
    <Head title="Preguntas" desc={<>El chat manda preguntas con <code>{c.command}</code>. Tú eliges cuál sale en pantalla.</>}>
      <IxField k="questions.enabled" label="Activas" type="switch" />
      <button className="eg-btn eg-btn--primary eg-btn--sm" disabled={!pend.length} onClick={guard(() => post('/api/questions/next'))}><Icon d={IC.arrowRight} className="eg-btn__icon" />Siguiente pregunta</button>
    </Head>
    <div className="cols cols--q">
      <div className="stack">
        <Stage eyebrow="En pantalla" src="/widget/question?debug"
          aside={<>{qs.current ? <span>{qs.current.user} · {PF[qs.current.platform] || 'Twitch'}</span> : <span>Ninguna</span>}<button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!qs.current} onClick={guard(() => post('/api/questions/hide'))}>Ocultar</button></>} />
        <Sec flat title="Cola" id="h-cola" aside={<span className="hint">{pend.length} {pend.length === 1 ? 'pregunta' : 'preguntas'} · llegan con <span className="eg-timeline__cmd">{c.command}</span></span>}>
          <div className="rows">{pend.length ? pend.map((q: Question, i: number) => <article key={q.id} className={cx('eg-post eg-post--row', i === 0 && 'eg-post--new')}>
            <div className="eg-post__content"><b>{q.text}</b><span className="eg-post__meta">{q.user} · {PF[q.platform] || 'Twitch'} · {ago(q.at)}</span></div>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/questions/show', { id: q.id }), 'En pantalla')}>Mostrar</button>
            <IconBtn icon={IC.up} label="Subir" disabled={i === 0} onClick={guard(() => post(`/api/questions/${q.id}/move`, { dir: -1 }))} />
            <IconBtn icon={IC.down} label="Bajar" disabled={i === pend.length - 1} onClick={guard(() => post(`/api/questions/${q.id}/move`, { dir: 1 }))} />
            <IconBtn icon={IC.x} label="Descartar" onClick={guard(() => post(`/api/questions/${q.id}/status`, { status: 'discarded' }))} />
          </article>) : <EmptyState>Aún no hay preguntas. Se envían con {c.command} tu pregunta.</EmptyState>}</div>
          <AddRow placeholder="Añadir una pregunta a mano…" onAdd={text => post('/api/questions', { text })} />
        </Sec>
        <Sec flat title="Respondidas" id="h-done" aside={<button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!done.length} onClick={guard(() => post('/api/questions/clear', {}))}>Limpiar</button>}>
          <div className="rows">{done.length ? done.map(q => <article key={q.id} className="eg-post eg-post--row eg-post--sent">
            <div className="eg-post__content"><b className="muted">{q.text}</b><span className="eg-post__meta">{q.user} · {q.status === 'discarded' ? 'descartada' : 'respondida'} {q.at ? `· ${fmtTime(q.at)}` : ''}</span></div>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post(`/api/questions/${q.id}/status`, { status: 'pending' }))}>Devolver a la cola</button>
          </article>) : <EmptyState>Nada todavía.</EmptyState>}</div>
        </Sec>
      </div>
      <div className="stack">
        <Sec title="Ajustes" id="h-aj">
          <IxField k="questions.command" label="Comando" className="mono" />
          <div className="row2">
            <IxField k="questions.maxPerUser" label="Por persona" type="range" min={1} max={10} />
            <IxField k="questions.minLength" label="Largo mínimo" type="range" min={0} max={60} />
          </div>
          <IxField k="questions.permission" label="Quién puede preguntar" type="perm" />
          <div className="row tight"><IxField k="questions.confirmInChat" label="Confirmar en el chat al recibirla" type="checkbox" /><IxField k="questions.showUser" label="Mostrar quién pregunta" type="checkbox" /></div>
          <IxField k="questions.confirmText" label="Texto de confirmación ({user} {position})" />
          <IxField k="questions.css" label="CSS del widget" type="css" placeholder=".text { font-size: 50px; }" />
          <p className="css-help">Clases: <code>.q</code> <code>.text</code> <code>.who</code> <code>.count</code></p>
        </Sec>
        <UrlSec url={origin() + '/widget/question'} size="1920×1080"><p className="hint">En Meld: + › Browser. Con <code>?nocount</code> se oculta el contador. El CSS propio del widget gana a los estilos de serie.</p></UrlSec>
      </div>
    </div>
  </>;
}

// ---------- Tier list ----------
export function TierList() {
  const I = useLive(s => s.interactive);
  const lists = I.tierlists || [];
  const [sel, setSel] = useState<string | null>(I.shownTierlist || lists[0]?.id || null);
  const [draft, setDraft] = useState({ title: '', items: '' });
  const l = lists.find(x => x.id === sel);
  const v = I.vote;
  const T = l ? '/api/tierlists/' + enc(l.id) : '';
  const saveTiers = (tiers: TierListTier[]) => put(T, { tiers });
  let main: ReactNode;
  if (!l) main = <Sec title="Nueva tier list" id="h-new">
    <label>Título <input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="Frameworks frontend" /></label>
    <label>Elementos (uno por línea) <textarea value={draft.items} onChange={e => setDraft({ ...draft, items: e.target.value })} style={{ minHeight: 120, fontFamily: 'var(--f-body)' }} placeholder={'React\nVue\nSvelte'} /></label>
    <div><button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(async () => {
      const d = await post<{ tierlist: { id: string } }>('/api/tierlists', { title: draft.title.trim() || 'Tier list', items: draft.items.split('\n').map(x => x.trim()).filter(Boolean) });
      setSel(d.tierlist.id); setDraft({ title: '', items: '' });
    })}>Crear</button></div></Sec>;
  else main = <>
    {v && v.listId === l.id && <Sec title={<>Votando: {v.item?.label}</>} id="h-vote" className="votebox" aside={<span className="hint">{v.total} {v.total === 1 ? 'voto' : 'votos'}{v.endsAt ? ' · se cierra sola' : ''}</span>}>
      <div className="vbars">{l.tiers.map((t: TierListTier) => { const n = v.counts[t.id || ''] || 0; const p = v.total ? (n / v.total) * 100 : 0; return <div key={t.id} className={cx('vbar', v.winner === t.id && 'win')}><span style={{ color: t.color }}>{t.label}</span><i><b style={{ width: p + '%', background: t.color }} /></i><span>{n}</span></div>; })}</div>
      <div className="row tight"><button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/vote/close', {}))}>Cerrar y colocar</button><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/vote/cancel'))}>Cancelar</button></div></Sec>}
    <Sec flat title="Elementos" id="h-items" aside={<span className="hint">{Object.keys(l.placements).length} / {l.items.length} colocados</span>}>
      <div className="rows">{l.items.length ? l.items.map((it: TierListItem) => <article key={it.id} className={cx('eg-post eg-post--row tl-row', v?.item?.id === it.id && 'eg-post--new')}>
        <div className="eg-post__content"><b>{it.label}</b></div>
        <span className="tbtns">{l.tiers.map((t: TierListTier) => <button key={t.id} type="button" className={cx('tbtn', l.placements[it.id] === t.id && 'on')} style={{ ['--c' as any]: t.color }} aria-pressed={l.placements[it.id] === t.id} onClick={guard(() => post(T + '/place', { item: it.id, tier: t.id }))}>{t.label}</button>)}
          <button type="button" className={cx('tbtn', !l.placements[it.id] && 'on')} title="Sin colocar" onClick={guard(() => post(T + '/place', { item: it.id, tier: '' }))}>–</button></span>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!!v} onClick={guard(() => post(T + '/vote', { item: it.id }))}>Votar en el chat</button>
        <IconBtn icon={IC.x} label={`Quitar ${it.label}`} onClick={guard(() => del(`${T}/items/${enc(it.id)}`))} />
      </article>) : <EmptyState>Sin elementos.</EmptyState>}</div>
      <AddRow placeholder="Añadir elementos (separados por comas)" onAdd={x => post(T + '/items', { items: x.split(',').map(y => y.trim()).filter(Boolean) })} />
    </Sec>
    <Sec title="Lista" id="h-list" aside={<div className="row tight">
      <button className={cx('eg-btn eg-btn--sm', I.shownTierlist === l.id ? 'eg-btn--secondary' : 'eg-btn--ghost')} onClick={guard(() => post(T + '/show'))}>{I.shownTierlist === l.id ? 'En pantalla' : 'Poner en pantalla'}</button>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/tierlists/hide'))}>Ocultar</button></div>}>
      <label>Título <LazyInput value={l.title} onCommit={x => put(T, { title: x }).catch(e => toast(e.message, true))} /></label>
      <div className="lbl">Tiers (de mejor a peor)
        <ul className="tiers-ed">{l.tiers.map((t: TierListTier, i: number) => <li key={t.id || i}>
          <input type="color" aria-label={`Color de ${t.label}`} value={t.color} onChange={e => { const tiers = structuredClone(l.tiers); tiers[i].color = e.target.value; saveTiers(tiers).catch(() => {}); }} />
          <LazyInput aria-label={`Nombre del tier ${i + 1}`} value={t.label} onCommit={x => { const tiers = structuredClone(l.tiers); tiers[i].label = x; saveTiers(tiers).catch(e => toast(e.message, true)); }} />
          <IconBtn icon={IC.x} label="Quitar tier" disabled={l.tiers.length <= 1} onClick={guard(() => saveTiers(l.tiers.filter((_: TierListTier, j: number) => j !== i)))} /></li>)}</ul>
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => saveTiers([...l.tiers, { label: '?', color: '#888888' }]))}><Icon d={IC.plus} className="eg-btn__icon" />Tier</button>
      </div>
      <div className="row tight">
        <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('¿Dejar todos los elementos sin colocar?')) await post(T + '/reset'); })}>Quitar todas las colocaciones</button>
        <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (confirm(`¿Borrar «${l.title}»?`)) { await del(T); setSel(null); } })}>Borrar lista</button>
      </div>
    </Sec></>;
  return <>
    <Head title="Tier list" desc="Clasifica lo que quieras y deja que el chat vote cada elemento escribiendo la letra del tier.">
      {v ? <Status tone="warning" icon={IC.play}>Votando</Status> : null}
    </Head>
    <ItemTabs label="Tier lists" items={lists.map(x => ({ id: x.id, label: x.title, badge: I.shownTierlist === x.id ? 'en pantalla' : undefined }))} selected={l?.id ?? null} onSelect={setSel} onNew={() => setSel(null)} newLabel="+ Nueva" />
    <div className="cols cols--q">
      <div className="stack">{main}</div>
      <div className="stack">
        {l && <Stage key={l.id} eyebrow="Vista previa" src={`/widget/tierlist?id=${enc(l.id)}&debug`} aside={<span>{I.shownTierlist === l.id ? 'En pantalla' : 'No está en pantalla'}</span>} />}
        <Sec title="Ajustes de la votación" id="h-vaj">
          <div className="row2"><IxField k="tierlist.command" label="Comando" className="mono" /><IxField k="tierlist.voteSeconds" label="Cierre automático (s, 0 = a mano)" type="number" min={0} /></div>
          <IxField k="tierlist.acceptBare" label="Vale escribir solo la letra («S», «A»…)" type="checkbox" />
          <IxField k="tierlist.css" label="CSS del widget" type="css" placeholder=".chip { font-size: 30px; }" />
          <p className="css-help">Clases: <code>.board</code> <code>.row</code> <code>.tier</code> <code>.chip</code> <code>.vote</code> <code>.bar</code> <code>.pool</code></p>
        </Sec>
        <UrlSec url={origin() + '/widget/tierlist'} size="1920×1080"><p className="hint">En Meld: + › Browser. Muestra la lista que pongas «en pantalla».</p></UrlSec>
      </div>
    </div>
  </>;
}

// ---------- Sorteo ----------
export function Sorteo() {
  const I = useLive(s => s.interactive);
  const g = I.giveaway, c = I.config.giveaway;
  const [member, setMember] = useState(false);
  const last = g.winners.at(-1);
  return <>
    <Head title="Sorteo" desc={<>Abre el sorteo, la gente entra escribiendo el comando y, al sortear, el ganador sale en pantalla y en el chat.{c.prize ? <> Premio: <b>{String(c.prize)}</b>.</> : null} </>}>
      <Status tone={g.open ? 'success' : 'neutral'} icon={g.open ? IC.check : undefined}>{g.open ? `Abierto · ${String(c.prize ?? '')} · ${String(c.command ?? '')}` : 'Cerrado'}</Status>
      {g.open ? <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/giveaway/close'))}>Cerrar inscripción</button> : <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(() => post('/api/giveaway/open', {}))}>Abrir sorteo</button>}
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('¿Vaciar participantes y ganadores?')) await post('/api/giveaway/reset'); })}>Vaciar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" disabled={!g.count} onClick={guard(async () => { const r = await post<{ winner: string; pool: number }>('/api/giveaway/draw'); toast(`Ganador: ${r.winner} (entre ${r.pool})`); })}><Icon d={IC.gift} className="eg-btn__icon" />Sortear</button>
    </Head>
    <div className="cols cols--q">
      <div className="stack">
        <div className="stats stats--3">
          <div className="eg-stat"><span className="eg-stat__label">Participantes</span><span className="eg-stat__value">{g.count}</span><span className="eg-stat__delta">{g.open ? 'inscripción abierta' : 'inscripción cerrada'}</span></div>
          <div className={cx('eg-stat', last && 'eg-stat--flash')}><span className="eg-stat__label">Último ganador</span><span className="eg-stat__value stat-name">{last ? last.user : '—'}</span><span className="eg-stat__delta">{last ? fmtTime(last.at) : 'aún no se ha sorteado'}</span></div>
        </div>
        <Sec flat title="Participantes" id="h-part" aside={<span className="hint">{g.count} {g.count === 1 ? 'participante' : 'participantes'}</span>}>
          <div className="rows">{g.entries.length ? g.entries.slice().reverse().map(e => <article key={e.user} className={cx('eg-post eg-post--row', g.winners.some(w => w.user === e.user) && 'won')}>
            <div className="eg-post__content"><b>{e.user}</b><span className="eg-post__meta">{e.member ? 'sub o miembro · ' : ''}{PF[String(e.platform)] || 'Twitch'}</span></div>
            <IconBtn icon={IC.x} label={`Quitar a ${e.user}`} onClick={guard(() => post('/api/giveaway/remove', { user: e.user }))} /></article>)
            : <EmptyState>Nadie todavía. {g.open ? <>Se entra con <code>{String(c.command ?? '')}</code>.</> : 'Abre el sorteo para que el chat pueda entrar.'}</EmptyState>}</div>
          <AddRow placeholder="Añadir a alguien a mano" onAdd={user => post('/api/giveaway/join', { user, member })}><label className="check"><input type="checkbox" checked={member} onChange={e => setMember(e.target.checked)} /> sub o miembro</label></AddRow>
        </Sec>
        <Sec flat title="Ganadores" id="h-win">
          <div className="rows">{g.winners.length ? g.winners.map(w => <article key={w.user + w.at} className="eg-post eg-post--row eg-post--new"><div className="eg-post__content"><b>{w.user}</b><span className="eg-post__meta">{fmtTime(w.at)}</span></div></article>) : <EmptyState>Aún no se ha sorteado.</EmptyState>}</div>
        </Sec>
        <Sec flat title="Sorteos anteriores" id="h-past">
          <div className="rows">{(g.history || []).length ? (g.history || []).slice(0, 8).map((h: any) => <article key={h.at} className="eg-post eg-post--row eg-post--sent"><div className="eg-post__content"><b>{h.winner}</b><span className="eg-post__meta">{fmtDate(h.at)} · {h.title}{h.prize ? ' · ' + h.prize : ''} · {h.entries} part.</span></div></article>) : <EmptyState>Sin sorteos anteriores.</EmptyState>}</div>
        </Sec>
      </div>
      <div className="stack">
        <Stage eyebrow="En pantalla" src="/widget/giveaway?debug" />
        <Sec title="Ajustes" id="h-gaj">
          <div className="row2">
            <IxField k="giveaway.title" label="Título" />
            <IxField k="giveaway.prize" label="Premio" placeholder="una camiseta EGDEV" />
            <IxField k="giveaway.command" label="Comando para entrar" className="mono" />
            <IxField k="giveaway.permission" label="Quién puede entrar" type="perm" />
            <IxField k="giveaway.memberLuck" label="Suerte de subs y miembros (×)" type="range" min={1} max={10} />
            <IxField k="giveaway.rollSeconds" label="Duración de la ruleta (s)" type="range" min={1} max={20} />
          </div>
          <div className="row tight">
            <IxField k="giveaway.excludeWinners" label="No repetir ganador" type="checkbox" />
            <IxField k="giveaway.announceInChat" label="Avisar en el chat" type="checkbox" />
            <IxField k="giveaway.meldConfetti" label="Confeti en Meld" type="checkbox" />
          </div>
          <IxField k="giveaway.openText" label="Al abrir" />
          <IxField k="giveaway.closeText" label="Al cerrar" />
          <IxField k="giveaway.winnerText" label="Al ganar" />
          <p className="hint">Variables: <code>{'{prize}'}</code> <code>{'{command}'}</code> <code>{'{count}'}</code> <code>{'{winner}'}</code></p>
          <IxField k="giveaway.css" label="CSS del widget" type="css" placeholder=".prize { color: #FF8FA6; }" />
          <p className="css-help">Clases: <code>.g</code> <code>.prize</code> <code>.join</code> <code>.count</code> <code>.reel</code> <code>.name</code></p>
        </Sec>
        <UrlSec url={origin() + '/widget/giveaway'} size="1920×1080" />
      </div>
    </div>
  </>;
}
