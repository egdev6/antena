// Preguntas, tier list y sorteo: lo que maneja el chat y se ve en pantalla.
import { useState, type ReactNode } from 'react';
import { del, enc, post, put } from '../../lib/api';
import { useLive } from '../../lib/live';
import { patchIx } from '../../lib/patch';
import { BrowserSource, codeTab, confirmDelete, cx, EmptyState, fmtDate, fmtTime, guard, Icon, IconBtn, LazyInput, Sec, Stage, Status, Switch, toast, WidgetLayout } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { PERMS } from './Editor';
import type { Question, TierListItem, TierListTier } from '../../lib/types';
import { origin } from './Widgets';
import { useManualSave } from '../../lib/draft';
import { Box, Dot, Kpis, ListPanel, NameCell, PageHead, SaveBar, Slide, Tags, Tabs, usePageTab } from '../../lib/layout';
import { go } from '../router';

function IxField({ k, label, type = 'text', ...rest }: { k: string; label: ReactNode; type?: string; [x: string]: any }) {
  const [sec, f] = k.split('.');
  const val = useLive(s => s.interactive?.config?.[sec]?.[f] as string | number | boolean | undefined);
  const set = (v: string | number | boolean) => patchIx(sec, { [f]: v });
  if (type === 'switch') return <Switch checked={!!val} onChange={set}>{label}</Switch>;
  if (type === 'range') { const n = Number(val ?? 0), min = Number(rest.min ?? 0), max = Number(rest.max ?? 100); return <label>{label}<span className="val">{n}</span><input type="range" min={min} max={max} value={n} style={{ ['--v' as any]: ((n - min) / ((max - min) || 1)) * 100 + '%' }} onChange={e => set(Number(e.target.value))} /></label>; }
  if (type === 'perm') return <label>{label}<select value={String(val ?? '')} onChange={e => set(e.target.value)}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  if (type === 'css') return <label>{label}<textarea className="code" spellCheck={false} style={{ minHeight: 70 }} value={val === undefined ? '' : String(val)} onKeyDown={codeTab} {...rest} onChange={e => set(e.target.value)} /></label>;
  if (type === 'number') return <label>{label}<input type="number" value={val === undefined ? '' : String(val)} {...rest} onChange={e => set(Number(e.target.value))} /></label>;
  return <label>{label}<input value={val === undefined ? '' : String(val)} {...rest} onChange={e => set(e.target.value)} /></label>;
}
const Head = ({ title, desc, children, tabs, tab, onTab }: { title: string; desc: ReactNode; children?: ReactNode; tabs?: any[]; tab?: string; onTab?: (t: string) => void }) =>
  <PageHead crumb="En directo" title={title} desc={desc} actions={children} tabs={tabs} tab={tab} onTab={onTab} />;
function AddRow({ placeholder, onAdd, children }: { placeholder: string; onAdd: (v: string) => Promise<unknown>; children?: ReactNode }) {
  const [v, setV] = useState('');
  const go = guard(async () => { if (!v.trim()) return; await onAdd(v.trim()); setV(''); });
  return <form className="row tight" onSubmit={e => { e.preventDefault(); go(); }}><input aria-label={placeholder} value={v} onChange={e => setV(e.target.value)} placeholder={placeholder} className="grow" />{children}<button type="submit" className="eg-btn eg-btn--secondary eg-btn--sm">Añadir</button></form>;
}

