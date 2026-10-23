// Animaciones de los mensajes del chat en pantalla (#130): las mismas para entrar y para salir.
// Fuente única de los ids: la importan el widget (public/widgets/chat.html), el esquema de la
// configuración (src/config-schema.mjs) y el panel React (app/src/panel/views/Widgets.tsx, que
// pone las etiquetas por id). Cada id es el sufijo de sus clases en el widget (a-<id> y o-<id>).

export const CHAT_ANIMS = Object.freeze(/** @type {const} */ (['slide', 'fade', 'pop', 'bounce', 'zoom', 'flip', 'blur', 'drop', 'none']));

/** @typedef {typeof CHAT_ANIMS[number]} ChatAnim */
