// Widgets de pantalla: chat, últimos + ticker, créditos y objetivos.
import { enc, post, put, del } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { patchWidgets } from '../../lib/patch';
import { codeTab, confirmDelete, CopyUrl, EmptyState, guard, ItemTabs, LazyInput, Panel, PfIcon, ScaledFrame } from '../../lib/ui';
import { useState, type ReactNode } from 'react';
import type { GoalBar, GoalConfig, GoalValue, WidgetSection } from '../../lib/types';

export const origin = () => location.origin;
const INFO: Record<string, { title: string; path: string; size: string; w: number; h: number; desc: string }> = {
  chat: { title: 'Chat en pantalla', path: '/widget/chat', size: '600×900', w: 600, h: 900, desc: 'El chat de Twitch y YouTube juntos, con tu estilo. Ideal para la escena de solo cámara.' },
  latest: { title: 'Últimos y ticker', path: '/widget/latest', size: '1400×200', w: 1400, h: 260, desc: 'Último seguidor, sub, bits… y una banda que recorre los últimos apoyos.' },
  credits: { title: 'Créditos', path: '/widget/credits', size: '1920×1080', w: 1920, h: 1080, desc: 'Créditos finales con todos los que han apoyado en el directo.' },
};
const q = (p: string, mode: string) => `${p}${p.includes('?') ? '&' : '?'}${mode}`;

