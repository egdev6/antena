// Editor de alerta, variación, comando de chat o mensaje programado (mismo formulario, distintas partes).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { del, enc, post, put, get } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import type { AlertConfig, AlertVariation, CommandConfig, Config, SendResult, TimerConfig } from '../../lib/types';
import { codeTab, cx, EmptyState, guard, Icon, IconBtn, PLATFORM_NAMES, ScaledFrame, Seg, Switch, toast, fmtTime } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { go } from '../router';
import { useUploader, UploadBar } from './General';
import { RecordPane, VIEWER_TYPES } from './Espectadores';

export type Target = { kind: 'alert'; type: string } | { kind: 'variation'; type: string; id: string } | { kind: 'command'; id: string } | { kind: 'timer'; id: string };

const ANIM_IN: [string, string][] = [['pop', 'Rebote'], ['fade', 'Fundido'], ['slide', 'Desde abajo'], ['zoom', 'Zoom'], ['none', 'Ninguna']];
const ANIM_OUT: [string, string][] = [['fade', 'Fundido'], ['slide', 'Hacia arriba'], ['zoom', 'Encoger'], ['none', 'Ninguna']];
const AMOUNT_TYPES = ['cheer', 'raid', 'giftsub', 'superchat', 'supersticker', 'giftmember'];
const TIER_TYPES = ['sub', 'resub', 'giftsub'];
export const ACTIONS: Record<string, string> = {
  scene: 'Cambiar a escena', layer: 'Mostrar capa unos segundos', hideLayer: 'Ocultar capa', toggleLayer: 'Alternar capa',
  effect: 'Alternar efecto', command: 'Comando de Meld', streamEvent: 'Evento de widget de Meld', chat: 'Escribir en el chat', say: 'Decir en voz alta',
};
export const PERMS: [string, string][] = [['everyone', 'Todo el mundo'], ['members', 'Subs y miembros'], ['vips', 'VIPs y mods'], ['mods', 'Moderadores'], ['broadcaster', 'Solo yo']];
export const DESTINATIONS: [string, string][] = [['twitch', 'Twitch'], ['youtube', 'YouTube'], ['both', 'Ambos']];
const TIMER_VARS = ['channel', 'title', 'uptime', 'follows'];
const CSS_VARS = ['--accent', '--title-color', '--name-color', '--sub-color', '--hl-color', '--card-width', '--card-radius', '--card-padding', '--card-bg', '--border-width', '--border-color', '--tile-size', '--icon-size', '--icon-color', '--title-size', '--name-size', '--sub-size', '--font-title', '--font-name', '--font-sub', '--tilt', '--reflection'];
const CSS_SNIPPETS: [string, string][] = [
  ['Otro color', '.alert { --accent: #00E0FF; }'],
  ['Sin inclinación', '.alert { --tilt: none; }'],
  ['Más pequeña', '.alert { --card-width: 700px; --name-size: 64px; --sub-size: 24px; --tile-size: 110px; --icon-size: 54px; }'],
  ['Sin decoración', '.alert-glow, .alert-dots, .alert-cube { display: none; }'],
  ['Sin reflejo', '.alert { --reflection: linear-gradient(transparent, transparent); }'],
  ['Sin plataforma', '.alert-platform { display: none; }'],
  ['Sin icono', '.alert-icon { display: none; }'],
  ['Fondo de cristal', '.alert { --card-bg: rgba(10, 10, 14, .55); }\n.card { backdrop-filter: blur(14px); }'],
  ['Texto con contorno', '.alert-name { -webkit-text-stroke: 2px #000; paint-order: stroke fill; }'],
  ['Latido al entrar', '@keyframes latido { 50% { scale: 1.06; } }\n.alert.on .alert-name { animation: latido .6s 1s 2; }'],
];

export const platformsText = (platforms: any = {}) => Object.entries<any>(platforms || {})
  .map(([p, r]) => `${PLATFORM_NAMES[p] || p}: ${r.ok ? (r.kind === 'announcement' ? 'anuncio enviado' : 'enviado') : `no enviado (${r.error})`}`).join(' · ');

function condSummary(c: any = {}) {
  const p: string[] = [];
  if (c.minAmount !== '' && c.minAmount != null) p.push(`≥ ${c.minAmount}`);
  if (c.maxAmount !== '' && c.maxAmount != null) p.push(`≤ ${c.maxAmount}`);
  if (c.tier) p.push(`tier ${c.tier}`);
  if (c.users) p.push(`usuarios: ${c.users}`);
  if (c.messageContains) p.push(`mensaje con: ${c.messageContains}`);
  if (Number(c.chance) < 100) p.push(`${c.chance} % de las veces`);
  return p.join(' · ') || 'siempre';
}
const fmtNext = (sec: number) => { if (sec <= 0) return 'ya'; const m = Math.floor(sec / 60), s2 = sec % 60; return m ? `${m} min${s2 ? ` ${s2} s` : ''}` : `${s2} s`; };
export function TimerState({ id }: { id: string }) {
  const t = useLive(s => (s.timers || []).find(x => x.id === id));
  if (!t) return null;
  const r = t.runtime || {};
  const parts: string[] = [];
  if (t.enabled === false) parts.push('Desactivado');
  else if ((r.nextInSec || 0) > 0) parts.push(`Siguiente en ${fmtNext(r.nextInSec || 0)}`);
  else if (r.blockedBy) parts.push(`Esperando: ${r.blockedBy}`);
  else parts.push('Sale en el próximo repaso');
  parts.push(`${r.lines || 0} mensajes en el chat desde el último`);
  if (r.runs) parts.push(`enviado ${r.runs} ${r.runs === 1 ? 'vez' : 'veces'}, la última a las ${fmtTime(r.lastRunAt ?? 0)}`);
  return <>{parts.join(' · ')}
    {r.platforms && Object.keys(r.platforms).length ? <><br />Último envío: {platformsText(r.platforms)}</> : null}
    {r.lastError ? <><br /><span className="err-inline">Último error: {r.lastError}</span></> : null}
    {(r.warnings || []).map((w: any, i: number) => <span key={i}><br /><span className="err-inline">{w.message}</span></span>)}</>;
}
export async function fireTimer(id: string, show?: (msg: string, err?: boolean) => void) {
  const out = (msg: string, err = false) => { show?.(msg, err); toast(msg, err); };
  let r: { platforms?: Record<string, SendResult>; error?: string; alert?: boolean };
  try { r = await post(`/api/timers/${enc(id)}/fire`); } catch (e: any) { return out(e.message, true); }
  const detail = platformsText(r.platforms);
  if (r.error) return out(`${Object.values<any>(r.platforms || {}).some(x => x.ok) ? 'Envío parcial' : 'No se pudo enviar'}: ${detail || r.error}`, true);
  out(`${r.alert ? 'Enviado al chat y a pantalla' : 'Enviado al chat'}${detail ? ` · ${detail}` : ''}`);
}

