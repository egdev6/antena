// Overlays propios (S3, S10): el catálogo en tarjetas → slide con el editor HTML/CSS/JS, la vista
// previa en vivo y las pruebas. Lo que el agente crea o cambia por MCP llega por SSE; si hay
// cambios sin guardar, el editor no los pisa: avisa y deja cargar la versión nueva a mano.
import { useEffect, useRef, useState } from 'react';
import { OVERLAY_ACTION_LABELS } from '../../../../src/actions.mjs';
import { del, enc, get, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { ManualDraft } from '../../lib/manual-draft';
import { isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { BrowserSource, codeTab, confirmDelete, copy, EmptyState, guard, Icon, Panel, Stage, Switch, WidgetLayout } from '../../lib/ui';
import { Card, CardGroup, PageHead, SaveBar, Slide, Tabs } from '../../lib/layout';
import { IC } from '../../lib/icons';
import { go } from '../router';
import { origin } from './Widgets';
import type { CustomOverlay as BaseCustomOverlay, CustomOverlayField, MediaItem } from '../../lib/types';

type CustomOverlay = BaseCustomOverlay & { reapprovalRequired?: boolean };

type OverlayDraft = Omit<CustomOverlay, 'id' | 'updatedAt'>;
const CODE_TABS = [{ id: 'html', label: 'HTML' }, { id: 'css', label: 'CSS' }, { id: 'js', label: 'JavaScript' }, { id: 'fields', label: 'Campos' }];
const FIELDS_TIP = '[\n  { "key": "titulo", "label": "Título", "type": "text", "default": "Sígueme" },\n  { "key": "color", "label": "Color", "type": "color", "default": "#ff0036" }\n]';
const CODE_TIP: Record<string, string> = {
  html: '<div class="marco">\n  <span class="quien">EGDEV</span>\n</div>',
  css: '.marco {\n  position: absolute;\n  inset: 40px;\n  border: 3px solid #00E0FF;\n  border-radius: 18px;\n}',
  js: "antena.on('alert', a => {\n  document.querySelector('.quien').textContent = a.vars.user;\n});",
};
const PROBAR: [string, string][] = [['alert', 'Probar alerta'], ['chat', 'Probar chat'], ['viewers', 'Probar espectadores']];
const size = (o: { width: number; height: number }) => `${o.width}×${o.height}`;

/** Un tipo pedido que no esté en el catálogo compartido se enseña tal cual. */
const PERMISOS: Record<string, string> = OVERLAY_ACTION_LABELS;
/** Firma de las aprobaciones: aprobar no cambia updatedAt, así que el editor compara esta firma. */
const approvalsOf = (o: CustomOverlay | null | undefined) => o
  ? `${o.approvedAt ?? 0}|${!!o.reapprovalRequired}|${(o.requestedPermissions ?? []).join(',')}|${(o.permissions ?? []).join(',')}`
  : '';
/** Firma de los valores: cambiarlos (p. ej. por MCP) tampoco cambia updatedAt. */
const valuesOf = (o: CustomOverlay | null | undefined) => JSON.stringify(o?.values ?? {});

/** Catálogo de overlays propios. Lo que crea el agente por MCP aparece aquí sin recargar. */
export function Overlays({ parts }: { parts: string[] }) {
  const list: CustomOverlay[] = useLive(s => s.customOverlays || []);
  const open = parts[1];
  const create = guard(async () => {
    const { overlay } = await post<{ overlay: CustomOverlay }>('/api/custom-overlays', { name: 'Overlay nuevo' });
    live.update(s => ({ customOverlays: [...(s.customOverlays || []).filter(o => o.id !== overlay.id), overlay] }));
    go(`#/overlays/${enc(overlay.id)}`);
  });
  const nuevo = <button type="button" className="eg-btn eg-btn--primary eg-btn--sm" onClick={create}><Icon d={IC.plus} className="eg-btn__icon" />Nuevo overlay</button>;
  return <>
    <PageHead crumb={`Configurar · ${list.length === 1 ? '1 personalizado' : `${list.length} personalizados`}`} title="Personalizados"
      desc="Overlays y widgets de HTML, CSS y JavaScript para el programa de emisión: un marco para la cámara, un título animado, lo que imagines. El agente los crea por MCP; aquí los ajustas, los pruebas y los ves en vivo. Si declaran campos, se configuran con un formulario sin tocar el código."
      actions={nuevo} />
    {list.length
      ? <div className="lv-groups">
        <CardGroup title="Tus personalizados" count={list.length} note="Cada uno es una capa de navegador: su dirección está también en Fuentes del programa de emisión" wide>
          {list.map(o => <Card key={o.id} href={`#/overlays/${enc(o.id)}`} label={`Abrir ${o.name}`} open={open === o.id}
            title={o.name} aside={<span className="lv-cmeta">{size(o)}</span>}
            thumb={<div className="lv-coverlay"><i /><b>HTML</b></div>}
            foot={<><span className="lv-cmeta">/custom/{o.id}</span><span className="sp" />
              <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(`${origin()}/custom/${o.id}`)}>Copiar URL</button></>} />)}
        </CardGroup>
      </div>
      : <EmptyState action={<button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={create}>Crear uno vacío</button>}>
        Todavía no hay overlays propios. Pídele a Claude: «crea un overlay con un marco para la cámara», o crea uno vacío y escribe el HTML, el CSS y el JavaScript aquí.
      </EmptyState>}
    {open && list.some(o => o.id === open) ? <OverlaySlide key={open} id={open} /> : null}
  </>;
}

/** Editor de un overlay: ajustes, código con pestañas y vista previa en vivo. Guardado manual. */
function OverlaySlide({ id }: { id: string }) {
  useManualSave();
  useDraftVersion();
  const remote = useLive(s => (s.customOverlays || []).find(o => o.id === id));
  const themeCss = useLive(s => s.config.customOverlayCss?.[id] ?? '');
  const [saved, setSaved] = useState<CustomOverlay | null>(remote || null);
  const [draft, setDraft] = useState<Partial<OverlayDraft> | null>(null);
  /** Versión remota que llegó mientras había cambios sin guardar: se carga solo a mano. */
  const [pending, setPending] = useState<CustomOverlay | null>(null);
  const [tab, setTab] = useState('html');
  const savedRef = useRef<CustomOverlay | null>(saved);
  savedRef.current = saved;
  const [buffer] = useState(() => new ManualDraft<Partial<OverlayDraft>, CustomOverlay>({
    empty: () => ({}),
    merge: (older, newer) => ({ ...older, ...newer }),
    take: () => savedRef.current as CustomOverlay,
    keys: () => ['overlay'],
    persist: async patch => (await put<{ overlay: CustomOverlay }>(`/api/custom-overlays/${enc(id)}`, patch)).overlay,
    publish: (baseline, newer) => {
      savedRef.current = baseline;
      setSaved(baseline);
      setPending(null);
      setDraft(Object.keys(newer).length ? { ...baseline, ...newer } : null);
      live.update(s => ({ customOverlays: (s.customOverlays || []).map(o => (o.id === baseline.id ? baseline : o)) }));
    },
    restore: baseline => { savedRef.current = baseline; setSaved(baseline); setDraft(null); setPending(null); },
    // #351: Discard restores the overlay as last saved, even when the agent changed it meanwhile.
    rebase: server => server.customOverlays?.find(o => o.id === id),
  }));
  useEffect(() => {
    const unregister = registerDraft('overlay:' + id, buffer);
    return () => { unregister(); buffer.dispose(); };
  }, [buffer, id]);
  // Aprobar o revocar un permiso de acción (S11a): la petición sale de ESTE navegador, que es lo
  // único que el servidor acepta con Sec-Fetch-Site: same-origin. Devuelve el overlay guardado.
  const approve = guard(async (kind: string, on: boolean, base: CustomOverlay) => {
    const requested = base.requestedPermissions ?? [];
    const next = requested.filter(k => (k === kind ? on : (base.permissions ?? []).includes(k)));
    const { overlay } = await put<{ overlay: CustomOverlay }>(`/api/custom-overlays/${enc(id)}/permissions`, { permissions: next });
    applyApprovals(overlay);
  });
  /** Aprobar no versiona el código: se fusionan solo los campos de permisos, sin tocar el borrador. */
  function applyApprovals(overlay: CustomOverlay) {
    const cur = savedRef.current as CustomOverlay;
    const next: CustomOverlay = {
      ...cur,
      requestedPermissions: overlay.requestedPermissions ?? [], permissions: overlay.permissions ?? [],
      approvedAt: overlay.approvedAt ?? 0, approvedUpdatedAt: overlay.approvedUpdatedAt ?? 0,
      reapprovalRequired: !!overlay.reapprovalRequired,
    };
    savedRef.current = next;
    setSaved(next);
    live.update(s => ({ customOverlays: (s.customOverlays || []).map(o => (o.id === next.id ? next : o)) }));
  }
  // Un cambio que llega por SSE (agente, MCP u otra ventana): sin cambios locales entra solo;
  // con cambios locales solo se anuncia, para no perder lo que el usuario estaba escribiendo.
  const remoteAt = remote?.updatedAt;
  const remoteApprovals = approvalsOf(remote);
  const remoteValues = valuesOf(remote);
  useEffect(() => {
    if (!remote) return;
    const cur = savedRef.current;
    if (!cur) { savedRef.current = remote; setSaved(remote); return; }
    if (Number(remote.updatedAt || 0) === Number(cur.updatedAt || 0)) {
      // Misma versión de código: si cambió la aprobación (otra ventana, el propio PUT), se
      // fusiona sin anunciar cambios ni pisar el borrador.
      if (approvalsOf(remote) !== approvalsOf(cur)) applyApprovals(remote);
      // Valores cambiados fuera (agente, otra ventana): entran si no hay cambios sin guardar.
      if (valuesOf(remote) !== valuesOf(cur)) {
        if (buffer.dirty()) { setPending(remote); return; }
        const next = { ...(savedRef.current as CustomOverlay), values: remote.values ?? {} };
        savedRef.current = next;
        setSaved(next);
      }
      return;
    }
    if (buffer.dirty()) { setPending(remote); return; }
    savedRef.current = remote;
    setSaved(remote);
    setDraft(null);
    setPending(null);
  }, [remote, remoteAt, remoteApprovals, remoteValues, buffer]);
  if (!saved) return <Slide crumb={<a href="#/overlays">Personalizados</a>} title="Overlay" back="#/overlays">
    <p className="hint">No existe ese overlay: puede que se haya borrado.</p>
  </Slide>;

  const cur: OverlayDraft = { ...saved, ...(draft || {}) };
  const set = (patch: Partial<OverlayDraft>) => { buffer.push(patch); setDraft(d => ({ ...d, ...patch })); };
  const loadPending = () => {
    if (!pending) return;
    buffer.discard();
    savedRef.current = pending;
    setSaved(pending);
    setDraft(null);
    setPending(null);
  };
  const remove = guard(async () => {
    if (isSaving() || !confirmDelete(saved.name, 'este overlay')) return;
    buffer.discard();
    await del(`/api/custom-overlays/${enc(id)}`);
    live.update(s => ({ customOverlays: (s.customOverlays || []).filter(o => o.id !== id) }));
    go('#/overlays');
  });
  const field = (['html', 'css', 'js'].includes(tab) ? tab : 'html') as 'html' | 'css' | 'js';
  const fields = cur.fields ?? [];
  const requested = saved.requestedPermissions ?? [];
  const approved = saved.permissions ?? [];
  // El servidor retira los permisos si cambia el código; los ajustes no disparan el aviso.
  const codeChanged = !!saved.reapprovalRequired;
  return <Slide crumb={<><a href="#/overlays">Personalizados</a> › {saved.name}</>} back="#/overlays" wide
    title={<input className="lv-title-input" aria-label="Nombre del overlay" value={cur.name} onChange={e => set({ name: e.target.value })} />}
    head={<button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={remove}>Borrar overlay…</button>}
    foot={<SaveBar />}>
    {pending ? <div className="eg-notice eg-notice--info" role="status" data-agent-change>
      <Icon d={IC.bell} />
      <span className="eg-notice__text">El agente ha cambiado este overlay. Tienes cambios sin guardar, así que tu borrador sigue como está.</span>
      <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={loadPending}>Cargar la versión nueva</button>
    </div> : null}
    <WidgetLayout
      source={<BrowserSource url={`${origin()}/custom/${id}`} size={size(saved)} hint="Añade una fuente de navegador con el tamaño indicado. La capa se recarga sola cada vez que guardas." />}
      preview={<Stage eyebrow="Vista previa" aside={<span>{size(cur)} · en vivo</span>} src={`/custom/${enc(id)}`} w={cur.width} h={cur.height} />}>
      <Panel title="Ajustes">
        <div className="row3">
          <label>Ancho (px)<input type="number" aria-label="Ancho" min={16} value={String(cur.width)} onChange={e => set({ width: Number(e.target.value) })} /></label>
          <label>Alto (px)<input type="number" aria-label="Alto" min={16} value={String(cur.height)} onChange={e => set({ height: Number(e.target.value) })} /></label>
          <Switch checked={cur.transparent !== false} onChange={v => set({ transparent: v })}>Fondo transparente</Switch>
        </div>
        <div className="row tight">
          {PROBAR.map(([event, label]) => <button key={event} type="button" className="eg-btn eg-btn--ghost eg-btn--sm"
            onClick={guard(() => post(`/api/custom-overlays/${enc(id)}/test`, { event }), 'Prueba enviada')}>{label}</button>)}
        </div>
        <p className="hint">Las pruebas mandan datos de ejemplo a las capas abiertas de este overlay: no tocan el directo, la cola de alertas ni los totales.</p>
      </Panel>
      {fields.length ? <Panel title="Valores" aside={<span className="hint">{fields.length === 1 ? '1 campo' : `${fields.length} campos`}</span>}>
        <SettingsForm fields={fields} values={cur.values ?? {}} onChange={(key, value) => set({ values: { ...(cur.values ?? {}), [key]: value } })} />
        <p className="hint">Los valores llegan a la capa en vivo al guardar, sin recargarla. «Por defecto» vuelve al valor que trae el campo.</p>
      </Panel> : null}
      <Panel title="Código" aside={<span className="hint">{CODE_TABS.find(t => t.id === tab)?.label}</span>}>
        <Tabs tabs={CODE_TABS} tab={tab === 'fields' ? 'fields' : field} onTab={setTab} label="Código" />
        {tab === 'fields'
          ? <FieldsEditor key={JSON.stringify(saved.fields ?? [])} fields={fields} onChange={next => set({ fields: next })} />
          : <textarea className="code" data-code={field} aria-label={`${CODE_TABS.find(t => t.id === tab)?.label} del overlay`}
            spellCheck={false} placeholder={CODE_TIP[field]} value={String(cur[field])} onKeyDown={codeTab}
            onChange={e => set(field === 'html' ? { html: e.target.value } : field === 'css' ? { css: e.target.value } : { js: e.target.value })} />}
      </Panel>
      <Panel title="CSS de este tema">
        <p className="hint">Este CSS pertenece al tema activo y se guarda en él. Cambiarlo no modifica el código ni las aprobaciones del overlay.</p>
        <textarea className="code" aria-label="CSS de este tema" spellCheck={false} value={themeCss} onKeyDown={codeTab}
          onChange={e => live.patchConfig({ customOverlayCss: { [id]: e.target.value } })} />
      </Panel>
      <Panel title="Permisos" aside={<span className="hint">{requested.length ? `${approved.length} de ${requested.length} aprobados` : 'sin permisos'}</span>}>
        <div data-permisos>
          {requested.length
            ? <div className="lv-permisos">
              {requested.map(kind => <div key={kind} data-perm={kind}>
                <Switch checked={approved.includes(kind)} disabled={!!pending} onChange={v => approve(kind, v, saved)}>{PERMISOS[kind] ?? kind}</Switch>
                {PERMISOS[kind] ? null : <span className="hint"> Tipo de acción desconocido para el panel: {kind}.</span>}
              </div>)}
            </div>
            : <p className="hint">Este overlay no pide ningún permiso. Si necesita cambiar de escena, escribir en el chat o hablar, pídeselo al agente (por MCP) y apruébalo aquí.</p>}
          {codeChanged ? <div className="eg-notice eg-notice--warning eg-notice--sm" role="alert" data-approval-stale>
            <Icon d={IC.bell} />
            <span className="eg-notice__text">El código ha cambiado desde que aprobaste los permisos. Se han retirado: revísalo y vuelve a aprobarlos si sigue haciendo lo que esperas.</span>
          </div> : null}
          <p className="hint">Las acciones (<code>antena.run(…)</code>) solo se ejecutan con lo que apruebas aquí; el agente las pide, no las aprueba. Un bucle que pida demasiadas se frena a las 10 acciones cada 10 segundos.</p>
        </div>
      </Panel>
    </WidgetLayout>
  </Slide>;
}

/** Default value of a field when nothing is stored (same rule as the server's overlaySettings). */
function fieldDefault(field: CustomOverlayField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === 'select') return field.options?.[0] ?? '';
  if (field.type === 'number') return field.min ?? 0;
  return ({ text: '', toggle: false, color: '#000000', list: [], media: '' } as Record<string, unknown>)[field.type];
}
const hex6 = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map(c => c + c).join('') : /^#[0-9a-f]{8}$/i.test(v) ? v.slice(0, 7) : '#000000');

