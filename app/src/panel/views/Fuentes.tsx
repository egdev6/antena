// Todas las fuentes de navegador para Meld, con su tamaño y un botón de copiar.
import { useEffect, useState } from 'react';
import { get } from '../../lib/api';
import { copy, toast } from '../../lib/ui';
import { ListPanel, NameCell, PageHead, useListFilter } from '../../lib/layout';

type Src = { id: string; name: string; path: string; url: string; width?: number; height?: number; note?: string };
export function Fuentes(_: { parts: string[] }) {
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
    />
    <ListPanel title="Fuentes de navegador" search={f.q} onSearch={f.setQ} placeholder="Buscar fuente" cols={cols} rows={rowsOf(d.sources)} empty="Ninguna fuente coincide." />
  </>;
}