// ---------- guardado del editor ----------
function findTarget(s: any, t: Target) {
  if (t.kind === 'alert') return s.config.alerts[t.type];
  if (t.kind === 'variation') return s.config.alerts[t.type]?.variations?.find((v: any) => v.id === t.id);
  if (t.kind === 'command') return (s.config.commands || []).find((c: any) => c.id === t.id);
  return (s.config.timers || []).find((x: any) => x.id === t.id);
}
function editorCfg(s: any, t: Target) {
  if (t.kind === 'alert') return { ...s.lookDefaults, ...s.config.alerts[t.type] };
  if (t.kind === 'variation') return { ...s.lookDefaults, ...s.config.alerts[t.type], ...(findTarget(s, t)?.overrides || {}) };
  if (t.kind === 'timer') return { ...s.timerDefaults, ...findTarget(s, t) };
  return { ...s.commandDefaults, ...findTarget(s, t) };
}
function applyLocal(s: any, t: Target, f: string, v: any) {
  const cfg = { ...s.config };
  const mapList = (list: any[], id: string, fn: (x: any) => any) => list.map(x => (x.id === id ? fn(x) : x));
  if (t.kind === 'alert') cfg.alerts = { ...cfg.alerts, [t.type]: { ...cfg.alerts[t.type], [f]: v } };
  if (t.kind === 'variation') {
    const a = cfg.alerts[t.type];
    cfg.alerts = { ...cfg.alerts, [t.type]: { ...a, variations: mapList(a.variations || [], t.id, vr => {
      if (f === 'name' || f === 'enabled') return { ...vr, [f]: v };
      if (f === 'conditions') return { ...vr, conditions: { ...vr.conditions, ...v } };
      const o = { ...(vr.overrides || {}) };
      if (v === null) delete o[f]; else o[f] = v;
      return { ...vr, overrides: o };
    }) } };
  }
  if (t.kind === 'command') cfg.commands = mapList(cfg.commands || [], t.id, c => ({ ...c, [f]: v }));
  if (t.kind === 'timer') cfg.timers = mapList(cfg.timers || [], t.id, c => ({ ...c, [f]: v }));
  return { config: cfg };
}
function testBody(t: Target, where: 'preview' | 'live') {
  if (t.kind === 'command') return { commandId: t.id, target: where };
  if (t.kind === 'timer') return { timerId: t.id, target: where };
  return { type: t.type, variationId: t.kind === 'variation' ? t.id : undefined, target: where };
}

function useEditor(t: Target) {
  const pending = useRef<any>({});
  const timer = useRef<any>(null);
  const autoPreview = useRef(true);
  const tRef = useRef(t); tRef.current = t;
  const flush = async () => {
    clearTimeout(timer.current);
    const p = pending.current; pending.current = {};
    if (!Object.keys(p).length) return;
    const tg = tRef.current;
    if (tg.kind === 'alert') { const d = await put<{ config: AlertConfig }>(`/api/alerts/${tg.type}`, p); live.update(s => ({ config: { ...s.config, alerts: { ...s.config.alerts, [tg.type]: d.config } } })); }
    if (tg.kind === 'variation') {
      const { name, enabled, conditions, ...overrides } = p;
      const d = await put<{ variation: AlertVariation }>(`/api/alerts/${tg.type}/variations/${enc(tg.id)}`, { name, enabled, conditions, overrides: Object.keys(overrides).length ? overrides : undefined });
      live.update(s => { const a = s.config.alerts[tg.type]; return { config: { ...s.config, alerts: { ...s.config.alerts, [tg.type]: { ...a, variations: (a.variations || []).map(x => (x.id === tg.id ? d.variation : x)) } } } }; });
    }
    if (tg.kind === 'command') { const d = await put<{ command: CommandConfig }>(`/api/commands/${enc(tg.id)}`, p); live.update(s => ({ config: { ...s.config, commands: s.config.commands.map((x: any) => (x.id === tg.id ? d.command : x)) } })); }
    if (tg.kind === 'timer') {
      const d = await put<{ timer: TimerConfig; warnings?: { message: string }[] }>(`/api/timers/${enc(tg.id)}`, p);
      live.update(s => ({ config: { ...s.config, timers: s.config.timers.map((x: any) => (x.id === tg.id ? d.timer : x)) }, timers: (s.timers || []).map(x => (x.id === tg.id ? { ...x, ...d.timer, runtime: { ...x.runtime, warnings: d.warnings || [] } } : x)) }));
    }
  };
  const preview = async () => {
    const tg = tRef.current;
    if (tg.kind === 'timer' && !editorCfg(live.state, tg).showAlert) return;
    await flush();
    await post('/api/test', testBody(tg, 'preview'));
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(guard(async () => { await flush(); if (autoPreview.current) await preview(); }), 400);
  };
  const set = (f: string, v: any) => { pending.current[f] = v; live.update(s => applyLocal(s, tRef.current, f, v)); schedule(); };
  const setCond = (k: string, v: any) => { pending.current.conditions = { ...(pending.current.conditions || {}), [k]: v }; live.update(s => applyLocal(s, tRef.current, 'conditions', { [k]: v })); clearTimeout(timer.current); timer.current = setTimeout(guard(flush), 500); };
  // al salir o cambiar de lo que se edita, se guarda lo pendiente
  const key = JSON.stringify(t);
  useEffect(() => () => { guard(flush)(); }, [key]);
  return { set, setCond, flush, preview, autoPreview };
}

