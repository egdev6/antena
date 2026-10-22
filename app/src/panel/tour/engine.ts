// Motor del tour guiado sobre driver.js. Al empezar se quedan solo los pasos cuya condición
// (`when`) se cumple, así que «n de N» cuenta lo que se va a ver. Cada paso navega a su vista
// (location.hash), espera un tiempo acotado a su ancla [data-tour] y la resalta. Si un ancla
// no aparece pese a todo (red de seguridad), ese paso se descarta y la numeración se rehace:
// el siguiente toma su número y el total baja en uno, sin huecos.
import { driver, type Driver } from 'driver.js';
import { TOUR_STEPS, type TourStep } from './steps';

const WAIT_MS = 2000;
const selector = (s: TourStep) => `[data-tour="${s.anchor}"]`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Abre la vista del paso y espera a su ancla visible; null si no aparece a tiempo. */
async function reach(step: TourStep): Promise<Element | null> {
  if (location.hash !== step.route) location.hash = step.route;
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const el = document.querySelector(selector(step));
    if (el && el.getClientRects().length > 0) return el;
    if (Date.now() >= end) return null;
    await sleep(50);
  }
}

let current: Driver | null = null;

/** Lanza el tour (si no hay otro en marcha). onEnd se llama al terminarlo o cerrarlo. */
export function startTour({ steps: all = TOUR_STEPS, onEnd }: { steps?: TourStep[]; onEnd?: () => void } = {}) {
  if (current) return;
  const steps = all.filter(s => !s.when || s.when());
  const dropped = new Set<number>();   // pasos cuya ancla no apareció
  let busy = false;
  // driver.js solo llama a onDestroyed si el resaltado terminó de animarse: cerrar durante la
  // animación lo perdería. El tour se cierra siempre por aquí (Esc, ✕ y «Terminar»).
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true; current = null;
    d.destroy();
    onEnd?.();
  };
  const d = driver({
    steps: steps.map(s => ({ element: selector(s), popover: { title: s.title, description: s.text, side: s.side, align: s.align ?? 'start' } })),
    animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    showProgress: true,
    nextBtnText: 'Siguiente',
    prevBtnText: 'Anterior',
    doneBtnText: 'Terminar',
    closeBtnLabel: 'Cerrar el tour',
    popoverClass: 'antena-tour',
    overlayClickBehavior: 'none',
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 10,
    onNextClick: () => { void go(1); },
    onPrevClick: () => { void go(-1); },
    onPopoverRender: (p, { index = 0 }) => {
      // numeración sobre los pasos que quedan (sin los descartados)
      const shown = steps.map((_, i) => i).filter(i => !dropped.has(i));
      p.progress.textContent = `${shown.indexOf(index) + 1} de ${shown.length}`;
      p.nextButton.textContent = index === shown.at(-1) ? 'Terminar' : 'Siguiente';
      p.wrapper.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => p.nextButton.focus({ preventScroll: true }));
    },
    onDestroyStarted: finish,
  });
  const show = (i: number) => (d.isActive() ? d.moveTo(i) : d.drive(i));
  // busca, desde el paso actual y en la dirección dada, el primero cuya ancla aparece
  async function go(dir: 1 | -1) {
    if (busy) return;
    busy = true;
    try {
      const from = d.getActiveIndex() ?? -1;
      for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
        if (dropped.has(i)) continue;
        const found = await reach(steps[i]);
        if (current !== d) return;   // cerrado mientras se esperaba
        if (found) { show(i); return; }
        dropped.add(i);
      }
      if (dir > 0) { finish(); return; }
      // hacia atrás no queda nada: se vuelve a la vista del paso actual
      if (from >= 0 && await reach(steps[from]) && current === d) show(from);
    } finally { busy = false; }
  }
  current = d;
  void go(1);
}
