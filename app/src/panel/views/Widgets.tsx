// Widgets (v3): el catálogo de widgets en tarjetas → slide con sus ajustes (O3.3: fuente, ajustes y vista previa).
// Los objetivos, lo único que creas tú, viven dentro de su tarjeta: tabla → objetivo (3.er nivel).
import { enc, post, put, del } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { patchWidgets } from '../../lib/patch';
import { BrowserSource, codeTab, confirmDelete, copy, EmptyState, guard, LazyInput, Panel, PfIcon, Stage, Switch, WidgetLayout } from '../../lib/ui';
import { useManualSave } from '../../lib/draft';
import { Box, Card, CardGroup, Dot, ListPanel, NameCell, PageHead, SaveBar, Slide, Tags } from '../../lib/layout';
import { go } from '../router';
import { useState, type ReactNode } from 'react';
import type { GoalBar, GoalConfig, GoalValue, WidgetSection } from '../../lib/types';
import { CHAT_ANIMS, type ChatAnim } from '../../../../public/widgets/chat-anims.js';

export const origin = () => location.origin;
const INFO: Record<string, { title: string; path: string; size: string; w: number; h: number; desc: string }> = {
  chat: { title: 'Chat en pantalla', path: '/widget/chat', size: '600×900', w: 600, h: 900, desc: 'El chat de Twitch y YouTube juntos, con tu estilo. Ideal para la escena de solo cámara.' },
  latest: { title: 'Últimos y ticker', path: '/widget/latest', size: '1400×200', w: 1400, h: 260, desc: 'Último seguidor, sub, bits… y una banda que recorre los últimos apoyos.' },
  viewers: { title: 'Espectadores', path: '/widget/viewers', size: '900×160', w: 900, h: 160, desc: 'Espectadores a la vez en Twitch y YouTube, por separado y en total. Se actualiza solo mientras emites.' },
  credits: { title: 'Créditos', path: '/widget/credits', size: '1920×1080', w: 1920, h: 1080, desc: 'Créditos finales con todos los que han apoyado en el directo.' },
};
const q = (p: string, mode: string) => `${p}${p.includes('?') ? '&' : '?'}${mode}`;

function WField({ w, f, label, type = 'text', ...rest }: { w: string; f: string; label: ReactNode; type?: string; [k: string]: unknown }) {
  const val = useLive(s => ((s.config.widgets as WidgetSection | undefined)?.[w] as WidgetSection | undefined)?.[f] as string | number | boolean | undefined);
  if (type === 'switch') return <Switch checked={!!val} onChange={x => patchWidgets({ [w]: { [f]: x } })}>{label}</Switch>;
  if (type === 'number') return <label>{label}<input type="number" value={val === undefined ? '' : String(val)} {...rest} onChange={e => patchWidgets({ [w]: { [f]: Number(e.target.value) } })} /></label>;
  if (type === 'css') return <label>{label}<textarea className="code" spellCheck={false} value={val === undefined ? '' : String(val)} onKeyDown={codeTab} {...rest} onChange={e => patchWidgets({ [w]: { [f]: e.target.value } })} /></label>;
  return <label>{label}<input value={val === undefined ? '' : String(val)} {...rest} onChange={e => patchWidgets({ [w]: { [f]: e.target.value } })} /></label>;
}
function ListChecks({ w, f, items }: { w: string; f: string; items: [string, string][] }) {
  const cur = useLive(s => ((((s.config.widgets as WidgetSection | undefined)?.[w] as WidgetSection | undefined)?.[f]) as string[] | undefined) || []);
  return <>{items.map(([k, l]) => <label className="check" key={k}><input type="checkbox" checked={cur.includes(k)} onChange={e => patchWidgets({ [w]: { [f]: e.target.checked ? [...cur, k] : cur.filter(x => x !== k) } })} /> {l}</label>)}</>;
}

/** Animaciones de los mensajes del chat: las mismas para entrar y para salir. Los ids vienen de
 *  public/widgets/chat-anims.js; el Record obliga a dar una etiqueta por id, ni más ni menos. */
