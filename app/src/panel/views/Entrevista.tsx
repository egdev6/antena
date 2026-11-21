// Interview catalog and whole-interview manual editor (#295).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { del, enc, get, post, put, withKey } from '../../lib/api';
import { isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { Box, Dot, Kpis, ListPanel, NameCell, PageHead, SaveBar, Slide } from '../../lib/layout';
import { InterviewPad, useInterview } from '../../lib/InterviewControls';
import { live, useLive } from '../../lib/live';
import { ManualDraft } from '../../lib/manual-draft';
import { BrowserSource, confirmDelete, guard, Panel, Stage, WidgetLayout } from '../../lib/ui';
import type { MediaItem } from '../../lib/types';
import { go } from '../router';
import { UploadBar, useUploader } from './General';
import { InterviewSettings } from './InterviewWidget';

interface InterviewSummary { id: string; title: string; guest: string; rounds: number; items: number; approved: number }
interface InterviewList { activeId: string; activeItemId: string; interviews: InterviewSummary[] }
type LocalMedia = { type: 'image' | 'video'; file: string };
type YoutubeMedia = { type: 'youtube'; url: string; startMinute?: number };
type PostMedia = { type: 'post'; author: string; text: string; date: string; url: string };
type InterviewMedia = LocalMedia | YoutubeMedia | PostMedia;
interface InterviewItem { id: string; question: string; notes?: string; aprobado: boolean; source?: { url: string; date: string }; media?: InterviewMedia }
interface InterviewRound { id: string; title: string; items: InterviewItem[] }
interface Interview { version: 1; id: string; title: string; guest: { name: string; bio?: string }; rounds: InterviewRound[] }
type EditFields = Pick<Interview, 'title' | 'guest' | 'rounds'>;
type Issue = { field: string; label: string; itemId?: string; roundId?: string };
type EditorError = { text: string; issue?: Issue };
const message = (error: unknown) => error instanceof Error ? error.message : 'No se pudo completar la operación';
const number = (n: number) => String(n).padStart(2, '0');
const mediaNames = { image: 'Imagen', video: 'Vídeo', youtube: 'YouTube', post: 'Post' } as const;

// Server-generated ids also use a short prefix and lowercase letters/digits. Validate uniqueness
// locally within the relevant collection; the API validates the whole interview again on save.
function newId(prefix: 'q' | 'r', rounds: InterviewRound[]) {
  const used = new Set(prefix === 'q' ? rounds.flatMap(round => round.items.map(item => item.id)) : rounds.map(round => round.id));
  let id: string;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } while (used.has(id));
  return id;
}

// The API remains the authority for validation. Translate its field path to a stable item id
// from the submitted snapshot, since the user may reorder the draft while the request is in flight.
function serverIssue(text: string, sent: Interview): Issue | undefined {
  const match = /rounds\[(\d+)\](?:\.items\[(\d+)\])?\.([\w.]+)/.exec(text);
  if (match) {
    const round = sent.rounds[Number(match[1])];
    const item = match[2] === undefined ? undefined : round?.items[Number(match[2])];
    if (!round || (match[2] !== undefined && !item)) return;
    const fields: Record<string, [string, string]> = {
      title: ['title', 'Nombre de la ronda'], question: ['question', 'Pregunta'], notes: ['notes', 'Notas privadas'],
      aprobado: ['approved', 'Aprobada para mostrar'], 'source.url': ['source-url', 'URL de la fuente'],
      'source.date': ['source-date', 'Fecha de la fuente'], 'media.file': ['media-file', 'Archivo de media'],
      'media.startMinute': ['youtube-start', 'Minuto de inicio'], 'media.author': ['post-author', 'Autor del post'],
      'media.text': ['post-text', 'Texto del post'], 'media.date': ['post-date', 'Fecha del post'],
      'media.type': ['media-type', 'Tipo de media'],
      'media.url': item?.media?.type === 'post' ? ['post-url', 'URL del post'] : ['youtube-url', 'URL de YouTube'],
    };
    const field = fields[match[3]];
    if (field) return { roundId: round.id, itemId: item?.id, field: field[0], label: field[1] };
    return;
  }
  const fields: Record<string, [string, string]> = {
    title: ['title', 'Título'], 'guest.name': ['guest', 'Persona invitada'], 'guest.bio': ['bio', 'Biografía'],
  };
  const top = /Paquete de entrevista no válido: (title|guest\.name|guest\.bio):/.exec(text);
  if (top) return { field: fields[top[1]][0], label: fields[top[1]][1] };
}

