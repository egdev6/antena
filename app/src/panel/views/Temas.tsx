// Saved themes master/detail: selection is a read-only preview, not activation.
import { useEffect, useState } from 'react';
import { del, post, put, upload } from '../../lib/api';
import { activateTheme, ThemeAvatar, useThemes } from '../../lib/themes';
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
  const [avatarImage, setAvatarImage] = useState('');
  const [avatarColor, setAvatarColor] = useState('');
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
  const startNew = (source: string) => { setOrigin(source); setName(''); setAvatarImage(''); setAvatarColor(''); setDialog({ kind: 'new', origin: source }); };
  const startEdit = (item: SavedThemeSummary) => { setName(item.name); setAvatarImage(item.avatar?.image || ''); setAvatarColor(item.avatar?.color || ''); setDialog({ kind: 'rename', theme: item }); };
  const previewLook = dialog?.kind === 'rename' ? looks[dialog.theme.id] : origin === '__default' ? { theme: { accent: '', platformAccent: true } } : looks[origin];
  const previewAvatar: SavedThemeSummary = { id: '', name, active: false, avatar: { ...(avatarImage && { image: avatarImage }), ...(avatarColor && { color: avatarColor }) } };
  const submit = guard(async () => {
    if (!dialog || busy) return;
    setBusy(true);
    try {
      const avatar = { image: avatarImage, color: avatarColor };
      if (dialog.kind === 'rename') {
        await put(`/api/themes/${encodeURIComponent(dialog.theme.id)}`, { name, avatar });
      } else {
        const result = origin === '__default'
          ? await post<{ theme: SavedThemeSummary }>('/api/themes/from-default', { name, avatar })
          : await post<{ theme: SavedThemeSummary }>('/api/themes/duplicate', { from: origin, name, avatar });
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
          <ThemeAvatar theme={item} look={looks[item.id]} /><span><b>{item.name}</b>{item.active ? <small className="is-active">✓ Activo</small> : selected?.id === item.id && <small>Vista previa seleccionada</small>}</span>
        </button>)}
      </section>
      {selected && <section className="lv-panel themes-detail" data-theme-preview data-look-accent={theme?.accent} aria-label={`Detalle y vista previa de ${selected.name}`}>
        <div className="themes-detail-head"><div className="themes-detail-title"><ThemeAvatar theme={selected} look={look} size={32} /><div><h3>{selected.name}</h3><p>{selected.active ? 'Activo' : 'Selección para vista previa · aún no activo'}</p></div></div><span className="lv-tag">Tema guardado</span></div>
        {theme && look ? <div className="themes-samples" key={previewKey}>
          <div className="themes-alert-stage" data-theme-alert><p className="themes-sample-label">Alerta · muestra</p><ScaledFrame src={`/overlay?still=follow&previewTheme=${previewId}`} className="preview wprev themes-alert-frame" title="Vista previa de alerta" /></div>
          <div className="themes-sample-row"><div className="themes-sample" data-theme-goal><h4>Widget · objetivo</h4><ScaledFrame src={`/widget/goal?demo&previewTheme=${previewId}`} w={1000} h={300} title="Vista previa de objetivo" /></div>
            <div className="themes-sample" data-theme-chat><h4>Widget · chat</h4><ScaledFrame src={`/widget/chat?demo&previewTheme=${previewId}`} w={600} h={180} title="Vista previa de chat" /></div></div>
        </div> : <p className="hint">Cargando vista previa…</p>}
        <div className="row tight">
          <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" data-theme-activate disabled={selected.active} onClick={guard(() => activateTheme(selected))}>Activar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" data-theme-duplicate disabled={themes.length >= MAX} title={themes.length >= MAX ? LIMIT : undefined} onClick={() => startNew(selected.id)}>Duplicar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" data-theme-edit data-theme-rename onClick={() => startEdit(selected)}>Editar</button>
          <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" data-theme-delete disabled={selected.active} title={selected.active ? DELETE_REASON : undefined} aria-describedby={selected.active ? 'theme-delete-reason' : undefined} onClick={guard(async () => { if (confirmDelete(selected.name, 'este tema')) { await del(`/api/themes/${encodeURIComponent(selected.id)}`); toast('Tema borrado'); } })}>Borrar</button>
        </div>
        {selected.active && <p className="hint" id="theme-delete-reason">{DELETE_REASON}</p>}
        <p className="hint">Al activar, el cambio se aplica en pantalla al momento. Las alertas en curso terminan con su aspecto anterior y la cola continúa.</p>
      </section>}
    </div>
    <div className="themes-notice"><b>Editas el tema activo: {active?.name || '…'}.</b> Los cambios en Alertas, Widgets, Overlays, Comandos, Mensajes programados y Apariencia se guardan en él. El tema copia toda la configuración de los elementos, incluidos CSS, mínimos y acciones; las conexiones y escenas de emisión no cambian.</div>
    {dialog && <Modal title={dialog.kind === 'new' ? 'Nuevo tema' : 'Editar tema'} onClose={() => { if (!busy) setDialog(null); }} className="themes-dialog">
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        {dialog.kind === 'new' && <fieldset id="theme-origin" className="themes-origin"><legend>Crear como copia de</legend>
          {themes.map(item => <label key={item.id} data-theme-origin={item.id}><input type="radio" name="theme-origin" value={item.id} checked={origin === item.id} onChange={() => setOrigin(item.id)} /><ThemeAvatar theme={item} look={looks[item.id]} /><span>{item.name}</span></label>)}
          <label data-theme-origin="__default"><input type="radio" name="theme-origin" value="__default" checked={origin === '__default'} onChange={() => setOrigin('__default')} /><ThemeAvatar look={{ theme: { accent: '', platformAccent: true } }} /><span>Desde Color de cada plataforma</span></label>
        </fieldset>}
        <label htmlFor="theme-name">Nombre<input id="theme-name" value={name} maxLength={40} required autoFocus onChange={e => setName(e.target.value)} /></label>
        <fieldset className="themes-avatar-field"><legend>Avatar</legend><div className="themes-avatar-controls">
          <span data-theme-avatar-preview><ThemeAvatar theme={previewAvatar} look={previewLook} size={32} /></span>
          <label>Subir imagen<input type="file" data-theme-avatar-image accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={e => {
            const file = e.currentTarget.files?.[0]; e.currentTarget.value = '';
            if (file) void guard(async () => {
              if (!/\.(?:png|jpe?g|webp|gif)$/i.test(file.name)) throw new Error('El avatar admite imágenes PNG, JPG, WebP o GIF');
              setBusy(true); try { setAvatarImage((await upload(file)).name); } finally { setBusy(false); }
            })();
          }} /></label>
          <button type="button" data-theme-avatar-remove-image className="eg-btn eg-btn--ghost eg-btn--sm" disabled={busy || !avatarImage} onClick={() => setAvatarImage('')}>Quitar imagen</button>
          <label>Color<input type="color" data-theme-avatar-color value={avatarColor || '#ff0036'} disabled={busy} onChange={e => setAvatarColor(e.target.value)} /></label>
          <button type="button" data-theme-avatar-remove-color className="eg-btn eg-btn--ghost eg-btn--sm" disabled={busy || !avatarColor} onClick={() => setAvatarColor('')}>Sin color</button>
        </div></fieldset>
        <div className="row"><button type="submit" data-theme-submit className="eg-btn eg-btn--primary eg-btn--sm" disabled={busy || !name.trim()}>{dialog.kind === 'new' ? 'Crear' : 'Guardar'}</button><button type="button" data-theme-cancel className="eg-btn eg-btn--ghost eg-btn--sm" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button></div>
      </form>
    </Modal>}
  </div>;
}