const CHAT_ANIM_LABELS: Record<ChatAnim, string> = { slide: 'Deslizante', fade: 'Desvanecida', pop: 'Pop', bounce: 'Rebote', zoom: 'Zoom', flip: 'Giro', blur: 'Desenfoque', drop: 'Caída', none: 'Sin animación' };
const CHAT_ANIM_OPTIONS: [string, string][] = CHAT_ANIMS.map(a => [a, CHAT_ANIM_LABELS[a]]);

/** Select de opciones de chat (#130): helper estable a nivel módulo, exclusivo del bloque chat. */
function ChatSelect({ f, label, options }: { f: string; label: string; options: [string, string][] }) {
  const val = useLive(s => String(((s.config.widgets as WidgetSection | undefined)?.chat as WidgetSection | undefined)?.[f] ?? ''));
  return <label>{label}<select value={val} onChange={e => patchWidgets({ chat: { [f]: e.target.value } })}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;
}

export function Widget({ name }: { name: string }) {
  useManualSave();
  const info = INFO[name];
  if (!info) return <p className="hint">Widget desconocido.</p>;
  let form: ReactNode = null;
  if (name === 'chat') form = <>
    <div className="row2">
      <WField w="chat" f="maxMessages" label="Mensajes en pantalla" type="number" min={1} max={50} />
      <WField w="chat" f="fontSize" label="Tamaño de letra (px)" type="number" min={12} max={60} />
      <WField w="chat" f="fadeAfterSec" label="Desaparecen tras (s, 0 = nunca)" type="number" min={0} />
      <div className="lbl">Plataformas<div className="row field-ctl"><ListChecks w="chat" f="platforms" items={[['twitch', 'Twitch'], ['youtube', 'YouTube']]} /></div></div>
      <WField w="chat" f="hideCommands" label="Ocultar los comandos (!…)" type="switch" />
      <WField w="chat" f="hideOwner" label="Ocultar mis mensajes (lo que escribo desde antena, el móvil o el prompter)" type="switch" />
      <WField w="chat" f="showPlatform" label="Mostrar el icono de la plataforma" type="switch" />
      <WField w="chat" f="reverse" label="Chat invertido (los mensajes nuevos aparecen arriba)" type="switch" />
      <ChatSelect f="animIn" label="Animación de entrada" options={CHAT_ANIM_OPTIONS} />
      <ChatSelect f="animOut" label="Animación al desaparecer" options={CHAT_ANIM_OPTIONS} />
    </div>
    <WField w="chat" f="css" label="CSS personalizado" type="css" placeholder=".msg { border-left-color: #fff; }" />
    <p className="css-help">Clases: <code>.msg</code> <code>.msg.mod</code> <code>.who</code> <code>.text</code> <code>.pf</code></p></>;
  if (name === 'latest') form = <>
    <h3 className="sub-h">Últimos</h3>
    <div className="row lead"><ListChecks w="latest" f="items" items={[['follow', 'Seguidor'], ['sub', 'Suscripción'], ['cheer', 'Bits'], ['raid', 'Raid'], ['superchat', 'Super Chat'], ['member', 'Miembro'], ['any', 'Cualquier evento']]} /></div>
    <WField w="latest" f="css" label="CSS de «últimos»" type="css" placeholder=".item .big { font-size: 34px; }" />
    <p className="css-help">Clases: <code>.root</code> <code>.root.col</code> <code>.item</code> <code>.item-{'<tipo>'}</code> <code>.item.empty</code> <code>.item.flash</code> <code>.kick</code> <code>.big</code> <code>.extra</code></p>
    <h3 className="sub-h">Ticker</h3>
    <div className="row3">
      <WField w="ticker" f="label" label="Etiqueta" />
      <WField w="ticker" f="count" label="Eventos" type="number" min={1} max={30} />
      <WField w="ticker" f="speed" label="Velocidad (px/s)" type="number" min={10} max={300} />
    </div>
    <WField w="ticker" f="css" label="CSS del ticker" type="css" placeholder=".band { border-top-color: #fff; }" />
    <p className="css-help">Clases: <code>.root</code> <code>.band</code> <code>.label</code> <code>.track</code> <code>.run</code> <code>.it</code> <code>.it b</code> <code>.k</code></p></>;
  if (name === 'viewers') form = <>
    <div className="lbl">Plataformas<div className="row field-ctl"><ListChecks w="viewers" f="platforms" items={[['twitch', 'Twitch'], ['youtube', 'YouTube']]} /></div></div>
    <WField w="viewers" f="showTotal" label="Mostrar el total (con dos plataformas)" type="switch" />
    <WField w="viewers" f="showPeak" label="Mostrar el pico del directo" type="switch" />
    <WField w="viewers" f="css" label="CSS personalizado" type="css" placeholder=".item .big { font-size: 64px; }" />
    <p className="css-help">Clases: <code>.root</code> <code>.root.col</code> <code>.item</code> <code>.item-twitch</code> <code>.item-youtube</code> <code>.item-total</code> <code>.item.off</code> <code>.item.up</code> <code>.kick</code> <code>.big</code> <code>.extra</code></p>
    <p className="hint mt">Parámetros: <code>?platforms=twitch</code> · <code>?layout=column</code> · <code>?total=0</code> · <code>?peak=1</code>. La cifra se refresca cada «pollSec» de la alerta de récord.</p></>;
  if (name === 'credits') form = <>
    <div className="row2"><WField w="credits" f="title" label="Título" /><WField w="credits" f="speed" label="Velocidad (px/s)" type="number" min={10} max={300} /></div>
    <WField w="credits" f="subtitle" label="Línea final" />
    <WField w="credits" f="css" label="CSS personalizado" type="css" placeholder=".grp li { color: #FF8FA6; }" />
    <p className="css-help">Clases: <code>.roll</code> <code>.head</code> <code>.grp</code> <code>.grp li</code> <code>.end</code> <code>.kick</code> <code>.big</code> <code>.sub</code> <code>.hl</code></p>
    <div className="row"><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/credits/play'))}>Lanzar créditos</button><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/credits/stop'))}>Parar</button></div>
    <p className="hint mt">Parámetros: <code>?transparent</code> (sin fondo) · <code>?autoplay</code> · <code>?loop</code>. Se lanzan desde aquí, desde el MCP, con una acción o con un atajo del Stream Deck.</p></>;
  return <Slide crumb={<><a href="#/widgets">Widgets</a> › {info.title}</>} title={info.title} back="#/widgets" wide
    foot={<SaveBar />}>
    <p className="hint">{info.desc}</p>
    <WidgetLayout
      source={<BrowserSource url={origin() + info.path} size={info.size} label={name === 'latest' ? 'Últimos' : undefined} also={name === 'latest' ? [{ url: origin() + '/widget/ticker', size: '1920×64', label: 'Ticker' }] : []} />}
      preview={<>
        <Stage eyebrow={name === 'latest' ? 'Vista previa · Últimos' : 'Vista previa'} aside={<span>Datos de ejemplo</span>} src={q(info.path, 'demo')} w={info.w} h={info.h} />
        {name === 'latest' && <Stage eyebrow="Vista previa · Ticker" aside={<span>Datos de ejemplo</span>} src="/widget/ticker?demo" w={1920} h={120} />}
      </>}>
      <Panel>{form}</Panel>
    </WidgetLayout>
  </Slide>;
}

