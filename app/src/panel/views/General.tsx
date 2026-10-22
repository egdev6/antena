import { useState } from 'react';
import { post, upload, enc } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import type { Access, MediaItem } from '../../lib/types';
import { confirmDelete, CopyUrl, guard, Panel, Range, Switch, toast } from '../../lib/ui';
import type { UploadResult } from '../../lib/types';

export function UploadBar({ name, progress }: { name: string; progress: number }) {
  if (!name) return null;
  return <div className="upbar"><span>Subiendo {name}</span><i><b style={{ width: progress * 100 + '%' }} /></i></div>;
}
/** Sube varios archivos y devuelve el último; actualiza la lista de media. */
export function useUploader() {
  const [st, setSt] = useState({ name: '', progress: 0 });
  const run = async (files: File[]) => {
    let last: UploadResult | null = null;
    try {
      for (const f of files) {
        setSt({ name: f.name, progress: 0 });
        last = await upload(f, p => setSt({ name: f.name, progress: p }));
        live.update(() => ({ media: last!.media }));
      }
      toast(files.length === 1 ? 'Archivo subido' : `${files.length} archivos subidos`);
    } finally { setSt({ name: '', progress: 0 }); }
    return last;
  };
  return { ...st, run };
}

// Tamaño humano: 1,2 MB · 340 kB · 12 B (#68).
function formatBytes(n?: number | null) {
  if (n === undefined || n === null || !(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

export function MediaThumb({ m }: { m: any }) {
  const src = '/media/' + enc(m.name);
  if (m.kind === 'video') return <video src={src + '#t=0.5'} muted preload="metadata" />;
  if (m.kind === 'image') return <img src={src} alt="" />;
  if (m.kind === 'font') return <span className="au">Aa · fuente</span>;
  return <span className="au">♪ audio</span>;
}

export function General() {
  const c = useLive(s => s.config);
  const media = useLive(s => s.media || []);
  const access = useLive(s => s.access || { lan: false, urls: [] });
  const up = useUploader();
  const setAccess = (a: Access) => live.update(() => ({ access: a }));
  return <>
    <header className="view-head"><div><span className="crumb">Ajustes › General y archivos</span><h1>General y archivos</h1></div></header>
    <Panel title="Bienvenida">
      <p className="hint">La bienvenida explica, en nueve tarjetas, qué hace cada área de antena. Si la cerraste y quieres volver a verla:</p>
      <button className="eg-btn eg-btn--ghost" onClick={() => live.patchConfig({ panel: { onboardingDone: false } })}>Ver la bienvenida de nuevo</button>
    </Panel>
    <Panel title="Capa de alertas">
      <CopyUrl url={`${location.origin}/overlay`} />
      <p className="hint">En Meld: <b>+ › Browser</b>, 1920×1080 y activa <b>Add audio track</b>. Todas las capas están en <a href="#/fuentes">Fuentes para Meld</a>. Parámetros: <code>?pos=top|center|bottom</code> <code>&amp;scale=0.8</code> <code>&amp;mute</code> <code>&amp;debug</code></p>
      <div className="row2 mt">
        <Range label="Volumen general" value={Math.round((c.overlay.volume ?? 0.6) * 100)} min={0} max={100} unit="%" onChange={v => live.patchConfig({ overlay: { volume: v / 100 } })} />
        <label>Tope de la cola del overlay <input type="number" min={0} value={c.overlay.queueMax ?? 20} onChange={e => live.patchConfig({ overlay: { queueMax: Math.max(0, Number(e.target.value) || 0) } })} /></label>
        <div className="row" style={{ alignItems: 'end', justifyContent: 'flex-end' }}>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/skip'))}>Saltar la actual</button>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/clear'))}>Vaciar cola</button>
        </div>
      </div>
      <p className="hint">Con una ráfaga se agrupan los regalos del mismo donante y, si aun así se supera el tope, se descartan las más antiguas sin ver (quedan en la cronología). 0 = sin tope.</p>
    </Panel>
    <Panel title="Acceso desde el móvil" aside={<Switch checked={!!access.lan} onChange={guard(async (v: boolean) => setAccess(await post<Access>('/api/access', { lan: v })))}>Activado</Switch>}>
      <p className="hint">Abre el panel desde el móvil conectado a la misma wifi para lanzar, pausar o saltar alertas durante el directo. Se protege con una clave.</p>
      <ul className="access-urls">{access.lan ? (access.urls?.length ? access.urls.map((u: string) => <li key={u}><CopyUrl url={u} /></li>) : <li className="hint">No encuentro ninguna red local.</li>) : <li className="hint">Desactivado: el panel solo se abre desde este PC.</li>}</ul>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('Los móviles que ya tenían acceso tendrán que abrir el enlace nuevo. ¿Seguir?')) setAccess(await post('/api/access', { regenerate: true })); })}>Generar otra clave</button>
    </Panel>
    <Panel title="Archivos" aside={<label className="eg-btn eg-btn--ghost upload">Subir archivos<input type="file" multiple accept="video/*,image/*,audio/*,.woff2,.woff,.ttf,.otf" hidden onChange={guard(async e => { await up.run([...(e.target.files || [])]); e.target.value = ''; })} /></label>}>
      <p className="hint">Vídeos (webm con transparencia, mp4), imágenes (gif, png, webp) y sonidos (mp3, ogg, wav). Se guardan en la carpeta <code>media/</code> de la app{media.length > 0 ? <> · total: <b>{formatBytes(media.reduce((s: number, m: MediaItem) => s + (m.size || 0), 0))}</b></> : null}.</p>
      <ul className="files">{media.map(m => <li key={m.name}><div className="thumb"><MediaThumb m={m} /></div>
        <div className="meta"><span title={m.name}>{m.name}{m.size ? <> · {formatBytes(m.size)}</> : null}</span><button className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={guard(async () => { if (!confirmDelete(m.name, 'este archivo')) return; const d = await post<{ media: MediaItem[] }>('/api/media/delete', { name: m.name }); live.update(() => ({ media: d.media })); })}>Borrar</button></div></li>)}</ul>
    </Panel>
    <UploadBar name={up.name} progress={up.progress} />
  </>;
}
