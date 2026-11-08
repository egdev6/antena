// #73: al empezar el directo, aviso de las plataformas configuradas que no están conectadas,
// con enlace a conectar cada una. Sale una vez por directo; al cerrarlo no vuelve hasta el
// siguiente. Se espera un momento tras empezar para dar tiempo a la conexión automática.
import { useEffect, useState } from 'react';
import { useLive } from '../lib/live';
import { Modal } from '../lib/ui';
import type { AppState } from '../lib/types';

export const GRACE_MS = 3000;

type Platform = { id: 'twitch' | 'youtube'; label: string };

/** Plataformas configuradas que ni están conectadas ni conectándose. */
export function missingPlatforms(s: AppState): Platform[] {
  const cfg = s.config, st = s.status;
  const yt = cfg?.youtube || {};
  const out: Platform[] = [];
  const twitchState = st?.twitch?.state || '';
  if (cfg?.twitch?.clientId && !['conectado', 'conectando', 'reconectando'].includes(twitchState)) out.push({ id: 'twitch', label: 'Twitch' });
  const ytConfigured = !!(yt.apiKeySet || yt.channelId || yt.video || st?.youtube?.account);
  const ytState = st?.youtube?.state || '';
  if (ytConfigured && !['escuchando', 'buscando directo', 'en espera'].includes(ytState)) out.push({ id: 'youtube', label: 'YouTube' });
  return out;
}

export function PlatformWarning() {
  const streaming = useLive(s => !!s.status?.meld?.streaming);
  const missing = useLive(missingPlatforms);
  const [armed, setArmed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    setArmed(false);
    if (!streaming) return;
    const timer = setTimeout(() => setArmed(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [streaming]);
  if (!streaming || !armed || dismissed || !missing.length) return null;
  const close = () => setDismissed(true);
  return <Modal title="Hay plataformas sin conectar" onClose={close} className="platform-warning">
    <p>El directo ha empezado, pero antena no está conectada a {missing.map(p => p.label).join(' ni a ')}. Sin conexión no llegan su chat ni sus alertas.</p>
    <div className="row">
      {missing.map(p => <a key={p.id} className="btn" href={`#/conexiones/${p.id}`} onClick={close}>Conectar {p.label}</a>)}
    </div>
  </Modal>;
}