/** Widgets (v3): el catálogo de widgets en tarjetas. Lo que creas tú (los objetivos) vive dentro de su tarjeta. */
export function Widgets({ parts }: { parts: string[] }) {
  const goals: GoalConfig[] = useLive(s => s.config.widgets?.goals || []);
  const w = useLive(s => (s.config.widgets || {}) as any);
  const I = useLive(s => s.interactive);
  const tp = useLive(s => s.teleprompter);
  const open = parts[1];
  const css = (x?: string) => (x ? [{ t: 'CSS propio', on: true }] : []);
  const shownGoals = goals.filter(g => g.visible !== false).length;
  const bars = goals.reduce((t, g) => t + g.bars.length, 0);
  const pend = (I?.questions?.list || []).filter((q: any) => q.status === 'pending').length;
  const url = (p: string) => <span className="lv-cmeta">{p}</span>;
  const copyBtn = (p: string) => <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(origin() + p)}>Copiar URL</button>;
  const fixed = (id: string, thumb: ReactNode, tags: { t: ReactNode; on?: boolean }[], action?: ReactNode) => {
    const i = INFO[id];
    return <Card key={id} href={`#/widgets/${id}`} label={`Abrir ${i.title}`} open={open === id} thumb={thumb} title={i.title} aside={<span className="lv-cmeta">{i.size}</span>}
      foot={<>{url(i.path)}<span className="sp" />{action || copyBtn(i.path)}</>}><Tags items={tags} /></Card>;
  };
  return <>
    <PageHead crumb={`Configurar · ${Object.keys(INFO).length + 5} widgets`} title="Widgets"
      desc="Cada uno es una fuente de navegador para Meld (sus URL también están en Fuentes para Meld). Cuando la app trae un widget nuevo, aparece aquí como una tarjeta más." />
    <div className="lv-groups">
      <CardGroup tour="widgets-catalog" title="Capas de pantalla" count={5} note="Se ajustan aquí y se dejan puestas en Meld" wide>
        {fixed('chat', <div className="lv-wchat"><i style={{ width: '62%' }} /><i style={{ width: '80%' }} /><i style={{ width: '48%' }} /><i style={{ width: '72%' }} /><i style={{ width: '56%' }} /></div>,
          [...((w.chat?.platforms || ['twitch', 'youtube']) as string[]).map(p => ({ t: p === 'youtube' ? 'YouTube' : 'Twitch' })), ...css(w.chat?.css)])}
        <Card href="#/widgets/objetivos" label="Abrir Objetivos" open={open === 'objetivos'} title="Objetivos" aside={<span className="lv-cmeta">1 capa por objetivo</span>}
          thumb={<div className="lv-wgoal">{(goals.flatMap(g => g.bars).slice(0, 3).length ? goals.flatMap(g => g.bars).slice(0, 3) : [null, null]).map((b, i) => <i key={i}><b style={{ width: [70, 55, 38][i] + '%', background: b && b.visible === false ? '#8a8f98' : undefined }} /></i>)}</div>}
          foot={<>{url('/widget/goal?id=…')}<span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/widgets/objetivos">{goals.length ? 'Ver objetivos' : 'Crear el primero'}</a></>}>
          <Tags items={goals.length ? [{ t: goals.length === 1 ? '1 objetivo' : `${goals.length} objetivos`, on: true }, { t: `${shownGoals} en pantalla` }, { t: bars === 1 ? '1 barra' : `${bars} barras` }] : [{ t: 'Sin objetivos todavía' }]} />
        </Card>
        {fixed('latest', <><div className="lv-wbar"><i /><i /><i /></div><div className="lv-wtick" /></>,
          [{ t: (w.latest?.items || []).length ? `${(w.latest.items as string[]).length} tipos de apoyo` : 'Últimos apoyos' }, { t: 'con ticker' }, ...css(w.latest?.css || w.ticker?.css)])}
        {fixed('viewers', <div className="lv-wbar"><i /><i /></div>,
          [...((w.viewers?.platforms || ['twitch', 'youtube']) as string[]).map(p => ({ t: p === 'youtube' ? 'YouTube' : 'Twitch' })), ...(w.viewers?.showTotal === false ? [] : [{ t: 'con total' }]), ...css(w.viewers?.css)])}
        {fixed('credits', <div className="lv-wcred"><b>GRACIAS</b><i /><i /><i /><i /></div>, [{ t: w.credits?.title || 'Créditos del directo' }, ...css(w.credits?.css)],
          <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={guard(() => post('/api/credits/play'), 'Créditos en marcha')}>Lanzar créditos</button>)}
      </CardGroup>
      <CardGroup title="Se manejan en directo" count={4} note="Su tarjeta lleva a su página de En directo" wide>
        <Card href="#/preguntas" label="Ir a Preguntas" title="Preguntas" aside={<Dot tone={pend ? 'ok' : 'off'}>{pend ? `${pend} en cola` : 'Cola vacía'}</Dot>}
          thumb={<div className="lv-wq"><small>Pregunta del chat</small>{I?.questions?.current?.text || '¿Cómo testeáis los hooks?'}</div>}
          foot={<>{url('/widget/question')}<span className="sp" /><span className="lv-cmeta">Ir a la página →</span></>}><Tags items={[{ t: String(I?.config?.questions?.command || '!pregunta') }]} /></Card>
        <Card href="#/tierlist" label="Ir a Tier list" title="Tier list" aside={<Dot tone={I?.vote ? 'live' : I?.shownTierlist ? 'ok' : 'off'}>{I?.vote ? 'Votando' : I?.shownTierlist ? 'En pantalla' : 'Oculta'}</Dot>}
          thumb={<div className="lv-wbar col"><i /><i /><i /></div>}
          foot={<>{url('/widget/tierlist')}<span className="sp" /><span className="lv-cmeta">Ir a la página →</span></>}><Tags items={[{ t: (I?.tierlists || []).length === 1 ? '1 lista' : `${(I?.tierlists || []).length} listas` }]} /></Card>
        <Card href="#/sorteo" label="Ir a Sorteo" title="Sorteo" aside={<Dot tone={I?.giveaway?.open ? 'ok' : 'off'}>{I?.giveaway?.open ? `Abierto · ${I.giveaway.count}` : 'Cerrado'}</Dot>}
          thumb={<div className="lv-wcred"><b>SORTEO</b><i /><i /></div>}
          foot={<>{url('/widget/giveaway')}<span className="sp" /><span className="lv-cmeta">Ir a la página →</span></>}><Tags items={[{ t: String(I?.config?.giveaway?.command || '!sorteo') }]} /></Card>
        <Card href="#/teleprompter" label="Ir a Teleprompter" title="Teleprompter" aside={<span className="lv-tag">Solo lo ves tú</span>}
          thumb={<div className="lv-wchat plain"><i style={{ width: '90%' }} /><i style={{ width: '84%', background: 'rgba(255,255,255,.3)' }} /><i style={{ width: '70%' }} /></div>}
          foot={<>{url('/widget/teleprompter')}<span className="sp" /><span className="lv-cmeta">Ir a la página →</span></>}><Tags items={[{ t: (tp?.scripts || []).length === 1 ? '1 guion' : `${(tp?.scripts || []).length} guiones` }]} /></Card>
      </CardGroup>
    </div>
    {open && INFO[open] ? <Widget key={open} name={open} /> : null}
    {open === 'objetivos' ? <ObjetivosSlide parts={parts} goals={goals} /> : null}
  </>;
}

