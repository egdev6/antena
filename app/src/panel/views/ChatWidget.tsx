// Chat variants have their own manual draft, keyed by the immutable server id. The default keeps
// using patchWidgets; a variant never travels through that shared /api/widgets draft.
import { useEffect, useRef, useState } from 'react';
import { del, enc, get, post, put } from '../../lib/api';
import { isDirty, isSaving, registerDraft, useDraftVersion } from '../../lib/draft';
import { SaveBar, Slide } from '../../lib/layout';
import { live, useLive } from '../../lib/live';
import { ManualDraft } from '../../lib/manual-draft';
import { patchWidgets } from '../../lib/patch';
import type { ChatVariant, WidgetSection } from '../../lib/types';
import { BrowserSource, codeTab, confirmDelete, Panel, Stage, Switch, toast, WidgetLayout } from '../../lib/ui';

const ROUTE = '/api/widgets/chat/variants';
type Info = { title: string; path: string; size: string; w: number; h: number; desc: string };
type Options = [string, string][];
type Changes = Record<string, unknown>;

function ChatFields({ value, set, anims }: { value: WidgetSection; set: (field: string, value: unknown) => void; anims: Options }) {
  const platforms = Array.isArray(value.platforms) ? value.platforms as string[] : [];
  const select = (field: string, label: string, options: Options) => <label>{label}<select value={String(value[field] ?? '')} onChange={e => set(field, e.target.value)}>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
  const number = (field: string, label: string, min: number, max?: number) => <label>{label}<input type="number" min={min} max={max} value={String(value[field] ?? '')} onChange={e => set(field, Number(e.target.value))} /></label>;
  return <>
    <div className="row2">
      {number('maxMessages', 'Mensajes en pantalla', 1, 50)}
      {number('fontSize', 'Tamaño de letra (px)', 12, 60)}
      {number('fadeAfterSec', 'Desaparecen tras (s, 0 = nunca)', 0)}
      <div className="lbl">Plataformas<div className="row field-ctl">{([['twitch', 'Twitch'], ['youtube', 'YouTube']] as const).map(([id, name]) =>
        <label className="check" key={id}><input type="checkbox" checked={platforms.includes(id)} onChange={e => set('platforms', e.target.checked ? [...platforms, id] : platforms.filter(x => x !== id))} /> {name}</label>)}</div></div>
      <Switch checked={!!value.hideCommands} onChange={v => set('hideCommands', v)}>Ocultar los comandos (!…)</Switch>
      <Switch checked={!!value.hideOwner} onChange={v => set('hideOwner', v)}>Ocultar mis mensajes (lo que escribo desde antena, el móvil o el prompter)</Switch>
      <Switch checked={!!value.showPlatform} onChange={v => set('showPlatform', v)}>Mostrar el icono de la plataforma</Switch>
      {select('layout', 'Disposición', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])}
      <Switch checked={!!value.reverse} onChange={v => set('reverse', v)}>{value.layout === 'horizontal' ? 'Chat invertido (los mensajes nuevos aparecen a la izquierda)' : 'Chat invertido (los mensajes nuevos aparecen arriba)'}</Switch>
      {select('animIn', 'Animación de entrada', anims)}
      {select('animOut', 'Animación al desaparecer', anims)}
    </div>
    <label>CSS personalizado<textarea className="code" spellCheck={false} value={String(value.css ?? '')} onKeyDown={codeTab} placeholder=".msg { border-left-color: #fff; }" onChange={e => set('css', e.target.value)} /></label>
    <p className="css-help">Clases: <code>.msg</code> <code>.msg.mod</code> <code>.who</code> <code>.text</code> <code>.pf</code></p>
  </>;
}

/** The snapshot and draft stay mounted even if another client deletes this variant. A rejected
 * save leaves the draft visible; discarding it allows the parent to select the default again. */
