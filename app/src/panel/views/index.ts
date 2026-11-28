import { lazy, type ComponentType } from 'react';

type ViewModule = { default: ComponentType<{ parts: string[] }> };

function lazyRoute(importView: () => Promise<ViewModule>) {
  let pending: Promise<ViewModule> | undefined;
  let loaded: ViewModule['default'] | undefined;
  const preload = () => pending ??= importView().then(module => {
    loaded = module.default;
    return module;
  });
  return { Lazy: lazy(preload), preload, get loaded() { return loaded; } };
}

export type LazyRoute = ReturnType<typeof lazyRoute>;

// Use direct imports so loading the registry doesn't load the views.
const routes = new Map([
  ['chat', lazyRoute(() => import('./Chat').then(m => ({ default: m.Chat })))],
  ['preguntas', lazyRoute(() => import('./Interactivos').then(m => ({ default: m.Preguntas })))],
  ['tierlist', lazyRoute(() => import('./Interactivos').then(m => ({ default: m.TierList })))],
  ['entrevista', lazyRoute(() => import('./Entrevista').then(m => ({ default: m.Entrevista })))],
  ['sorteo', lazyRoute(() => import('./Interactivos').then(m => ({ default: m.Sorteo })))],
  ['teleprompter', lazyRoute(() => import('./Teleprompter').then(m => ({ default: m.Teleprompter })))],
  ['alertas', lazyRoute(() => import('./Alertas').then(m => ({ default: m.Alertas })))],
  ['comandos', lazyRoute(() => import('./Comandos').then(m => ({ default: m.Comandos })))],
  ['mensajes', lazyRoute(() => import('./Comandos').then(m => ({ default: m.Mensajes })))],
  ['widgets', lazyRoute(() => import('./Widgets').then(m => ({ default: m.Widgets })))],
  ['overlays', lazyRoute(() => import('./Overlays').then(m => ({ default: m.Overlays })))],
  ['atajos', lazyRoute(() => import('./Atajos').then(m => ({ default: m.Atajos })))],
  ['fuentes', lazyRoute(() => import('./Fuentes').then(m => ({ default: m.Fuentes })))],
  ['meld', lazyRoute(() => import('./Ajustes').then(m => ({ default: m.Meld })))],
  ['prompter', lazyRoute(() => import('./Ajustes').then(m => ({ default: m.PrompterAjustes })))],
  ['historial', lazyRoute(() => import('./Historial').then(m => ({ default: m.Historial })))],
  ['directos', lazyRoute(() => import('./Registro').then(m => ({ default: m.Directos })))],
  ['archivos', lazyRoute(() => import('./Registro').then(m => ({ default: m.Archivos })))],
  ['apariencia', lazyRoute(() => import('./Apariencia').then(m => ({ default: m.Apariencia })))],
  ['conexiones', lazyRoute(() => import('./Conexiones').then(m => ({ default: m.Conexiones })))],
  ['filtros', lazyRoute(() => import('./Ajustes').then(m => ({ default: m.Filtros })))],
  ['general', lazyRoute(() => import('./General').then(m => ({ default: m.General })))],
  ['acerca', lazyRoute(() => import('./AcercaDe').then(m => ({ default: m.AcercaDe })))],
]);

export const getLazyRoute = (page: string) => routes.get(page);
export function preloadView(page: string) {
  // Speculative failures should surface only if the user opens that view.
  void getLazyRoute(page)?.preload().catch(() => {});
}