/** 2.º nivel: la tabla de tus objetivos, con «+ Nuevo objetivo». Cada objetivo abre un 3.er nivel. */
function ObjetivosSlide({ parts, goals }: { parts: string[]; goals: GoalConfig[] }) {
  const sub = parts[2];
  const metrics = useLive(s => s.metrics || {});
  const values: GoalValue[] = useLive(s => s.widgets?.goals || []);
  const label = (k: string) => (metrics[k] as { label?: string } | undefined)?.label || k;
  const rows = goals.map(g => {
    const href = `#/widgets/objetivos/${enc(g.id)}`;
    const vs = values.find(x => x.id === g.id);
    return { id: g.id, href, open: sub === g.id, cls: g.visible === false ? 'is-off' : undefined, cells: {
      name: <NameCell href={href} name={g.title} sub={`/widget/goal?id=${g.id}`} />,
      state: <Dot tone={g.visible === false ? 'off' : 'ok'}>{g.visible === false ? 'Oculto' : 'En pantalla'}</Dot>,
      bars: <Tags items={g.bars.map(b => ({ t: `${b.platform === 'youtube' ? 'YT' : 'TW'} · ${label(b.metric).toLowerCase()} ${vs?.bars?.find(x => x.id === b.id)?.value ?? 0}/${b.target}`, on: b.visible !== false }))} />,
      copy: <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(`${origin()}/widget/goal?id=${enc(g.id)}`)}>Copiar URL</button>,
    } };
  });
  return <>
    <Slide crumb={<><a href="#/widgets">Widgets</a> › Objetivos</>} title="Objetivos" back="#/widgets" wide
      head={<a className="eg-btn eg-btn--primary eg-btn--sm" href="#/widgets/objetivos/nuevo">+ Nuevo objetivo</a>}>
      <div className="lv-cols aside">
        <div className="lv-col">
          <ListPanel tour="goals-list" title="Mis objetivos" note="Cada uno es su propia capa en Meld. Pulsa uno para editar sus barras."
            cols={[{ key: 'name', label: 'Objetivo' }, { key: 'state', label: 'Estado' }, { key: 'bars', label: 'Barras' }, { key: 'copy', label: '' }]}
            rows={rows} empty={<>Todavía no hay objetivos. <a href="#/widgets/objetivos/nuevo">Crea el primero</a>.</>} />
        </div>
        <aside className="lv-col"><Box title="Cómo funcionan"><p className="hint">Una caja, varias metas: añade barras de Twitch y YouTube a un mismo objetivo. Los contadores se mueven solos con el directo; +1, −1 y «Fijar» se aplican al momento.</p></Box></aside>
      </div>
    </Slide>
    {sub === 'nuevo' ? <NuevoObjetivo /> : sub && goals.some(g => g.id === sub) ? <GoalSlide key={sub} id={sub} /> : null}
  </>;
}

