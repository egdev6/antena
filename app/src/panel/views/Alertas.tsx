// Alertas (v3): los tipos fijos en tarjetas por plataforma → slide con pestañas (Editor). Las variaciones abren un 2.º nivel.
import { useCallback, useEffect, useRef, useState } from 'react';
import { enc, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { EmptyState, guard, Icon, PfIcon, ScaledFrame } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { Card, CardGroup, CardSwitch, Dot, Kpis, PageHead, Tags, useListFilter } from '../../lib/layout';
import type { AppState } from '../../lib/types';
import { Editor } from './Editor';

/** Avisos de una alerta: archivo que ya no está en media/ (vídeo, imagen o sonido). */
export function alertIssues(s: AppState, type: string): string[] {
  const a = { ...(s.lookDefaults || {}), ...(s.config.alerts?.[type] || {}) } as Record<string, any>;
  const files = new Set((s.media || []).map(m => m.name));
  const out: string[] = [];
  if (['media', 'mixed'].includes(a.layout) && a.media && !files.has(a.media)) out.push(`falta ${a.media}`);
  if (a.sound && !['default', 'none'].includes(a.sound) && !files.has(a.sound)) out.push(`falta ${a.sound}`);
  for (const v of a.variations || []) {
    const o = v.overrides || {};
    if (o.media && !files.has(o.media)) out.push(`«${v.name}»: falta ${o.media}`);
    if (o.sound && !['default', 'none'].includes(o.sound) && !files.has(o.sound)) out.push(`«${v.name}»: falta ${o.sound}`);
  }
  return out;
}
export const alertWarnings = (s: AppState) => (s?.types ? Object.keys(s.types).filter(t => alertIssues(s, t).length) : []);

const isVid = (f?: string) => /\.(webm|mp4|mov|m4v)$/i.test(f || '');
const GROUPS: [string, string, string][] = [
  ['twitch', 'Twitch', 'Seguidores, subs, bits, raids, recompensas y récord'],
  ['youtube', 'YouTube', 'Suscriptores, Super Chats, stickers, miembros y récord'],
];

/** Huella corta de lo que cambia la miniatura: si cambia, el marco se recarga con lo guardado. */
function stamp(v: unknown) {
  const t = JSON.stringify(v) || '';
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Miniatura real de una alerta: el overlay de verdad en pequeño (/overlay?still=<tipo>), con la
 *  configuración y el tema guardados (Apariencia, CSS, diseño, textos). El vídeo se queda en su primer
 *  fotograma y, al pasar el ratón, se reproduce en bucle y sin sonido. */
function AlertThumb({ type, label, issue, version, video, mixed, playing, origin }: { type: string; label: string; issue?: string; version: string; video: boolean; mixed: boolean; playing: boolean; origin: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [dur, setDur] = useState(0);
  const [pos, setPos] = useState(0);
  const setFrame = useCallback((el: HTMLIFrameElement | null) => { frame.current = el; }, []);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.still !== type) return;
      if (typeof e.data.dur === 'number') setDur(e.data.dur);
      if (typeof e.data.pos === 'number') setPos(e.data.pos);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, [type]);
  const syncPlayback = useCallback(() => {
    if (video) frame.current?.contentWindow?.postMessage({ still: playing ? 'play' : 'pause' }, location.origin);
  }, [playing, video]);
  useEffect(syncPlayback, [syncPlayback]);
  const onLoad = useCallback(() => {
    setDur(0); setPos(0);
    syncPlayback(); // navigation loses the previous document's hover/pause intent
  }, [syncPlayback]);
  if (issue) return <span className="missing"><Icon d={IC.alert} /><span>{issue[0].toUpperCase() + issue.slice(1)}</span></span>;
  return <>
    {/* acercada hacia donde sale la alerta (posición y alineación de Apariencia) para que se lea */}
    <span className="lv-still-z" style={{ transformOrigin: origin }}><ScaledFrame src={`/overlay?still=${enc(type)}&v=${version}`} className="lv-still" title={`Vista previa de ${label}`} frameRef={setFrame} onLoad={onLoad} lazy /></span>
    {video ? <span className="badge">{playing ? 'vista previa · sin sonido' : `${mixed ? 'fondo + tarjeta' : 'vídeo'}${dur ? ' · ' + mmss(dur) : ''}`}</span> : null}
    {video && playing ? <span className="prog"><i style={{ width: pos * 100 + '%' }} /></span> : null}
  </>;
}
const DESIGN: Record<string, string> = { card: 'tarjeta', media: 'vídeo con texto', mixed: 'vídeo + tarjeta' };

export function Alertas({ parts }: { parts: string[] }) {
  const s = useLive(x => x);
  const f = useListFilter();
  const [hover, setHover] = useState<string | null>(null);
  const [, open, sub, vid] = parts;
  const types = Object.entries(s.types || {});
  const cfg = (t: string) => ({ ...(s.lookDefaults || {}), ...(s.config.alerts?.[t] || {}) }) as Record<string, any>;
  const th = (s.theme || {}) as { position?: string; align?: string };
  const origin = `${th.align === 'left' ? '0%' : th.align === 'right' ? '100%' : '50%'} ${th.position === 'top' ? '0%' : th.position === 'bottom' ? '100%' : '50%'}`;
  const all = types.map(([type, meta]) => {
    const a = cfg(type), issues = alertIssues(s, type), vars = a.variations || [];
    return { type, meta, a, issues, vars };
  });
  // el interruptor de la tarjeta se aplica al momento (como activar una variación)
  const toggle = (type: string, on: boolean) => guard(async () => {
    live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts?.[type], enabled: on } } } }));
    try { await put('/api/alerts/' + enc(type), { enabled: on }); }
    catch (e) { live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts?.[type], enabled: !on } } } })); throw e; }
  }, on ? 'Alerta activada' : 'Alerta apagada')();
  const shown = all
    .filter(x => f.chip === 'all' || (f.chip === 'warn' ? x.issues.length > 0 : x.meta.platform === f.chip))
    .filter(x => f.match(x.meta.label, x.type));
  const n = (fn: (x: typeof all[number]) => boolean) => all.filter(fn).length;
  const nVars = all.reduce((t, x) => t + x.vars.length, 0), nVarsOn = all.reduce((t, x) => t + x.vars.filter((v: any) => v.enabled !== false).length, 0);
  const nWarn = n(x => x.issues.length > 0);
  const nTw = n(x => x.meta.platform === 'twitch'), nYt = n(x => x.meta.platform === 'youtube');
  const card = (x: typeof all[number]) => {
    const href = `#/alertas/${x.type}`;
    const on = x.a.enabled !== false;
    const layout = ['media', 'mixed'].includes(x.a.layout) && x.a.media ? x.a.layout : 'card';
    const tags = [
      ...(x.a.ttsEnabled ? [{ t: 'Voz', on: true }] : []),
      ...((x.a.actions || []).length ? [{ t: 'Acciones', on: true }] : []),
      ...(x.vars.length ? [{ t: x.vars.length === 1 ? '1 variación' : `${x.vars.length} variaciones`, on: true }] : []),
      ...(x.meta.system ? [{ t: 'Récord' }] : []),
    ];
    // Server-confirmed alert/CSS/theme, never the optimistic editor draft. Track
    // only this saved media dependency so unrelated uploads do not reload 14 frames.
    const preview = s.alertPreviews?.[x.type];
    const mediaVersion = stamp(preview?.media && (s.media || []).find(m => m.name === preview.media));
    const version = `${preview?.version || 'initial'}-${mediaVersion}`;
    return <Card key={x.type} href={href} label={`Abrir ${x.meta.label}`} open={open === x.type} off={!on} warn={x.issues.length > 0}
      onEnter={() => setHover(x.type)} onLeave={() => setHover(h => (h === x.type ? null : h))}
      thumb={<AlertThumb type={x.type} label={x.meta.label} issue={x.issues[0]} version={version} video={layout !== 'card' && isVid(x.a.media)} mixed={layout === 'mixed'} playing={hover === x.type} origin={origin} />}
      title={x.meta.label} aside={<span className="lv-mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><PfIcon platform={x.meta.platform} />{x.meta.platform === 'youtube' ? 'YouTube' : 'Twitch'}</span>}
      foot={<><span className="lv-cmeta">{DESIGN[layout]}</span><span className="sp" /><CardSwitch checked={on} onChange={v => toggle(x.type, v)} label={`Activar ${x.meta.label}`} /></>}>
      {x.issues.length ? <Dot tone="warn">{x.issues.length === 1 ? 'Falta un archivo' : `Faltan ${x.issues.length} archivos`}</Dot> : <Dot tone={on ? 'ok' : 'off'}>{on ? 'Activa' : 'Apagada'}</Dot>}
      {tags.length ? <Tags items={tags} /> : null}
    </Card>;
  };
  return <>
    <PageHead crumb={`Configurar · ${all.length} alertas de Twitch y YouTube`} title="Alertas"
      desc="Pulsa una para editarla por pestañas. Los tipos son fijos: lo nuevo se crea como variación dentro de cada alerta."
      actions={<a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/apariencia">Tema en Apariencia</a>} />
    <Kpis items={[
      { value: n(x => x.a.enabled !== false), label: `activas de ${all.length}` },
      { value: n(x => ['media', 'mixed'].includes(x.a.layout) && !!x.a.media), label: 'con vídeo o imagen propios' },
      { value: nVars, label: `variaciones · ${nVarsOn} activas` },
      { value: nWarn, label: nWarn === 1 ? 'con un archivo que ya no está en media/' : 'con archivos que ya no están en media/', warn: nWarn > 0 },
    ]} />
    <div className="lv-tools lv-tools--bare">
      <label className="lv-search"><span className="sr-only">Buscar alerta</span><input type="search" value={f.q} placeholder="Buscar alerta" onChange={e => f.setQ(e.target.value)} /></label>
      <div className="lv-chips" role="group" aria-label="Filtrar">{([['all', `Todas · ${all.length}`], ['twitch', `Twitch · ${nTw}`], ['youtube', `YouTube · ${nYt}`], ['warn', `Con avisos · ${nWarn}`]] as [string, string][]).map(([k, l]) =>
        <button key={k} type="button" className="eg-chip" aria-pressed={f.chip === k} onClick={() => f.setChip(k)}>{l}</button>)}</div>
    </div>
    <div className="lv-groups">
      {GROUPS.map(([pf, title, note]) => {
        const list = shown.filter(x => x.meta.platform === pf);
        return list.length ? <CardGroup key={pf} title={title} count={list.length} note={note}>{list.map(card)}</CardGroup> : null;
      })}
      {!shown.length && <div className="lv-empty"><EmptyState>Ninguna alerta coincide.</EmptyState></div>}
    </div>
    {open && s.types?.[open] && (sub === 'v' && vid
      ? <Editor key={`v-${open}-${vid}`} target={{ kind: 'variation', type: open, id: vid }} />
      : <Editor key={`a-${open}`} target={{ kind: 'alert', type: open }} />)}
  </>;
}
