// Live interview controls (#278), shared by the dock, the interview page and the prompter tab.
// Every button calls the same /api/interview-control actions as the shortcuts and the MCP tools; the
// widget on screen follows through its own SSE event. Private notes come from the presenter view
// (`interviewControl`, panel clients only) and are never part of the widget payload.
import { post } from './api';
import { live, useLive } from './live';
import { guard } from './ui';

const act = (path: string, body?: unknown) => guard(() => post('/api/interview-control/' + path, body));
export const useInterview = () => useLive(() => live.interview);

type Classes = { root?: string; btn: string; primary: string; muted: string; row: string; note: string; title: string };

export function InterviewPad({ cls, notes = true, label = 'Entrevista', compact = false, enabled = true }: { cls: Classes; notes?: boolean; label?: string; compact?: boolean; enabled?: boolean }) {
  const iv = useInterview();
  if (compact) {
    // Only drive the interview open in this detail, never a different active interview.
    const active = enabled && !!iv?.active;
    const current = active ? iv?.current : null, next = active ? iv?.next : null;
    const progress = active ? iv!.progress : { index: 0, total: 0 };
    return <section className={cls.root} aria-label={label}>
      <span className={`lv-dot ${active ? 'is-ok' : 'is-off'} interview-live-label`}>Directo</span>
      <button type="button" className={cls.btn} data-interview-act="previous" disabled={!active || progress.index <= 1} onClick={act('previous')}>← Anterior</button>
      <button type="button" className={cls.btn} data-interview-act="next" disabled={!active || progress.index >= progress.total} onClick={act('next')}>Siguiente →</button>
      <button type="button" className={cls.btn} data-interview-act="media" disabled={!current?.media} onClick={act('media', { visible: iv?.mediaHidden })}>{iv?.mediaHidden && active ? 'Mostrar media' : 'Ocultar media'}</button>
      <button type="button" className={cls.btn} data-interview-act="hide" disabled={!current} onClick={act('hide')}>Ocultar widget</button>
      {active && <details className="interview-live-details"><summary>En directo <span data-interview-progress>{progress.index} / {progress.total}</span></summary>
        <div className="interview-live-popover">
          <p data-interview-title>{iv!.title} · {iv!.guest}</p>
          <p data-interview-current>{current ? current.question : 'Nada en pantalla'}</p>
          {notes && current?.notes ? <p data-interview-notes>Notas: {current.notes}</p> : null}
          {next ? <p data-interview-next>Siguiente: {next.question}</p> : null}
          {notes && next?.notes ? <p data-interview-next-notes>Notas siguiente: {next.notes}</p> : null}
          <select aria-label="Ir al ítem" data-interview-goto value={current?.id || ''} onChange={e => { if (e.target.value) void act('goto', { itemId: e.target.value })(); }}>
            <option value="">Ir a…</option>
            {iv!.items.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {x.question.slice(0, 70)}</option>)}
          </select>
        </div>
      </details>}
      <span className="hint interview-live-hint">El directo utiliza la versión guardada</span>
    </section>;
  }
  if (!iv) return null;
  if (!iv.active) return <section className={cls.root} aria-label={label}><p className={cls.muted}>Sin entrevista activa. Elige una en Widgets › Entrevista o con «elegir_entrevista».</p></section>;
  const { current, next, progress } = iv;
  const hasMedia = !!current?.media;
  return <section className={cls.root} aria-label={label}>
    <p className={cls.muted} data-interview-title>{iv.title} · {iv.guest}</p>
    <p className={cls.title} data-interview-progress>{progress.index} / {progress.total}</p>
    <p data-interview-current>{current ? current.question : 'Nada en pantalla'}</p>
    {notes && current?.notes ? <p className={cls.note} data-interview-notes>Notas: {current.notes}</p> : null}
    {next ? <p className={cls.muted} data-interview-next>Siguiente: {next.question}</p> : null}
    {notes && next?.notes ? <p className={cls.note} data-interview-next-notes>Notas siguiente: {next.notes}</p> : null}
    <div className={cls.row}>
      <button type="button" className={cls.btn} data-interview-act="previous" disabled={progress.index <= 1} onClick={act('previous')}>Anterior</button>
      <button type="button" className={cls.primary} data-interview-act="next" disabled={progress.index >= progress.total} onClick={act('next')}>Siguiente</button>
    </div>
    <div className={cls.row}>
      <button type="button" className={cls.btn} data-interview-act="media" disabled={!current || !hasMedia}
        onClick={act('media', { visible: iv.mediaHidden })}>{iv.mediaHidden ? 'Mostrar media' : 'Ocultar media'}</button>
      <button type="button" className={cls.btn} data-interview-act="hide" disabled={!current} onClick={act('hide')}>Ocultar widget</button>
    </div>
    <select className={cls.btn} aria-label="Ir al ítem" data-interview-goto value={current?.id || ''}
      onChange={e => { if (e.target.value) void act('goto', { itemId: e.target.value })(); }}>
      <option value="">Ir a…</option>
      {iv.items.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {x.question.slice(0, 70)}</option>)}
    </select>
  </section>;
}
