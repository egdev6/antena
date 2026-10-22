// Récord de espectadores a la vez (src/viewers.mjs): pestaña «Récord» del editor de las alertas
// viewers (Twitch) y ytviewers (YouTube), y chips del Directo.
import { useEffect, useState } from 'react';
import { post, put } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { fmtTime, guard, PfIcon, Status, Switch, toast } from '../../lib/ui';
import { IC } from '../../lib/icons';
import type { ViewerPlatform, ViewersState } from '../../lib/types';

export const VIEWER_TYPES: Record<string, 'twitch' | 'youtube'> = { viewers: 'twitch', ytviewers: 'youtube' };
const NAME = { twitch: 'Twitch', youtube: 'YouTube' } as const;
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('es-ES'));

const saveSettings = (patch: Record<string, unknown>) => put<ViewersState>('/api/viewers/settings', patch).then(d => live.update(() => ({ viewers: d })));

/** Chip del Directo: espectadores ahora y récord. */
export function ViewerChips() {
  const v = useLive(s => s.viewers);
  if (!v || v.settings.enabled === false) return null;
  return <>{(['twitch', 'youtube'] as const).filter(p => v.platforms[p]?.live).map(p => {
    const x = v.platforms[p];
    const near = x.current !== null && x.record > 0 && x.current >= x.record;
    return <Status key={p} tone={near ? 'success' : 'neutral'} icon={IC.eye} title={`Pico del directo ${fmt(x.peak)} · récord ${fmt(x.record)}`}>{NAME[p]} · {fmt(x.current)} viendo · récord {fmt(x.record)}</Status>;
  })}</>;
}

function NumField({ label, k, value, min, max, unit, hint }: { label: string; k: string; value: number; min: number; max: number; unit?: string; hint?: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  const commit = () => { const n = Number(v); if (!Number.isFinite(n) || n === value) { setV(String(value)); return; } guard(() => saveSettings({ [k]: n }))(); };
  return <label title={hint}>{label}{unit ? ` (${unit})` : ''}<input type="number" min={min} max={max} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>;
}

function PlatformCard({ p, x }: { p: 'twitch' | 'youtube'; x?: ViewerPlatform }) {
  const [rec, setRec] = useState('');
  if (!x) return null;
  const state = x.off ? (p === 'twitch' ? 'Twitch sin conectar' : 'sin escuchar un directo de YouTube') : x.live ? 'en directo' : 'sin directo';
  return <article className="eg-module-card">
    <div className="eg-module-card__head"><PfIcon platform={p} className="eg-module-card__icon pf-ico" /><h2 className="eg-module-card__name">{NAME[p]}</h2>
      <Status tone={x.error ? 'danger' : x.live ? 'success' : 'neutral'}>{x.error ? 'error al leer' : state}</Status></div>
    <div className="eg-module-card__body">
      <span className="eg-module-card__label">Récord a la vez</span>
      <span className="eg-module-card__kpi">{fmt(x.record)}</span>
      <span>Ahora {fmt(x.current)} · pico del directo {fmt(x.peak)}{x.live ? ` · la próxima alerta, desde ${fmt(x.nextAt)}` : ''}</span>
      {x.pending ? <span className="hint">Récord batido: la alerta saldrá al terminar la espera.</span> : null}
      {x.lastAlertAt ? <span className="hint">Última alerta: {fmt(x.lastAlertValue)} a las {fmtTime(x.lastAlertAt)}</span> : null}
      {x.error ? <span className="hint err-inline">{x.error}</span> : null}
    </div>
    <div className="eg-module-card__actions">
      <form className="row tight" onSubmit={e => { e.preventDefault(); const n = Number(rec); if (rec === '' || !Number.isFinite(n)) return; guard(async () => { const d = await put<ViewersState>(`/api/viewers/records/${p}`, { value: n }); live.update(() => ({ viewers: d })); setRec(''); }, 'Récord cambiado')(); }}>
        <label className="sr-only" htmlFor={'rec-' + p}>Nuevo récord de {NAME[p]}</label>
        <input id={'rec-' + p} type="number" min={0} placeholder="Fijar récord" value={rec} onChange={e => setRec(e.target.value)} style={{ margin: 0, width: 130 }} />
        <button type="submit" className="eg-btn eg-btn--ghost eg-btn--sm">Guardar</button>
        <button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { if (!confirm(`¿Poner a cero el récord de ${NAME[p]}? La próxima cifra será el punto de partida, sin alerta.`)) return; const d = await put<ViewersState>(`/api/viewers/records/${p}`, { value: 0 }); live.update(() => ({ viewers: d })); }, 'Récord a cero')}>A cero</button>
      </form>
    </div>
  </article>;
}

/** Pestaña «Récord» del editor de alertas de espectadores. */
export function RecordPane({ type }: { type: string }) {
  const v = useLive(s => s.viewers);
  const p = VIEWER_TYPES[type];
  if (!v) return <p className="hint">El servidor no ha mandado aún el estado de espectadores.</p>;
  const c = v.settings;
  return <>
    <p className="hint">Sale cuando hay más gente viendo a la vez que nunca en {NAME[p]}. El récord se guarda siempre; lo que se limita es la alerta, para que no salga cada vez que la cifra sube uno.</p>
    <PlatformCard p={p} x={v.platforms[p]} />
    <div className="row2 switches">
      <Switch checked={c.enabled} onChange={x => guard(() => saveSettings({ enabled: x }))()} title="Apagado no se mira ninguna plataforma">Vigilar espectadores</Switch>
      <Switch checked={c.alertFirst} onChange={x => guard(() => saveSettings({ alertFirst: x }))()}>Avisar también la primera vez (sin récord guardado)</Switch>
    </div>
    <h3 className="subhead">Para que no se convierta en spam</h3>
    <div className="row2">
      <NumField label="Supera lo último anunciado en al menos" k="minStep" unit="personas" value={c.minStep} min={1} max={100000} />
      <NumField label="…o en este porcentaje" k="minStepPct" unit="%" value={c.minStepPct} min={0} max={100} />
      <NumField label="Espera entre alertas" k="cooldownMin" unit="min" value={c.cooldownMin} min={0} max={240} />
      <NumField label="Sin avisos al empezar el directo" k="warmupMin" unit="min" value={c.warmupMin} min={0} max={120} />
      <NumField label="Mínimo de espectadores" k="minViewers" value={c.minViewers} min={0} max={1000000} />
      <NumField label="Lecturas seguidas para confirmarlo" k="confirmPolls" value={c.confirmPolls} min={1} max={10} />
      <NumField label="Mirar cada" k="pollSec" unit="s" value={c.pollSec} min={20} max={600} />
    </div>
    <p className="hint">Gana el mayor de los dos saltos: con 40 de récord y 3 personas o 10 %, la alerta sale a partir de 44. Lo que se bata durante la espera sale una sola vez al acabarla, con la cifra más alta. Estos ajustes valen para Twitch y YouTube. En YouTube cada lectura gasta 1 unidad de cuota.</p>
    <div><button type="button" className="eg-btn eg-btn--ghost eg-btn--sm" onClick={guard(async () => { const d = await post<ViewersState & { fired: unknown[] }>('/api/viewers/check'); live.update(() => ({ viewers: d })); toast(d.fired?.length ? 'Nuevo récord: alerta enviada' : 'Leído'); })}>Mirar ahora</button></div>
  </>;
}
