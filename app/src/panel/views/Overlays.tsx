// Overlays propios (S3, S10): el catálogo en tarjetas → slide con el editor HTML/CSS/JS, la vista
// previa en vivo y las pruebas. Lo que el agente crea o cambia por MCP llega por SSE; si hay
// cambios sin guardar, el editor no los pisa: avisa y deja cargar la versión nueva a mano.
import { useEffect, useRef, useState } from 'react';
import { del, enc, post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { ManualDraft } from '../../lib/manual-draft';
import { isSaving, registerDraft, useDraftVersion, useManualSave } from '../../lib/draft';
import { BrowserSource, codeTab, confirmDelete, copy, EmptyState, guard, Icon, Panel, Stage, Switch, WidgetLayout } from '../../lib/ui';
import { Card, CardGroup, PageHead, SaveBar, Slide, Tabs } from '../../lib/layout';
import { IC } from '../../lib/icons';
import { go } from '../router';
import { origin } from './Widgets';
import type { CustomOverlay } from '../../lib/types';

type OverlayDraft = Omit<CustomOverlay, 'id' | 'updatedAt'>;
const CODE_TABS = [{ id: 'html', label: 'HTML' }, { id: 'css', label: 'CSS' }, { id: 'js', label: 'JavaScript' }];
const CODE_TIP: Record<string, string> = {
  html: '<div class="marco">\n  <span class="quien">EGDEV</span>\n</div>',
  css: '.marco {\n  position: absolute;\n  inset: 40px;\n  border: 3px solid #00E0FF;\n  border-radius: 18px;\n}',
  js: "antena.on('alert', a => {\n  document.querySelector('.quien').textContent = a.vars.user;\n});",
};
const PROBAR: [string, string][] = [['alert', 'Probar alerta'], ['chat', 'Probar chat'], ['viewers', 'Probar espectadores']];
const size = (o: { width: number; height: number }) => `${o.width}×${o.height}`;

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
    <PageHead crumb={`Configurar · ${list.length === 1 ? '1 overlay' : `${list.length} overlays`}`} title="Overlays"
      desc="Capas de HTML, CSS y JavaScript para Meld: un marco para la cámara, un título animado, lo que imagines. El agente las crea por MCP; aquí las ajustas, las pruebas y las ves en vivo."
      actions={nuevo} />
    {list.length
      ? <div className="lv-groups">
        <CardGroup title="Tus overlays" count={list.length} note="Cada uno es una capa de navegador: su dirección está también en Fuentes para Meld" wide>
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
  }));
  useEffect(() => {
    const unregister = registerDraft('overlay:' + id, buffer);
    return () => { unregister(); buffer.dispose(); };
  }, [buffer, id]);
  // Un cambio que llega por SSE (agente, MCP u otra ventana): sin cambios locales entra solo;
  // con cambios locales solo se anuncia, para no perder lo que el usuario estaba escribiendo.
  const remoteAt = remote?.updatedAt;
  useEffect(() => {
    if (!remote) return;
    const cur = savedRef.current;
    if (!cur) { savedRef.current = remote; setSaved(remote); return; }
    if (Number(remote.updatedAt || 0) === Number(cur.updatedAt || 0)) return;
    if (buffer.dirty()) { setPending(remote); return; }
    savedRef.current = remote;
    setSaved(remote);
    setDraft(null);
    setPending(null);
  }, [remote, remoteAt, buffer]);
  if (!saved) return <Slide crumb={<a href="#/overlays">Overlays</a>} title="Overlay" back="#/overlays">
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
  return <Slide crumb={<><a href="#/overlays">Overlays</a> › {saved.name}</>} back="#/overlays" wide
    title={<input className="lv-title-input" aria-label="Nombre del overlay" value={cur.name} onChange={e => set({ name: e.target.value })} />}
    head={<button type="button" className="eg-btn eg-btn--ghost eg-btn--sm danger" disabled={isSaving()} onClick={remove}>Borrar overlay…</button>}
    foot={<SaveBar />}>
    {pending ? <div className="eg-notice eg-notice--info" role="status" data-agent-change>
      <Icon d={IC.bell} />
      <span className="eg-notice__text">El agente ha cambiado este overlay. Tienes cambios sin guardar, así que tu borrador sigue como está.</span>
      <button type="button" className="eg-btn eg-btn--secondary eg-btn--sm" onClick={loadPending}>Cargar la versión nueva</button>
    </div> : null}
    <WidgetLayout
      source={<BrowserSource url={`${origin()}/custom/${id}`} size={size(saved)} hint="En Meld: + › Browser. La capa se recarga sola cada vez que guardas." />}
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
      <Panel title="Código" aside={<span className="hint">{CODE_TABS.find(t => t.id === tab)?.label}</span>}>
        <Tabs tabs={CODE_TABS} tab={field} onTab={setTab} label="Código" />
        <textarea className="code" data-code={field} aria-label={`${CODE_TABS.find(t => t.id === tab)?.label} del overlay`}
          spellCheck={false} placeholder={CODE_TIP[field]} value={String(cur[field])} onKeyDown={codeTab}
          onChange={e => set(field === 'html' ? { html: e.target.value } : field === 'css' ? { css: e.target.value } : { js: e.target.value })} />
      </Panel>
    </WidgetLayout>
  </Slide>;
}