function WField({ w, f, label, type = 'text', ...rest }: { w: string; f: string; label: ReactNode; type?: string; [k: string]: unknown }) {
  const val = useLive(s => ((s.config.widgets as WidgetSection | undefined)?.[w] as WidgetSection | undefined)?.[f] as string | number | boolean | undefined);
  if (type === 'checkbox') return <label className="check"><input type="checkbox" checked={!!val} onChange={e => patchWidgets({ [w]: { [f]: e.target.checked } })} /> {label}</label>;
  if (type === 'number') return <label>{label}<input type="number" value={val === undefined ? '' : String(val)} {...rest} onChange={e => patchWidgets({ [w]: { [f]: Number(e.target.value) } })} /></label>;
  if (type === 'css') return <label>{label}<textarea className="code" spellCheck={false} value={val === undefined ? '' : String(val)} onKeyDown={codeTab} {...rest} onChange={e => patchWidgets({ [w]: { [f]: e.target.value } })} /></label>;
  return <label>{label}<input value={val === undefined ? '' : String(val)} {...rest} onChange={e => patchWidgets({ [w]: { [f]: e.target.value } })} /></label>;
}
function ListChecks({ w, f, items }: { w: string; f: string; items: [string, string][] }) {
  const cur = useLive(s => ((((s.config.widgets as WidgetSection | undefined)?.[w] as WidgetSection | undefined)?.[f]) as string[] | undefined) || []);
  return <>{items.map(([k, l]) => <label className="check" key={k}><input type="checkbox" checked={cur.includes(k)} onChange={e => patchWidgets({ [w]: { [f]: e.target.checked ? [...cur, k] : cur.filter(x => x !== k) } })} /> {l}</label>)}</>;
}

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
      <div className="lbl">Plataformas<div className="row" style={{ marginTop: 8 }}><ListChecks w="chat" f="platforms" items={[['twitch', 'Twitch'], ['youtube', 'YouTube']]} /></div></div>
      <WField w="chat" f="hideCommands" label="Ocultar los comandos (!…)" type="checkbox" />
      <WField w="chat" f="hideOwner" label="Ocultar mis mensajes (lo que escribo desde antena, el móvil o el prompter)" type="checkbox" />
      <WField w="chat" f="showPlatform" label="Mostrar el icono de la plataforma" type="checkbox" />
      <WField w="chat" f="reverse" label="Chat invertido (los mensajes nuevos aparecen arriba)" type="checkbox" />
      <ChatSelect f="animIn" label="Animación de entrada" options={[['slide', 'Deslizante'], ['fade', 'Desvanecida'], ['pop', 'Pop'], ['bounce', 'Rebote'], ['zoom', 'Zoom'], ['flip', 'Giro'], ['blur', 'Desenfoque'], ['none', 'Sin animación']]} />
      <ChatSelect f="animOut" label="Animación al desaparecer" options={[['slide', 'Deslizante'], ['fade', 'Desvanecida'], ['zoom', 'Zoom'], ['blur', 'Desenfoque'], ['drop', 'Caída'], ['none', 'Ninguna']]} />
    </div>
    <WField w="chat" f="css" label="CSS personalizado" type="css" placeholder=".msg { border-left-color: #fff; }" />
    <p className="css-help">Clases: <code>.msg</code> <code>.msg.mod</code> <code>.who</code> <code>.text</code> <code>.pf</code></p></>;
  if (name === 'latest') form = <>
    <h3 className="sub-h">Últimos</h3>
    <div className="row" style={{ marginBottom: 12 }}><ListChecks w="latest" f="items" items={[['follow', 'Seguidor'], ['sub', 'Suscripción'], ['cheer', 'Bits'], ['raid', 'Raid'], ['superchat', 'Super Chat'], ['member', 'Miembro'], ['any', 'Cualquier evento']]} /></div>
    <WField w="latest" f="css" label="CSS de «últimos»" type="css" placeholder=".item .big { font-size: 34px; }" />
    <p className="css-help">Clases: <code>.root</code> <code>.root.col</code> <code>.item</code> <code>.item-{'<tipo>'}</code> <code>.item.empty</code> <code>.item.flash</code> <code>.kick</code> <code>.big</code> <code>.extra</code></p>
    <h3 className="sub-h">Ticker</h3>
    <CopyUrl url={origin() + '/widget/ticker'}><span className="hint">1920×64</span></CopyUrl>
    <div className="row3">
      <WField w="ticker" f="label" label="Etiqueta" />
      <WField w="ticker" f="count" label="Eventos" type="number" min={1} max={30} />
      <WField w="ticker" f="speed" label="Velocidad (px/s)" type="number" min={10} max={300} />
    </div>
    <WField w="ticker" f="css" label="CSS del ticker" type="css" placeholder=".band { border-top-color: #fff; }" />
    <p className="css-help">Clases: <code>.root</code> <code>.band</code> <code>.label</code> <code>.track</code> <code>.run</code> <code>.it</code> <code>.it b</code> <code>.k</code></p>
    <ScaledFrame src="/widget/ticker?demo" w={1920} h={120} /></>;
  if (name === 'credits') form = <>
    <div className="row2"><WField w="credits" f="title" label="Título" /><WField w="credits" f="speed" label="Velocidad (px/s)" type="number" min={10} max={300} /></div>
    <WField w="credits" f="subtitle" label="Línea final" />
    <WField w="credits" f="css" label="CSS personalizado" type="css" placeholder=".grp li { color: #FF8FA6; }" />
    <p className="css-help">Clases: <code>.roll</code> <code>.head</code> <code>.grp</code> <code>.grp li</code> <code>.end</code> <code>.kick</code> <code>.big</code> <code>.sub</code> <code>.hl</code></p>
    <div className="row"><button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(() => post('/api/credits/play'))}>Lanzar créditos</button><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => post('/api/credits/stop'))}>Parar</button></div>
    <p className="hint mt">Parámetros: <code>?transparent</code> (sin fondo) · <code>?autoplay</code> · <code>?loop</code>. Se lanzan desde aquí, desde el MCP, con una acción o con un atajo del Stream Deck.</p></>;
  return <>
    <header className="view-head"><div><span className="crumb">Widgets › {info.title}</span><h1>{info.title}</h1><p className="hint">{info.desc}</p></div></header>
    <div className="editor">
      <div className="form-col">
        <Panel title="Fuente de navegador en Meld" aside={<span className="hint">{info.size}</span>}><CopyUrl url={origin() + info.path} /></Panel>
        <Panel>{form}</Panel>
      </div>
      <div className="preview-col"><ScaledFrame src={q(info.path, 'demo')} w={info.w} h={info.h} /><p className="hint">Vista previa con datos de ejemplo.</p></div>
    </div>
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
  const saveGoal = (id: string, patch: Partial<GoalConfig>) => {
    reloadGoals(goals.map(g => (g.id === id ? { ...g, ...patch } : g)));
    return put('/api/goals/' + enc(id), patch);
  };
  const saveBar = (boxId: string, barId: string, patch: Partial<GoalBar>) => {
    reloadGoals(goals.map(g => (g.id === boxId ? { ...g, bars: g.bars.map(b => (b.id === barId ? { ...b, ...patch } : b)) } : g)));
    return put(`/api/goals/${enc(boxId)}/bars/${enc(barId)}`, patch);
  };
  const setValue = (boxId: string, barId: string, value: number) => live.update(s => ({
    widgets: { ...s.widgets, goals: (s.widgets?.goals || []).map(g => (g.id === boxId ? { ...g, bars: g.bars.map(b => (b.id === barId ? { ...b, value } : b)) } : g)) },
  }));
  return <>
    <header className="view-head"><div><span className="crumb">Widgets › Objetivos</span><h1>Objetivos</h1><p className="hint">Una caja, varias metas. Añade barras de Twitch y YouTube con su propio progreso. Cada caja es una fuente de navegador para Meld.</p></div></header>
    <ItemTabs label="Objetivos" items={goals.map(x => ({ id: x.id, label: x.title, badge: x.visible === false ? 'oculto' : undefined }))} selected={g?.id} onSelect={setSel} newLabel="+ Nuevo objetivo"
      onNew={guard(async () => { const d = await post<{ goal: GoalConfig }>('/api/goals', { title: 'Nuevo objetivo', metric: 'follows', target: 10 }); reloadGoals([...goals, d.goal]); setSel(d.goal.id); })} />
    {g ? (() => {
      const vs = values.find(x => x.id === g.id);
      const visibleBars = g.visible === false ? 0 : g.bars.filter(b => b.visible !== false).length;
      const previewHeight = 210 + 60 * visibleBars;
      return <article className="panel goal-card" key={g.id}>
        <header className="goal-card-head"><h2>{g.title}</h2><span className="hint">{visibleBars} barras visibles · {g.visible === false ? 'Caja oculta' : 'En pantalla'}</span></header>
        <div className="editor">
        <div className="form-col">
          <div className="row2">
            <label>Título <LazyInput value={g.title} onCommit={x => saveGoal(g.id, { title: x })} /></label>
            <label className="check">Visible <input type="checkbox" checked={g.visible !== false} onChange={guard(e => saveGoal(g.id, { visible: e.target.checked }))} /></label>
            <label className="check">Mostrar qué cuenta <input type="checkbox" checked={g.showMetric !== false} onChange={guard(e => saveGoal(g.id, { showMetric: e.target.checked }))} /></label>
            <label>Etiqueta <LazyInput aria-label="Etiqueta" placeholder="Objetivo" value={g.label || ''} onCommit={x => saveGoal(g.id, { label: x })} /></label>
            <label className="check">Mostrar etiqueta <input type="checkbox" checked={g.showLabel !== false} onChange={guard(e => saveGoal(g.id, { showLabel: e.target.checked }))} /></label>
            <label className="check">Mostrar título <input type="checkbox" checked={g.showTitle !== false} onChange={guard(e => saveGoal(g.id, { showTitle: e.target.checked }))} /></label>
          </div>
          {(g.bars || []).map(b => {
            const v = vs?.bars?.find(x => x.id === b.id)?.value ?? 0;
            const validas = GOAL_METRICS[b.platform] || GOAL_METRICS.twitch;
            return <fieldset key={b.id} className="goal-bar-editor">
              <legend><PfIcon platform={b.platform === 'youtube' ? 'youtube' : 'twitch'} /> Barra · {b.platform === 'youtube' ? 'YouTube' : 'Twitch'}</legend>
              <div className="goal-fields">
                <label>Plataforma <select value={b.platform} onChange={guard(e => saveBar(g.id, b.id, { platform: e.target.value as GoalBar['platform'] }))}>{GOAL_PLATFORMS.map(p => <option key={p} value={p}>{p === 'youtube' ? 'YouTube' : 'Twitch'}</option>)}</select></label>
                <label>Qué cuenta <select value={b.metric} onChange={guard(e => saveBar(g.id, b.id, { metric: e.target.value }))}>{validas.map(k => <option key={k} value={k}>{(metrics[k] as { label?: string } | undefined)?.label || k}</option>)}</select></label>
                <label>Meta <LazyInput type="number" min={1} value={b.target} onCommit={x => saveBar(g.id, b.id, { target: Number(x) })} /></label>
                <label className="check">Visible <input type="checkbox" checked={b.visible !== false} onChange={guard(e => saveBar(g.id, b.id, { visible: e.target.checked }))} /></label>
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
          <CopyUrl url={`${origin()}/widget/goal?id=${enc(g.id)}`}><span className="hint">1000×{previewHeight}</span></CopyUrl>
          <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(g.title, 'este objetivo')) return; const d = await del<{ goals: GoalConfig[] }>('/api/goals/' + enc(g.id)); reloadGoals(d.goals); })}>Borrar objetivo</button>
        </div>
        {/* O1.5: la preview se vuelve a montar al cambiar la config de la caja (no con cada valor) */}
        <div className="preview-col"><ScaledFrame key={JSON.stringify(g)} src={`/widget/goal?id=${enc(g.id)}&debug`} w={1000} h={previewHeight} /><p className="hint">{visibleBars ? 'Con los datos reales del directo.' : 'Sin barras visibles en el overlay.'}</p></div>
      </div></article>;
    })() : <EmptyState>Sin objetivos.</EmptyState>}
  </>;
}

// verificación de caché de diagnóstico: sin cambios funcionales
