// Piezas comunes del panel con las clases de EGDEV Foundation que ya usa panel.css.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LOGOS } from '../../../public/platform-icons.js';
import { IC } from './icons';

// ---------- avisos ----------
let toastMsg = { text: '', err: false, n: 0 };
const toastSubs = new Set<() => void>();
let toastTimer: any;
export function toast(text: string, err = false) {
  toastMsg = { text, err, n: toastMsg.n + 1 };
  toastSubs.forEach(f => f());
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg = { ...toastMsg, text: '' }; toastSubs.forEach(f => f()); }, err ? 4200 : 2600);
}
export function Toaster({ className = 'toast' }: { className?: string }) {
  const t = useSyncExternalStore(f => { toastSubs.add(f); return () => { toastSubs.delete(f); }; }, () => toastMsg);
  return <div className={`${className}${t.text ? ' on' : ''}${t.err ? ' err' : ''}`} role="status" aria-live="polite">{t.text}</div>;
}
/** Envuelve una acción: si falla, el error sale como aviso. */
export const guard = <A extends any[]>(fn: (...a: A) => any, ok?: string) => async (...a: A) => {
  try { const r = await fn(...a); if (ok) toast(ok); return r; } catch (e: any) { toast(e?.message || String(e), true); }
};
/** Confirmación nativa de borrado con la misma redacción en todo el panel: «¿Borrar «nombre»?» o, sin nombre, «¿Borrar este …?». */
export const confirmDelete = (name: string | null | undefined, fallback: string) => confirm(name?.trim() ? `¿Borrar «${name.trim()}»?` : `¿Borrar ${fallback}?`);
export const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast(text));

// ---------- formato ----------
// Fecha y hora unificadas (#126): dd/MM/yyyy y HH:mm en 24 horas, sin dependencia
// de la configuración regional (app/src/lib/format.mjs). Los números siguen con es-ES.
export { fmtDate, fmtDateTime, fmtTime } from './format.mjs';
export const mmss = (s: number) => {
  s = Math.max(0, s | 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
};
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- iconos ----------
// Logos de plataforma a color: la misma definición que overlay y widgets (public/platform-icons.js).
export const PLATFORM_NAMES: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube' };
export function PfIcon({ platform, className = 'pf-ico' }: { platform?: string; className?: string }) {
  const logo = platform ? LOGOS[platform] : undefined;
  if (!logo) return null;
  return <svg className={className} viewBox={logo.viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label={PLATFORM_NAMES[platform!]}>
    {logo.paths.map(([fill, d], i) => <path key={i} fill={fill} d={d} />)}</svg>;
}
export function Icon({ d, className = 'eg-icon' }: { d: string; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />;
}

// ---------- controles ----------
/** Cabecera de una vista: miga (grupo › vista, o enlace a la vista padre), título, explicación opcional y acciones a la derecha. */
export function ViewHead({ crumb, title, hint, actions, tour }: { crumb: ReactNode; title: ReactNode; hint?: ReactNode; actions?: ReactNode; tour?: string }) {
  return <header className="view-head" data-tour={tour}><div><span className="crumb">{crumb}</span><h1>{title}</h1>{hint && <p className="hint">{hint}</p>}</div>{actions && <div className="actions">{actions}</div>}</header>;
}
export function Panel({ title, aside, children, className, tour }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; tour?: string }) {
  return <article className={cx('panel', className)} data-tour={tour}>{(title || aside) && <header>{title && <h2>{title}</h2>}{aside}</header>}{children}</article>;
}
export function Switch({ checked, onChange, children, title }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; title?: string }) {
  return <label className="switch" title={title}><input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} /><i></i>{children}</label>;
}
export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return <label className="check"><input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} /> {children}</label>;
}
/** Selector de un valor entre pocas opciones: aspecto de pestañas subrayadas (como el editor de
 *  alertas) y semántica de radio para que se anuncie como un ajuste, no como navegación. */
export function Seg<T extends string>({ value, options, onChange, wide, className, label }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; wide?: boolean; className?: string; label?: string }) {
  return <div className={cx('eg-tabs choice-tabs', wide && 'choice-tabs--wide', className)} role="radiogroup" aria-label={label}>
    {options.map(([v, l]) => <button type="button" key={v} role="radio" className="eg-tabs__item" aria-checked={v === value} aria-selected={v === value} onClick={() => onChange(v)}>{l}</button>)}
  </div>;
}
export function Range({ label, value, min, max, step = 1, unit = '', onChange, extra }: { label: ReactNode; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; extra?: ReactNode }) {
  const pct = ((Number(value) - min) / ((max - min) || 1)) * 100;
  return <label>{label}{extra} <span className="val">{value} {unit}</span>
    <input type="range" min={min} max={max} step={step} value={value} style={{ ['--v' as any]: pct + '%' }} onChange={e => onChange(Number(e.target.value))} /></label>;
}
export function Opt({ value, children }: { value: string | number; children: ReactNode }) { return <option value={value}>{children}</option>; }