// ---------- Preguntas ----------
const PF: Record<string, string> = { manual: 'a mano', youtube: 'YouTube', twitch: 'Twitch' };
const ago = (at: string | number) => { const s = Math.max(0, (Date.now() - +new Date(at)) / 1000); return s < 60 ? `hace ${Math.round(s)} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `a las ${fmtTime(at)}`; };
export function Preguntas({ parts }: { parts: string[] }) {
  useManualSave();
  const [tab, setTab] = usePageTab(parts, 'preguntas', ['cola', 'ajustes']);
  const I = useLive(s => s.interactive);
  const c = I.config.questions as Record<string, string>, qs = I.questions;
  const pend = qs.list.filter(q => q.status === 'pending');
  const done = qs.list.filter(q => q.status === 'answered' || q.status === 'discarded').reverse();
  return <>
    <Head title="Preguntas" desc={<>El chat manda preguntas con <code>{c.command}</code>. Tú eliges cuál sale en pantalla.</>}
      tabs={[{ id: 'cola', label: 'Cola', count: pend.length }, { id: 'ajustes', label: 'Ajustes y capa' }]} tab={tab} onTab={setTab}>
      <IxField k="questions.enabled" label="Activas" type="switch" />
      <button className="eg-btn eg-btn--primary eg-btn--sm" disabled={!pend.length} onClick={guard(() => post('/api/questions/next'))}><Icon d={IC.arrowRight} className="eg-btn__icon" />Siguiente pregunta</button>
    </Head>
    {tab === 'cola' ? <div className="cols cols--q">
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
          </article>) : <EmptyState>Todavía no hay preguntas. Se envían con {c.command} tu pregunta.</EmptyState>}</div>
          <AddRow placeholder="Añadir una pregunta a mano…" onAdd={text => post('/api/questions', { text })} />
        </Sec>
        <Sec flat title="Respondidas" id="h-done" aside={<button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!done.length} onClick={guard(() => post('/api/questions/clear', {}))}>Limpiar</button>}>
          <div className="rows">{done.length ? done.map(q => <article key={q.id} className="eg-post eg-post--row eg-post--sent">
            <div className="eg-post__content"><b className="muted">{q.text}</b><span className="eg-post__meta">{q.user} · {q.status === 'discarded' ? 'descartada' : 'respondida'} {q.at ? `· ${fmtTime(q.at)}` : ''}</span></div>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post(`/api/questions/${q.id}/status`, { status: 'pending' }))}>Devolver a la cola</button>
          </article>) : <EmptyState>Nada todavía.</EmptyState>}</div>
        </Sec>
      </div>
    </div> : <WidgetLayout
      source={<BrowserSource url={origin() + '/widget/question'} size="1920×1080" hint={<>En Meld: + › Browser. Con <code>?nocount</code> se oculta el contador. El CSS propio del widget gana a los estilos de serie.</>} />}
      preview={<Stage eyebrow="Vista previa" src="/widget/question?debug" />}>
        <Sec title="Ajustes" id="h-aj">
          <IxField k="questions.command" label="Comando" className="mono" />
          <div className="row2">
            <IxField k="questions.maxPerUser" label="Por persona" type="range" min={1} max={10} />
            <IxField k="questions.minLength" label="Largo mínimo" type="range" min={0} max={60} />
          </div>
          <IxField k="questions.permission" label="Quién puede preguntar" type="perm" />
          <div className="row tight"><IxField k="questions.confirmInChat" label="Confirmar en el chat al recibirla" type="switch" /><IxField k="questions.showUser" label="Mostrar quién pregunta" type="switch" /></div>
          <IxField k="questions.confirmText" label="Texto de confirmación ({user} {position})" />
          <IxField k="questions.css" label="CSS del widget" type="css" placeholder=".text { font-size: 50px; }" />
          <p className="css-help">Clases: <code>.q</code> <code>.text</code> <code>.who</code> <code>.count</code></p>
        </Sec>
    </WidgetLayout>}
    <SaveBar />
  </>;
}

// ---------- Tier list ----------
export function TierList({ parts }: { parts: string[] }) {
  useManualSave();
  const I = useLive(s => s.interactive);
  const lists = I.tierlists || [];
  const tab = parts[1] === 'ajustes' ? 'ajustes' : 'listas';
  const open = tab === 'listas' ? parts[1] : undefined;
  const v = I.vote;
  const rows = lists.map(x => {
    const href = `#/tierlist/${enc(x.id)}`;
    const placed = Object.keys(x.placements || {}).length;
    return { id: x.id, href, open: open === x.id, cells: {
      name: <NameCell href={href} name={x.title} sub={x.tiers.map((t: TierListTier) => t.label).join(' · ')} />,
      state: v?.listId === x.id ? <Dot tone="live">Votando</Dot> : I.shownTierlist === x.id ? <Dot tone="ok">En pantalla</Dot> : <Dot tone="off">Oculta</Dot>,
      items: <span className="lv-mono">{placed} / {x.items.length} colocados</span>,
    } };
  });
  return <>
    <Head title="Tier list" desc="Clasifica lo que quieras y deja que el chat vote cada elemento escribiendo la letra del tier."
      tabs={[{ id: 'listas', label: 'Listas', count: lists.length }, { id: 'ajustes', label: 'Votación y capa' }]} tab={tab} onTab={t => go(t === 'listas' ? '#/tierlist' : '#/tierlist/ajustes')}>
      {v ? <Status tone="warning" icon={IC.play}>Votando</Status> : null}
      <a className="eg-btn eg-btn--primary eg-btn--sm" href="#/tierlist/nueva">+ Nueva tier list</a>
    </Head>
    {tab === 'listas' ? <>
      <Kpis items={[{ value: lists.length, label: 'tier lists' }, { value: lists.reduce((t, x) => t + x.items.length, 0), label: 'elementos en total' }, { value: I.shownTierlist ? 1 : 0, label: 'en pantalla' }, { value: v ? 'Sí' : 'No', label: 'votación abierta' }]} />
      <ListPanel title="Tier lists" cols={[{ key: 'name', label: 'Lista' }, { key: 'state', label: 'Estado' }, { key: 'items', label: 'Elementos' }]} rows={rows} empty="Todavía no hay tier lists." />
    </> : <WidgetLayout
      source={<BrowserSource url={origin() + '/widget/tierlist'} size="1920×1080" hint="En Meld: + › Browser. Muestra la lista que pongas «en pantalla»." />}
      preview={<Stage key="demo" eyebrow="Vista previa" src={I.shownTierlist ? `/widget/tierlist?id=${enc(I.shownTierlist)}&debug` : '/widget/tierlist?demo'} aside={<span>{I.shownTierlist ? 'La que está en pantalla' : 'Datos de ejemplo'}</span>} />}>
        <Sec title="Ajustes de la votación" id="h-vaj">
          <div className="row2"><IxField k="tierlist.command" label="Comando" className="mono" /><IxField k="tierlist.voteSeconds" label="Cierre automático (s, 0 = a mano)" type="number" min={0} /></div>
          <IxField k="tierlist.acceptBare" label="Vale escribir solo la letra («S», «A»…)" type="switch" />
          <IxField k="tierlist.css" label="CSS del widget" type="css" placeholder=".chip { font-size: 30px; }" />
          <p className="css-help">Clases: <code>.board</code> <code>.row</code> <code>.tier</code> <code>.chip</code> <code>.vote</code> <code>.bar</code> <code>.pool</code></p>
        </Sec>
    </WidgetLayout>}
    {tab === 'ajustes' && <SaveBar />}
    {open === 'nueva' ? <NuevaTier /> : open && lists.some(x => x.id === open) ? <TierSlide key={open} id={open} tab={parts[2] === 'niveles' ? 'niveles' : 'elementos'} /> : null}
  </>;
}
function NuevaTier() {
  const [draft, setDraft] = useState({ title: '', items: '' });
  const create = guard(async () => {
    const d = await post<{ tierlist: { id: string } }>('/api/tierlists', { title: draft.title.trim() || 'Tier list', items: draft.items.split('\n').map(x => x.trim()).filter(Boolean) });
    go(`#/tierlist/${enc(d.tierlist.id)}`);
  });
  return <Slide crumb={<><a href="#/tierlist">Tier list</a> › Nueva</>} title="Nueva tier list" back="#/tierlist"
    tabs={[{ id: 'min', label: 'Lo mínimo' }, { id: 'rest', label: 'Niveles, al crear', locked: true }]} tab="min" onTab={() => {}}
    foot={<footer className="lv-sfoot sticky"><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/tierlist">Cancelar</a><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}>Crear tier list</button></footer>}>
    <Box title="Lo mínimo">
      <label>Título <input autoFocus value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="Frameworks frontend" /></label>
      <label>Elementos (uno por línea) <textarea value={draft.items} onChange={e => setDraft({ ...draft, items: e.target.value })} style={{ minHeight: 120, fontFamily: 'var(--f-body)' }} placeholder={'React\nVue\nSvelte'} /></label>
      <p className="hint">Se crea con los niveles S, A, B, C y D. Los cambias después en «Niveles».</p>
    </Box>
  </Slide>;
}
function TierSlide({ id, tab }: { id: string; tab: string }) {
  const I = useLive(s => s.interactive);
  const l = (I.tierlists || []).find(x => x.id === id)!;
  const v = I.vote;
  const T = '/api/tierlists/' + enc(l.id);
  const saveTiers = (tiers: TierListTier[]) => put(T, { tiers });
  const base = `#/tierlist/${enc(l.id)}`;
  return <Slide crumb={<><a href="#/tierlist">Tier list</a> › {I.shownTierlist === l.id ? 'En pantalla' : 'Oculta'}</>} title={l.title} back="#/tierlist" wide
    head={<div className="row tight"><button className={cx('eg-btn eg-btn--sm', I.shownTierlist === l.id ? 'eg-btn--secondary' : 'eg-btn--ghost')} onClick={guard(() => post(T + '/show'))}>{I.shownTierlist === l.id ? 'En pantalla' : 'Poner en pantalla'}</button>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/tierlists/hide'))}>Ocultar</button></div>}
    tabs={[{ id: 'elementos', label: 'Elementos', count: l.items.length }, { id: 'niveles', label: 'Título y niveles', count: l.tiers.length }]} tab={tab} onTab={t => go(t === 'elementos' ? base : `${base}/${t}`)}
    foot={<footer className="lv-sfoot sticky">
      <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (confirmDelete(l.title, 'esta tier list')) { go('#/tierlist'); await del(T); } })}>Borrar lista…</button>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('¿Dejar todos los elementos sin colocar?')) await post(T + '/reset'); })}>Quitar colocaciones</button>
      <span className="sp" /><span className="lv-dirty">Se aplica al momento: la tier list se usa en directo.</span></footer>}>
    <div className="lv-cols aside">
      <div className="lv-col">
        {v && v.listId === l.id && <Sec title={<>Votando: {v.item?.label}</>} id="h-vote" className="votebox" aside={<span className="hint">{v.total} {v.total === 1 ? 'voto' : 'votos'}{v.endsAt ? ' · se cierra sola' : ''}</span>}>
          <div className="vbars">{l.tiers.map((t: TierListTier) => { const n = v.counts[t.id || ''] || 0; const p = v.total ? (n / v.total) * 100 : 0; return <div key={t.id} className={cx('vbar', v.winner === t.id && 'win')}><span style={{ color: t.color }}>{t.label}</span><i><b style={{ width: p + '%', background: t.color }} /></i><span>{n}</span></div>; })}</div>
          <div className="row tight"><button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/vote/close', {}))}>Cerrar y colocar</button><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/vote/cancel'))}>Cancelar</button></div></Sec>}
        {tab === 'elementos' ? <Sec flat title="Elementos" id="h-items" aside={<span className="hint">{Object.keys(l.placements).length} / {l.items.length} colocados</span>}>
          <div className="rows">{l.items.length ? l.items.map((it: TierListItem) => <article key={it.id} className={cx('eg-post eg-post--row tl-row', v?.item?.id === it.id && 'eg-post--new')}>
            <div className="eg-post__content"><b>{it.label}</b></div>
            <span className="tbtns">{l.tiers.map((t: TierListTier) => <button key={t.id} type="button" className={cx('tbtn', l.placements[it.id] === t.id && 'on')} style={{ ['--c' as any]: t.color }} aria-pressed={l.placements[it.id] === t.id} onClick={guard(() => post(T + '/place', { item: it.id, tier: t.id }))}>{t.label}</button>)}
              <button type="button" className={cx('tbtn', !l.placements[it.id] && 'on')} title="Sin colocar" onClick={guard(() => post(T + '/place', { item: it.id, tier: '' }))}>–</button></span>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!!v} onClick={guard(() => post(T + '/vote', { item: it.id }))}>Votar en el chat</button>
            <IconBtn icon={IC.x} label={`Quitar ${it.label}`} onClick={guard(() => del(`${T}/items/${enc(it.id)}`))} />
          </article>) : <EmptyState>Sin elementos.</EmptyState>}</div>
          <AddRow placeholder="Añadir elementos (separados por comas)" onAdd={x => post(T + '/items', { items: x.split(',').map(y => y.trim()).filter(Boolean) })} />
        </Sec> : <Box title="Título y niveles">
          <label>Título <LazyInput value={l.title} onCommit={x => put(T, { title: x }).catch(e => toast(e.message, true))} /></label>
          <div className="lbl">Niveles (de mejor a peor)
            <ul className="tiers-ed">{l.tiers.map((t: TierListTier, i: number) => <li key={t.id || i}>
              <input type="color" aria-label={`Color de ${t.label}`} value={t.color} onChange={e => { const tiers = structuredClone(l.tiers); tiers[i].color = e.target.value; saveTiers(tiers).catch(() => {}); }} />
              <LazyInput aria-label={`Nombre del tier ${i + 1}`} value={t.label} onCommit={x => { const tiers = structuredClone(l.tiers); tiers[i].label = x; saveTiers(tiers).catch(e => toast(e.message, true)); }} />
              <LazyInput aria-label={`Texto de voto del tier ${i + 1}`} placeholder="Texto de voto (opcional)" value={t.voteText ?? ''} onCommit={x => { const tiers = structuredClone(l.tiers); tiers[i].voteText = x; saveTiers(tiers).catch(e => toast(e.message, true)); }} />
              <IconBtn icon={IC.x} label="Quitar tier" disabled={l.tiers.length <= 1} onClick={guard(() => saveTiers(l.tiers.filter((_: TierListTier, j: number) => j !== i)))} /></li>)}</ul>
            <p className="hint">El texto de voto solo se muestra en pantalla. El chat vota con el nombre o el id del nivel; vacío muestra el nombre.</p>
            <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => saveTiers([...l.tiers, { label: '?', color: '#888888' }]))}><Icon d={IC.plus} className="eg-btn__icon" />Nivel</button>
          </div>
        </Box>}
      </div>
      <aside className="lv-col"><Stage key={l.id} eyebrow="Vista previa" src={`/widget/tierlist?id=${enc(l.id)}&debug`} aside={<span>{I.shownTierlist === l.id ? 'En pantalla' : 'No está en pantalla'}</span>} /></aside>
    </div>
  </Slide>;
}

