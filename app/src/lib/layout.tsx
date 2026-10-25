// Jerarquía v2 (lienzo «antena — Rediseño» › v2): cabecera de página, indicadores, listado en tabla,
// slide a todo el ancho con pestañas y barra de guardado manual. Mismo patrón que Vigía v4.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx, EmptyState, guard, Icon } from './ui';
import { IC } from './icons';
import { dirtyKeys, discardAll, isDirty, isSaving, saveAll, useDraftVersion } from './draft';
import { go } from '../panel/router';

// ---------- cabecera de página ----------
export type TabDef = { id: string; label: ReactNode; count?: number | string; dirty?: boolean; warn?: boolean; locked?: boolean };
export function Tabs({ tabs, tab, onTab, label, className }: { tabs: TabDef[]; tab: string; onTab: (id: string) => void; label: string; className?: string }) {
  return <div className={cx('lv-tabs', className)} role="tablist" aria-label={label}>
    {tabs.map(t => <button key={t.id} type="button" role="tab" className="lv-tab" aria-selected={tab === t.id} disabled={t.locked} onClick={() => onTab(t.id)}>
      {t.label}{t.count !== undefined && t.count !== 0 && t.count !== '' ? <span className="c">{t.count}</span> : null}
      {t.warn ? <span className="w" aria-label="tiene un aviso" /> : null}
      {t.dirty ? <span className="d" aria-label="cambios sin guardar" /> : null}
    </button>)}
  </div>;
}
/** Cabecera de una página: antetítulo, título, acción principal y, si hay, pestañas de página. */
export function PageHead({ crumb, title, desc, actions, tabs, tab, onTab, tour }: { crumb: ReactNode; title: ReactNode; desc?: ReactNode; actions?: ReactNode; tabs?: TabDef[]; tab?: string; onTab?: (id: string) => void; tour?: string }) {
  return <header className={cx('view-head lv-head', tabs && 'has-tabs')} data-tour={tour}>
    <div><span className="crumb">{crumb}</span><h1>{title}</h1>{desc ? <p className="hint">{desc}</p> : null}</div>
    {actions ? <div className="actions">{actions}</div> : null}
    {tabs && tab !== undefined && onTab ? <Tabs tabs={tabs} tab={tab} onTab={onTab} label="Partes de la página" className="lv-pagetabs" /> : null}
  </header>;
}
/** Pestañas de página guardadas en la dirección (#/pagina/pestaña), para enlazarlas y volver. */
export function usePageTab(parts: string[], base: string, ids: string[]) {
  const tab = ids.includes(parts[1]) ? parts[1] : ids[0];
  return [tab, (id: string) => go(`#/${base}/${id}`)] as const;
}

// ---------- indicadores ----------
export type Kpi = { value: ReactNode; label: ReactNode; warn?: boolean };
export function Kpis({ items }: { items: Kpi[] }) {
  return <div className="lv-kpis">{items.map((k, i) => <div key={i} className={cx('lv-kpi', k.warn && 'is-warn')}><b>{k.value}</b><span>{k.label}</span></div>)}</div>;
}