export function CopyUrl({ url, children }: { url: string; children?: ReactNode }) {
  return <div className="overlay-url"><code>{url}</code><button className="eg-btn eg-btn--ghost eg-btn--sm" type="button" onClick={() => copy(url)}>Copiar</button>{children}</div>;
}

/** Estado vacío de una lista o sección (eg-post--empty, sin acción): el mismo aspecto en todo el panel.
 *  `action` (opcional) añade el CTA bajo el texto, centrado como el resto de la caja. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="eg-post eg-post--empty empty-state">{children}{action && <div className="mt-s">{action}</div>}</div>;
}

/** Pestañas de una sección con varios objetos: una por elemento y la última para crear uno nuevo.
 *  Mismo estilo subrayado que las pestañas del editor de alertas (eg-tabs sin modificadores). */
export function ItemTabs({ items, selected, onSelect, onNew, newLabel, label, tour }: { items: { id: string; label: ReactNode; badge?: ReactNode }[]; selected: string | null | undefined; onSelect: (id: string) => void; onNew: () => void; newLabel: ReactNode; label?: string; tour?: string }) {
  return <div className="eg-tabs list-tabs" role="tablist" aria-label={label} data-tour={tour}>
    {items.map(x => <button key={x.id} type="button" role="tab" className="eg-tabs__item" aria-selected={x.id === selected} onClick={() => onSelect(x.id)}>{x.label}{x.badge ? <span className="eg-tabs__count">{x.badge}</span> : null}</button>)}
    <button type="button" role="tab" className="eg-tabs__item" aria-selected={selected == null} onClick={onNew}>{newLabel}</button>
  </div>;
}

/** iframe escalado: muestra una capa de 1920×1080 (u otro tamaño) dentro del ancho disponible. */
export function ScaledFrame({ src, w = 1920, h = 1080, className = 'preview wprev', title = 'Vista previa', frameRef }: { src: string; w?: number; h?: number; className?: string; title?: string; frameRef?: (el: HTMLIFrameElement | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => setScale((box.current?.clientWidth || w) / w));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [w]);
  return <div className={className} ref={box} style={{ aspectRatio: `${w}/${h}` }}>
    <iframe ref={frameRef} src={src} title={title} style={{ width: w, height: h, transform: `scale(${scale})` }} />
  </div>;
}

/** Valor que se guarda con retardo mientras se escribe (para inputs que mandan peticiones). */
export function useDebounced<T>(fn: (v: T) => void, ms = 400) {
  const t = useRef<any>(null);
  const f = useRef(fn); f.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return (v: T) => { clearTimeout(t.current); t.current = setTimeout(() => f.current(v), ms); };
}

/** Input de texto con estado local que avisa con retardo (no se pisa mientras escribes). */
export function LazyInput({ value, onCommit, ms = 450, as = 'input', ...rest }: { value: any; onCommit: (v: string) => void; ms?: number; as?: 'input' | 'textarea'; [k: string]: any }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value ?? ''); }, [value]);
  const commit = useDebounced<string>(onCommit, ms);
  const props = {
    ...rest, value: v,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; },
    onChange: (e: any) => { setV(e.target.value); commit(e.target.value); },
  };
  return as === 'textarea' ? <textarea {...props} /> : <input {...props} />;
}

/** Tab escribe dos espacios en los editores de código. */
export function codeTab(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = e.currentTarget, s = ta.selectionStart;
  const v = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, v);
  ta.setSelectionRange(s + 2, s + 2);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- componentes del sistema (EGDEV Foundation) ----------
export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
/** StatusBadge: estado con icono. */
export function Status({ tone = 'neutral', icon, children, title }: { tone?: Tone; icon?: string | ReactNode; children: ReactNode; title?: string }) {
  return <span className={`eg-status eg-status--${tone}`} title={title}>{typeof icon === 'string' ? <Icon d={icon} /> : icon}{children}</span>;
}
/** Estados de conexión de la píldora: las tres superficies (panel, dock y prompter) muestran
 *  el mismo texto para el mismo hecho (#3): «Twitch · desconectado», «YouTube · desconectado»,
 *  «Meld · desconectado». YouTube descansa en 'parado' (src/youtube.mjs nunca usa
 *  'desconectado'): es el mismo hecho —no está leyendo el chat—, así que se muestra en la
 *  misma familia y solo cambia el matiz activo («leyendo el chat» cuando 'escuchando'). */
export type ConnPlatform = 'twitch' | 'youtube' | 'meld';
const CONN_PLATFORM_NAMES: Record<ConnPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', meld: 'Meld' };
/** Texto visible de un estado de conexión, en la misma familia en las tres superficies. */
export const connStateText = (state?: string) => !state ? 'sin conectar' : state === 'parado' ? 'desconectado' : state;
/** Tono por defecto de un estado de conexión. */
export const connStateTone = (state?: string): Tone =>
  state === 'conectado' || state === 'escuchando' ? 'success'
    : state === 'error' ? 'danger'
    : !state || state === 'desconectado' || state === 'parado' ? 'neutral'
    : 'warning'; // estados intermedios: conectando, reconectando, buscando directo, en espera…
