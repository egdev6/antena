import { del, enc, post } from '../lib/api';
import { useLive } from '../lib/live';
import { guard } from '../lib/ui';
import { DockAdd } from './DockAdd';

export function DockTierlist() {
  const I = useLive(s => s.interactive);
  const lists = I?.tierlists || [];
  const vote = I?.vote;
  const list = lists.find(item => item.id === I?.shownTierlist);
  const base = list ? `/api/tierlists/${enc(list.id)}` : '';
  return <>
    {vote ? <section className="d-card" aria-label="Tier list"><div className="d-card-h">Tier list<span className="d-meta">{vote.item?.label ? `Votando ${vote.item.label} · ` : ''}{vote.total} votos</span></div>
      <div className="d-row"><button className="d-btn sm grow" onClick={guard(() => post('/api/vote/close', { apply: true }), 'Votación colocada')}>Cerrar y colocar</button>
      <button className="d-btn sm" onClick={guard(() => post('/api/vote/cancel'), 'Votación cancelada')}>Cancelar</button></div></section>
      : <p className="d-muted">Ninguna votación abierta.</p>}
    {lists.length ? <section className="d-card" aria-label="Elementos de la tier list">
      <label className="d-pick">Lista en pantalla
        <select aria-label="Lista en pantalla" value={list?.id || ''} onChange={e => guard(() => post(`/api/tierlists/${enc(e.target.value)}/show`))()}>
          <option value="" disabled>Elige una lista</option>
          {lists.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {list ? <>
        <h3 className="d-sub">Elementos</h3>
        {list.items.length ? <div className="d-items">{list.items.map(item => <article className="d-item" key={item.id}>
          <div className="d-item-text"><b>{item.label}</b>{list.placements[item.id] && <small>{list.tiers.find(tier => tier.id === list.placements[item.id])?.label}</small>}</div>
          <div className="d-item-actions">
            <button type="button" className="d-btn sm" aria-label={`Votar ${item.label}`} disabled={!!vote} onClick={guard(() => post(base + '/vote', { item: item.id }))}>Votar</button>
            <button type="button" className="d-btn sm" aria-label={`Quitar ${item.label}`} onClick={guard(() => del(`${base}/items/${enc(item.id)}`))}>Quitar</button>
          </div>
        </article>)}</div> : <p className="d-muted">Sin elementos.</p>}
        <DockAdd key={list.id} label="Añadir un elemento" placeholder="Añadir un elemento…" onAdd={async label => { await post(base + '/items', { label }); }} />
      </> : <p className="d-muted">Elige qué lista poner en pantalla.</p>}
    </section> : <p className="d-muted">Crea una tier list en el panel para gestionarla aquí.</p>}
  </>;
}