/** Form generated from the declared fields: one control per type. null = back to the default. */
function SettingsForm({ fields, values, onChange }: { fields: CustomOverlayField[]; values: Record<string, unknown>; onChange: (key: string, value: unknown) => void }) {
  const media = useLive(s => (s.media || []) as MediaItem[]);
  const needsMedia = fields.some(f => f.type === 'media');
  useEffect(() => {
    if (needsMedia) get<MediaItem[]>('/api/media').then(result => live.update(() => ({ media: result }))).catch(() => {});
  }, [needsMedia]);
  return <div className="lv-settings" data-settings>
    {fields.map(field => {
      const has = values[field.key] !== undefined && values[field.key] !== null;
      const value = has ? values[field.key] : fieldDefault(field);
      const id = 'ajuste-' + field.key;
      const reset = has && field.type !== 'toggle'
        ? <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => onChange(field.key, null)}>Por defecto</button> : null;
      if (field.type === 'toggle') return <div key={field.key} data-field={field.key}>
        <Switch checked={value === true} onChange={v => onChange(field.key, v)}>{field.label}</Switch>
      </div>;
      let control;
      if (field.type === 'number') control = <input id={id} type="number" min={field.min} max={field.max} step={field.step} value={String(value)} onChange={e => onChange(field.key, e.target.value === '' ? null : Number(e.target.value))} />;
      else if (field.type === 'select') control = <select id={id} value={String(value)} onChange={e => onChange(field.key, e.target.value)}>{(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}</select>;
      else if (field.type === 'color') control = <div className="row tight" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
        <input type="color" style={{ flex: 'none', width: 48, padding: 2 }} aria-label={`${field.label}: selector`} value={hex6(String(value))} onChange={e => onChange(field.key, e.target.value)} />
        <input id={id} style={{ flex: 1, minWidth: 0 }} value={String(value)} maxLength={9} onChange={e => onChange(field.key, e.target.value)} />
      </div>;
      else if (field.type === 'list') control = <textarea id={id} rows={4} value={(Array.isArray(value) ? value : []).join('\n')} placeholder="Un elemento por línea"
        onChange={e => onChange(field.key, e.target.value.split('\n').slice(0, 50))} />;
      else if (field.type === 'media') control = <select id={id} value={String(value)} onChange={e => onChange(field.key, e.target.value)}>
        <option value="">Sin archivo</option>
        {value && !media.some(m => m.name === value) ? <option value={String(value)}>{String(value)} (no está en Archivos)</option> : null}
        {media.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
      </select>;
      else control = <input id={id} value={String(value)} maxLength={2000} onChange={e => onChange(field.key, e.target.value)} />;
      return <div key={field.key} className="lbl" data-field={field.key}>
        <label htmlFor={id}>{field.label}</label>
        <div className="row tight" style={{ flexWrap: 'nowrap', alignItems: 'center' }}><div style={{ flex: 1, minWidth: 0 }}>{control}</div>{reset}</div>
      </div>;
    })}
  </div>;
}

/** The declared fields as JSON. Only a valid JSON list reaches the draft; the server validates the rest on save. */
function FieldsEditor({ fields, onChange }: { fields: CustomOverlayField[]; onChange: (next: CustomOverlayField[]) => void }) {
  const [text, setText] = useState(() => (fields.length ? JSON.stringify(fields, null, 2) : ''));
  const [error, setError] = useState('');
  return <>
    <textarea className="code" data-code="fields" aria-label="Campos del overlay (JSON)" spellCheck={false} placeholder={FIELDS_TIP} value={text} onKeyDown={codeTab}
      onChange={e => {
        const next = e.target.value;
        setText(next);
        if (!next.trim()) { setError(''); onChange([]); return; }
        try {
          const parsed = JSON.parse(next);
          if (!Array.isArray(parsed)) throw new Error('lista');
          setError('');
          onChange(parsed);
        } catch { setError('JSON no válido: tiene que ser una lista de campos. Los cambios no se guardan hasta corregirlo.'); }
      }} />
    {error ? <p className="hint" role="alert" data-fields-error>{error}</p> : null}
    <p className="hint">Tipos: text, number (min, max, step), toggle, select (options), color, list y media. Cada campo: key, label, type y default opcional. En el código: <code>antena.settings</code> o <code>antena.on('settings', fn)</code>.</p>
  </>;
}