/** Píldora de conexión: «<Plataforma> · <estado>». `label` sustituye al texto del estado
 *  (p. ej. «leyendo el chat») y `detail` añade un matiz al final (« · chat conectado»). */
export function ConnPill({ platform, state, label, tone, detail, title }: { platform: ConnPlatform; state?: string; label?: ReactNode; tone?: Tone; detail?: ReactNode; title?: string }) {
  const on = state === 'conectado' || state === 'escuchando';
  return <Status tone={tone ?? connStateTone(state)} icon={platform === 'meld' ? (on ? IC.check : IC.plug) : <PfIcon platform={platform} />} title={title}>
    {CONN_PLATFORM_NAMES[platform]} · {label ?? connStateText(state)}{detail ? <> · {detail}</> : null}
  </Status>;
}
/** ProgressBar (p entre 0 y 1). */
export function Progress({ p, lg, label, style }: { p: number; lg?: boolean; label: string; style?: React.CSSProperties }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
  return <span className={cx('eg-progress', lg && 'eg-progress--lg')} role="progressbar" aria-label={label} aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100} style={{ ['--p' as any]: v, ...style }}><span className="eg-progress__bar" /></span>;
}
/** Sección del lienzo: tarjeta con cabecera (título display y acciones), contenido y pie opcional (#127). */
export function Sec({ title, aside, children, foot, footRight, flat, className, id, tour }: { title: ReactNode; aside?: ReactNode; children?: ReactNode; foot?: ReactNode; footRight?: ReactNode; flat?: boolean; className?: string; id?: string; tour?: string }) {
  return <section className={cx('sec', flat && 'sec--flat', className)} aria-labelledby={id} data-tour={tour}>
    <div className="sec-h"><h2 id={id}>{title}</h2>{aside}</div>
    {children}
    {(foot || footRight) && <footer className="sec-foot"><span className="sec-foot__l">{foot}</span><span className="sec-foot__r">{footRight}</span></footer>}
  </section>;
}
/** IconButton con etiqueta accesible. */
export function IconBtn({ icon, label, onClick, disabled, pressed, className }: { icon: string; label: string; onClick?: () => void; disabled?: boolean; pressed?: boolean; className?: string }) {
  return <button type="button" className={cx('eg-icon-btn', className)} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon d={icon} /></button>;
}
/** Diálogo modal: Esc, el botón «Cerrar» y el fondo piden cerrar (onClose decide, p. ej. si hay
 *  cambios sin guardar); el foco entra al abrir y vuelve al botón que lo abrió al cerrar. */
export function Modal({ title, onClose, children, className }: { title: ReactNode; onClose: () => void; children?: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close.current(); }}>
    <div className={cx('modal panel', className)} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={box}>
      <header className="modal-head"><h2 id="modal-title">{title}</h2><IconBtn icon={IC.x} label="Cerrar" onClick={() => close.current()} /></header>
      {children}
    </div>
  </div>;
}
/** StageFrame con barra superior: una capa en vivo (iframe escalado) con su título y acciones. */
export function Stage({ eyebrow, aside, src, w = 1920, h = 1080, foot, frameRef }: { eyebrow: ReactNode; aside?: ReactNode; src: string; w?: number; h?: number; foot?: ReactNode; frameRef?: (el: HTMLIFrameElement | null) => void }) {
  return <figure className="eg-stage">
    <figcaption className="eg-stage__bar"><span className="eg-eyebrow">{eyebrow}</span><span className="eg-stage__spacer" />{aside}</figcaption>
    <ScaledFrame src={src} w={w} h={h} className="preview wprev" frameRef={frameRef} />
    {foot && <div className="eg-stage__bar">{foot}</div>}
  </figure>;
}
/** Una URL de fuente de navegador: dirección, tamaño y, si la página tiene varias, su nombre. */
export type SourceUrl = { url: string; size: string; label?: string };
/** Bloque «Fuente de navegador en Meld» (O3.3): siempre el primero de la columna izquierda de una página de widget. */
export function BrowserSource({ url, size, label, also = [], hint }: SourceUrl & { also?: SourceUrl[]; hint?: ReactNode }) {
  return <Sec title="Fuente de navegador en Meld" className="browser-source">
    {[{ url, size, label }, ...also].map(s => <CopyUrl key={s.url} url={s.url}><span className="hint">{s.label ? `${s.label} · ` : ''}{s.size}</span></CopyUrl>)}
    <p className="hint">{hint ?? 'En Meld: + › Browser. El CSS propio del widget gana a los estilos de serie.'}</p>
  </Sec>;
}
/** Esqueleto de una página de widget (O3.3): a la izquierda la fuente y la configuración, a la derecha la vista previa. */
export function WidgetLayout({ source, preview, children, className }: { source: ReactNode; preview: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cx('editor widget-layout', className)}>
    <div className="form-col">{source}{children}</div>
    <div className="preview-col">{preview}</div>
  </div>;
}
