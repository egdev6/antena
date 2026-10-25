// Todas las fuentes de navegador para Meld, con su tamaño y un botón de copiar.
import { useEffect, useState } from 'react';
import { get } from '../../lib/api';
import { isDesktop, openDock } from '../../lib/desktop';
import { copy, guard, Panel, toast } from '../../lib/ui';
import { ListPanel, NameCell, PageHead, usePageTab, useListFilter } from '../../lib/layout';

type Src = { id: string; name: string; path: string; url: string; width?: number; height?: number; note?: string };
export function Fuentes({ parts }: { parts: string[] }) {
  const [tab, setTab] = usePageTab(parts, 'fuentes', ['capas', 'paneles', 'como']);
  const f = useListFilter();
  const [d, setD] = useState<{ base: string; sources: Src[]; panels: Src[] } | null>(null);
  useEffect(() => { get<{ base: string; sources: Src[]; panels: Src[] }>('/api/sources').then(setD).catch(e => toast(e.message, true)); }, []);
  if (!d) return <p className="hint">Cargando…</p>;
  const rowsOf = (list: Src[]) => list.filter(x => f.match(x.name, x.path)).map(x => ({ id: x.id, cells: {
    name: <NameCell name={x.name} sub={x.note} />, size: <span className="lv-mono">{x.width ? `${x.width}×${x.height}` : '—'}</span>, url: <span className="lv-mono">{x.url}</span>,
    btns: <div className="row tight"><a className="eg-btn eg-btn--ghost eg-btn--sm" href={x.path + (x.path.includes('?') ? '&' : '?') + 'demo'} target="_blank" rel="noopener">Ver</a><button className="eg-btn eg-btn--secondary eg-btn--sm" onClick={() => copy(x.url)}>Copiar</button></div> } }));
  const cols = [{ key: 'name', label: 'Fuente' }, { key: 'size', label: 'Tamaño' }, { key: 'url', label: 'Dirección', hide: true }, { key: 'btns', label: '' }];
  return <>
    <PageHead crumb={`Producción · ${d.sources.length} fuentes`} title="Fuentes para Meld" desc="Cada alerta, widget y panel es una fuente de navegador. Copia la dirección y pégala en Meld."
      actions={<button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={() => copy(d.sources.map(s => `${s.name}\t${s.width}×${s.height}\t${s.url}`).join('\n'))}>Copiar todas</button>}
      tabs={[{ id: 'capas', label: 'Capas', count: d.sources.length }, { id: 'paneles', label: 'Paneles dentro de Meld', count: d.panels.length }, { id: 'como', label: 'Cómo añadirlas' }]} tab={tab} onTab={setTab} />
    {tab === 'capas' && <ListPanel title="Fuentes de navegador" search={f.q} onSearch={f.setQ} placeholder="Buscar fuente" cols={cols} rows={rowsOf(d.sources)} empty="Ninguna fuente coincide." />}
    {tab === 'paneles' && <>
      <ListPanel title="Paneles" note="Meld no tiene paneles personalizados, pero su panel de chat acepta una dirección: pon ahí el dock." cols={cols} rows={rowsOf(d.panels)} empty="—"
        foot={<>En Meld: <b>File › Preferences › User Interface</b> y pega la dirección del dock en la del panel de chat.</>} />
      {isDesktop() && <p><button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => openDock(true))}>Abrir el dock como ventana flotante</button></p>}
    </>}
    {tab === 'como' && <Panel title="Cómo añadirlas">
      <ol className="steps">
        <li>En Meld, en la escena: <b>+ › Browser</b>.</li>
        <li>Pega la dirección y pon el <b>ancho y alto</b> que indica cada una.</li>
        <li>En la del overlay de alertas activa <b>Add audio track</b> para que suenen.</li>
        <li>Las fuentes funcionan mientras antena está abierta (también minimizado en la bandeja).</li>
      </ol>
      <p className="hint">Meld no deja crear capas desde fuera: hay que añadirlas a mano una vez. Luego las alertas pueden mostrarlas, ocultarlas o cambiar de escena.</p>
    </Panel>}
  </>;
}
