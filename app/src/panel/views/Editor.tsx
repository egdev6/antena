// Editor de alerta, variación, comando de chat o mensaje programado (mismo formulario, distintas partes).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { del, enc, post, put, get } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { ManualDraft } from '../../lib/manual-draft';
import type { AlertConfig, AlertVariation, AppState, CommandConfig, Config, SendResult, TimerConfig } from '../../lib/types';
import { codeTab, confirmDelete, cx, EmptyState, guard, Icon, IconBtn, PLATFORM_NAMES, ScaledFrame, Seg, SegField, Switch, toast, fmtTime } from '../../lib/ui';
import { IC } from '../../lib/icons';
import { go } from '../router';
import { useUploader, UploadBar } from './General';
import { confirmLeave, isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { ListPanel, NameCell, SaveBar, Slide, Tags, type TabDef } from '../../lib/layout';
import { RecordPane, VIEWER_TYPES } from './Espectadores';

export type Target = { kind: 'alert'; type: string } | { kind: 'variation'; type: string; id: string } | { kind: 'command'; id: string } | { kind: 'timer'; id: string };

const ANIM_IN: [string, string][] = [['pop', 'Rebote'], ['fade', 'Fundido'], ['slide', 'Desde abajo'], ['zoom', 'Zoom'], ['none', 'Ninguna']];
const ANIM_OUT: [string, string][] = [['fade', 'Fundido'], ['slide', 'Hacia arriba'], ['zoom', 'Encoger'], ['none', 'Ninguna']];
const AMOUNT_TYPES = ['cheer', 'raid', 'giftsub', 'superchat', 'supersticker', 'giftmember'];
const TIER_TYPES = ['sub', 'resub', 'giftsub'];
const TIER_OPTIONS: [string, string][] = [['', 'Cualquiera'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']];
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

// Campo → pestaña, para el punto de «cambios sin guardar» de cada pestaña.
const FIELD_TAB: Record<string, string> = {
  conditions: 'when', trigger: 'cmd', permission: 'cmd', cooldownSec: 'cmd', userCooldownSec: 'cmd', platforms: 'cmd', outputMode: 'cmd', chatReply: 'cmd',
  message: 'chat', intervalMin: 'chat', minChatLines: 'chat', destination: 'chat', onlyWhenLive: 'chat', announce: 'chat', announceColor: 'chat', showAlert: 'chat',
  title: 'message', text: 'message', sub: 'message', minAmount: 'message',
  sound: 'sound', soundVolume: 'sound', ttsEnabled: 'sound', ttsTemplate: 'sound', ttsMinAmount: 'sound',
  actions: 'actions', css: 'css', name: 'head', enabled: 'head',
};
export const fieldTab = (f: string) => FIELD_TAB[f] || 'design';
const FIELD_LABEL: Record<string, string> = { media: 'vídeo o imagen', layout: 'diseño', sound: 'sonido', soundVolume: 'volumen', title: 'antetítulo', text: 'texto', sub: 'línea de apoyo', actions: 'acciones', css: 'CSS', ttsEnabled: 'voz', ttsTemplate: 'voz', durationMs: 'duración', accentColor: 'color', textColor: 'color', cardX: 'posición', cardY: 'posición', textDelayMs: 'retraso' };
function replaceTarget(s: any, t: Target, value: any) {
  const cfg = { ...s.config };
  const mapList = (list: any[], id: string) => list.map(x => (x.id === id ? value : x));
  if (t.kind === 'alert') cfg.alerts = { ...cfg.alerts, [t.type]: value };
  if (t.kind === 'variation') { const a = cfg.alerts[t.type]; cfg.alerts = { ...cfg.alerts, [t.type]: { ...a, variations: mapList(a.variations || [], t.id) } }; }
  if (t.kind === 'command') cfg.commands = mapList(cfg.commands || [], t.id);
  if (t.kind === 'timer') cfg.timers = mapList(cfg.timers || [], t.id);
  return { config: cfg };
}

/** Guardado MANUAL (v2): los cambios quedan en borrador hasta «Guardar»; la vista previa enseña el borrador. */
function useEditor(t: Target) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const active = useRef(true);
  const autoPreview = useRef(true);
  // Editors are keyed by entity. Jobs keep that captured entity, never a mutable tRef.
  const [buffer] = useState(() => {
    const overlay = (state: AppState, patch: Record<string, unknown>) => {
      let next = state;
      for (const [field, value] of Object.entries(patch)) next = { ...next, ...applyLocal(next, t, field, value) };
      return next;
    };
    return new ManualDraft<Record<string, unknown>, AlertConfig | AlertVariation | CommandConfig | TimerConfig>({
      empty: () => ({}), merge: (older, newer) => ({ ...older, ...newer }),
      take: () => findTarget(live.state, t),
      keys: patch => Object.keys(patch).map(fieldTab),
      persist: async patch => {
        if (t.kind === 'alert') return (await put<{ config: AlertConfig }>(`/api/alerts/${t.type}`, patch)).config;
        if (t.kind === 'variation') {
          const { name, enabled, conditions, ...overrides } = patch;
          return (await put<{ variation: AlertVariation }>(`/api/alerts/${t.type}/variations/${enc(t.id)}`, { name, enabled, conditions, overrides: Object.keys(overrides).length ? overrides : undefined })).variation;
        }
        if (t.kind === 'command') return (await put<{ command: CommandConfig }>(`/api/commands/${enc(t.id)}`, patch)).command;
        const result = await put<{ timer: TimerConfig; warnings?: { message: string }[] }>(`/api/timers/${enc(t.id)}`, patch);
        if (active.current) live.update(s => ({ timers: (s.timers || []).map(x => x.id === t.id ? { ...x, ...result.timer, runtime: { ...x.runtime, warnings: result.warnings || [] } } : x) }));
        return result.timer;
      },
      publish: (saved, newer) => live.update(s => ({ config: overlay({ ...s, ...replaceTarget(s, t, saved) }, newer).config })),
      restore: saved => live.update(s => replaceTarget(s, t, saved)),
      protect: overlay,
    });
  });
  const preview = async () => {
    const cfg = editorCfg(live.state, t);
    if (!active.current || (t.kind === 'timer' && !cfg.showAlert) || (t.kind === 'command' && cfg.outputMode === 'chat')) return;
    // el CSS común también va como está en pantalla (se edita en la pestaña CSS con guardado manual)
    await post('/api/test', { ...testBody(t, 'preview'), draft: buffer.dirty() ? findTarget(live.state, t) : undefined, globalCss: live.state?.config.overlay?.css ?? '' });
  };
  const queuePreview = (ms: number) => { clearTimeout(timer.current); timer.current = setTimeout(guard(preview), ms); };
  const discard = () => {
    if (isSaving()) return;
    clearTimeout(timer.current); buffer.discard();
    if (autoPreview.current) guard(preview)();
  };
  const set = (field: string, value: unknown) => {
    buffer.push({ [field]: value });
    live.update(s => applyLocal(s, t, field, value));
    if (autoPreview.current) queuePreview(450);
  };
  const setCond = (key: string, value: unknown) => {
    const conditions = buffer.changes().conditions;
    set('conditions', { ...(conditions && typeof conditions === 'object' ? conditions : {}), [key]: value });
  };
  useEffect(() => {
    const unregister = registerDraft('editor:' + JSON.stringify(t), {
      dirty: buffer.dirty, keys: buffer.keys, protect: buffer.protect,
      prepareSave: () => { clearTimeout(timer.current); return buffer.prepareSave(); }, discard,
    });
    return () => { active.current = false; clearTimeout(timer.current); unregister(); buffer.dispose(); };
  }, [buffer]);
  const flush = () => { clearTimeout(timer.current); return buffer.save(); };
  return { set, setCond, flush, preview, queuePreview, discard, autoPreview, dirtyTabs: () => new Set(buffer.keys()) };
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
    {k === 'chat' && <SegField label="Dónde" value={act.destination || 'twitch'} options={DESTINATIONS} onChange={v => upd('destination', v)} />}
    {inp('delaySec', 'Retardo (s)', 'number', { min: 0, step: 0.5 })}
  </div>;
}
export function ActionsEditor({ list, onChange }: { list: any[]; onChange: (l: any[]) => void }) {
  const repl = (i: number, a: any) => { const l = [...list]; l[i] = a; onChange(l); };
  return <div className="actions-list">
    {list.map((act, i) => <div className="action" key={i}>
      <select value={act.kind} onChange={e => repl(i, { kind: e.target.value, delaySec: act.delaySec })} aria-label="Qué hace">{Object.entries(ACTIONS).map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select>
      <ActionFields act={act} uid={'a' + i} onChange={a => repl(i, a)} />
      <IconBtn icon={IC.x} label="Quitar acción" onClick={() => { const l = [...list]; l.splice(i, 1); onChange(l); }} />
    </div>)}
  </div>;
}

// ---------- editor ----------
export function Editor({ target }: { target: Target }) {
  const s = useLive(x => x);
  useManualSave();
  useDraftVersion();
  const ed = useEditor(target);
  const up = useUploader();
  const [cssTab, setCssTab] = useState<'own' | 'global'>('own');
  const [tab, setTab] = useState('');
  const [fireMsg, setFireMsg] = useState<{ text: string; err: boolean } | null>(null);
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const cssRef = useRef<HTMLTextAreaElement>(null);
  const gcssRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useCallback((el: HTMLIFrameElement | null) => {
    if (el) el.onload = async () => {
      const doc = el.contentDocument;
      const frame = el.contentWindow as (Window & { antenaPreviewReady?: Promise<void> }) | null;
      await frame?.antenaPreviewReady;
      if (el.isConnected && el.contentDocument === doc) ed.queuePreview(300);
    };
  }, []);
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
  const isMixed = a.layout === 'mixed';
  const isVideo = (isMedia || isMixed) && mediaKind === 'video';
  const showAlert = kind === 'timer' ? !!a.showAlert : kind !== 'command' || a.outputMode !== 'chat';
  const when = { card: !isMedia && !isMixed, media: isMedia, mixed: isMixed, bg: isMedia || isMixed, video: isVideo, fixed: !isVideo || a.durationMode !== 'media' };
  const mediaThumb = a.media && mediaKind === 'image' ? <img src={`/media/${enc(a.media)}`} alt="" /> : a.media && mediaKind === 'video' ? <video src={`/media/${enc(a.media)}`} muted preload="metadata" /> : <Icon d={IC.camera} className="eg-icon eg-icon--lg" />;
  const pickLayout = (l: string) => { set('layout', l); if (l !== 'card' && mediaKind === 'video' && a.layout === 'card') set('durationMode', 'media'); };

  const set = ed.set;
  const unset = (f: string) => kind === 'variation' && f in overrides ? <button className="unset" title="Volver a heredar de la alerta" onClick={(e) => { e.preventDefault(); set(f, null); }}>↺</button> : null;
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
  const saveGlobalCss = (css: string) => { live.patchConfig({ overlay: { css } }); if (ed.autoPreview.current) ed.queuePreview(500); };
  const onUpload = (f: 'sound' | 'media') => guard(async (e: any) => {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    const d = await up.run(files as File[]);
    if (!d) return;
    set(f, d.name);
    if (f === 'media') { if (live.state && editorCfg(live.state, target).layout !== 'mixed') set('layout', 'media'); if ((live.state?.media || []).find(m => m.name === d.name)?.kind === 'video') set('durationMode', 'media'); }
  });

  // ---------- slide: cabecera y pie (guardado manual) ----------
  const listHref = kind === 'command' ? '#/comandos' : kind === 'timer' ? '#/mensajes' : '#/alertas';
  const back = kind === 'variation' ? `#/alertas/${type}` : listHref;
  const testLive = guard(async () => {
    const d = await post<{ overlays?: number }>('/api/test', { ...testBody(target, 'live') });
    toast(d.overlays ? 'Enviada al directo (lo guardado)' : 'Enviada, pero no hay ningún overlay abierto en Meld');
  });
  const pf = t.platform === 'youtube' ? 'YouTube' : t.platform === 'twitch' ? 'Twitch' : '';
  const crumb = kind === 'alert' ? <><a href="#/alertas">Alertas</a> › {pf}</>
    : kind === 'variation' ? <><a href="#/alertas">Alertas</a> › <a href={`#/alertas/${type}`}>{t.label}</a> › Variación</>
    : kind === 'timer' ? <><a href="#/mensajes">Mensajes programados</a> › Mensaje</> : <><a href="#/comandos">Comandos de chat</a> › Comando</>;
  const title = kind === 'alert' ? t.label
    : kind === 'variation' ? <input className="title-input" value={v.name} aria-label="Nombre de la variación" onChange={e => set('name', e.target.value)} />
    : kind === 'timer' ? <input className="title-input" value={item.name} aria-label="Nombre del mensaje" onChange={e => set('name', e.target.value)} />
    : <input className="title-input" value={item.trigger} aria-label="Disparador" onChange={e => set('trigger', e.target.value.trim())} />;
  const headSwitch = <Switch checked={kind === 'alert' ? !!a.enabled : (kind === 'variation' ? v.enabled !== false : item.enabled !== false)} onChange={x => set('enabled', x)}>{kind === 'alert' ? 'Activada' : kind === 'variation' ? 'Activa' : 'Activo'}</Switch>;
  const headLeft = kind === 'alert' ? <button className="eg-btn eg-btn--ghost eg-btn--sm" disabled={isSaving()} onClick={guard(async () => {
      if (isSaving() || !confirm('¿Restaurar esta alerta a sus valores de serie? Se borran también sus variaciones.')) return;
      ed.discard(); const d = await post<{ config: Config }>(`/api/alerts/${type}/reset`); live.update(() => ({ config: d.config }));
    }, 'Alerta restaurada')}>Restaurar de serie…</button>
    : kind === 'variation' ? <button className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={guard(async () => {
      if (isSaving() || !confirmDelete(v.name, 'esta variación')) return;
      ed.discard(); const d = await del<{ variations: AlertVariation[] }>(`/api/alerts/${type}/variations/${enc(v.id)}`);
      live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: d.variations } } } }));
      go(`#/alertas/${type}`);
    })}>Borrar variación…</button>
    : kind === 'timer' ? <button className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={guard(async () => { if (isSaving() || !confirmDelete(item.name, 'este mensaje programado')) return; ed.discard(); const d = await del<{ timers: TimerConfig[] }>(`/api/timers/${enc(item.id)}`); live.update(st => ({ config: { ...st.config, timers: d.timers } })); go('#/mensajes'); })}>Borrar mensaje…</button>
    : <button className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={guard(async () => { if (isSaving() || !confirmDelete(item.trigger, 'este comando')) return; ed.discard(); const d = await del<{ commands: CommandConfig[] }>(`/api/commands/${enc(item.id)}`); live.update(st => ({ config: { ...st.config, commands: d.commands } })); go('#/comandos'); })}>Borrar comando…</button>;
  const headRight = kind === 'timer'
    ? <button className="eg-btn eg-btn--primary eg-btn--sm" title="Envía lo guardado" onClick={guard(async () => { await fireTimer(item.id, (text, err) => setFireMsg({ text, err: !!err })); })}>Enviar ahora</button>
    : !showAlert ? null : <button className="eg-btn eg-btn--primary eg-btn--sm" title="Prueba lo guardado en Meld" onClick={testLive}><Icon d={IC.play} className="eg-btn__icon" />Probar en el directo</button>;

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
  const dirtyTabs = ed.dirtyTabs();
  const tabDefs: TabDef[] = tabs.map(([k, l]) => ({ id: k, label: l, dirty: dirtyTabs.has(k) }));
  // todas las pestañas quedan montadas (solo se ocultan): el formulario no pierde lo escrito al cambiar
  const pane = (k: string, children: ReactNode) => <div role="tabpanel" id={`tp-${k}`} aria-labelledby={`tb-${k}`} hidden={cur !== k} className="tabpane">{children}</div>;
  const box = (title: ReactNode, children: ReactNode, aside?: ReactNode) => <section className="subbox"><div className="subbox-h"><span>{title}</span>{aside}</div>{children}</section>;
  return <Slide crumb={crumb} title={title} back={back} close={listHref} head={<div className="lv-shead-actions">{headSwitch}{headLeft}{headRight}</div>}
    tabs={tabDefs.length > 1 ? tabDefs : undefined} tab={cur} onTab={setTab}
    foot={<SaveBar />}>
    <div className={cx('editor', !showAlert && 'solo')}>
      <div className="form-col">
        {kind === 'alert' && VIEWER_TYPES[type] && pane('rec', <RecordPane type={type} />)}
        {kind === 'variation' && pane('when', <>
          <p className="hint">Sale esta variación en vez de la alerta normal cuando se cumple todo lo que rellenes. Si varias encajan, gana la primera de la lista.</p>
          <div className="row2">
            {amountType && <><label>Cantidad mínima <input type="number" value={c.minAmount ?? ''} placeholder="sin mínimo" onChange={e => ed.setCond('minAmount', e.target.value)} /></label>
              <label>Cantidad máxima <input type="number" value={c.maxAmount ?? ''} placeholder="sin máximo" onChange={e => ed.setCond('maxAmount', e.target.value)} /></label></>}
            {TIER_TYPES.includes(type) && <SegField label="Tier" value={String(c.tier ?? '')} options={TIER_OPTIONS} onChange={v => ed.setCond('tier', v)} />}
            <label>Solo para estos usuarios <input value={c.users ?? ''} placeholder="nombre1, nombre2" onChange={e => ed.setCond('users', e.target.value)} /></label>
            <label>Si el mensaje contiene <input value={c.messageContains ?? ''} placeholder="palabra, otra" onChange={e => ed.setCond('messageContains', e.target.value)} /></label>
            <label>Probabilidad <span className="val">{c.chance} %</span><input type="range" min={1} max={100} value={c.chance} style={{ ['--v' as any]: c.chance + '%' }} onChange={e => ed.setCond('chance', Number(e.target.value))} /></label>
          </div>
          <p className="hint">Una variación solo guarda lo que cambia; lo marcado con <b style={{ color: 'var(--red)' }}>●</b> pisa a la alerta y ↺ lo devuelve a lo heredado.</p>
        </>)}

        {kind === 'command' && pane('cmd', <>
          <label>Modo de salida <select aria-label="Modo de salida" value={item.outputMode || 'alert'} onChange={e => set('outputMode', e.target.value)}><option value="alert">Alerta en pantalla</option><option value="chat">Solo chat</option></select></label>
          {!showAlert && <><label data-field="chatReply">Respuesta en el chat <textarea value={item.chatReply || ''} onChange={e => set('chatReply', e.target.value)} /></label>
            <p className="hint">Responde en la plataforma de origen, sin alerta ni vista previa. Las acciones de alerta se conservan, pero no se ejecutan. Si la respuesta está vacía, no se envía nada. En pausa espera hasta reanudar. El simulador puede enviar la respuesta al chat real si estás conectado.</p></>}
          <div className="row2">
            <label>Quién puede usarlo <select value={item.permission} onChange={e => set('permission', e.target.value)}>{PERMS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></label>
            <div className="lbl">Plataformas<div className="row field-ctl">
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
            <SegField label="Dónde se publica" value={item.destination || 'twitch'} options={DESTINATIONS} onChange={v => set('destination', v)} />
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
              <div className="tiles2 tiles3" role="radiogroup" aria-label="Tipo de alerta">
                <button type="button" role="radio" className="eg-tile" aria-pressed={when.card} aria-checked={when.card} onClick={() => pickLayout('card')}>
                  <span className="eg-tile__thumb"><span className="tile-card">Tarjeta 3D</span></span>
                  <span className="eg-tile__name">Tarjeta 3D EGDEV</span><span className="eg-tile__meta">De serie, con brillo y giro</span></button>
                <button type="button" role="radio" className="eg-tile" aria-pressed={isMedia} aria-checked={isMedia} onClick={() => pickLayout('media')}>
                  <span className="eg-tile__thumb">{mediaThumb}</span>
                  <span className="eg-tile__name">Mi vídeo o imagen</span><span className="eg-tile__meta">Con el texto encima</span></button>
                <button type="button" role="radio" className="eg-tile" aria-pressed={isMixed} aria-checked={isMixed} onClick={() => pickLayout('mixed')}>
                  <span className="eg-tile__thumb tile-mixed">{mediaThumb}<span className="tile-card">Tarjeta</span></span>
                  <span className="eg-tile__name">Vídeo + tarjeta</span><span className="eg-tile__meta">Fondo propio y la tarjeta encima</span></button>
              </div>
            </div>
            {when.bg && <>
              <div className={cx('lbl', kind === 'variation' && 'media' in overrides && 'ovr')} data-field="media">{isMixed ? 'Fondo (vídeo o imagen)' : mediaKind === 'image' ? 'Imagen' : 'Vídeo o imagen'}{unset('media')}
                <div className="picker">
                  <select value={a.media || ''} onChange={e => set('media', e.target.value)}><option value="">— Elige un vídeo o una imagen —</option>{visuals.map((m: any) => <option key={m.name} value={m.name}>{m.name}</option>)}</select>
                  <label className="eg-btn eg-btn--ghost eg-btn--sm upload">Subir<input type="file" accept="video/*,image/*" hidden onChange={onUpload('media')} /></label>
                </div>
                <span className="hint">Se guarda en la carpeta media/ de la app.</span>
              </div>
              {isMixed && !a.media && <p className="hint err-inline">Elige un vídeo o una imagen: sin fondo, la alerta sale solo con la tarjeta.</p>}
              <div className="row2">{R('mediaSize', isMixed ? 'Tamaño del fondo (100 % = pantalla completa)' : 'Tamaño', 10, 200, 1, '%')}{when.video && R('mediaVolume', 'Volumen del vídeo', 0, 100, 1, '%')}</div>
            </>}
            {when.video && <div className="lbl">Duración<div className="field-ctl"><Seg value={a.durationMode} onChange={x => set('durationMode', x)} options={[['media', 'Lo que dure el vídeo'], ['fixed', 'Tiempo fijo']]} /></div></div>}
            <div className="row2">
              {when.fixed && R('durationMs', 'Duración', 1, 30, 0.5, 's', true)}
              {when.media && F('animIn', 'Animación de entrada', <><select value={a.animIn} onChange={e => set('animIn', e.target.value)}>{ANIM_IN.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></>)}
              {when.media && F('animOut', 'Animación de salida', <><select value={a.animOut} onChange={e => set('animOut', e.target.value)}>{ANIM_OUT.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></>)}
              {when.media && R('textDelayMs', 'Retardo del texto', 0, 6, 0.1, 's', true)}
              {when.mixed && R('textDelayMs', 'Retraso de la tarjeta', 0, 6, 0.1, 's', true)}
            </div>
            {when.card && <p className="hint">La tarjeta 3D de la marca: icono, antetítulo, nombre y línea de apoyo. Cambia su aspecto en la pestaña CSS.</p>}
            {when.mixed && box('Posición de la tarjeta', <>
              <div className="row2">{R('cardX', 'Ajuste horizontal', -900, 900, 10, 'px')}{R('cardY', 'Ajuste vertical', -500, 500, 10, 'px')}</div>
              <p className="hint">Parte de la posición del tema (Apariencia › Forma y posición) y la mueve sobre el fondo. 0/0 = donde sale la tarjeta normal. El fondo ocupa toda la capa de 1920×1080: un webm con transparencia deja ver la escena.</p>
            </>)}
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
            <div className="row middle">
              <p className="hint grow">Se ejecutan cuando la alerta aparece en pantalla: cambiar de escena en Meld, mostrar una capa, lanzar confeti, escribir en el chat…{s.status.meld?.state !== 'conectado' && <> <b>Meld no está conectado</b>: puedes prepararlas igualmente.</>}</p>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => set('actions', [...structuredClone(a.actions || []), { kind: 'layer', scene: '', layer: '', seconds: 8, delaySec: 0 }])}><Icon d={IC.plus} className="eg-btn__icon" />Añadir acción</button>
            </div>
            <ActionsEditor list={a.actions || []} onChange={l => set('actions', l)} />
            {kind === 'variation' && 'actions' in overrides && <p className="hint">Las acciones de una variación sustituyen a las de la alerta. {unset('actions')}</p>}
          </>)}

          {kind === 'alert' && pane('vars', <>
            <ListPanel title="Variaciones" note="Solo guardan lo que cambia (otro vídeo, sonido o texto) según la cantidad, el tier, el usuario o el mensaje. Gana la primera que encaja."
              tools={<button type="button" className="eg-btn eg-btn--secondary eg-btn--sm push" disabled={isSaving()} onClick={guard(async () => {
                if (!confirmLeave()) return;
                const d = await post<{ variation: AlertVariation }>(`/api/alerts/${type}/variations`, { name: `Variación ${(a.variations?.length || 0) + 1}`, conditions: AMOUNT_TYPES.includes(type) ? { minAmount: 100 } : {} });
                live.update(st => {
                  const alert = st.config.alerts[type], variations = alert.variations || [];
                  // SSE may already contain this ID (and edits newer than the held
                  // POST response). Keep that object; append only when HTTP wins.
                  if (variations.some(v => v.id === d.variation.id)) return {};
                  return { config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...alert, variations: [...variations, d.variation] } } } };
                });
                go(`#/alertas/${type}/v/${d.variation.id}`);
              })}><Icon d={IC.plus} className="eg-btn__icon" />Nueva variación</button>}
              cols={[{ key: 'name', label: 'Variación' }, { key: 'changes', label: 'Cambia' }, { key: 'on', label: 'Activa' }, { key: 'order', label: 'Orden', hide: true }, { key: 'test', label: '' }]}
              empty="Sin variaciones."
              rows={(a.variations || []).map((x: any, i: number, arr: any[]) => ({
                id: x.id, href: `#/alertas/${type}/v/${x.id}`, cls: x.enabled === false ? 'is-off' : undefined,
                cells: {
                  name: <NameCell href={`#/alertas/${type}/v/${x.id}`} name={x.name} sub={condSummary(x.conditions)} />,
                  changes: <Tags items={Object.keys(x.overrides || {}).slice(0, 4).map(k => ({ t: FIELD_LABEL[k] || k, on: true }))} />,
                  on: <label className="switch" aria-label={`${x.name} activa`}><input type="checkbox" checked={x.enabled !== false} disabled={isSaving()} onChange={guard(async e => {
                    if (isSaving()) return;
                    const d = await put<{ variation: AlertVariation }>(`/api/alerts/${type}/variations/${enc(x.id)}`, { enabled: e.target.checked });
                    live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: (st.config.alerts[type]?.variations || []).map((z: any) => (z.id === x.id ? d.variation : z)) } } } }));
                  })} /><i></i></label>,
                  order: <span className="row tight">{[-1, 1].map(dir => <IconBtn key={dir} icon={dir < 0 ? IC.up : IC.down} label={dir < 0 ? 'Subir' : 'Bajar'} disabled={isSaving() || (dir < 0 ? i === 0 : i === arr.length - 1)} onClick={guard(async () => {
                    if (isSaving()) return;
                    const ids = arr.map(z => z.id); const j = i + dir; [ids[i], ids[j]] = [ids[j], ids[i]];
                    const d = await post<{ variations: AlertVariation[] }>(`/api/alerts/${type}/variations-order`, { ids });
                    live.update(st => ({ config: { ...st.config, alerts: { ...st.config.alerts, [type]: { ...st.config.alerts[type], variations: d.variations } } } }));
                  })} />)}</span>,
                  test: <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" title={`Probar ${x.name} en la vista previa`} onClick={guard(() => post('/api/test', { type, variationId: x.id, target: 'preview' }))}><Icon d={IC.play} className="eg-btn__icon" />Probar</button>,
                },
              }))} />
            <p className="hint">Activar, ordenar y crear variaciones se aplica al momento. Lo de dentro de cada una se guarda con su botón Guardar.</p>
          </>)}

          {pane('css', <>
            <div className="row middle"><Seg value={cssTab} onChange={setCssTab} options={[['own', kind === 'variation' ? 'Esta variación' : kind === 'alert' ? 'Esta alerta' : 'Este'], ['global', 'Todas las alertas']]} /><span className="hint">· gana siempre a los estilos de serie</span></div>
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
          <figcaption className="eg-stage__bar"><span className="eg-eyebrow">Vista previa · 1920×1080</span><span className="eg-stage__spacer" />
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
  </Slide>;
}
