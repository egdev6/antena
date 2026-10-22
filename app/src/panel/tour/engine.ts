// Motor del tour guiado sobre driver.js: cada paso navega a su vista (location.hash),
// espera un tiempo acotado a que aparezca su ancla [data-tour] y la resalta. Si el ancla
// no llega, salta al siguiente paso en la misma dirección en lugar de romperse.
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
export function startTour({ steps = TOUR_STEPS, onEnd }: { steps?: TourStep[]; onEnd?: () => void } = {}) {
  if (current) return;
  let busy = false;
  const d = driver({
    steps: steps.map(s => ({ element: selector(s), popover: { title: s.title, description: s.text, side: s.side, align: s.align ?? 'start' } })),
    animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    showProgress: true,
    progressText: '{{current}} de {{total}}',
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
    onPopoverRender: p => {
      p.wrapper.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => p.nextButton.focus({ preventScroll: true }));
    },
    onDestroyed: () => { current = null; onEnd?.(); },
  });
  const show = (i: number) => (d.isActive() ? d.moveTo(i) : d.drive(i));
  // busca, desde el paso actual y en la dirección dada, el primero cuya ancla aparece
  async function go(dir: 1 | -1) {
    if (busy) return;
    busy = true;
    try {
      const from = d.getActiveIndex() ?? -1;
      for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
        const found = await reach(steps[i]);
        if (current !== d) return;   // cerrado mientras se esperaba
        if (found) { show(i); return; }
      }
      if (dir > 0) { if (d.isActive()) d.destroy(); else { current = null; onEnd?.(); } return; }
      // hacia atrás no queda nada: se vuelve a la vista del paso actual
      if (from >= 0 && await reach(steps[from]) && current === d) show(from);
    } finally { busy = false; }
  }
  current = d;
  void go(1);
}
