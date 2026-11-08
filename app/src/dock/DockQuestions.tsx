import { post } from '../lib/api';
import { useLive } from '../lib/live';
import { patchIx } from '../lib/patch';
import { guard } from '../lib/ui';
import { DockAdd } from './DockAdd';

export function DockQuestions() {
  const I = useLive(s => s.interactive);
  const q = I?.questions;
  const config = (I?.config?.questions || {}) as { enabled?: unknown; command?: unknown };
  if (!q) return null;
  const pending = q.list.filter(item => item.status === 'pending');
  return <section className="d-card" aria-label="Preguntas">
    <div className="d-card-h"><button type="button" className="d-sw" role="switch" aria-checked={!!config.enabled} aria-label="Preguntas del chat"
      title={config.enabled ? 'El comando del chat está activo' : 'El comando del chat está desactivado'} onClick={() => patchIx('questions', { enabled: !config.enabled })} />
      Preguntas<span className="d-meta">{config.command ? `${config.command} · ` : ''}{q.pending || 0} en cola</span></div>
    {q.current ? <p className="d-q"><b>{q.current.user}</b> {q.current.text}</p> : <p className="d-muted">Ninguna en pantalla</p>}
    <div className="d-row"><button className="d-btn sm grow" disabled={!q.pending} title={q.pending ? 'Pasa a la siguiente pregunta de la cola' : 'No hay preguntas en cola'}
      onClick={guard(() => post('/api/questions/next'))}>Siguiente</button>
      <button className="d-btn sm" disabled={!q.current} title={q.current ? 'Quita la pregunta de la pantalla' : 'No hay ninguna pregunta en pantalla'}
        onClick={guard(() => post('/api/questions/hide'), 'Pregunta oculta')}>Ocultar</button></div>
    <h3 className="d-sub">Cola</h3>
    {pending.length ? <div className="d-items">{pending.map((item, index) => <article className="d-item" key={item.id}>
      <div className="d-item-text"><b>{item.text}</b><small>{item.user}</small></div>
      <div className="d-item-actions">
        <button type="button" className="d-btn sm" aria-label={`Mostrar ${item.text}`} onClick={guard(() => post('/api/questions/show', { id: item.id }))}>Mostrar</button>
        <button type="button" className="d-btn sm" aria-label={`Subir ${item.text}`} disabled={index === 0} onClick={guard(() => post(`/api/questions/${encodeURIComponent(item.id)}/move`, { dir: -1 }))}>↑</button>
        <button type="button" className="d-btn sm" aria-label={`Bajar ${item.text}`} disabled={index === pending.length - 1} onClick={guard(() => post(`/api/questions/${encodeURIComponent(item.id)}/move`, { dir: 1 }))}>↓</button>
        <button type="button" className="d-btn sm" aria-label={`Descartar ${item.text}`} onClick={guard(() => post(`/api/questions/${encodeURIComponent(item.id)}/status`, { status: 'discarded' }))}>Descartar</button>
      </div>
    </article>)}</div> : <p className="d-muted">No hay preguntas en cola.</p>}
    <DockAdd label="Añadir una pregunta a mano" placeholder="Añadir una pregunta…" onAdd={async text => { await post('/api/questions', { text }); }} />
  </section>;
}
