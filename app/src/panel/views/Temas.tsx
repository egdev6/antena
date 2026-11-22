// Saved themes master/detail: selection is a read-only preview, not activation.
import { useEffect, useState } from 'react';
import { del, post, put } from '../../lib/api';
import { activateTheme, ThemeSwatch, useThemes } from '../../lib/themes';
import { confirmDelete, cx, guard, Modal, ScaledFrame, toast } from '../../lib/ui';
import { useLive } from '../../lib/live';
import type { SavedThemeSummary } from '../../lib/types';

const MAX = 10;
const DELETE_REASON = 'No se puede borrar el tema activo. Activa otro primero.';
const LIMIT = 'Máximo 10 temas. Borra un tema inactivo para crear otro.';

type Dialog = { kind: 'new'; origin: string } | { kind: 'rename'; theme: SavedThemeSummary };

export function Temas() {
  const { themes, activeId, looks } = useThemes();
  const [chosen, setChosen] = useState('');
  const [pendingSelection, setPendingSelection] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const activePreviewVersion = useLive(s => s.alertPreviews?.follow?.version);
  const activeWidgets = useLive(s => s.config.widgets);
  useEffect(() => {
    if (pendingSelection) {
      if (themes.some(x => x.id === pendingSelection)) { setChosen(pendingSelection); setPendingSelection(''); }
      return;
    }
    if (themes.length && !themes.some(x => x.id === chosen)) setChosen(activeId || themes[0].id);
  }, [themes, chosen, activeId, pendingSelection]);
  const selected = themes.find(x => x.id === chosen);
  const active = themes.find(x => x.id === activeId);
  const look = selected ? looks[selected.id] : undefined;
  const startNew = (source: string) => { setOrigin(source); setName(''); setDialog({ kind: 'new', origin: source }); };
  const submit = guard(async () => {
    if (!dialog || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === 'rename') {
        await put(`/api/themes/${encodeURIComponent(dialog.theme.id)}`, { name });
      } else {
        const result = origin === '__default'
          ? await post<{ theme: SavedThemeSummary }>('/api/themes/from-default', { name })
          : await post<{ theme: SavedThemeSummary }>('/api/themes/duplicate', { from: origin, name });
        setPendingSelection(result.theme.id);
      }
      setDialog(null);
    } finally { setBusy(false); }
  });
  const theme = look?.theme;
  const previewId = selected ? encodeURIComponent(selected.id) : '';
  const previewKey = selected?.active ? JSON.stringify([activePreviewVersion, activeWidgets]) : selected?.id;
  return <div className="themes-page">
    <div className="themes-header"><h2>Temas guardados <span>{themes.length} / {MAX}</span></h2>
      <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" data-theme-new disabled={themes.length >= MAX} title={themes.length >= MAX ? LIMIT : undefined} onClick={() => startNew(activeId || themes[0]?.id || '')}>+ Nuevo tema</button>
    </div>
    {themes.length >= MAX && <p className="hint" data-theme-limit>{LIMIT}</p>}
    <div className="themes-detail-layout">
      <section className="lv-panel themes-master" aria-label="Lista de temas">
        <h3>Selecciona para previsualizar</h3>
        {themes.map(item => <button key={item.id} type="button" data-theme-row={item.id} className={cx('themes-row', selected?.id === item.id && 'is-selected')} aria-pressed={selected?.id === item.id} onClick={() => setChosen(item.id)}>
          <ThemeSwatch color={looks[item.id]?.theme?.accent} /><span><b>{item.name}</b>{item.active && <small>✓ Activo</small>}</span>
        </button>)}
      </section>
      {selected && <section className="lv-panel themes-detail" data-theme-preview data-look-accent={theme?.accent} aria-label={`Detalle y vista previa de ${selected.name}`}>
        <div className="themes-detail-head"><div><h3>{selected.name}</h3><p>{selected.active ? 'Activo' : 'Selección para vista previa · aún no activo'}</p></div><span className="lv-tag">Tema guardado</span></div>
        {theme && look ? <div className="themes-samples" key={previewKey}>
          <div data-theme-alert><p className="themes-sample-label">Alerta · muestra</p><ScaledFrame src={`/overlay?still=follow&previewTheme=${previewId}`} className="preview wprev" title="Vista previa de alerta" /></div>
          <div className="themes-sample-row"><div className="themes-sample" data-theme-goal><h4>Widget · objetivo</h4><ScaledFrame src={`/widget/goal?demo&previewTheme=${previewId}`} w={1000} h={300} title="Vista previa de objetivo" /></div>
            <div className="themes-sample" data-theme-chat><h4>Widget · chat</h4><ScaledFrame src={`/widget/chat?demo&previewTheme=${previewId}`} w={600} h={700} title="Vista previa de chat" /></div></div>
        </div> : <p className="hint">Cargando vista previa…</p>}
        <div className="row tight">
          <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" data-theme-activate disabled={selected.active} onClick={guard(() => activateTheme(selected))}>Activar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" data-theme-duplicate disabled={themes.length >= MAX} title={themes.length >= MAX ? LIMIT : undefined} onClick={() => startNew(selected.id)}>Duplicar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" data-theme-rename onClick={() => { setName(selected.name); setDialog({ kind: 'rename', theme: selected }); }}>Renombrar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" data-theme-delete disabled={selected.active} title={selected.active ? DELETE_REASON : undefined} aria-describedby={selected.active ? 'theme-delete-reason' : undefined} onClick={guard(async () => { if (confirmDelete(selected.name, 'este tema')) { await del(`/api/themes/${encodeURIComponent(selected.id)}`); toast('Tema borrado'); } })}>Borrar</button>
        </div>
        {selected.active && <p className="hint" id="theme-delete-reason">{DELETE_REASON}</p>}
        <p className="hint">Al activar, el cambio se aplica en pantalla al momento. Las alertas en curso terminan con su aspecto anterior y la cola continúa.</p>
      </section>}
    </div>
    <div className="themes-notice"><b>Editas el tema activo: {active?.name || '…'}.</b> Los cambios en Alertas, Widgets, Overlays, Comandos, Mensajes programados y Apariencia se guardan en él. El tema copia toda la configuración de los elementos, incluidos CSS, mínimos y acciones; las conexiones y escenas de emisión no cambian.</div>
    {dialog && <Modal title={dialog.kind === 'new' ? 'Nuevo tema' : 'Renombrar tema'} onClose={() => { if (!busy) setDialog(null); }} className="themes-dialog">
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        {dialog.kind === 'new' && <label htmlFor="theme-origin">Crear como copia de<select id="theme-origin" value={origin} onChange={e => setOrigin(e.target.value)}>
          <optgroup label="Temas guardados">{themes.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup><optgroup label="Aspecto por defecto"><option value="__default">Desde Color de cada plataforma</option></optgroup>
        </select></label>}
        <label htmlFor="theme-name">Nombre<input id="theme-name" value={name} maxLength={40} required autoFocus onChange={e => setName(e.target.value)} /></label>
        <div className="row"><button type="submit" data-theme-submit className="eg-btn eg-btn--primary eg-btn--sm" disabled={busy || !name.trim()}>{dialog.kind === 'new' ? 'Crear' : 'Guardar'}</button><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button></div>
      </form>
    </Modal>}
  </div>;
}