// ---------- acciones al salir ----------
/** Campos de una acción (escena, capa, efecto, chat…). Lo usan las alertas y los atajos. */
export function ActionFields({ act, onChange, uid }: { act: any; onChange: (a: any) => void; uid: string }) {
  const meld = useLive(s => s.meld);
  const scenes = meld?.session?.scenes || [];
  const sc = scenes.find((x: any) => x.name === act.scene);
  const layers = [...new Set<string>((sc ? [sc] : scenes).flatMap((x: any) => x.layers.map((l: any) => l.name)))];
  const k = act.kind;
  const upd = (f: string, v: any) => onChange({ ...act, [f]: v });
  const inp = (f: string, label: string, type = 'text', extra: any = {}) => <label key={f} className={f === 'text' ? 'wide' : undefined}>{label}<input type={type} value={act[f] ?? ''} {...extra} onChange={e => upd(f, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} /></label>;
  return <div className="afields">
    <datalist id={`dl-scenes-${uid}`}>{scenes.map((x: any) => <option key={x.id} value={x.name} />)}</datalist>
    {['scene', 'layer', 'hideLayer', 'toggleLayer', 'effect'].includes(k) && inp('scene', 'Escena', 'text', { list: `dl-scenes-${uid}`, placeholder: k === 'scene' ? 'Escena' : 'cualquiera' })}
    {['layer', 'hideLayer', 'toggleLayer', 'effect'].includes(k) && <>{inp('layer', 'Capa', 'text', { list: `dl-layers-${uid}` })}<datalist id={`dl-layers-${uid}`}>{layers.map(x => <option key={x} value={x} />)}</datalist></>}
    {k === 'effect' && inp('effect', 'Efecto')}
    {k === 'scene' && inp('returnAfterSec', 'Volver tras (s)', 'number', { min: 0, placeholder: 'no volver' })}
    {k === 'layer' && inp('seconds', 'Durante (s)', 'number', { min: 0 })}
    {k === 'command' && <label>Comando<select value={act.command || ''} onChange={e => upd('command', e.target.value)}><option value="">—</option>{(meld?.commands || []).map((c: string) => <option key={c} value={c}>{c.replace('meld.', '')}</option>)}</select></label>}
    {k === 'streamEvent' && <><label>Evento<select value={act.event || ''} onChange={e => upd('event', e.target.value)}><option value="">—</option>{(meld?.events || []).map((c: string) => <option key={c} value={c}>{c}</option>)}</select></label>{inp('amount', 'Cantidad', 'number')}</>}
    {(k === 'chat' || k === 'say') && inp('text', k === 'chat' ? 'Mensaje (con {user}…)' : 'Texto (con {user}…)')}
    {k === 'chat' && <label>Dónde<select value={act.destination || 'twitch'} onChange={e => upd('destination', e.target.value)}>{DESTINATIONS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>}
    {inp('delaySec', 'Retardo (s)', 'number', { min: 0, step: 0.5 })}
  </div>;
}
export function ActionsEditor({ list, onChange }: { list: any[]; onChange: (l: any[]) => void }) {
  const repl = (i: number, a: any) => { const l = [...list]; l[i] = a; onChange(l); };
  return <div className="actions-list">
    {list.map((act, i) => <div className="action" key={i}>
      <select value={act.kind} onChange={e => repl(i, { kind: e.target.value, delaySec: act.delaySec })}>{Object.entries(ACTIONS).map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select>
      <ActionFields act={act} uid={'a' + i} onChange={a => repl(i, a)} />
      <IconBtn icon={IC.x} label="Quitar acción" onClick={() => { const l = [...list]; l.splice(i, 1); onChange(l); }} />
    </div>)}
  </div>;
}

// ---------- editor ----------
export function Editor({ target }: { target: Target }) {
  const s = useLive(x => x);
  const ed = useEditor(target);
  const up = useUploader();
  const [cssTab, setCssTab] = useState<'own' | 'global'>('own');
  const [tab, setTab] = useState('');
  const [fireMsg, setFireMsg] = useState<{ text: string; err: boolean } | null>(null);
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const cssRef = useRef<HTMLTextAreaElement>(null);
  const gcssRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef(ed.preview); previewRef.current = ed.preview;
  const frameRef = useCallback((el: HTMLIFrameElement | null) => { if (el) el.onload = () => setTimeout(guard(() => previewRef.current()), 300); }, []);
  const item = findTarget(s, target);
  // timers: refresca el estado (cuenta atrás) cada 5 s
  useEffect(() => {
    if (target.kind !== 'timer') return;
    // SAFETY: la API antigua devolvía el array de timers directamente en el cuerpo; el cast cubre esa respuesta legacy.
    const h = setInterval(guard(async () => { const t = await get<{ timers?: TimerConfig[] }>('/api/timers'); live.update(() => ({ timers: t.timers ?? (t as unknown as TimerConfig[]) })); }), 5000);
    return () => clearInterval(h);
  }, [target.kind]);
  if (!item) return <p className="hint">No existe. <a href="#/directo">Volver</a></p>;

  const a = editorCfg(s, target);
  const kind = target.kind;
  const type = 'type' in target ? target.type : '';
  const t = kind === 'command' ? { label: 'Comando de chat', platform: 'chat' } : kind === 'timer' ? { label: 'Mensaje programado', platform: 'chat' } : s.types[type];
  const visuals = (s.media || []).filter(m => m.kind === 'video' || m.kind === 'image');
  const audios = (s.media || []).filter(m => m.kind === 'audio');
  const vars = kind === 'timer' ? TIMER_VARS : Object.keys(s.samples[kind === 'command' ? 'command' : type] || {});
  const v = kind === 'variation' ? item : null;
  const amountType = (kind === 'alert' || kind === 'variation') && AMOUNT_TYPES.includes(type);
  const overrides = v?.overrides || {};
  const mediaKind = (s.media || []).find(m => m.name === a.media)?.kind;
  const isMedia = a.layout === 'media';
  const isVideo = isMedia && mediaKind === 'video';
  const showAlert = kind !== 'timer' || !!a.showAlert;
  const when = { card: !isMedia, media: isMedia, video: isVideo, fixed: !isVideo || a.durationMode !== 'media' };

  const set = ed.set;
  const unset = (f: string) => kind === 'variation' && f in overrides ? <button className="unset" title="Volver a heredar de la alerta" onClick={guard(async (e: any) => { e.preventDefault(); set(f, null); await ed.flush(); })}>↺</button> : null;
  // función (no componente) para que React no remonte los campos y no se pierda el foco al escribir
  const F = (f: string, label: ReactNode, children: ReactNode, className?: string) =>
    <label data-field={f} className={cx(className, kind === 'variation' && f in overrides && 'ovr')}>{label}{unset(f)}{children}</label>;
  const R = (f: string, label: string, min: number, max: number, step: number, unit: string, ms = false) => {
    const val = ms ? (a[f] ?? 0) / 1000 : a[f] ?? 0;
    return F(f, label, <><span className="val">{val} {unit}</span>
      <input type="range" min={min} max={max} step={step} value={val} style={{ ['--v' as any]: ((val - min) / (max - min)) * 100 + '%' }} onChange={e => set(f, ms ? Math.round(Number(e.target.value) * 1000) : Number(e.target.value))} /></>);
  };
  const txt = (f: string, label: string) => F(f, label, <><input value={a[f] ?? ''} onFocus={e => { lastField.current = e.target; }} onChange={e => set(f, e.target.value)} /></>);
  const insertVar = (x: string) => {
    const fld = lastField.current; const ins = `{${x}}`;
    if (!fld) { set('sub', (a.sub || '') + ins); return; }
    const f = fld.dataset.f || (fld.closest('[data-field]') as HTMLElement)?.dataset.field || 'sub';
    const st = fld.selectionStart ?? fld.value.length, en = fld.selectionEnd ?? st;
    set(f, fld.value.slice(0, st) + ins + fld.value.slice(en));
    requestAnimationFrame(() => { fld.focus(); fld.setSelectionRange(st + ins.length, st + ins.length); });
  };
  const insertSnippet = (code: string) => {
    const ta = cssTab === 'own' ? cssRef.current : gcssRef.current; if (!ta) return;
    const st = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? st;
    const pre = ta.value.slice(0, st), sep = pre && !pre.endsWith('\n') ? '\n' : '';
    const next = pre + sep + code + '\n' + ta.value.slice(en);
    if (cssTab === 'own') set('css', next); else saveGlobalCss(next);
    const pos = (pre + sep + code + '\n').length;
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(pos, pos); });
  };
  const saveGlobalCss = (css: string) => { live.patchConfig({ overlay: { css } }); if (ed.autoPreview.current) setTimeout(guard(ed.preview), 500); };
  const onUpload = (f: 'sound' | 'media') => guard(async (e: any) => {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    const d = await up.run(files as File[]);
    if (!d) return;
    set(f, d.name);
    if (f === 'media') { set('layout', 'media'); if ((live.state?.media || []).find(m => m.name === d.name)?.kind === 'video') set('durationMode', 'media'); }
    await ed.flush();
  });

  // ---------- cabecera ----------
  const head = kind === 'alert' ? <>
    <div><span className="crumb">Alertas de {t.platform === 'youtube' ? 'YouTube' : 'Twitch'} › {t.label}</span><h1>{t.label}</h1></div>
    <div className="actions">
      <Switch checked={a.enabled} onChange={x => set('enabled', x)}>Activada</Switch>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => {
        if (!confirm('¿Restaurar esta alerta a sus valores por defecto? Se borran también sus variaciones.')) return;
        await ed.flush(); const d = await post<{ config: Config }>(`/api/alerts/${type}/reset`); live.update(() => ({ config: d.config }));
      })}>Restaurar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(async () => { await ed.flush(); const d = await post<{ overlays?: number }>('/api/test', testBody(target, 'live')); toast(d.overlays ? 'Enviada al directo' : 'Enviada, pero no hay ningún overlay abierto en Meld'); })}><Icon d={IC.play} className="eg-btn__icon" />Probar en el directo</button>
    </div></> : kind === 'variation' ? <>
    <div><span className="crumb"><a href={`#/alerta/${type}`}>{t.label}</a> › Variación</span>
      <input className="title-input" value={v.name} aria-label="Nombre de la variación" onChange={e => set('name', e.target.value)} /></div>
    <div className="actions">
      <Switch checked={v.enabled !== false} onChange={x => set('enabled', x)}>Activa</Switch>
      <a className="eg-btn eg-btn--ghost eg-btn--sm" href={`#/alerta/${type}`}>Volver a la alerta</a>
      <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => {
        if (!confirm('¿Borrar esta variación?')) return;
        const d = await del<{ variations: AlertVariation[] }>(`/api/alerts/${type}/variations/${enc(v.id)}`);
        live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: d.variations } } } }));
        go(`#/alerta/${type}`);
      })}>Borrar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(async () => { await ed.flush(); const d = await post<{ overlays?: number }>('/api/test', testBody(target, 'live')); toast(d.overlays ? 'Enviada al directo' : 'Enviada, pero no hay ningún overlay abierto en Meld'); })}><Icon d={IC.play} className="eg-btn__icon" />Probar en el directo</button>
    </div></> : kind === 'timer' ? <>
    <div><span className="crumb"><a href="#/mensajes">Mensajes programados</a> › Mensaje</span>
      <input className="title-input" value={item.name} aria-label="Nombre del mensaje" onChange={e => set('name', e.target.value)} /></div>
    <div className="actions">
      <Switch checked={item.enabled !== false} onChange={x => set('enabled', x)}>Activo</Switch>
      <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirm('¿Borrar este mensaje programado?')) return; const d = await del<{ timers: TimerConfig[] }>(`/api/timers/${enc(item.id)}`); live.update(st => ({ config: { ...st.config, timers: d.timers } })); go('#/mensajes'); })}>Borrar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(async () => { await ed.flush(); await fireTimer(item.id, (text, err) => setFireMsg({ text, err: !!err })); })}>Enviar ahora</button>
    </div></> : <>
    <div><span className="crumb"><a href="#/comandos">Comandos de chat</a> › Comando</span>
      <input className="title-input" value={item.trigger} aria-label="Disparador" onChange={e => set('trigger', e.target.value.trim())} /></div>
    <div className="actions">
      <Switch checked={item.enabled !== false} onChange={x => set('enabled', x)}>Activo</Switch>
      <button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirm('¿Borrar este comando?')) return; const d = await del<{ commands: CommandConfig[] }>(`/api/commands/${enc(item.id)}`); live.update(st => ({ config: { ...st.config, commands: d.commands } })); go('#/comandos'); })}>Borrar</button>
      <button className="eg-btn eg-btn--primary eg-btn--sm" onClick={guard(async () => { await ed.flush(); await post('/api/test', testBody(target, 'live')); }, 'Enviado al directo')}><Icon d={IC.play} className="eg-btn__icon" />Probar en el directo</button>
    </div></>;

  const c = kind === 'variation' ? { ...s.conditionDefaults, ...v.conditions } : null;
  const nActions = (a.actions || []).length, nVars = (a.variations || []).length;
  // pestañas del editor (lienzo: Diseño, Mensaje, Sonido y voz, Acciones al salir, Variaciones, CSS)
  const tabs: [string, ReactNode][] = [
    ...(kind === 'alert' && VIEWER_TYPES[type] ? [['rec', 'Récord'] as [string, ReactNode]] : []),
    ...(kind === 'variation' ? [['when', 'Cuándo sale'] as [string, ReactNode]] : []),
    ...(kind === 'command' ? [['cmd', 'Comando'] as [string, ReactNode]] : []),
    ...(kind === 'timer' ? [['chat', 'Mensaje en el chat'] as [string, ReactNode]] : []),
    ...(showAlert ? [
      ['design', 'Diseño'], ['message', 'Mensaje'], ['sound', 'Sonido y voz'],
      ['actions', <>Acciones al salir{nActions ? <span className="eg-tabs__count">{nActions}</span> : null}</>],
      ...(kind === 'alert' ? [['vars', <>Variaciones{nVars ? <span className="eg-tabs__count">{nVars}</span> : null}</>] as [string, ReactNode]] : []),
      ['css', 'CSS'],
    ] as [string, ReactNode][] : []),
  ];
  const cur = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  // todas las pestañas quedan montadas (solo se ocultan): el formulario no pierde lo escrito al cambiar
  const pane = (k: string, children: ReactNode) => <div role="tabpanel" id={`tp-${k}`} aria-labelledby={`tb-${k}`} hidden={cur !== k} className="tabpane">{children}</div>;
  const box = (title: ReactNode, children: ReactNode, aside?: ReactNode) => <section className="subbox"><div className="subbox-h"><span>{title}</span>{aside}</div>{children}</section>;
  return <>
    <header className="view-head">{head}</header>
    {tabs.length > 1 && <div className="eg-tabs editor-tabs" role="tablist" aria-label="Partes">
      {tabs.map(([k, l]) => <button key={k} type="button" role="tab" id={`tb-${k}`} aria-controls={`tp-${k}`} className="eg-tabs__item" aria-selected={cur === k} onClick={() => setTab(k)}>{l}</button>)}
    </div>}
    <div className={cx('editor', !showAlert && 'solo')}>
      <div className="form-col">
        {kind === 'alert' && VIEWER_TYPES[type] && pane('rec', <RecordPane type={type} />)}
        {kind === 'variation' && pane('when', <>
          <p className="hint">Sale esta variación en vez de la alerta normal cuando se cumple todo lo que rellenes. Si varias encajan, gana la primera de la lista.</p>
          <div className="row2">
            {amountType && <><label>Cantidad mínima <input type="number" value={c.minAmount ?? ''} placeholder="sin mínimo" onChange={e => ed.setCond('minAmount', e.target.value)} /></label>
              <label>Cantidad máxima <input type="number" value={c.maxAmount ?? ''} placeholder="sin máximo" onChange={e => ed.setCond('maxAmount', e.target.value)} /></label></>}
            {TIER_TYPES.includes(type) && <label>Tier <select value={c.tier ?? ''} onChange={e => ed.setCond('tier', e.target.value)}><option value="">Cualquiera</option><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select></label>}
            <label>Solo para estos usuarios <input value={c.users ?? ''} placeholder="nombre1, nombre2" onChange={e => ed.setCond('users', e.target.value)} /></label>
            <label>Si el mensaje contiene <input value={c.messageContains ?? ''} placeholder="palabra, otra" onChange={e => ed.setCond('messageContains', e.target.value)} /></label>
            <label>Probabilidad <span className="val">{c.chance} %</span><input type="range" min={1} max={100} value={c.chance} style={{ ['--v' as any]: c.chance + '%' }} onChange={e => ed.setCond('chance', Number(e.target.value))} /></label>
          </div>
          <p className="hint">Una variación solo guarda lo que cambia; lo marcado con <b style={{ color: 'var(--red)' }}>●</b> pisa a la alerta y ↺ lo devuelve a lo heredado.</p>
        </>)}

        {kind === 'command' && pane('cmd', <>
          <div className="row2">
            <label>Quién puede usarlo <select value={item.permission} onChange={e => set('permission', e.target.value)}>{PERMS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>
            <div className="lbl">Plataformas<div className="row" style={{ marginTop: 8 }}>
              {['twitch', 'youtube'].map(p => <label className="check" key={p}><input type="checkbox" checked={item.platforms?.includes(p)} onChange={e => set('platforms', e.target.checked ? [...new Set([...(item.platforms || []), p])] : (item.platforms || []).filter((x: string) => x !== p))} /> {PLATFORM_NAMES[p]}</label>)}
            </div></div>
            <label>Espera entre usos (s) <input type="number" min={0} value={item.cooldownSec} onChange={e => set('cooldownSec', Number(e.target.value) || 0)} /></label>
            <label>Espera por persona (s) <input type="number" min={0} value={item.userCooldownSec} onChange={e => set('userCooldownSec', Number(e.target.value) || 0)} /></label>
          </div>
          <p className="hint">Los moderadores y tú no tienen espera. Variables: <code>{'{user}'}</code> y <code>{'{args}'}</code> (lo que se escribe detrás del comando).</p>
        </>)}

        {kind === 'timer' && pane('chat', <>
          <div className="vars">{TIMER_VARS.map(x => <button key={x} className="eg-chip" type="button" onClick={() => insertVar(x)}>{`{${x}}`}</button>)}</div>
          <label data-field="message">Mensaje <textarea data-f="message" value={item.message || ''} spellCheck onFocus={e => { lastField.current = e.target; }} onChange={e => set('message', e.target.value)} style={{ minHeight: 84, fontFamily: 'var(--f-body)', fontSize: 14 }} /></label>
          <div className="row2">
            <label>Cada (minutos) <input type="number" min={1} value={item.intervalMin} onChange={e => set('intervalMin', Number(e.target.value) || 0)} /></label>
            <label>Solo si ha habido al menos estos mensajes en el chat <input type="number" min={0} value={item.minChatLines} onChange={e => set('minChatLines', Number(e.target.value) || 0)} /></label>
            <label>Dónde se publica <select value={item.destination || 'twitch'} onChange={e => set('destination', e.target.value)}>{DESTINATIONS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>
          </div>
          <div className="row2 switches">
            <Switch checked={item.onlyWhenLive} onChange={x => set('onlyWhenLive', x)} title="Viene activado. Sin Meld conectado no se publica.">Solo mientras emito (sin Meld conectado, no se publica)</Switch>
            <Switch checked={item.announce} onChange={x => set('announce', x)}>Como anuncio destacado</Switch>
          </div>
          {item.announce && <label>Color del anuncio <select value={item.announceColor} onChange={e => set('announceColor', e.target.value)}>{[['primary', 'Color del canal'], ['blue', 'Azul'], ['green', 'Verde'], ['orange', 'Naranja'], ['purple', 'Morado']].map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>}
          {item.announce && ['youtube', 'both'].includes(item.destination) && <p className="hint">En YouTube no hay anuncios destacados: recibe el mismo texto como mensaje normal.</p>}
          <p className="timer-state"><TimerState id={item.id} /></p>
          {fireMsg && <p className={cx('hint', fireMsg.err && 'err-inline')} aria-live="polite">{fireMsg.text}</p>}
          <p className="hint">Variables: <code>{'{channel}'}</code> tu canal, <code>{'{title}'}</code> título del directo, <code>{'{uptime}'}</code> tiempo en directo, <code>{'{follows}'}</code> seguidores nuevos hoy. «Solo mientras emito» usa el estado de Meld: sin Meld conectado no se publica. Límites: 500 caracteres en Twitch y 200 en YouTube; si el texto no cabe, no se envía a esa plataforma (nunca se corta).</p>
          {box('También en pantalla', <p className="hint">Además del mensaje en el chat, saca una alerta en el overlay con su diseño, mensaje y sonido (aparecen sus pestañas).</p>, <Switch checked={item.showAlert} onChange={x => set('showAlert', x)}>Mostrar alerta</Switch>)}
        </>)}

        {showAlert && <>
          {pane('design', <>
            <div className="lbl" data-field="layout">Tipo de alerta{unset('layout')}
              <div className="tiles2" role="radiogroup" aria-label="Tipo de alerta">
                <button type="button" role="radio" className="eg-tile" aria-pressed={a.layout !== 'media'} aria-checked={a.layout !== 'media'} onClick={() => set('layout', 'card')}>
                  <span className="eg-tile__thumb"><span className="tile-card">Tarjeta 3D</span></span>
                  <span className="eg-tile__name">Tarjeta 3D EGDEV</span><span className="eg-tile__meta">De serie, con brillo y giro</span></button>
                <button type="button" role="radio" className="eg-tile" aria-pressed={a.layout === 'media'} aria-checked={a.layout === 'media'} onClick={() => set('layout', 'media')}>
                  <span className="eg-tile__thumb">{a.media && mediaKind === 'image' ? <img src={`/media/${enc(a.media)}`} alt="" /> : a.media && mediaKind === 'video' ? <video src={`/media/${enc(a.media)}`} muted preload="metadata" /> : <Icon d={IC.camera} className="eg-icon eg-icon--lg" />}</span>
                  <span className="eg-tile__name">Mi vídeo o imagen</span><span className="eg-tile__meta">Con el texto encima</span></button>
              </div>
            </div>
            {when.media && <>
              <div className={cx('lbl', kind === 'variation' && 'media' in overrides && 'ovr')} data-field="media">{mediaKind === 'image' ? 'Imagen' : 'Vídeo o imagen'}{unset('media')}
                <div className="picker">
                  <select value={a.media || ''} onChange={e => set('media', e.target.value)}><option value="">— Elige un vídeo o una imagen —</option>{visuals.map((m: any) => <option key={m.name} value={m.name}>{m.name}</option>)}</select>
                  <label className="eg-btn eg-btn--ghost eg-btn--sm upload">Subir<input type="file" accept="video/*,image/*" hidden onChange={onUpload('media')} /></label>
                </div>
                <span className="hint">Se guarda en la carpeta media/ de la app.</span>
              </div>
              <div className="row2">{R('mediaSize', 'Tamaño', 10, 200, 1, '%')}{when.video && R('mediaVolume', 'Volumen del vídeo', 0, 100, 1, '%')}</div>
            </>}
            {when.video && <div className="lbl">Duración<div style={{ marginTop: 6 }}><Seg value={a.durationMode} onChange={x => set('durationMode', x)} options={[['media', 'Lo que dure el vídeo'], ['fixed', 'Tiempo fijo']]} /></div></div>}
            <div className="row2">
              {when.fixed && R('durationMs', 'Duración', 1, 30, 0.5, 's', true)}
              {when.media && F('animIn', 'Animación de entrada', <><select value={a.animIn} onChange={e => set('animIn', e.target.value)}>{ANIM_IN.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></>)}
              {when.media && F('animOut', 'Animación de salida', <><select value={a.animOut} onChange={e => set('animOut', e.target.value)}>{ANIM_OUT.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></>)}
              {when.media && R('textDelayMs', 'Retardo del texto', 0, 6, 0.1, 's', true)}
            </div>
            {when.card && <p className="hint">La tarjeta 3D de la marca: icono, antetítulo, nombre y línea de apoyo. Cambia su aspecto en la pestaña CSS.</p>}
            {when.media && box('Posición y estilo del texto', <>
              <div className="row3">{R('textX', 'X', 0, 100, 1, '%')}{R('textY', 'Y', 0, 100, 1, '%')}{R('textWidth', 'Ancho', 20, 140, 1, '%')}</div>
              <div className="row2">{R('fontSize', 'Tamaño de fuente', 20, 160, 1, 'px')}
                <div className={cx('lbl', kind === 'variation' && 'textAlign' in overrides && 'ovr')} data-field="textAlign">Alineación{unset('textAlign')}
                  <Seg wide value={a.textAlign} onChange={x => set('textAlign', x)} options={[['left', 'Izq.'], ['center', 'Centro'], ['right', 'Der.']]} /></div></div>
              <div className="row2">
                {F('textColor', 'Color del texto', <><input type="color" value={a.textColor} onChange={e => set('textColor', e.target.value)} /></>)}
                {F('accentColor', 'Color de acento (nombre)', <><input type="color" value={a.accentColor} onChange={e => set('accentColor', e.target.value)} /></>)}
              </div>
              <p className="hint">La posición es el centro del bloque de texto, en % del vídeo: 50/50 es el centro; 50/80, abajo.</p>
            </>)}
          </>)}

          {pane('message', <>
            <div className="vars">{vars.map(x => <button key={x} className="eg-chip" type="button" onClick={() => insertVar(x)}>{`{${x}}`}</button>)}</div>
            {txt('title', 'Antetítulo')}{txt('text', 'Texto grande')}{txt('sub', 'Línea de apoyo')}
            {amountType && kind === 'alert' && <label>Mínimo para alertar <input type="number" min={0} value={a.minAmount || 0} onChange={e => set('minAmount', Number(e.target.value) || 0)} /></label>}
            <p className="hint">Deja un campo vacío para que no salga. Si falta un dato, el separador « · » desaparece solo.</p>
          </>)}

          {pane('sound', <>
            <div className={cx('lbl', kind === 'variation' && 'sound' in overrides && 'ovr')} data-field="sound">Sonido{unset('sound')}
              <div className="picker">
                <select value={a.sound} onChange={e => set('sound', e.target.value)}><option value="default">Sonido EGDEV</option><option value="none">Sin sonido</option>{audios.map((m: any) => <option key={m.name} value={m.name}>{m.name}</option>)}</select>
                <label className="eg-btn eg-btn--ghost eg-btn--sm upload">Subir<input type="file" accept="audio/*" hidden onChange={onUpload('sound')} /></label>
              </div>
            </div>
            {R('soundVolume', 'Volumen del sonido', 0, 100, 1, '%')}
            {when.video && <p className="hint">Si tu vídeo ya trae el sonido, elige «Sin sonido» aquí.</p>}
            {box('Voz', <>
              {txt('ttsTemplate', 'Qué se lee')}
              {amountType && F('ttsMinAmount', 'Solo a partir de esta cantidad', <><input type="number" min={0} value={a.ttsMinAmount || 0} onChange={e => set('ttsMinAmount', Number(e.target.value) || 0)} /></>)}
              <p className="hint">La voz, la velocidad y el filtro de palabras se ajustan en <a href="#/filtros">Filtros y voz</a>.</p>
            </>, <Switch checked={a.ttsEnabled} onChange={x => set('ttsEnabled', x)}>Leer en voz alta</Switch>)}
          </>)}

          {pane('actions', <>
            <div className="row" style={{ alignItems: 'center' }}>
              <p className="hint grow">Se ejecutan cuando la alerta aparece en pantalla: cambiar de escena en Meld, mostrar una capa, lanzar confeti, escribir en el chat…{s.status.meld?.state !== 'conectado' && <> <b>Meld no está conectado</b>: puedes prepararlas igualmente.</>}</p>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => set('actions', [...structuredClone(a.actions || []), { kind: 'layer', scene: '', layer: '', seconds: 8, delaySec: 0 }])}><Icon d={IC.plus} className="eg-btn__icon" />Añadir acción</button>
            </div>
            <ActionsEditor list={a.actions || []} onChange={l => set('actions', l)} />
            {kind === 'variation' && 'actions' in overrides && <p className="hint">Las acciones de una variación sustituyen a las de la alerta. {unset('actions')}</p>}
          </>)}

          {kind === 'alert' && pane('vars', <>
            <div className="row" style={{ alignItems: 'center' }}>
              <p className="hint grow">Solo guardan lo que cambia (otro vídeo, sonido o texto) según la cantidad, el tier, el usuario o el mensaje. Gana la primera que encaja.</p>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => {
                await ed.flush();
                const d = await post<{ variation: AlertVariation }>(`/api/alerts/${type}/variations`, { name: `Variación ${(a.variations?.length || 0) + 1}`, conditions: AMOUNT_TYPES.includes(type) ? { minAmount: 100 } : {} });
                live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: [...(st.config.alerts[type].variations || []), d.variation] } } } }));
                go(`#/alerta/${type}/v/${d.variation.id}`);
              })}><Icon d={IC.plus} className="eg-btn__icon" />Añadir variación</button>
            </div>
            <div className="rows">{nVars ? a.variations.map((x: any, i: number, arr: any[]) => <article key={x.id} className={cx('eg-post eg-post--row', x.enabled === false && 'is-off')}>
              <div className="eg-post__content"><b>{x.name}</b><span className="eg-post__meta">{condSummary(x.conditions)}{Object.keys(x.overrides || {}).length ? ` · cambia ${Object.keys(x.overrides).length} ${Object.keys(x.overrides).length === 1 ? 'cosa' : 'cosas'}` : ''}</span></div>
              {[-1, 1].map(dir => <IconBtn key={dir} icon={dir < 0 ? IC.up : IC.down} label={dir < 0 ? 'Subir' : 'Bajar'} disabled={dir < 0 ? i === 0 : i === arr.length - 1} onClick={guard(async () => {
                const ids = arr.map(z => z.id); const j = i + dir; [ids[i], ids[j]] = [ids[j], ids[i]];
                const d = await post<{ variations: AlertVariation[] }>(`/api/alerts/${type}/variations-order`, { ids });
                live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: d.variations } } } }));
              })} />)}
              <label className="switch" aria-label={`${x.name} activa`}><input type="checkbox" checked={x.enabled !== false} onChange={guard(async e => {
                const d = await put<{ variation: AlertVariation }>(`/api/alerts/${type}/variations/${enc(x.id)}`, { enabled: e.target.checked });
                live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: (st.config.alerts[type]?.variations || []).map((z: any) => (z.id === x.id ? d.variation : z)) } } } }));
              })} /><i></i></label>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" title={`Probar ${x.name}`} onClick={guard(() => post('/api/test', { type, variationId: x.id, target: 'preview' }))}><Icon d={IC.play} className="eg-btn__icon" />Probar</button>
              <a className="eg-btn eg-btn--ghost eg-btn--sm" href={`#/alerta/${type}/v/${x.id}`}>Editar</a>
            </article>) : <EmptyState>Sin variaciones.</EmptyState>}</div>
          </>)}

          {pane('css', <>
            <div className="row" style={{ alignItems: 'center' }}><Seg value={cssTab} onChange={setCssTab} options={[['own', kind === 'variation' ? 'Esta variación' : kind === 'alert' ? 'Esta alerta' : 'Este'], ['global', 'Todas las alertas']]} /><span className="hint">· gana siempre a los estilos de serie</span></div>
            {cssTab === 'own'
              ? <div className={cx('lbl', kind === 'variation' && 'css' in overrides && 'ovr')} data-field="css">{unset('css')}
                <textarea ref={cssRef} className="code" spellCheck={false} value={a.css || ''} onKeyDown={codeTab} onChange={e => set('css', e.target.value)} placeholder={'/* Tu CSS gana a los estilos de serie: no hace falta !important */\n.alert { --accent: #00E0FF; }'} /></div>
              : <><textarea ref={gcssRef} className="code" spellCheck={false} value={s.config.overlay?.css || ''} onKeyDown={codeTab} onChange={e => saveGlobalCss(e.target.value)} placeholder={"/* Se aplica a TODAS las alertas, antes que el CSS de cada una */\n.alert { --font-name: 'Barlow Condensed', sans-serif; }"} />
                <p className="hint">Se aplica a todas las alertas, comandos y mensajes. El CSS de cada alerta va después y puede pisarlo.</p></>}
            <div className="snippets"><span className="hint">Insertar:</span>{CSS_SNIPPETS.map(([l, code]) => <button key={l} type="button" className="eg-chip" onClick={() => insertSnippet(code)}>{l}</button>)}</div>
            <p className="css-help">Clases: <code>.alert</code> (raíz; también <code>.type-{kind === 'command' ? 'command' : kind === 'timer' ? 'custom' : type}</code>, <code>.alert-card</code> o <code>.alert-media-layout</code>) <code>.alert-box</code> <code>.alert-text</code> <code>.alert-title</code> <code>.alert-name</code> <code>.alert-sub</code> <code>.alert-sub b</code></p>
            <details className="css-ref"><summary>Más clases y variables</summary>
              <p><b>Solo tarjeta:</b> <code>.alert-icon</code> · <code>.alert-platform</code> · <code>.alert-timer</code> · <code>.alert-glow</code> · <code>.alert-dots</code> · <code>.alert-cube</code> · <code>.card</code> · <b>Solo vídeo o imagen:</b> <code>.alert-media</code></p>
              <p><b>Variables de la tarjeta</b> (en <code>.alert {'{ … }'}</code>): {CSS_VARS.map(x => <code key={x}>{x} </code>)}</p>
              <p>Animaciones: <code>.alert.on</code> mientras se ve, <code>.alert.out</code> al salir.</p>
            </details>
          </>)}
        </>}
      </div>

      {showAlert && <div className="preview-col">
        <figure className="eg-stage">
          <figcaption className="eg-stage__bar"><span className="eg-eyebrow" style={{ margin: 0 }}>Vista previa · 1920×1080</span><span className="eg-stage__spacer" />
            {kind === 'variation' && <span>Variación: <b style={{ color: 'var(--text)' }}>{v.name}</b></span>}
            <label className="switch"><input type="checkbox" defaultChecked onChange={e => { ed.autoPreview.current = e.target.checked; }} /><i></i>Al cambiar algo</label>
            <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(ed.preview)}><Icon d={IC.repeat} className="eg-btn__icon" />Repetir</button>
          </figcaption>
          <ScaledFrame src="/overlay?preview" className="preview" frameRef={frameRef} />
          <div className="eg-stage__bar"><span>Variables:</span>{vars.map(x => <button key={x} type="button" className="eg-chip" onClick={() => insertVar(x)} title="Insertar en el último campo de texto">{`{${x}}`}</button>)}</div>
        </figure>
        <p className="hint">Se ve igual que en Meld a 1920×1080. El vídeo puede sonar silenciado aquí; en Meld suena normal.</p>
      </div>}
    </div>
    <UploadBar name={up.name} progress={up.progress} />
  </>;
}
