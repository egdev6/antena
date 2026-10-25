// Registro (v2): directos anteriores y archivos de media/, como listado → slide.
import { useEffect, useState } from 'react';
import { enc, get, post } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { confirmDelete, copy, guard } from '../../lib/ui';
import { Box, Dot, Kpis, ListPanel, NameCell, PageHead, Slide, Tags, useListFilter } from '../../lib/layout';
import { go } from '../router';
import type { AppState, MediaItem } from '../../lib/types';
import { MediaThumb, UploadBar, useUploader } from './General';

const fmtDate = (d?: string | number) => (d ? new Date(d).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const dur = (a?: string | number, b?: string | number) => { if (!a || !b) return ''; const s = Math.max(0, Math.round((+new Date(b) - +new Date(a)) / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; };

// ---------- directos anteriores ----------
type Past = { id: string; title?: string; startedAt?: string | number; endedAt?: string | number; events?: number; pending?: boolean };
function DirectoSlide({ id, tab }: { id: string; tab: string }) {
  const s = useLive(x => x);
  const [d, setD] = useState<any>(null);
  const [md, setMd] = useState('');
  useEffect(() => { guard(async () => { setD(await get(`/api/session/summary?id=${enc(id)}&format=json`)); setMd((await get<{ markdown: string }>(`/api/session/summary?id=${enc(id)}`)).markdown); })(); }, [id]);
  const base = `#/directos/${enc(id)}`;
  const t0 = d?.startedAt ? +new Date(d.startedAt) : 0;
  const at = (x: string | number) => { const sec = Math.max(0, Math.round((+new Date(x) - t0) / 1000)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec % 60).padStart(2, '0'); };
  const markers = (d?.notes || []).filter((n: any) => n.kind === 'marker');
  const events = d?.events || [];
  const tabs = [{ id: 'resumen', label: 'Resumen' }, { id: 'cronologia', label: 'Cronología', count: events.length }, { id: 'marcas', label: 'Marcas', count: markers.length }, { id: 'exportar', label: 'Exportar' }];
  return <Slide crumb={<><a href="#/directos">Directos anteriores</a> › {fmtDate(d?.startedAt)}</>} title={d ? d.title || 'Sin título' : 'Cargando…'} back="#/directos" wide
    tabs={tabs} tab={tab} onTab={t => go(`${base}/${t}`)}
    foot={<footer className="lv-sfoot sticky"><span className="lv-dirty">Solo lectura: es un directo archivado.</span><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href={`/api/session/summary.md?id=${enc(id)}`} target="_blank" rel="noreferrer">Abrir resumen (.md)</a><button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={!md} onClick={() => copy(md)}>Copiar resumen</button></footer>}>
    {!d ? <p className="hint">Cargando…</p> : tab === 'resumen' ? <div className="lv-cols aside">
      <div className="lv-col">
        <Kpis items={Object.entries(s.metrics || {}).filter(([k]) => k !== 'events').slice(0, 4).map(([k, m]) => ({ value: (d.totals?.[k] ?? 0).toLocaleString('es-ES'), label: m.label }))} />
        <Box title="Gracias a">{(d.credits || []).length ? (d.credits as any[]).map(g => <p key={g.title}><b>{g.title}:</b> {g.names.join(', ')}</p>) : <p className="hint">Nadie apoyó en este directo.</p>}</Box>
      </div>
      <aside className="lv-col"><Box title="Datos"><p className="hint">Empezó: {fmtDate(d.startedAt)}<br />{d.endedAt ? <>Duración: {dur(d.startedAt, d.endedAt)}<br /></> : null}{events.length} eventos · {markers.length} marcas</p></Box></aside>
    </div> : tab === 'cronologia' ? <ListPanel title="Eventos" cols={[{ key: 'at', label: 'Minuto' }, { key: 'type', label: 'Tipo' }, { key: 'user', label: 'Quién' }, { key: 'sub', label: 'Detalle', hide: true }]}
      rows={events.map((e: any) => ({ id: e.id, cells: { at: <span className="lv-mono">{at(e.at || e.ts)}</span>, type: s.types?.[e.type]?.label || e.type, user: <b>{e.user || '—'}</b>, sub: e.sub || '' } }))} empty="Sin eventos." />
      : tab === 'marcas' ? <ListPanel title="Marcas para shorts" cols={[{ key: 'at', label: 'Minuto' }, { key: 'label', label: 'Marca' }]}
        rows={markers.map((n: any) => ({ id: n.id, cells: { at: <span className="lv-mono">{at(n.at)}</span>, label: n.label || 'Sin nombre' } }))} empty="No se marcó ningún momento." />
      : <Box title="Resumen en Markdown"><pre className="lv-pre">{md}</pre></Box>}
  </Slide>;
}
export function Directos({ parts }: { parts: string[] }) {
  const [past, setPast] = useState<Past[]>([]);
  const f = useListFilter();
  useEffect(() => { guard(async () => setPast((await get<{ past?: Past[] }>('/api/sessions')).past || []))(); }, []);
  const open = parts[1];
  const rows = past.filter(p => f.match(p.title, fmtDate(p.startedAt))).map(p => {
    const href = `#/directos/${enc(p.id)}`;
    return { id: p.id, href, open: open === p.id, cells: {
      name: <NameCell href={href} name={p.title || 'Sin título'} sub={fmtDate(p.startedAt)} />,
      state: p.pending ? <Dot tone="warn">Archivándose</Dot> : <Dot tone="off">Archivado</Dot>,
      dur: <span className="lv-mono">{dur(p.startedAt, p.endedAt) || '—'}</span>,
      events: <span className="lv-mono">{p.events ?? 0} eventos</span>,
    } };
  });
  const total = past.reduce((t, p) => t + (p.events || 0), 0);
  return <>
    <PageHead crumb={`Registro · ${past.length} ${past.length === 1 ? 'directo' : 'directos'}`} title="Directos anteriores"
      desc="Cada vez que empiezas un directo nuevo, el anterior se archiva aquí con su cronología, sus marcas y su resumen."
      actions={<a className="eg-btn eg-btn--ghost eg-btn--sm" href="#/general/directos">Cuántos se guardan</a>} />
    <Kpis items={[{ value: past.length, label: 'directos archivados' }, { value: total.toLocaleString('es-ES'), label: 'eventos en total' }, { value: past[0] ? fmtDate(past[0].startedAt) : '—', label: 'el último' }]} />
    <ListPanel title="Directos" search={f.q} onSearch={f.setQ} placeholder="Buscar por título o fecha"
      cols={[{ key: 'name', label: 'Directo' }, { key: 'state', label: 'Estado' }, { key: 'dur', label: 'Duración' }, { key: 'events', label: 'Eventos', hide: true }]}
      rows={rows} empty={past.length ? 'Ningún directo coincide.' : 'Todavía no hay directos archivados.'} />
    {open ? <DirectoSlide key={open} id={open} tab={['resumen', 'cronologia', 'marcas', 'exportar'].includes(parts[2]) ? parts[2] : 'resumen'} /> : null}
  </>;
}

// ---------- archivos ----------
function formatBytes(n?: number | null) {
  if (n === undefined || n === null || !(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['kB', 'MB', 'GB']; let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}
/** Dónde se usa cada archivo: alertas (y sus variaciones), comandos, mensajes y tema. */
export function mediaUses(s: AppState): Record<string, { t: string; href: string }[]> {
  const out: Record<string, { t: string; href: string }[]> = {};
  const add = (name: any, t: string, href: string) => { if (typeof name === 'string' && name && !['default', 'none'].includes(name)) (out[name] ||= []).push({ t, href }); };
  for (const [type, a] of Object.entries<any>(s.config.alerts || {})) {
    const label = s.types?.[type]?.label || type;
    add(a.media, label, `#/alertas/${type}`); add(a.sound, label, `#/alertas/${type}`);
    for (const v of a.variations || []) { add(v.overrides?.media, `${label} › ${v.name}`, `#/alertas/${type}/v/${v.id}`); add(v.overrides?.sound, `${label} › ${v.name}`, `#/alertas/${type}/v/${v.id}`); }
  }
  for (const c of s.config.commands || []) { add((c as any).media, c.trigger, `#/comandos/${enc(c.id)}`); add((c as any).sound, c.trigger, `#/comandos/${enc(c.id)}`); }
  for (const t of s.config.timers || []) { add((t as any).media, t.name, `#/mensajes/${enc(t.id)}`); add((t as any).sound, t.name, `#/mensajes/${enc(t.id)}`); }
  const th = (s as any).theme || {};
  for (const k of ['font', 'fontFile', 'headFont', 'bodyFont']) add(th[k], 'Tema', '#/apariencia');
  return out;
}
const KIND: Record<string, string> = { video: 'Vídeo', image: 'Imagen', audio: 'Sonido', font: 'Fuente' };
export function Archivos({ parts }: { parts: string[] }) {
  const s = useLive(x => x);
  const media: MediaItem[] = s.media || [];
  const f = useListFilter();
  const up = useUploader();
  const uses = mediaUses(s);
  const open = parts[1];
  const rows = media.filter(m => f.chip === 'all' || (f.chip === 'unused' ? !uses[m.name] : m.kind === f.chip)).filter(m => f.match(m.name)).map(m => {
    const href = `#/archivos/${enc(m.name)}`;
    const u = uses[m.name] || [];
    return { id: m.name, href, open: open === m.name, cells: {
      name: <NameCell href={href} name={m.name} sub={KIND[m.kind as string] || m.kind} lead={<span className="lv-thumb"><MediaThumb m={m} /></span>} />,
      used: u.length ? <Tags items={u.slice(0, 3).map(x => ({ t: x.t, on: true })).concat(u.length > 3 ? [{ t: `+${u.length - 3}`, on: false }] : [])} /> : <Dot tone="off">Sin usar</Dot>,
      size: <span className="lv-mono">{formatBytes(m.size)}</span>,
    } };
  });
  const m = media.find(x => x.name === open);
  const total = media.reduce((t, x) => t + (x.size || 0), 0);
  const del = guard(async (name: string) => { if (uses[name] && !confirm(`«${name}» se usa en ${uses[name].map(x => x.t).join(', ')}. Si lo borras, esas alertas se quedan sin él.`)) return; if (!confirmDelete(name, 'este archivo')) return; const d = await post<{ media: MediaItem[] }>('/api/media/delete', { name }); live.update(() => ({ media: d.media })); go('#/archivos'); });
  return <>
    <PageHead crumb={`Registro · ${media.length} archivos`} title="Archivos"
      desc={<>Vídeos (webm con transparencia, mp4), imágenes, sonidos y fuentes. Se guardan en la carpeta <code>media/</code> de la app.</>}
      actions={<label className="eg-btn eg-btn--primary eg-btn--sm upload">+ Subir archivos<input type="file" multiple accept="video/*,image/*,audio/*,.woff2,.woff,.ttf,.otf" hidden onChange={guard(async e => { await up.run([...(e.target.files || [])]); e.target.value = ''; })} /></label>} />
    <Kpis items={[
      { value: media.length, label: `archivos · ${formatBytes(total) || '0 B'}` },
      { value: media.filter(x => x.kind === 'video').length, label: 'vídeos' },
      { value: media.filter(x => x.kind === 'audio').length, label: 'sonidos' },
      { value: media.filter(x => !uses[x.name]).length, label: 'sin usar en ninguna parte' },
    ]} />
    <ListPanel title="Archivos" search={f.q} onSearch={f.setQ} placeholder="Buscar archivo"
      chips={[['all', 'Todos'], ['video', 'Vídeos'], ['image', 'Imágenes'], ['audio', 'Sonidos'], ['font', 'Fuentes'], ['unused', 'Sin usar']]} chip={f.chip} onChip={f.setChip}
      cols={[{ key: 'name', label: 'Archivo' }, { key: 'used', label: 'Se usa en' }, { key: 'size', label: 'Tamaño' }]}
      rows={rows} empty={media.length ? 'Ningún archivo coincide.' : <>Todavía no hay archivos. Sube los vídeos, imágenes y sonidos que usan tus alertas. <label className="eg-btn eg-btn--secondary eg-btn--sm upload">Subir archivos<input type="file" multiple accept="video/*,image/*,audio/*,.woff2,.woff,.ttf,.otf" hidden onChange={guard(async e => { await up.run([...(e.target.files || [])]); e.target.value = ''; })} /></label></>} />
    {m ? <Slide crumb={<><a href="#/archivos">Archivos</a> › {KIND[m.kind as string] || m.kind}</>} title={m.name} back="#/archivos"
      foot={<footer className="lv-sfoot sticky"><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={() => del(m.name)}>Borrar archivo…</button><span className="sp" /><a className="eg-btn eg-btn--ghost eg-btn--sm" href={'/media/' + enc(m.name)} target="_blank" rel="noreferrer">Abrir</a></footer>}>
      <div className="lv-cols aside">
        <div className="lv-col"><Box title="Vista previa"><div className="lv-preview">{m.kind === 'video' ? <video src={'/media/' + enc(m.name)} controls muted /> : m.kind === 'audio' ? <audio src={'/media/' + enc(m.name)} controls /> : <MediaThumb m={m} />}</div></Box></div>
        <aside className="lv-col"><Box title="Se usa en">{(uses[m.name] || []).length ? <ul className="lv-links">{uses[m.name].map((x, i) => <li key={i}><a href={x.href}>{x.t}</a></li>)}</ul> : <p className="hint">En ninguna alerta, comando ni mensaje.</p>}</Box>
          <Box title="Datos"><p className="hint">{KIND[m.kind as string] || m.kind} · {formatBytes(m.size)}</p></Box></aside>
      </div>
    </Slide> : null}
    <UploadBar name={up.name} progress={up.progress} />
  </>;
}