function issuesFor(draft: Interview, error: EditorError | null): Issue[] {
  const issues: Issue[] = [];
  for (const round of draft.rounds) for (const item of round.items) {
    if (!item.source) continue;
    const url = item.source.url.trim(), date = item.source.date.trim();
    if (!!url === !!date) continue;
    issues.push({ roundId: round.id, itemId: item.id, field: url ? 'source-date' : 'source-url', label: url ? 'Fecha de la fuente' : 'URL de la fuente' });
  }
  const issue = error?.issue;
  if (issue && (issue.itemId ? draft.rounds.some(r => r.items.some(item => item.id === issue.itemId))
    : !issue.roundId || draft.rounds.some(r => r.id === issue.roundId)) &&
    !issues.some(x => x.itemId === issue.itemId && x.field === issue.field && (issue.itemId || x.roundId === issue.roundId))) issues.push(issue);
  return issues;
}

// Count distinct changed fields/collections, not keystrokes; SaveBar still owns save/discard.
function countChanges(saved: Interview, draft: Interview): number {
  const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b) ? 1 : 0;
  let count = different(saved.title, draft.title) + different(saved.guest.name, draft.guest.name) + different(saved.guest.bio || '', draft.guest.bio || '');
  count += different(saved.rounds.map(r => r.id), draft.rounds.map(r => r.id));
  for (const round of draft.rounds) {
    const before = saved.rounds.find(r => r.id === round.id);
    if (!before) continue;
    count += different(before.title, round.title) + different(before.items.map(i => i.id), round.items.map(i => i.id));
    for (const item of round.items) {
      const old = saved.rounds.flatMap(r => r.items).find(i => i.id === item.id);
      if (!old) continue;
      count += different(old.question, item.question) + different(old.notes || '', item.notes || '') + different(old.aprobado, item.aprobado)
        + different(old.media, item.media) + different(old.source, item.source);
    }
  }
  return Math.max(1, count);
}

function InterviewSaveBar({ count, issues, focusIssue }: { count: number; issues: Issue[]; focusIssue: (issue: Issue) => void }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null);
  useEffect(() => { setSlot(root?.querySelector<HTMLSpanElement>('.lv-savebar .sp') || null); }, [root]);
  return <div className="interview-save" ref={setRoot}><SaveBar />{slot && createPortal(<span className="interview-save-info">
    <span className="lv-dirty is-on" role="status">{isSaving() ? 'Guardando…' : `${count} ${count === 1 ? 'cambio' : 'cambios'} sin guardar`}</span>
    {issues.length > 0 && <button type="button" className="interview-error-link" data-interview-validation-link onClick={() => focusIssue(issues[0])}>
      {issues.length} {issues.length === 1 ? 'error' : 'errores'}: {issues[0].label}
    </button>}
  </span>, slot)}</div>;
}

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
function InterviewPreview({ item }: { item: InterviewItem }) {
  const media = item.media;
  let source = '';
  if (media) {
    if (item.source) source = [host(item.source.url) || (item.source.url ? 'Fuente indicada' : ''), item.source.date || 'fecha pendiente'].filter(Boolean).join(' · ');
    else if (media.type === 'image' || media.type === 'video') source = `Archivo local${media.file ? ` · ${media.file}` : ''}`;
    else if (media.type === 'youtube') source = `YouTube${media.startMinute ? ` · desde ${media.startMinute}:00` : ''}`;
    else if (media.type === 'post') source = [host(media.url), media.author].filter(Boolean).join(' · ');
  }
  return <aside className="interview-preview" data-interview-preview aria-label="Vista previa de la pregunta">
    <h4>Vista previa en pantalla</h4><p className="hint">Borrador · no es la emisión</p>
    <figure className={`interview-stage ${media ? `is-${media.type}` : 'is-none'}`} aria-label="Simulación del widget, sin notas privadas">
      <div className="interview-preview-media" data-preview-media={media?.type || 'none'}>
        {media?.type === 'image' && media.file && <img src={withKey('/media/' + enc(media.file))} alt="" />}
        {media?.type === 'video' && media.file && <video src={withKey('/media/' + enc(media.file)) + '#t=0.05'} muted playsInline preload="metadata" />}
        {(media?.type === 'video' || media?.type === 'youtube') && <span className="interview-preview-play" aria-hidden="true">▶</span>}
        {media?.type === 'post' && <div className="interview-preview-post"><b>{media.author || 'Autor del post'}</b><span>{media.text || 'Texto del post'}</span><small>{media.date}</small></div>}
      </div>
      {source && <div className="interview-preview-source" data-preview-source><b>Fuente</b> {source}</div>}
      <div className="interview-preview-question"><small>Pregunta</small><span data-preview-question>{item.question || 'Escribe una pregunta'}</span></div>
    </figure>
    <div className="interview-preview-note"><b>Solo lo que ve la audiencia</b><p>La vista corresponde a la pregunta y la media elegidas. Las notas privadas nunca aparecen aquí.</p></div>
  </aside>;
}

