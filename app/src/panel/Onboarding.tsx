// Bienvenida del panel: la primera vez (config.panel.onboardingDone) un saludo corto ofrece
// el tour guiado. «Ahora no» lo marca como visto; terminar o cerrar el tour, también.
// «General y archivos» relanza el tour directamente, sin pasar por aquí.
import { useEffect, useRef, useState } from 'react';
import { useLive } from '../lib/live';
import { launchTour, markOnboardingDone } from './tour';

export function Onboarding() {
  const done = useLive(s => s.config?.panel?.onboardingDone);
  const [touring, setTouring] = useState(false);
  const startBtn = useRef<HTMLButtonElement>(null);
  const open = done === false && !touring;   // undefined = estado aún sin cargar
  useEffect(() => { if (open) startBtn.current?.focus(); }, [open]);
  if (!open) return null;
  const start = () => { setTouring(true); launchTour(); };
  return <div className="tour-greet" role="dialog" aria-modal="true" aria-labelledby="tour-greet-t" aria-describedby="tour-greet-d" onKeyDown={e => { if (e.key === 'Escape') markOnboardingDone(); }}>
    <div className="tour-greet__box">
      <img className="tour-greet__mark" src="/brand/logo.png" alt="" aria-hidden="true" />
      <span className="kicker">Bienvenido a antena</span>
      <h1 id="tour-greet-t">¿Te enseño cómo funciona?</h1>
      <p id="tour-greet-d" className="hint">Un tour corto por el panel: el directo, el chat, los objetivos, Meld, los atajos y las conexiones. Puedes repetirlo cuando quieras desde <b>General y archivos</b>.</p>
      <div className="tour-greet__actions">
        <button type="button" className="eg-btn eg-btn--ghost" onClick={markOnboardingDone}>Ahora no</button>
        <button type="button" ref={startBtn} className="eg-btn eg-btn--primary" onClick={start}>Empezar el tour</button>
      </div>
    </div>
  </div>;
}