function VariantFields({ id, initial, anims, refresh }: { id: string; initial: ChatVariant; anims: Options; refresh: () => Promise<ChatVariant[]> }) {
  const version = useDraftVersion();
  const remote = useLive(s => s.config.widgets.chatVariants?.find(v => v.id === id));
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<Changes>({});
  const savedRef = useRef(saved);
  const [buffer] = useState(() => new ManualDraft<Changes, ChatVariant>({
    empty: () => ({}), merge: (older, newer) => ({ ...older, ...newer }),
    take: () => savedRef.current,
    keys: () => ['chat'],
    persist: async changes => {
      await put<{ variant: ChatVariant }>(`${ROUTE}/${enc(id)}`, changes);
      // A PUT reply only describes this id and widgets events do not update config.widgets.
      // Re-read before publishing so a concurrent change to another variant is not overwritten.
      let variants: ChatVariant[];
      try { variants = await refresh(); }
      catch { throw new Error('Se guardó el cambio, pero no se pudo actualizar la lista. Reintenta antes de cambiar de variante.'); }
      const result = variants.find(v => v.id === id);
      if (!result) throw new Error('La variante ya no existe. El borrador sigue aquí hasta que lo descartes.');
      return result;
    },
    publish: (result, newer) => { savedRef.current = result; setSaved(result); setDraft(newer); },
    restore: result => { savedRef.current = result; setSaved(result); setDraft({}); },
  }));
  useEffect(() => {
    const unregister = registerDraft('chat-variant:' + id, buffer);
    return () => { unregister(); buffer.dispose(); };
  }, [buffer, id]);
  useEffect(() => {
    if (remote && !buffer.dirty()) { savedRef.current = remote; setSaved(remote); setDraft({}); }
  }, [remote, buffer, version]);
  const set = (field: string, value: unknown) => {
    buffer.push({ [field]: value });
    setDraft(previous => ({ ...previous, [field]: value }));
  };
  return <ChatFields value={{ ...saved, ...draft }} set={set} anims={anims} />;
}