export function Entrevista({ parts }: { parts: string[] }) {
  const [snapshot, setSnapshot] = useState<InterviewList>({ activeId: '', activeItemId: '', interviews: [] });
  const [listError, setListError] = useState('');
  const [tab, setTab] = useState('listas');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [guest, setGuest] = useState('');
  const [createError, setCreateError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const request = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await get<InterviewList>('/api/interviews');
      if (mounted.current && current === request.current) { setSnapshot(next); setListError(''); }
    } catch (error) {
      if (mounted.current && current === request.current) setListError(message(error));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const update = () => { void refresh(); };
    const off = live.on('interviewControl', update), offOpen = live.onOpen(update);
    update();
    return () => { mounted.current = false; request.current++; off(); offOpen(); };
  }, [refresh]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setCreateError('');
    try {
      const result = await post<{ interview: Interview }>('/api/interviews', { title, guest: { name: guest } });
      await refresh();
      setCreating(false); setTitle(''); setGuest(''); setTab('listas');
      go(`#/entrevista/${enc(result.interview.id)}`);
    } catch (error) { setCreateError(message(error)); }
    finally { setBusy(false); }
  };
  const importPack = async (file: File) => {
    if (importLock.current) return;
    importLock.current = true; setImporting(true); setImportError('');
    try {
      let pack: unknown;
      try { pack = JSON.parse(await file.text()); }
      catch { throw new Error('El archivo no contiene JSON válido.'); }
      await post('/api/interviews/import', pack);
      await refresh();
    } catch (error) { if (mounted.current) setImportError(message(error)); }
    finally { importLock.current = false; if (mounted.current) setImporting(false); }
  };
  const list = snapshot.interviews;
  const rows = list.map(iv => {
    const href = `#/entrevista/${enc(iv.id)}`;
    const active = snapshot.activeId === iv.id, shown = active && !!snapshot.activeItemId;
    return { id: iv.id, href, open: parts[1] === iv.id, cells: {
      name: <NameCell href={href} name={iv.title} sub={iv.guest} />,
      state: <Dot tone={shown ? 'live' : active ? 'ok' : 'off'}>{shown ? 'En pantalla' : active ? 'Lista' : 'Guardada'}</Dot>,
      items: <span className="lv-mono">{iv.approved} / {iv.items} aprobadas</span>,
    } };
  });
  return <>
    <PageHead crumb="En directo" title="Entrevista" desc="Prepara las preguntas y elige qué mostrar durante la entrevista."
      actions={<>
        <label className="eg-btn eg-btn--secondary eg-btn--sm upload">{importing ? 'Importando…' : 'Importar pack JSON'}<input type="file" accept=".json,application/json" data-interview-import hidden disabled={importing} onChange={e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (file) void importPack(file);
        }} /></label>
        <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={() => { setTab('listas'); setCreating(true); }}>+ Nueva entrevista</button>
      </>}
      tabs={[{ id: 'listas', label: 'Entrevistas', count: list.length }, { id: 'capa', label: 'Capa' }]} tab={tab} onTab={setTab} />
    {importError && <p className="hint err-inline" role="alert" data-interview-import-error>{importError}</p>}
    {tab === 'listas' ? <>
      {creating && <Box title="Nueva entrevista">
        <form onSubmit={create}>
          <label>Título <input autoFocus data-interview-create-title value={title} onChange={e => setTitle(e.target.value)} /></label>
          <label>Nombre de la persona invitada <input data-interview-create-guest value={guest} onChange={e => setGuest(e.target.value)} /></label>
          {createError && <p className="hint err-inline" role="alert" data-interview-create-error>{createError}</p>}
          <div className="row tight"><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => { setCreating(false); setCreateError(''); }}>Cancelar</button>
            <button type="submit" className="eg-btn eg-btn--primary eg-btn--sm" disabled={busy}>Crear entrevista</button></div>
        </form>
      </Box>}
      {listError && <p role="alert" className="hint err-inline">No se pudieron cargar las entrevistas: {listError} <button type="button" onClick={() => void refresh()}>Reintentar</button></p>}
      <Kpis items={[{ value: list.length, label: 'entrevistas' }, { value: list.reduce((n, iv) => n + iv.rounds, 0), label: 'rondas' }, { value: list.reduce((n, iv) => n + iv.items, 0), label: 'preguntas' }, { value: snapshot.activeItemId ? 1 : 0, label: 'en pantalla' }]} />
      <ListPanel title="Entrevistas" note="Pulsa una entrevista para editar sus preguntas." cols={[{ key: 'name', label: 'Entrevista' }, { key: 'state', label: 'Estado' }, { key: 'items', label: 'Preguntas' }]} rows={rows} empty="Todavía no hay entrevistas." />
    </> : <WidgetLayout
      source={<BrowserSource url={location.origin + '/widget/interview'} size="1920×1080" hint="Añade una fuente de navegador con el tamaño indicado. Solo se muestran preguntas aprobadas." />}
      preview={<Stage eyebrow="Vista previa" aside={<span>Datos de ejemplo</span>} src="/widget/interview?demo" />}>
      <Panel><InterviewSettings /></Panel>
    </WidgetLayout>}
    {parts[1] && <InterviewEditor key={parts[1]} id={parts[1]} refresh={refresh} />}
  </>;
}

