import { live } from '../../lib/live';
import { startTour } from './engine';

/** Marca el onboarding como visto y lo guarda en el servidor (config.panel.onboardingDone). */
export const markOnboardingDone = () => live.patchConfig({ panel: { onboardingDone: true } });

/** Lanza el tour; al terminarlo o cerrarlo queda marcado como visto. */
export const launchTour = () => startTour({ onEnd: markOnboardingDone });

export { startTour } from './engine';
export { TOUR_STEPS, type TourStep } from './steps';