// ---------- Sorteo ----------
export function Sorteo({ parts }: { parts: string[] }) {
  useManualSave();
  const [tab, setTab] = usePageTab(parts, 'sorteo', ['sorteo', 'ajustes']);
  const I = useLive(s => s.interactive);
  const g = I.giveaway, c = I.config.giveaway;
  const [member, setMember] = useState(false);
  const last = g.winners.at(-1);
  return <>
    <Head title="Sorteo" desc={<>Abre el sorteo, la gente entra escribiendo el comando y, al sortear, el ganador sale en pantalla y en el chat.{c.prize ? <> Premio: <b>{String(c.prize)}</b>.</> : null} </>}
      tabs={[{ id: 'sorteo', label: 'Sorteo', count: g.count }, { id: 'ajustes', label: 'Ajustes y capa' }]} tab={tab} onTab={setTab}>
      <Status tone={g.open ? 'success' : 'neutral'} icon={g.open ? IC.check : undefined}>{g.open ? `Abierto · ${String(c.prize ?? '')} · ${String(c.command ?? '')}` : 'Cerrado'}</Status>
      {g.open ? <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/giveaway/close'))}>Cerrar inscripción</button> : <button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(() => post('/api/giveaway/open', {}))}>Abrir sorteo</button>}
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('¿Vaciar participantes y ganadores?')) await post('/api/giveaway/reset'); })}>Vaciar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" disabled={!g.count} onClick={guard(async () => { const r = await post<{ winner: string; pool: number }>('/api/giveaway/draw'); toast(`Ganador: ${r.winner} (entre ${r.pool})`); })}><Icon d={IC.gift} className="eg-btn__icon" />Sortear</button>
    </Head>
    {tab === 'sorteo' ? <div className="cols cols--q">
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
      <div className="stack"><Stage eyebrow="En pantalla" src="/widget/giveaway?debug" /></div>
    </div> : <WidgetLayout source={<BrowserSource url={origin() + '/widget/giveaway'} size="1920×1080" />} preview={<Stage eyebrow="Vista previa" src="/widget/giveaway?debug" />}>
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
            <IxField k="giveaway.excludeWinners" label="No repetir ganador" type="switch" />
            <IxField k="giveaway.announceInChat" label="Avisar en el chat" type="switch" />
            <IxField k="giveaway.meldConfetti" label="Confeti en Meld" type="switch" />
          </div>
          <IxField k="giveaway.openText" label="Al abrir" />
          <IxField k="giveaway.closeText" label="Al cerrar" />
          <IxField k="giveaway.winnerText" label="Al ganar" />
          <p className="hint">Variables: <code>{'{prize}'}</code> <code>{'{command}'}</code> <code>{'{count}'}</code> <code>{'{winner}'}</code></p>
          <IxField k="giveaway.css" label="CSS del widget" type="css" placeholder=".prize { color: #FF8FA6; }" />
          <p className="css-help">Clases: <code>.g</code> <code>.prize</code> <code>.join</code> <code>.count</code> <code>.reel</code> <code>.name</code></p>
        </Sec>
    </WidgetLayout>}
    <SaveBar />
  </>;
}