function InterviewEditor({ id, refresh }: { id: string; refresh: () => Promise<void> }) {
  useManualSave();
  useDraftVersion();
  const media = useLive(s => s.media || []);
  const interview = useInterview();
  const uploader = useUploader();
  const [saved, setSaved] = useState<Interview | null>(null);
  const [draft, setDraft] = useState<Interview | null>(null);
  const [error, setError] = useState<EditorError | null>(null);
  const [loadError, setLoadError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [pendingFocus, setPendingFocus] = useState<Issue | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectLock = useRef(false);
  const savedRef = useRef<Interview | null>(null);
  const currentRef = useRef<Interview | null>(null);
  const mounted = useRef(false);
  const mediaEpoch = useRef(0);
  const [buffer] = useState(() => new ManualDraft<Partial<EditFields>, Interview>({
    empty: () => ({}), merge: (older, newer) => ({ ...older, ...newer }),
    take: () => savedRef.current!, keys: () => ['entrevista'],
    persist: async changes => {
      try {
        const result = await put<{ interview: Interview }>(`/api/interviews/${enc(id)}`, changes);
        if (mounted.current) setError(null);
        return result.interview;
      } catch (error) {
        const text = message(error);
        if (mounted.current) setError({ text, issue: serverIssue(text, { ...savedRef.current!, ...changes }) });
        throw error;
      }
    },
    publish: (result, newer) => {
      const next = { ...result, ...newer };
      savedRef.current = result; currentRef.current = next;
      setSaved(result); setDraft(Object.keys(newer).length ? next : null);
      void refresh();
    },
    restore: result => { savedRef.current = result; currentRef.current = result; setSaved(result); setDraft(null); setError(null); },
  }));
  useEffect(() => {
    mounted.current = true;
    get<{ interview: Interview }>(`/api/interviews/${enc(id)}`).then(result => {
      if (mounted.current) { savedRef.current = result.interview; currentRef.current = result.interview; setSaved(result.interview); }
    }).catch(error => { if (mounted.current) setLoadError(message(error)); });
    const epoch = mediaEpoch.current;
    get<MediaItem[]>('/api/media').then(result => {
      if (mounted.current && mediaEpoch.current === epoch) live.update(() => ({ media: result }));
    }).catch(error => { if (mounted.current) setError({ text: message(error) }); });
    const unregister = registerDraft('entrevista:' + id, buffer);
    return () => { mounted.current = false; unregister(); buffer.dispose(); };
  }, [buffer, id]);
  useEffect(() => {
    if (!pendingFocus || !editorRef.current) return;
    const root = editorRef.current;
    let target: HTMLElement | null = null;
    if (pendingFocus.itemId) {
      const item = [...root.querySelectorAll<HTMLElement>('[data-interview-item]')].find(el => el.dataset.interviewItem === pendingFocus.itemId);
      target = item?.querySelector<HTMLElement>(`[data-field="${pendingFocus.field}"]`) || item?.querySelector<HTMLElement>('[data-field="media-type"]') || null;
    } else if (pendingFocus.roundId) {
      const round = [...root.querySelectorAll<HTMLElement>('[data-interview-round]')].find(el => el.dataset.interviewRound === pendingFocus.roundId);
      const menu = round?.querySelector<HTMLDetailsElement>('details');
      if (menu) menu.open = true;
      target = round?.querySelector<HTMLElement>(`[data-round-field="${pendingFocus.field}"]`) || null;
    } else target = root.querySelector<HTMLElement>(`[data-interview-${pendingFocus.field}]`);
    target?.focus();
    setPendingFocus(null);
  }, [pendingFocus, selectedId]);
  if (!saved) return <Slide crumb={<a href="#/entrevista">Entrevista</a>} title={loadError ? 'No se pudo cargar' : 'Cargando…'} back="#/entrevista">
    <p className="hint" role={loadError ? 'alert' : undefined}>{loadError || 'Cargando la entrevista…'}</p>
  </Slide>;
  const cur = draft || saved;
  const allItems = cur.rounds.flatMap(round => round.items.map(item => ({ item, round })));
  const selected = allItems.find(entry => entry.item.id === selectedId) || allItems[0];
  const selectedNumber = selected ? allItems.findIndex(entry => entry.item.id === selected.item.id) + 1 : 0;
  const issues = issuesFor(cur, error);
  const focusIssue = (issue: Issue) => { if (issue.itemId) setSelectedId(issue.itemId); setPendingFocus(issue); };
  const change = (edit: (value: Interview) => Interview) => {
    if (!currentRef.current) return;
    const next = edit(currentRef.current);
    if (next === currentRef.current) return;
    currentRef.current = next;
    buffer.push({ title: next.title, guest: next.guest, rounds: next.rounds });
    setDraft(next); setError(null);
  };
  const changeItem = (roundId: string, itemId: string, edit: (value: InterviewItem) => InterviewItem) => change(value => ({ ...value,
    rounds: value.rounds.map(round => round.id === roundId ? { ...round, items: round.items.map(item => item.id === itemId ? edit(item) : item) } : round),
  }));
  const setMedia = (roundId: string, itemId: string, type: string) => changeItem(roundId, itemId, item => {
    const { media: _media, ...rest } = item;
    if (type === 'image' || type === 'video') return { ...rest, media: { type, file: '' } };
    if (type === 'youtube') return { ...rest, media: { type, url: '' } };
    if (type === 'post') return { ...rest, media: { type, author: '', text: '', date: '', url: '' } };
    return rest;
  });
  const updateSource = (roundId: string, itemId: string, field: 'url' | 'date', text: string) => changeItem(roundId, itemId, item => {
    const source = { url: item.source?.url || '', date: item.source?.date || '', [field]: text };
    if (source.url || source.date) return { ...item, source };
    const { source: _source, ...rest } = item; return rest;
  });
  const uploadFile = async (roundId: string, itemId: string, kind: LocalMedia['type'], file: File) => {
    mediaEpoch.current++;
    try {
      const result = await uploader.run([file]);
      if (result && mounted.current) changeItem(roundId, itemId, item => item.media?.type === kind ? { ...item, media: { type: kind, file: result.name } } : item);
    } catch (error) { if (mounted.current) setError({ text: message(error) }); }
  };
  const moveRound = (roundId: string, delta: number) => change(value => {
    const from = value.rounds.findIndex(round => round.id === roundId), to = from + delta;
    if (from < 0 || to < 0 || to >= value.rounds.length) return value;
    const rounds = value.rounds.slice();
    [rounds[from], rounds[to]] = [rounds[to], rounds[from]];
    return { ...value, rounds };
  });
  const moveItem = (roundId: string, itemId: string, destination: string) => change(value => {
    const source = value.rounds.find(round => round.id === roundId);
    const target = value.rounds.find(round => round.id === destination);
    const item = source?.items.find(entry => entry.id === itemId);
    if (!item || !target || destination === roundId) return value;
    return { ...value, rounds: value.rounds.map(round => round.id === roundId ? { ...round, items: round.items.filter(entry => entry.id !== itemId) }
      : round.id === destination ? { ...round, items: [...round.items, item] } : round) };
  });
  const select = guard(async () => {
    if (selectLock.current || isSaving() || interview?.interviewId === id) return;
    selectLock.current = true; setSelecting(true);
    try { await post('/api/interviews/select', { id }); }
    finally { selectLock.current = false; if (mounted.current) setSelecting(false); }
  });
  const remove = guard(async () => {
    if (isSaving() || deleting || !confirmDelete(saved.title, 'esta entrevista')) return;
    setDeleting(true);
    try {
      await del(`/api/interviews/${enc(id)}`);
      buffer.discard(); await refresh(); go('#/entrevista');
    } finally { if (mounted.current) setDeleting(false); }
  });
  let itemNumber = 0;
  return <Slide crumb={<><a href="#/entrevista">Entrevista</a> › {cur.title}</>} title={cur.title} back="#/entrevista" wide
    head={<div className="interview-detail-head">
      <div className="lv-shead-actions interview-detail-actions">
        <button type="button" data-interview-select className="eg-btn eg-btn--secondary eg-btn--sm" disabled={selecting || isSaving() || interview?.interviewId === id} onClick={select}>{interview?.interviewId === id ? '✓ Usar en directo · activa' : 'Usar en directo'}</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving() || deleting} onClick={remove}>Borrar entrevista…</button>
      </div>
      <InterviewPad compact enabled={interview?.interviewId === id} label="Controles del directo" cls={{ root: 'interview-head-controls', btn: 'eg-btn eg-btn--ghost eg-btn--sm', primary: 'eg-btn eg-btn--primary eg-btn--sm', muted: 'hint', row: 'row tight', note: 'hint', title: 'hint' }} />
    </div>}
    foot={<InterviewSaveBar count={countChanges(saved, cur)} issues={issues} focusIssue={focusIssue} />}>
    <div data-interview-editor ref={editorRef}>
      {error && <p className="hint err-inline" role="alert" data-interview-error>{error.text}</p>}
      <Box title="Entrevista" className="interview-meta" aside={<span className="hint">{cur.rounds.length} rondas · {allItems.length} preguntas · {allItems.filter(x => x.item.aprobado).length} aprobadas</span>}>
        <div className="interview-meta-grid">
          <label>Título <input data-interview-title value={cur.title} onChange={e => change(value => ({ ...value, title: e.target.value }))} /></label>
          <label>Persona invitada <input data-interview-guest value={cur.guest.name} onChange={e => change(value => ({ ...value, guest: { ...value.guest, name: e.target.value } }))} /></label>
          <label>Biografía <textarea rows={1} data-interview-bio value={cur.guest.bio || ''} onChange={e => change(value => ({ ...value, guest: { ...value.guest, bio: e.target.value } }))} /></label>
        </div>
      </Box>
      <div className="interview-layout">
        <Box title="Guion" className="interview-outline" aside={<span className="hint">{cur.rounds.length} rondas · {allItems.length} preguntas</span>}>
          <div data-interview-outline>
            {cur.rounds.map((round, roundIndex) => <section key={round.id} className="interview-round" data-interview-round={round.id}>
              <div className="interview-round-head"><span>{number(roundIndex + 1)}</span><b>{round.title || `Ronda ${roundIndex + 1}`}</b><span className="hint">{round.items.length}</span>
                <details className="interview-round-menu" data-round-menu><summary aria-label={`Opciones de la ronda ${round.title || roundIndex + 1}`}>⋯</summary><div className="interview-round-popover">
                  <label>Nombre de la ronda <input data-round-field="title" value={round.title} onChange={e => change(value => ({ ...value, rounds: value.rounds.map(entry => entry.id === round.id ? { ...entry, title: e.target.value } : entry) }))} /></label>
                  <button type="button" data-round-act="up" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={roundIndex === 0} onClick={() => moveRound(round.id, -1)}>↑ Subir ronda</button>
                  <button type="button" data-round-act="down" className="eg-btn eg-btn--ghost eg-btn--sm" disabled={roundIndex === cur.rounds.length - 1} onClick={() => moveRound(round.id, 1)}>↓ Bajar ronda</button>
                  <button type="button" data-round-act="delete" className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={() => {
                    if (!confirm(`¿Borrar la ronda «${round.title}» y todas sus preguntas?`)) return;
                    change(value => ({ ...value, rounds: value.rounds.filter(entry => entry.id !== round.id) }));
                  }}>Borrar ronda…</button>
                  <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => {
                    const itemId = newId('q', cur.rounds);
                    change(value => ({ ...value, rounds: value.rounds.map(r => r.id === round.id ? { ...r, items: [...r.items, { id: itemId, question: '', aprobado: false }] } : r) }));
                    setSelectedId(itemId);
                  }}>+ Añadir pregunta</button>
                </div></details>
              </div>
              {round.items.map(item => {
                const n = ++itemNumber;
                const itemIssues = issues.filter(issue => issue.itemId === item.id);
                const sourceIncomplete = itemIssues.some(issue => issue.field === 'source-url' || issue.field === 'source-date') && !!item.source && (!item.source.url.trim() || !item.source.date.trim());
                return <button type="button" key={item.id} data-interview-outline-item={item.id} aria-current={selected?.item.id === item.id ? 'true' : undefined}
                  className={`interview-outline-item${selected?.item.id === item.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                  <span className="interview-item-number">{number(n)}</span><span className="interview-item-content"><span className="interview-item-title">{item.question || 'Pregunta sin texto'}</span>
                    <span className="interview-item-meta"><Dot tone={item.aprobado ? 'ok' : 'warn'}>{item.aprobado ? 'Aprobada' : 'Sin aprobar'}</Dot> · {item.media ? mediaNames[item.media.type] : 'Sin media'}
                      {itemIssues.length > 0 && <span className="err-inline"> · {sourceIncomplete ? 'Fuente incompleta' : itemIssues[0].label}</span>}
                    </span></span>
                </button>;
              })}
            </section>)}
            {!cur.rounds.length && <p className="hint">Esta entrevista todavía no tiene rondas.</p>}
          </div>
          <div className="interview-outline-foot"><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => change(value => ({ ...value, rounds: [...value.rounds, { id: newId('r', value.rounds), title: `Ronda ${value.rounds.length + 1}`, items: [] }] }))}>+ Añadir ronda</button></div>
        </Box>
        {selected ? (() => {
          const { item, round } = selected;
          const itemIssues = issues.filter(issue => issue.itemId === item.id);
          const invalid = (field: string) => itemIssues.some(issue => issue.field === field) || undefined;
          return <article data-interview-item={item.id} className="lv-box interview-question-editor">
            <div className="interview-question-head"><div><h3>Pregunta {number(selectedNumber)}</h3><p className="hint">{round.title} · edición del borrador</p></div>
              <button type="button" data-field="delete" className="eg-btn eg-btn--ghost eg-btn--sm danger" onClick={() => {
                if (!confirmDelete(item.question, 'esta pregunta')) return;
                change(value => ({ ...value, rounds: value.rounds.map(r => r.id === round.id ? { ...r, items: r.items.filter(q => q.id !== item.id) } : r) }));
              }}>Quitar pregunta…</button>
            </div>
            <div className="interview-editor-grid"><div className="interview-fields">
              <label>Pregunta <input data-field="question" aria-invalid={invalid('question')} value={item.question} onChange={e => changeItem(round.id, item.id, value => ({ ...value, question: e.target.value }))} /></label>
              <label>Notas privadas <small>Nunca salen en pantalla</small><textarea rows={2} data-field="notes" aria-invalid={invalid('notes')} value={item.notes || ''} onChange={e => changeItem(round.id, item.id, value => ({ ...value, notes: e.target.value }))} /></label>
              <label className="check"><input data-field="approved" type="checkbox" checked={item.aprobado} onChange={e => changeItem(round.id, item.id, value => ({ ...value, aprobado: e.target.checked }))} /> Aprobada para mostrar</label>
              <label>Mover a la ronda <select data-field="move-round" value={round.id} disabled={cur.rounds.length < 2} onChange={e => moveItem(round.id, item.id, e.target.value)}>
                {cur.rounds.map((entry, i) => <option key={entry.id} value={entry.id}>{entry.title || `Ronda ${i + 1}`}</option>)}
              </select></label>
              <div className="interview-subhead">Media <small>Solo un tipo por pregunta</small></div>
              <label>Tipo de media <select data-field="media-type" value={item.media?.type || ''} onChange={e => setMedia(round.id, item.id, e.target.value)}>
                <option value="">Sin media</option><option value="image">Imagen</option><option value="video">Vídeo</option><option value="youtube">YouTube</option><option value="post">Post</option>
              </select></label>
              {(item.media?.type === 'image' || item.media?.type === 'video') && (() => {
                const local = item.media as LocalMedia;
                const choices = media.filter(file => file.kind === local.type);
                return <div className="row2">
                  <label>Elegir archivo <select data-field="media-file" aria-invalid={invalid('media-file')} value={local.file} onChange={e => changeItem(round.id, item.id, value => ({ ...value, media: { type: local.type, file: e.target.value } }))}>
                    <option value="">Elige un archivo</option>
                    {local.file && !choices.some(file => file.name === local.file) && <option value={local.file}>{local.file} · no encontrado</option>}
                    {choices.map(file => <option key={file.name} value={file.name}>{file.name}</option>)}
                  </select></label>
                  <label>Subir {local.type === 'image' ? 'imagen' : 'vídeo'} <input data-field="media-upload" type="file" accept={local.type === 'image' ? 'image/*' : 'video/*'} onChange={e => {
                    const file = e.target.files?.[0]; e.target.value = ''; if (file) void uploadFile(round.id, item.id, local.type, file);
                  }} /></label>
                </div>;
              })()}
              {item.media?.type === 'youtube' && <div className="row2">
                <label>URL de YouTube <input data-field="youtube-url" aria-invalid={invalid('youtube-url')} value={item.media.url} onChange={e => changeItem(round.id, item.id, value => value.media?.type === 'youtube' ? { ...value, media: { ...value.media, url: e.target.value } } : value)} /></label>
                <label>Minuto de inicio <input data-field="youtube-start" aria-invalid={invalid('youtube-start')} type="number" min={0} max={1439} value={item.media.startMinute ?? ''} onChange={e => changeItem(round.id, item.id, value => {
                  if (value.media?.type !== 'youtube') return value;
                  const { startMinute: _start, ...rest } = value.media;
                  return { ...value, media: e.target.value === '' ? rest : { ...rest, startMinute: Number(e.target.value) } };
                })} /></label>
              </div>}
              {item.media?.type === 'post' && <>
                <label>Autor del post <input data-field="post-author" aria-invalid={invalid('post-author')} value={item.media.author} onChange={e => changeItem(round.id, item.id, value => value.media?.type === 'post' ? { ...value, media: { ...value.media, author: e.target.value } } : value)} /></label>
                <label>Texto del post <textarea rows={2} data-field="post-text" aria-invalid={invalid('post-text')} value={item.media.text} onChange={e => changeItem(round.id, item.id, value => value.media?.type === 'post' ? { ...value, media: { ...value.media, text: e.target.value } } : value)} /></label>
                <div className="row2"><label>Fecha del post <input data-field="post-date" aria-invalid={invalid('post-date')} placeholder="AAAA-MM-DD" value={item.media.date} onChange={e => changeItem(round.id, item.id, value => value.media?.type === 'post' ? { ...value, media: { ...value.media, date: e.target.value } } : value)} /></label>
                  <label>URL del post <input data-field="post-url" aria-invalid={invalid('post-url')} value={item.media.url} onChange={e => changeItem(round.id, item.id, value => value.media?.type === 'post' ? { ...value, media: { ...value.media, url: e.target.value } } : value)} /></label></div>
              </>}
              <div className="interview-subhead">Fuente <small>Opcional · URL y fecha juntas</small></div>
              <div className="row2">
                <label>URL de la fuente <input data-field="source-url" aria-invalid={invalid('source-url')} value={item.source?.url || ''} onChange={e => updateSource(round.id, item.id, 'url', e.target.value)} /></label>
                <label>Fecha de la fuente <input data-field="source-date" aria-invalid={invalid('source-date')} placeholder="AAAA-MM-DD" value={item.source?.date || ''} onChange={e => updateSource(round.id, item.id, 'date', e.target.value)} /></label>
              </div>
              {itemIssues.some(issue => issue.field.startsWith('source-')) && <p className="hint err-inline">{itemIssues.find(issue => issue.field.startsWith('source-'))?.label}: revisa la fuente antes de guardar.</p>}
            </div><InterviewPreview item={item} /></div>
          </article>;
        })() : <Box title="Pregunta" className="interview-empty"><p className="hint">Añade una pregunta desde el menú de una ronda para empezar.</p></Box>}
      </div>
      <UploadBar name={uploader.name} progress={uploader.progress} />
    </div>
  </Slide>;
}
