// Widgets de pantalla: chat, últimos + ticker, créditos y objetivos.
import { enc, post, put, del } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { patchWidgets } from '../../lib/patch';
import { BrowserSource, codeTab, confirmDelete, EmptyState, guard, ItemTabs, LazyInput, Panel, PfIcon, Stage, Switch, ViewHead, WidgetLayout } from '../../lib/ui';
import { useState, type ReactNode } from 'react';
import type { GoalBar, GoalConfig, GoalValue, WidgetSection } from '../../lib/types';
import { CHAT_ANIMS, type ChatAnim } from '../../../../public/widgets/chat-anims.js';

export const origin = () => location.origin;
const INFO: Record<string, { title: string; path: string; size: string; w: number; h: number; desc: string }> = {
  chat: { title: 'Chat en pantalla', path: '/widget/chat', size: '600×900', w: 600, h: 900, desc: 'El chat de Twitch y YouTube juntos, con tu estilo. Ideal para la escena de solo cámara.' },
  latest: { title: 'Últimos y ticker', path: '/widget/latest', size: '1400×200', w: 1400, h: 260, desc: 'Último seguidor, sub, bits… y una banda que recorre los últimos apoyos.' },
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
  if (name === 'goals') return <Goals />;
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
  if (name === 'credits') form = <>
    <div className="row2"><WField w="credits" f="title" label="Título" /><WField w="credits" f="speed" label="Velocidad (px/s)" type="number" min={10} max={300} /></div>
    <WField w="credits" f="subtitle" label="Línea final" />
    <WField w="credits" f="css" label="CSS personalizado" type="css" placeholder=".grp li { color: #FF8FA6; }" />
    <p className="css-help">Clases: <code>.roll</code> <code>.head</code> <code>.grp</code> <code>.grp li</code> <code>.end</code> <code>.kick</code> <code>.big</code> <code>.sub</code> <code>.hl</code></p>
    <div className="row"><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/credits/play'))}>Lanzar créditos</button><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/credits/stop'))}>Parar</button></div>
    <p className="hint mt">Parámetros: <code>?transparent</code> (sin fondo) · <code>?autoplay</code> · <code>?loop</code>. Se lanzan desde aquí, desde el MCP, con una acción o con un atajo del Stream Deck.</p></>;
  return <>
    <ViewHead crumb={<>Widgets › {info.title}</>} title={info.title} hint={info.desc} />
    <WidgetLayout
      source={<BrowserSource url={origin() + info.path} size={info.size} label={name === 'latest' ? 'Últimos' : undefined} also={name === 'latest' ? [{ url: origin() + '/widget/ticker', size: '1920×64', label: 'Ticker' }] : []} />}
      preview={<>
        <Stage eyebrow={name === 'latest' ? 'Vista previa · Últimos' : 'Vista previa'} aside={<span>Datos de ejemplo</span>} src={q(info.path, 'demo')} w={info.w} h={info.h} />
        {name === 'latest' && <Stage eyebrow="Vista previa · Ticker" aside={<span>Datos de ejemplo</span>} src="/widget/ticker?demo" w={1920} h={120} />}
      </>}>
      <Panel>{form}</Panel>
    </WidgetLayout>
  </>;
}

// Métricas válidas por plataforma (contrato de src/goals.mjs; los enums del schema son la fuente).
const GOAL_PLATFORMS = ['twitch', 'youtube'] as const;
const GOAL_METRICS: Record<string, string[]> = {
  twitch: ['follows', 'subs', 'bits', 'raids', 'events'],
  youtube: ['superchats', 'members', 'events'],
};

function Goals() {
  const goals: GoalConfig[] = useLive(s => s.config.widgets?.goals || []);
  const values: GoalValue[] = useLive(s => s.widgets?.goals || []);
  const metrics = useLive(s => s.metrics || {});
  const [setVal, setSetVal] = useState<Record<string, string>>({});
  // O1.7: una pestaña por objetivo; sin selección (o si se borró) se edita el primero.
  const [sel, setSel] = useState<string | null>(null);
  const g = goals.find(x => x.id === sel) || goals[0];
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
  return <>
    <ViewHead tour="goals-head" crumb="Widgets › Objetivos" title="Objetivos" hint="Una caja, varias metas. Añade barras de Twitch y YouTube con su propio progreso. Cada caja es una fuente de navegador para Meld." />
    <ItemTabs label="Objetivos" tour="goals-tabs" items={goals.map(x => ({ id: x.id, label: x.title, badge: x.visible === false ? 'oculto' : undefined }))} selected={g?.id} onSelect={setSel} newLabel="+ Nuevo objetivo"
      onNew={guard(async () => { const d = await post<{ goal: GoalConfig }>('/api/goals', { title: 'Nuevo objetivo', metric: 'follows', target: 10 }); reloadGoals([...goals, d.goal]); setSel(d.goal.id); })} />
    {g ? (() => {
      const vs = values.find(x => x.id === g.id);
      const visibleBars = g.visible === false ? 0 : g.bars.filter(b => b.visible !== false).length;
      const previewHeight = 210 + 60 * visibleBars;
      return <article className="goal-card" key={g.id} data-tour="goals-editor">
        <header className="goal-card-head"><h2>{g.title}</h2><span className="hint">{visibleBars} barras visibles · {g.visible === false ? 'Caja oculta' : 'En pantalla'}</span></header>
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
          <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(g.title, 'este objetivo')) return; const d = await del<{ goals: GoalConfig[] }>('/api/goals/' + enc(g.id)); reloadGoals(d.goals); })}>Borrar objetivo</button>
        </Panel>
        </WidgetLayout></article>;
    })() : <EmptyState>Sin objetivos.</EmptyState>}
  </>;
}

// verificación de caché de diagnóstico: sin cambios funcionales
