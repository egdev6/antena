// Un catálogo: tipos que despacha Engine.#execAction y etiquetas de editor / permisos.
const ACTIONS = {
  scene: ['Cambiar a escena', 'Cambiar de escena'],
  layer: ['Mostrar capa unos segundos', 'Mostrar una capa'],
  hideLayer: ['Ocultar capa', 'Ocultar una capa'],
  toggleLayer: ['Alternar capa', 'Alternar una capa'],
  effect: ['Alternar efecto', 'Activar un efecto'],
  command: ['Comando de Meld', 'Lanzar un comando de Meld'],
  streamEvent: ['Evento de widget de Meld', 'Disparar un evento de Meld'],
  chat: ['Escribir en el chat', 'Escribir en el chat'],
  say: ['Decir en voz alta', 'Leer en voz alta'],
};
export const ACTION_KINDS = Object.keys(ACTIONS);
export const ACTION_LABELS = Object.fromEntries(Object.entries(ACTIONS).map(([kind, labels]) => [kind, labels[0]]));
export const OVERLAY_ACTION_LABELS = Object.fromEntries(Object.entries(ACTIONS).map(([kind, labels]) => [kind, labels[1]]));
// Los seis comandos que admite OBS (src/programs/obs-adapter.mjs).
export const OBS_COMMANDS = [
  'meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction',
  'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction',
];