// ---------- listado ----------
export type Col = { key: string; label: string; hide?: boolean; className?: string };
export type Row = { id: string; href?: string; cells: Record<string, ReactNode>; cls?: string; open?: boolean };
export function ListPanel({ title, note, search, onSearch, placeholder = 'Buscar', chips, chip, onChip, cols, rows, empty, foot, tools, flush, tour }: {
  title: ReactNode; note?: ReactNode; search?: string; onSearch?: (v: string) => void; placeholder?: string;
  chips?: [string, ReactNode][]; chip?: string; onChip?: (id: string) => void; cols: Col[]; rows: Row[]; empty: ReactNode; foot?: ReactNode; tools?: ReactNode; flush?: boolean; tour?: string;
}) {
  const id = 'lv-' + String(typeof title === 'string' ? title : 'lista').toLowerCase().replace(/\W+/g, '-');
  return <section className="lv-panel" aria-labelledby={id} data-tour={tour}>
    <div className="lv-panel-h"><h2 id={id}>{title}</h2>{note ? <p>{note}</p> : null}</div>
    {(onSearch || chips || tools) && <div className="lv-tools">
      {onSearch && <label className="lv-search"><span className="sr-only">{placeholder}</span><input type="search" value={search || ''} placeholder={placeholder} onChange={e => onSearch(e.target.value)} /></label>}
      {chips && <div className="lv-chips" role="group" aria-label="Filtrar">{chips.map(([k, l]) => <button key={k} type="button" className="eg-chip" aria-pressed={chip === k} onClick={() => onChip?.(k)}>{l}</button>)}</div>}
      {tools}
    </div>}
    <div className={cx('lv-scroll', flush && 'flush')}>
      <table className="lv-list">
        <thead><tr>{cols.map(c => <th key={c.key} scope="col" className={cx(c.hide && 'lv-hide', c.className)}>{c.label}</th>)}<th scope="col" className="lv-chev"><span className="sr-only">Abrir</span></th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className={cx(r.cls, r.open && 'is-open', r.href && 'is-link')}
          onClick={r.href ? e => { if (!(e.target as HTMLElement).closest('a,button,input,select,label,textarea')) go(r.href!); } : undefined}>
          {cols.map(c => <td key={c.key} className={cx(c.hide && 'lv-hide', c.className)}>{r.cells[c.key]}</td>)}
          <td className="lv-chev" aria-hidden="true">{r.href ? '→' : ''}</td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <div className="lv-empty"><EmptyState>{empty}</EmptyState></div>}
    </div>
    {foot ? <p className="lv-foot">{foot}</p> : null}
  </section>;
}
/** Primera celda de una fila: nombre (enlace al slide) y subtítulo. */
export function NameCell({ href, name, sub, lead }: { href?: string; name: ReactNode; sub?: ReactNode; lead?: ReactNode }) {
  return <div className="lv-name">{lead}<span>{href ? <a className="lv-open" href={href}>{name}</a> : <b>{name}</b>}{sub ? <span className="lv-sub">{sub}</span> : null}</span></div>;
}
export function Dot({ tone, children }: { tone?: 'ok' | 'warn' | 'off' | 'live'; children: ReactNode }) {
  return <span className={cx('lv-dot', tone && 'is-' + tone)}>{children}</span>;
}
export function Tags({ items }: { items: { t: ReactNode; on?: boolean }[] }) {
  return <div className="lv-tags">{items.length ? items.map((x, i) => <span key={i} className={cx('lv-tag', x.on && 'is-on')}>{x.t}</span>) : <span className="lv-tag">—</span>}</div>;
}
/** Buscador + chips de un listado (estado local). */
export function useListFilter(def = 'all') {
  const [q, setQ] = useState('');
  const [chip, setChip] = useState(def);
  const match = (...texts: (string | undefined)[]) => !q.trim() || texts.some(t => (t || '').toLowerCase().includes(q.trim().toLowerCase()));
  return { q, setQ, chip, setChip, match };
}

