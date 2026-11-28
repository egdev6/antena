import { PfIcon, PLATFORM_NAMES } from '../../lib/ui';

export function sendResultText(r: any) {
  const errs = Object.entries<string>(r.errors || {});
  return `Enviado a ${Object.keys(r.sent || {}).map(k => PLATFORM_NAMES[k]).join(' y ')}${errs.length ? ' · ' + errs.map(([k, v]) => PLATFORM_NAMES[k] + ': ' + v).join(' · ') : ''}`;
}

export function SendTo({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts: [string, React.ReactNode, string][] = [['twitch', <PfIcon platform="twitch" />, 'Solo Twitch'], ['youtube', <PfIcon platform="youtube" />, 'Solo YouTube'], ['both', 'Ambos', 'Twitch y YouTube']];
  return <div className="eg-tabs send-to" role="radiogroup" aria-label="Escribir en">
    {opts.map(([v, l, t]) => <button key={v} type="button" role="radio" className="eg-tabs__item" aria-checked={v === value} aria-selected={v === value} title={t} aria-label={t} onClick={() => onChange(v)}>{l}</button>)}
  </div>;
}

export const platformsText = (platforms: any = {}) => Object.entries<any>(platforms || {})
  .map(([p, r]) => `${PLATFORM_NAMES[p] || p}: ${r.ok ? (r.kind === 'announcement' ? 'anuncio enviado' : 'enviado') : `no enviado (${r.error})`}`).join(' · ');
