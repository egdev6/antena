import { useState } from 'react';
import { post } from '../lib/api';
import { useLive } from '../lib/live';
import { guard } from '../lib/ui';
import { DockAdd } from './DockAdd';

export function DockGiveaway() {
  const giveaway = useLive(s => s.interactive?.giveaway);
  const [member, setMember] = useState(false);
  if (!giveaway) return null;
  return <section className="d-card" aria-label="Sorteo"><div className="d-card-h">Sorteo<span className="d-meta">{giveaway.open ? 'abierto' : 'cerrado'} · {giveaway.count === 1 ? '1 participante' : `${giveaway.count || 0} participantes`}</span></div>
    <div className="d-row">{giveaway.open ? <button className="d-btn sm grow" onClick={guard(() => post('/api/giveaway/close'), 'Sorteo cerrado')}>Cerrar</button>
      : <button className="d-btn sm grow" onClick={guard(() => post('/api/giveaway/open', { reset: true }), 'Sorteo abierto')}>Abrir</button>}
      <button className="d-btn sm grow pri" disabled={!giveaway.count} title={giveaway.count ? 'Elige un ganador' : 'Todavía no hay participantes'} onClick={guard(() => post('/api/giveaway/draw'), 'Sorteado')}>Sortear</button></div>
    <h3 className="d-sub">Participantes</h3>
    {giveaway.entries.length ? <div className="d-items">{giveaway.entries.slice().reverse().map(entry => <article className="d-item" key={entry.user}>
      <div className="d-item-text"><b>{entry.user}</b>{entry.member && <small>sub o miembro</small>}</div>
      <div className="d-item-actions"><button type="button" className="d-btn sm" aria-label={`Quitar a ${entry.user}`} onClick={guard(() => post('/api/giveaway/remove', { user: entry.user }))}>Quitar</button></div>
    </article>)}</div> : <p className="d-muted">Nadie todavía.</p>}
    <DockAdd label="Añadir participante" placeholder="Añadir participante…" onAdd={async user => {
      const result = await post<{ added: boolean }>('/api/giveaway/join', { user, member });
      if (!result.added) throw new Error('Esta persona ya está en el sorteo.');
    }}><label className="d-check"><input type="checkbox" checked={member} onChange={e => setMember(e.target.checked)} /> sub o miembro</label></DockAdd>
    <div className="d-winners"><h3 className="d-sub">Ganadores</h3>
      {giveaway.winners.length ? <div className="d-items">{giveaway.winners.map(winner => <div className="d-item d-item-text" key={winner.user + winner.at}><b>{winner.user}</b></div>)}</div>
        : <p className="d-muted">Aún no se ha sorteado.</p>}
    </div>
  </section>;
}