function NuevoObjetivo() {
  const metrics = useLive(s => s.metrics || {});
  const [d, setD] = useState({ title: '', platform: 'twitch', metric: 'follows', target: 10 });
  const create = guard(async () => {
    const r = await post<{ goal: GoalConfig }>('/api/goals', { title: d.title.trim() || 'Nuevo objetivo', platform: d.platform, metric: d.metric, target: d.target });
    live.update(s => ({ config: { ...s.config, widgets: { ...s.config.widgets, goals: [...(s.config.widgets?.goals || []), r.goal] } } }));
    go(`#/widgets/objetivos/${enc(r.goal.id)}`);
  });
  return <Slide crumb={<><a href="#/widgets">Widgets</a> › <a href="#/widgets/objetivos">Objetivos</a> › Nuevo</>} title="Nuevo objetivo" back="#/widgets/objetivos"
    tabs={[{ id: 'min', label: 'Lo mínimo' }, { id: 'rest', label: 'Barras y CSS, al crear', locked: true }]} tab="min" onTab={() => {}}
    foot={<footer className="lv-sfoot sticky"><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/widgets/objetivos">Cancelar</a><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}>Crear objetivo</button></footer>}>
    <Box title="Lo mínimo">
      <label>Título <input autoFocus value={d.title} onChange={e => setD({ ...d, title: e.target.value })} placeholder="Meta de hoy" /></label>
      <div className="row3">
        <label>Plataforma <select value={d.platform} onChange={e => setD({ ...d, platform: e.target.value, metric: GOAL_METRICS[e.target.value][0] })}>{GOAL_PLATFORMS.map(p => <option key={p} value={p}>{p === 'youtube' ? 'YouTube' : 'Twitch'}</option>)}</select></label>
        <label>Qué cuenta <select value={d.metric} onChange={e => setD({ ...d, metric: e.target.value })}>{GOAL_METRICS[d.platform].map(k => <option key={k} value={k}>{(metrics[k] as { label?: string } | undefined)?.label || k}</option>)}</select></label>
        <label>Meta <input type="number" min={1} value={d.target} onChange={e => setD({ ...d, target: Math.max(1, Number(e.target.value) || 1) })} /></label>
      </div>
      <p className="hint">Se crea con una barra. Después puedes añadir más (por ejemplo, una de YouTube) en el mismo objetivo.</p>
    </Box>
  </Slide>;
}

// Métricas válidas por plataforma (contrato de src/goals.mjs; los enums del schema son la fuente).
const GOAL_PLATFORMS = ['twitch', 'youtube'] as const;
const GOAL_METRICS: Record<string, string[]> = {
  twitch: ['follows', 'subs', 'bits', 'raids', 'events'],
  youtube: ['superchats', 'members', 'events'],
};

function GoalSlide({ id }: { id: string }) {
  const goals: GoalConfig[] = useLive(s => s.config.widgets?.goals || []);
  const values: GoalValue[] = useLive(s => s.widgets?.goals || []);
  const metrics = useLive(s => s.metrics || {});
  const [setVal, setSetVal] = useState<Record<string, string>>({});
  const g = goals.find(x => x.id === id);
  const reloadGoals = (list: GoalConfig[]) => live.update(s => ({ config: { ...s.config, widgets: { ...s.config.widgets, goals: list } } }));
  // Optimistic save: if the server rejects the change, the panel goes back to the saved list
  // instead of showing a value that does not exist (the error still reaches guard's toast).
  const saveOptimistic = async (next: GoalConfig[], request: () => Promise<unknown>) => {
    const saved = goals;
    reloadGoals(next);
    try { return await request(); } catch (e) { reloadGoals(saved); throw e; }
  };
  const saveGoal = (id: string, patch: Partial<GoalConfig>) =>
    saveOptimistic(goals.map(g => (g.id === id ? { ...g, ...patch } : g)), () => put('/api/goals/' + enc(id), patch));
  const saveBar = (boxId: string, barId: string, patch: Partial<GoalBar>) =>
    saveOptimistic(goals.map(g => (g.id === boxId ? { ...g, bars: g.bars.map(b => (b.id === barId ? { ...b, ...patch } : b)) } : g)),
      () => put(`/api/goals/${enc(boxId)}/bars/${enc(barId)}`, patch));
  // A metric only counts on some platforms: switching platform keeps the metric when it is valid
  // there and otherwise takes the first valid one, in the same request (the server checks the pair).
  const savePlatform = (boxId: string, b: GoalBar, platform: GoalBar['platform']) => {
    const valid = GOAL_METRICS[platform] || GOAL_METRICS.twitch;
    return saveBar(boxId, b.id, { platform, metric: valid.includes(b.metric) ? b.metric : valid[0] });
  };
  const setValue = (boxId: string, barId: string, value: number) => live.update(s => ({
    widgets: { ...s.widgets, goals: (s.widgets?.goals || []).map(g => (g.id === boxId ? { ...g, bars: g.bars.map(b => (b.id === barId ? { ...b, value } : b)) } : g)) },
  }));
  if (!g) return null;
  return <>
    {(() => {
      const vs = values.find(x => x.id === g.id);
      const visibleBars = g.visible === false ? 0 : g.bars.filter(b => b.visible !== false).length;
      const previewHeight = 210 + 60 * visibleBars;
      return <Slide key={g.id} crumb={<><a href="#/widgets">Widgets</a> › <a href="#/widgets/objetivos">Objetivos</a> › Objetivo</>} title={g.title} back="#/widgets/objetivos" close="#/widgets" wide
        foot={<footer className="lv-sfoot sticky"><button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(g.title, 'este objetivo')) return; const d = await del<{ goals: GoalConfig[] }>('/api/goals/' + enc(g.id)); reloadGoals(d.goals); go('#/widgets/objetivos'); })}>Borrar objetivo…</button><span className="sp" /><span className="lv-dirty">Los objetivos se guardan al momento: sus barras cuentan en directo.</span></footer>}>
        <article className="goal-card" data-tour="goals-editor">
        <p className="hint">{visibleBars} barras visibles · {g.visible === false ? 'Caja oculta' : 'En pantalla'}</p>
        <WidgetLayout
          source={<BrowserSource url={`${origin()}/widget/goal?id=${enc(g.id)}`} size={`1000×${previewHeight}`} hint="En Meld: + › Browser. Cada caja de objetivos es una fuente propia." />}
          /* O1.5: la preview se vuelve a montar al cambiar la config de la caja (no con cada valor) */
          preview={<Stage key={JSON.stringify(g)} eyebrow="Vista previa" aside={<span>{visibleBars ? 'Con los datos reales del directo' : 'Sin barras visibles en el overlay'}</span>} src={`/widget/goal?id=${enc(g.id)}&debug`} w={1000} h={previewHeight} />}>
        <Panel>
          <div className="row2">
            <label>Título <LazyInput value={g.title} onCommit={guard((x: string) => saveGoal(g.id, { title: x }))} /></label>
            <Switch checked={g.visible !== false} onChange={guard((x: boolean) => saveGoal(g.id, { visible: x }))}>Visible</Switch>
            <Switch checked={g.showMetric !== false} onChange={guard((x: boolean) => saveGoal(g.id, { showMetric: x }))}>Mostrar qué cuenta</Switch>
            <label>Etiqueta <LazyInput aria-label="Etiqueta" placeholder="Objetivo" value={g.label || ''} onCommit={guard((x: string) => saveGoal(g.id, { label: x }))} /></label>
            <Switch checked={g.showLabel !== false} onChange={guard((x: boolean) => saveGoal(g.id, { showLabel: x }))}>Mostrar etiqueta</Switch>
            <Switch checked={g.showTitle !== false} onChange={guard((x: boolean) => saveGoal(g.id, { showTitle: x }))}>Mostrar título</Switch>
          </div>
          {(g.bars || []).map(b => {
            const v = vs?.bars?.find(x => x.id === b.id)?.value ?? 0;
            const validas = GOAL_METRICS[b.platform] || GOAL_METRICS.twitch;
            return <fieldset key={b.id} className="goal-bar-editor">
              <legend><PfIcon platform={b.platform === 'youtube' ? 'youtube' : 'twitch'} /> Barra · {b.platform === 'youtube' ? 'YouTube' : 'Twitch'}</legend>
              <div className="goal-fields">
                <label>Plataforma <select value={b.platform} onChange={guard(e => savePlatform(g.id, b, e.target.value as GoalBar['platform']))}>{GOAL_PLATFORMS.map(p => <option key={p} value={p}>{p === 'youtube' ? 'YouTube' : 'Twitch'}</option>)}</select></label>
                <label>Qué cuenta <select value={b.metric} onChange={guard(e => saveBar(g.id, b.id, { metric: e.target.value }))}>{validas.map(k => <option key={k} value={k}>{(metrics[k] as { label?: string } | undefined)?.label || k}</option>)}</select></label>
                <label>Meta <LazyInput type="number" min={1} value={b.target} onCommit={guard((x: string) => saveBar(g.id, b.id, { target: Number(x) }))} /></label>
                <Switch checked={b.visible !== false} onChange={guard((x: boolean) => saveBar(g.id, b.id, { visible: x }))}>Visible</Switch>
              </div>
                <div className="goal-adjust"><span>Ahora: <b className="gval">{v}</b> / {b.target}</span>
                  <div className="row">
                    {[-1, 1].map(n => <button key={n} className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { const d = await post<{ value: number }>(`/api/goals/${enc(g.id)}/bars/${enc(b.id)}/add`, { amount: n }); setValue(g.id, b.id, d.value); })}>{n > 0 ? '+1' : '−1'}</button>)}
                    <input type="number" aria-label={`Fijar valor de ${b.platform} · ${b.metric}`} placeholder="Valor" className="goal-set-value" value={setVal[b.id] ?? ''} onChange={e => setSetVal({ ...setVal, [b.id]: e.target.value })} />
                    <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { const d = await post<{ value: number }>(`/api/goals/${enc(g.id)}/bars/${enc(b.id)}/set`, { value: Number(setVal[b.id] || 0) }); setValue(g.id, b.id, d.value); })}>Fijar</button>
                  </div></div>
              <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(null, 'esta barra')) return; const d = await del<{ bars: GoalBar[] }>(`/api/goals/${enc(g.id)}/bars/${enc(b.id)}`); reloadGoals(goals.map(x => (x.id === g.id ? { ...x, bars: d.bars } : x))); })}>Borrar barra</button>
            </fieldset>;
          })}
          <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { const d = await post<{ bar: GoalBar }>(`/api/goals/${enc(g.id)}/bars`, { platform: 'twitch', metric: 'follows', target: 10 }); reloadGoals(goals.map(x => (x.id === g.id ? { ...x, bars: [...x.bars, d.bar] } : x))); })}>+ Añadir barra</button>
          <details className="goal-css"><summary>CSS personalizado</summary><label>CSS <LazyInput as="textarea" className="code" spellCheck={false} style={{ minHeight: 70 }} placeholder=".title { color: #FF8FA6; }" value={g.css || ''} onCommit={x => saveGoal(g.id, { css: x })} /></label>
            <p className="css-help">Clases: <code>.goal</code> <code>.goal.done</code> <code>.kick</code> <code>.title</code> <code>.bar</code> <code>.bar.pf-twitch</code> <code>.bar.pf-youtube</code> <code>.fill</code> <code>.pf-ico</code> <code>.metric</code> <code>.pct</code></p></details>
        </Panel>
        </WidgetLayout></article></Slide>;
    })()}
  </>;
}

