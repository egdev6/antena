import { useEffect, useRef, useState } from 'react';
import { post, upload, enc, withKey } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import type { Access, MediaItem } from '../../lib/types';
import { CopyUrl, guard, Panel, Range, Switch, toast } from '../../lib/ui';
import { launchTour } from '../tour';
import { isDirty, isSaving, useDraftVersion, useManualSave } from '../../lib/draft';
import { PageHead, SaveBar, usePageTab } from '../../lib/layout';
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

type ChangeGroup = { count: number; paths: string[] };
type Summary = Record<string, Record<'added' | 'removed' | 'changed', ChangeGroup>>;
type Preview = { file: File; summary: Summary };

// Se envía el archivo tal cual: incluso el JSON mal formado recibe el error exacto del servidor.
async function transfer<T>(path: string, file: File): Promise<T> {
  const r = await fetch(withKey(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : `Error ${r.status}`);
  return data as T;
}

function TransferPreview({ preview, busy, error, cancel, apply, trigger }: { preview: Preview; busy: boolean; error: string; cancel: () => void; apply: () => void; trigger: React.RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal(); cancelButton.current?.focus();
    return () => { node?.close(); trigger.current?.focus(); };
  }, [trigger]);
  const groups = [['added', 'Añadidos'], ['removed', 'Eliminados'], ['changed', 'Cambiados']] as const;
  return <dialog ref={dialog} className="modal panel transfer-dialog" aria-labelledby="transfer-title" aria-describedby="transfer-notes" onCancel={e => { e.preventDefault(); if (!busy) cancel(); }}>
    <header><h2 id="transfer-title">Importar configuración</h2></header>
    <div id="transfer-notes"><p>No incluye cuentas ni contraseñas: tus conexiones actuales se conservan.</p><p>Antes de aplicar se guarda una copia de tu configuración actual.</p></div>
    {Object.keys(preview.summary).length === 0 && <p>No hay cambios en la configuración.</p>}
    <div className="transfer-changes">{Object.entries(preview.summary).map(([section, changes]) => <section key={section}>
      <h3>{section}</h3>
      {groups.map(([key, label]) => {
        const group = changes[key];
        const paths = <ul>{group.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>;
        return <div key={key}><b>{label}: {group.count}</b>{group.count > 5 ? <details><summary>Ver {group.count} rutas</summary>{paths}</details> : group.count > 0 && paths}</div>;
      })}
    </section>)}</div>
    {error && <p className="errors" role="alert">{error}</p>}
    <div className="row mt"><button ref={cancelButton} type="button" className="eg-btn eg-btn--ghost" disabled={busy} onClick={cancel}>Cancelar</button>
      <button type="button" className="eg-btn eg-btn--primary" disabled={busy} onClick={apply}>{busy ? 'Aplicando…' : 'Aplicar'}</button></div>
  </dialog>;
}

function ConfigTransfer() {
  useDraftVersion();
  const picker = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), lock = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [backup, setBackup] = useState('');
  const dirty = isDirty() || isSaving();
  const select = async (file?: File) => {
    if (!file || lock.current || isDirty() || isSaving()) return;
    lock.current = true; setBusy(true); setError(''); setBackup('');
    try { const { summary } = await transfer<{ summary: Summary }>('/api/config/import/preview', file); setPreview({ file, summary }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const apply = async () => {
    if (!preview || lock.current) return;
    if (isDirty() || isSaving()) { setError('Guarda o descarta los cambios pendientes antes de importar.'); return; }
    lock.current = true; setBusy(true); setError('');
    let applied = false;
    try {
      const result = await transfer<{ summary: Summary; backup: string }>('/api/config/import', preview.file);
      applied = true; setBackup(result.backup);
      try { await live.load(); } catch { setError('Se importó la configuración, pero no se pudo actualizar el panel.'); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); if (applied) setPreview(null); }
  };
  return <Panel title="Copia de la configuración">
    <p className="hint">Exporta la configuración guardada o importa una copia después de revisar los cambios.</p>
    <div className="row mt">
      <a className="eg-btn eg-btn--secondary" href={withKey('/api/config/export')}>Exportar configuración</a>
      <button ref={trigger} type="button" className="eg-btn eg-btn--ghost" disabled={busy || dirty} onClick={() => picker.current?.click()}>Importar configuración…</button>
      <input ref={picker} type="file" accept=".json" aria-label="Archivo de configuración JSON" hidden onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void select(file); }} />
    </div>
    {dirty && <p className="hint mt">Guarda o descarta los cambios pendientes antes de importar.</p>}
    {backup && <p role="status">Configuración importada. Copia guardada: <code>{backup}</code></p>}
    {error && !preview && <p className="errors" role="alert">{error}</p>}
    {preview && <TransferPreview preview={preview} busy={busy} error={error} trigger={trigger} cancel={() => { if (!lock.current) { setPreview(null); setError(''); } }} apply={() => void apply()} />}
  </Panel>;
}

export function General({ parts }: { parts: string[] }) {
  useManualSave();
  const c = useLive(s => s.config);
  const access = useLive(s => s.access || { lan: false, urls: [] });
  const setAccess = (a: Access) => live.update(() => ({ access: a }));
  const [tab, setTab] = usePageTab(parts, 'general', ['overlay', 'directos', 'movil', 'tour', 'copia']);
  return <>
    <PageHead tour="general-head" crumb="Ajustes" title="General" desc="Capa de alertas, directos guardados, acceso desde el móvil, tour guiado y copia de la configuración. Los archivos están en Registro › Archivos."
      tabs={[{ id: 'overlay', label: 'Capa de alertas' }, { id: 'directos', label: 'Directos' }, { id: 'movil', label: 'Acceso desde el móvil' }, { id: 'tour', label: 'Tour guiado' }, { id: 'copia', label: 'Copia' }]} tab={tab} onTab={setTab} />
    {tab === 'overlay' && <Panel title="Capa de alertas">
      <CopyUrl url={`${location.origin}/overlay`} />
      <p className="hint">En Meld: <b>+ › Browser</b>, 1920×1080 y activa <b>Add audio track</b>. Todas las capas están en <a href="#/fuentes">Fuentes para Meld</a>. Parámetros: <code>?pos=top|center|bottom</code> <code>&amp;scale=0.8</code> <code>&amp;mute</code> <code>&amp;debug</code></p>
      <div className="row2 mt">
        <Range label="Volumen general" value={Math.round((c.overlay.volume ?? 0.6) * 100)} min={0} max={100} unit="%" onChange={v => live.patchConfig({ overlay: { volume: v / 100 } })} />
        <label>Tope de la cola del overlay <input type="number" min={0} value={c.overlay.queueMax ?? 20} onChange={e => live.patchConfig({ overlay: { queueMax: Math.max(0, Number(e.target.value) || 0) } })} /></label>
        <div className="row to-end">
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/skip'))}>Saltar la actual</button>
          <button className="eg-btn eg-btn--ghost" onClick={guard(() => post('/api/clear'))}>Vaciar cola</button>
        </div>
      </div>
      <p className="hint">Con una ráfaga se agrupan los regalos del mismo donante y, si aun así se supera el tope, se descartan las más antiguas sin ver (quedan en la cronología). 0 = sin tope.</p>
    </Panel>}
    {tab === 'directos' && <Panel title="Directos archivados">
      <label>Cuántos directos anteriores se guardan <input type="number" min={0} max={1000} value={(c as any).sessions?.retention ?? 0} onChange={e => live.patchConfig({ sessions: { retention: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) } } as any)} /></label>
      <p className="hint">Al empezar un directo nuevo, el anterior se archiva. Los más antiguos se borran al pasar de este número (0 = se guardan todos). Están en <a href="#/directos">Directos anteriores</a>.</p>
    </Panel>}
    {tab === 'movil' && <Panel title="Acceso desde el móvil" aside={<Switch checked={!!access.lan} onChange={guard(async (v: boolean) => setAccess(await post<Access>('/api/access', { lan: v })))}>Activado</Switch>}>
      <p className="hint">Abre el panel desde el móvil conectado a la misma wifi para lanzar, pausar o saltar alertas durante el directo. Se protege con una clave. Este interruptor se aplica al momento.</p>
      <ul className="access-urls">{access.lan ? (access.urls?.length ? access.urls.map((u: string) => <li key={u}><CopyUrl url={u} /></li>) : <li className="hint">No encuentro ninguna red local.</li>) : <li className="hint">Desactivado: el panel solo se abre desde este PC.</li>}</ul>
      <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (confirm('Los móviles que ya tenían acceso tendrán que abrir el enlace nuevo. ¿Seguir?')) setAccess(await post('/api/access', { regenerate: true })); })}>Generar otra clave</button>
    </Panel>}
    {tab === 'tour' && <Panel title="Tour guiado" tour="general-tour">
      <p className="hint">Un recorrido paso a paso que señala para qué sirve cada zona: el directo, el chat, los widgets, Meld, los atajos y las conexiones.</p>
      <button className="eg-btn eg-btn--ghost" onClick={launchTour}>Ver el tour de nuevo</button>
    </Panel>}
    {tab === 'copia' && <ConfigTransfer />}
    {(tab === 'overlay' || tab === 'directos' || tab === 'copia') && <SaveBar />}
  </>;
}
