// Todas las fuentes de navegador para Meld, con su tamaño y un botón de copiar.
import { useEffect, useState } from 'react';
import { get } from '../../lib/api';
import { isDesktop, openDock } from '../../lib/desktop';
import { copy, guard, Panel, toast } from '../../lib/ui';

type Src = { id: string; name: string; path: string; url: string; width?: number; height?: number; note?: string };
export function Fuentes() {
  const [d, setD] = useState<{ base: string; sources: Src[]; panels: Src[] } | null>(null);
  useEffect(() => { get<{ base: string; sources: Src[]; panels: Src[] }>('/api/sources').then(setD).catch(e => toast(e.message, true)); }, []);
  if (!d) return <p className="hint">Cargando…</p>;
  const row = (s: Src) => <li key={s.id}>
    <div className="src-main"><b>{s.name}</b>{s.width && <span className="tagm">{s.width}×{s.height}</span>}<code>{s.url}</code>{s.note && <span className="hint">{s.note}</span>}</div>
    <div className="vbtns"><a className="eg-btn eg-btn--ghost eg-btn--sm" href={s.path + (s.path.includes('?') ? '&' : '?') + 'demo'} target="_blank" rel="noopener">Ver</a><button className="eg-btn eg-btn--primary eg-btn--sm" onClick={() => copy(s.url)}>Copiar</button></div>
  </li>;
  return <>
    <header className="view-head"><div><span className="crumb">Meld y Stream Deck › Fuentes</span><h1>Fuentes para Meld</h1><p className="hint">Cada alerta, widget y panel es una fuente de navegador. Copia la dirección y pégala en Meld.</p></div>
      <div className="actions"><button className="eg-btn eg-btn--ghost" onClick={() => copy(d.sources.map(s => `${s.name}\t${s.width}×${s.height}\t${s.url}`).join('\n'))}>Copiar todas</button></div></header>
    <div className="grid2">
      <Panel title="Cómo añadirlas">
        <ol className="steps">
          <li>En Meld, en la escena: <b>+ › Browser</b>.</li>
          <li>Pega la dirección y pon el <b>ancho y alto</b> que indica cada una.</li>
          <li>En la del overlay de alertas activa <b>Add audio track</b> para que suenen.</li>
          <li>Las fuentes funcionan mientras antena está abierto (también minimizado en la bandeja).</li>
        </ol>
        <p className="hint">Meld no deja crear capas desde fuera: hay que añadirlas a mano una vez. Luego las alertas pueden mostrarlas, ocultarlas o cambiar de escena.</p>
      </Panel>
      <Panel title="Paneles dentro de Meld">
        <p className="hint" style={{ marginBottom: 10 }}>Meld no tiene paneles personalizados, pero su <b>panel de chat</b> acepta una dirección: pon ahí el <b>dock</b> y tendrás estado, pausa, marcas, preguntas y tus atajos sin salir de Meld.</p>
        <ol className="steps"><li><b>File › Preferences › User Interface</b>.</li><li>En la dirección del panel de chat pega la del dock.</li></ol>
        <ul className="src-list">{d.panels.map(row)}</ul>
        {isDesktop() && <button className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(() => openDock(true))}>Abrir el dock como ventana flotante</button>}
      </Panel>
    </div>
    <Panel title="Fuentes de navegador" aside={<span className="hint">{d.sources.length} fuentes</span>}>
      <ul className="src-list">{d.sources.map(row)}</ul>
    </Panel>
  </>;
}