// ---------- slide a todo el ancho ----------
export function Slide({ crumb, title, back, close, head, tabs, tab, onTab, children, foot, wide }: {
  crumb: ReactNode; title: ReactNode; back: string; close?: string; head?: ReactNode;
  tabs?: TabDef[]; tab?: string; onTab?: (id: string) => void; children: ReactNode; foot?: ReactNode; wide?: boolean;
}) {
  return <div className="lv-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Detalle'}
    onKeyDown={e => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,select')) go(close || back); }}>
    <a className="lv-scrim" href={close || back} aria-label="Cerrar" tabIndex={-1} />
    <div className={cx('lv-slide', wide && 'wide')}>
      <header className="lv-shead">
        <div className="lv-sbar">
          <div className="lv-stitle">
            <a className="eg-icon-btn" href={back} aria-label="Volver" title="Volver"><Icon d={IC.arrowLeft} /></a>
            <div><p className="lv-crumb">{crumb}</p><h2>{title}</h2></div>
          </div>
          {head}
          <a className="eg-icon-btn" href={close || back} aria-label="Cerrar" title="Cerrar"><Icon d={IC.x} /></a>
        </div>
        {tabs && tab !== undefined && onTab ? <Tabs tabs={tabs} tab={tab} onTab={onTab} label="Partes" className="lv-stabs" /> : null}
      </header>
      <div className="lv-sbody">{children}</div>
      {foot}
    </div>
  </div>;
}

// ---------- guardado manual ----------
/** Pie con «N cambios sin guardar · Descartar · Guardar». left/right: acciones de la pantalla. */
export function SaveBar({ left, right, saveLabel = 'Guardar', sticky = true }: { left?: ReactNode; right?: ReactNode; saveLabel?: string; sticky?: boolean }) {
  useDraftVersion();
  const dirty = isDirty();
  const saving = isSaving();
  const n = dirtyKeys().length;
  return <footer className={cx('lv-sfoot', sticky && 'sticky')}>
    {left}
    <span className="sp" />
    <span className={cx('lv-dirty', dirty && 'is-on')} role="status">{saving ? 'Guardando…' : dirty ? (n > 1 ? `${n} cambios sin guardar` : 'Cambios sin guardar') : 'Todo guardado'}</span>
    <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={saving || !dirty} onClick={() => discardAll()}>Descartar</button>
    <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={saving || !dirty} onClick={guard(saveAll, 'Guardado')}>{saveLabel}</button>
    {right}
  </footer>;
}
/** Sección dentro del cuerpo de un slide o de una pestaña. */
export function Box({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cx('lv-box', className)}>{(title || aside) && <div className="lv-box-h">{title ? <h3>{title}</h3> : null}{aside}</div>}{children}</section>;
}

// ---------- tarjetas (v3): catálogo de la app; lo que creas tú sigue en ListPanel ----------
/** Grupo de tarjetas con título, contador y una nota. La cuadrícula se rellena sola. */
export function CardGroup({ title, count, note, wide, children, tour }: { title: ReactNode; count?: number; note?: ReactNode; wide?: boolean; children: ReactNode; tour?: string }) {
  return <section className="lv-group" aria-label={typeof title === 'string' ? title : undefined} data-tour={tour}>
    <div className="lv-group-h"><h2>{title}</h2>{count !== undefined ? <span className="n">{count}</span> : null}{note ? <p>{note}</p> : null}</div>
    <div className={cx('lv-cards', wide && 'wide')}>{children}</div>
  </section>;
}
/** Tarjeta: toda ella enlaza a `href`; lo que va en `foot` (interruptores, botones) queda por encima. */
export function Card({ href, label, thumb, title, aside, children, foot, open, off, warn, className, onEnter, onLeave, tour }: {
  href?: string; label: string; thumb?: ReactNode; title: ReactNode; aside?: ReactNode; children?: ReactNode; foot?: ReactNode;
  open?: boolean; off?: boolean; warn?: boolean; className?: string; onEnter?: () => void; onLeave?: () => void; tour?: string;
}) {
  return <article className={cx('lv-card', open && 'is-open', off && 'is-off', warn && 'is-warn', className)} data-tour={tour} onMouseEnter={onEnter} onMouseLeave={onLeave} onFocus={onEnter} onBlur={onLeave}>
    {href ? <a className="lv-hit" href={href} aria-label={label} /> : null}
    {thumb ? <div className="lv-cthumb" aria-hidden="true">{thumb}</div> : null}
    <div className="lv-cbody">
      <div className="lv-ctitle"><span className="lv-cname">{title}</span>{aside}</div>
      {children}
      {foot ? <div className="lv-cfoot lv-up">{foot}</div> : null}
    </div>
  </article>;
}
/** Interruptor pequeño para el pie de una tarjeta (se aplica al momento). */
export function CardSwitch({ checked, onChange, label, on = 'Activa', off = 'Apagada' }: { checked: boolean; onChange: (v: boolean) => void; label: string; on?: string; off?: string }) {
  return <label className="lv-switch"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={label} /><span>{checked ? on : off}</span></label>;
}
const mmssShort = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
/** Primer fotograma real de un vídeo o una imagen; al pasar el ratón (o con foco), vista previa en bucle sin sonido. */
export function MediaPreview({ src, video, playing, label }: { src: string; video: boolean; playing: boolean; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    if (playing) { v.loop = true; v.play().catch(() => {}); }
    else { v.pause(); try { v.currentTime = 0.05; } catch { /* aún sin cargar */ } setPos(0); }
  }, [playing]);
  if (!video) return <img src={src} alt="" loading="lazy" />;
  return <>
    <video ref={ref} src={src + '#t=0.05'} muted playsInline preload="metadata"
      onLoadedMetadata={e => setDur((e.target as HTMLVideoElement).duration || 0)}
      onTimeUpdate={e => { const v = e.target as HTMLVideoElement; if (v.duration) setPos(v.currentTime / v.duration); }} />
    <span className="badge">{playing ? 'vista previa · sin sonido' : `${label || 'vídeo'}${dur ? ' · ' + mmssShort(dur) : ''}`}</span>
    {playing ? <span className="prog"><i style={{ width: pos * 100 + '%' }} /></span> : null}
  </>;
}
