import { post } from '../../lib/api';
import { useLive } from '../../lib/live';
import { EmptyState, fmtTime, guard, Panel, PfIcon } from '../../lib/ui';

export function Historial() {
  const history = useLive(s => s.history || []);
  const types = useLive(s => s.types);
  return <>
    <header className="view-head"><div><span className="crumb">En directo › Historial</span><h1>Historial</h1><p className="hint">Las alertas que han salido en pantalla. Las pruebas no se guardan.</p></div></header>
    <Panel>{history.length ? <ol className="history">{history.map((h: any) => <li key={h.id}>
      <time>{fmtTime(h.at)}</time><span className="pf"><PfIcon platform={types[h.type]?.platform} /></span>
      <span className="t">{types[h.type]?.label || (h.type === 'command' ? 'Comando' : h.type)}</span>
      <span className="x"><b>{h.text}</b> {h.sub ? '· ' + h.sub : ''}{h.variation ? <> <span className="tagm">{h.variation.name}</span></> : null}</span>
      <button className="btn ghost sm" onClick={guard(() => post('/api/replay', { id: h.id }), 'Repitiendo')}>Repetir</button></li>)}</ol> : <EmptyState>Todavía no ha llegado ninguna alerta.</EmptyState>}</Panel>
  </>;
}