export function ChatWidget({ info, anims }: { info: Info; anims: Options }) {
  useDraftVersion();
  const widgets = useLive(s => s.config.widgets);
  // The widget event carries saved settings; config.widgets may contain an unsaved default draft.
  const savedDefaultLayout = useLive(s => s.widgets.widgets?.chat?.layout);
  const variants = widgets.chatVariants || [];
  const [id, setId] = useState('default');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'new' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const active = useRef(true);
  const lock = useRef(false);
  const eventVersion = useRef(0);
  const selected = variants.find(v => v.id === id);
  const lastSelected = useRef<ChatVariant | null>(null);
  if (selected) lastSelected.current = selected;
  const dirty = isDirty(), saving = isSaving();
  const locked = busy || dirty || saving;

  const updateVariants = (list: ChatVariant[]) => live.update(s => ({ config: { ...s.config, widgets: { ...s.config.widgets, chatVariants: list } } }));
  const refresh = async () => {
    const started = eventVersion.current;
    const list = await get<ChatVariant[]>(ROUTE);
    if (!active.current) return list;
    // Do not apply an older GET over a widgets event that arrived while it was in flight.
    if (started === eventVersion.current) { updateVariants(list); return list; }
    return live.state?.config.widgets.chatVariants || [];
  };
  useEffect(() => {
    active.current = true;
    // widgets SSE has the configuration under payload.widgets, while the generic live handler
    // stores that event in state.widgets, not in state.config.widgets where editors read it.
    const off = live.on('widgets', state => {
      const list = state.widgets?.chatVariants;
      if (!Array.isArray(list)) return;
      eventVersion.current++;
      updateVariants(list);
    });
    refresh().then(() => { if (active.current) { setLoaded(true); setError(''); } }, e => {
      if (active.current) { setLoaded(false); setError(`No se pudieron cargar las variantes: ${e.message}`); }
    });
    return () => { active.current = false; off(); };
  }, []);
  useEffect(() => {
    if (loaded && id !== 'default' && !selected && !dirty && !saving && !busy) {
      setId('default'); setError('La variante ya no existe. Se muestra el chat predeterminado.');
    }
  }, [loaded, id, selected, dirty, saving, busy]);

  const run = async (action: () => Promise<void>) => {
    if (lock.current || isDirty() || isSaving()) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'No se pudo completar la operación'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  };
  const changeSelection = (next: string) => {
    if (next === id) return;
    void run(async () => {
      const list = await refresh();
      if (!active.current) return;
      if (next !== 'default' && !list.some(v => v.id === next)) { setId('default'); setError('La variante ya no existe. Se muestra el chat predeterminado.'); return; }
      setId(next);
    });
  };
  const submit = () => void run(async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('La variante necesita un nombre'); return; }
    if (mode === 'new') {
      const { variant } = await post<{ variant: ChatVariant }>(ROUTE, { name: trimmed });
      let list: ChatVariant[];
      try { list = await refresh(); }
      catch {
        if (!active.current) return;
        // Creation succeeded: do not invite a retry that would create a second variant.
        const current = live.state?.config.widgets.chatVariants || [];
        if (!current.some(v => v.id === variant.id)) updateVariants([...current, variant]);
        setId(variant.id); setMode(null); setName(''); setLoaded(false);
        setError('La variante se creó, pero no se pudo actualizar la lista. Reintenta cargarla.'); return;
      }
      if (!active.current) return;
      if (!list.some(v => v.id === variant.id)) { setMode(null); setName(''); setError('Se creó la variante, pero ya no aparece en la lista.'); return; }
      setId(variant.id); setMode(null); setName(''); toast('Variante creada');
    } else if (mode === 'rename' && selected) {
      const { variant } = await put<{ variant: ChatVariant }>(`${ROUTE}/${enc(selected.id)}`, { name: trimmed });
      try { await refresh(); }
      catch {
        if (!active.current) return;
        updateVariants((live.state?.config.widgets.chatVariants || []).map(v => v.id === variant.id ? { ...v, name: variant.name } : v));
        setMode(null); setName(''); setLoaded(false);
        setError('La variante se renombró, pero no se pudo actualizar la lista. Reintenta cargarla.'); return;
      }
      if (!active.current) return;
      setMode(null); setName(''); toast('Variante renombrada');
    }
  });
  const remove = () => {
    if (!selected || locked || !confirmDelete(selected.name, 'esta variante')) return;
    const target = selected;
    void run(async () => {
      await del(`${ROUTE}/${enc(target.id)}`);
      try { await refresh(); }
      catch {
        if (!active.current) return;
        updateVariants((live.state?.config.widgets.chatVariants || []).filter(v => v.id !== target.id));
        setId('default'); setLoaded(false);
        setError('La variante se borró, pero no se pudo actualizar la lista. Reintenta cargarla.'); return;
      }
      if (!active.current) return;
      setId('default'); toast('Variante borrada');
    });
  };
  const retry = () => void run(async () => { await refresh(); if (active.current) setLoaded(true); });
  const path = id === 'default' ? info.path : `${info.path}?variant=${enc(id)}`;
  const preview = `${path}${path.includes('?') ? '&' : '?'}demo`;
  const current = selected || (lastSelected.current?.id === id ? lastSelected.current : undefined);
  // Horizontal chat is a row, not the default portrait source. The preview and suggested Meld
  // size follow the saved layout (not an unsaved edit) using the issue's 1832×160 reference.
  const horizontal = (id === 'default' ? savedDefaultLayout : current?.layout) === 'horizontal';
  const dimensions = horizontal ? { size: '1832×160', w: 1832, h: 160 } : info;
  return <Slide crumb={<><a href="#/widgets">Widgets</a> › {info.title}</>} title={info.title} desc={info.desc} back="#/widgets" wide foot={<SaveBar />}>
    <WidgetLayout className="chat-variant-editor"
      source={<BrowserSource url={location.origin + path} size={dimensions.size} />}
      preview={<Stage eyebrow="Vista previa" aside={<span>Datos de ejemplo</span>} src={preview} w={dimensions.w} h={dimensions.h} />}>
      <Panel>
        <div className="chat-variants">
          <label>Variante de chat<select value={id} disabled={!loaded || locked || mode !== null} onChange={e => changeSelection(e.target.value)}>
            <option value="default">Predeterminada</option>
            {variants.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            {id !== 'default' && !selected && current && <option value={id}>{current.name} (eliminada)</option>}
          </select></label>
          <div className="row">
            <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={!loaded || locked || mode !== null} onClick={() => { setError(''); setName(''); setMode('new'); }}>+ Nueva variante</button>
            {id !== 'default' && <><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={!selected || locked || mode !== null} onClick={() => { setError(''); setName(selected?.name || ''); setMode('rename'); }}>Renombrar</button>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={!selected || locked || mode !== null} onClick={remove}>Borrar variante…</button></>}
          </div>
          {!loaded && !error && <p className="hint" role="status">Cargando variantes…</p>}
          {loaded && !variants.length && <p className="hint">Todavía no hay variantes. Crea una copia del chat predeterminado.</p>}
          {(dirty || saving) && <p className="hint">Guarda o descarta los cambios antes de cambiar de variante o gestionarlas.</p>}
          {id !== 'default' && !selected && dirty && <p className="hint" role="alert">La variante se borró desde otro lugar. Conserva el borrador hasta guardarlo o descartarlo.</p>}
          {error && <p className="chat-variant-error" role="alert">{error}{!loaded && <> <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={locked} onClick={retry}>Reintentar</button></>}</p>}
          {mode && <form className="chat-variant-name" onSubmit={e => { e.preventDefault(); submit(); }}>
            <label>Nombre de la variante<input autoFocus maxLength={60} value={name} onChange={e => setName(e.target.value)} /></label>
            <div className="row"><button type="submit" className="eg-btn eg-btn--secondary eg-btn--sm" disabled={busy}>{mode === 'new' ? 'Crear variante' : 'Guardar nombre'}</button>
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={busy} onClick={() => { setMode(null); setError(''); }}>Cancelar</button></div>
          </form>}
        </div>
        <fieldset className="chat-settings" disabled={busy || mode !== null}>
          {id === 'default'
            ? <ChatFields value={widgets.chat || {}} set={(field, value) => patchWidgets({ chat: { [field]: value } })} anims={anims} />
            : current && <VariantFields key={id} id={id} initial={current} anims={anims} refresh={refresh} />}
        </fieldset>
      </Panel>
    </WidgetLayout>
  </Slide>;
}
