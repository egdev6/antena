# Temas guardados (API y MCP)

Un tema es una copia completa de `theme`, `alerts`, `overlay`, `widgets`, la **configuración** de interactivos (preguntas, tier list y sorteo), `commands` y `timers`. Viajan también sus valores operativos: acciones, plataformas, mínimos, objetivos y mensajes, no solo colores o CSS. Los cambios corrientes editan el tema activo. El estado del directo (cola, preguntas, votos, participantes y contadores) no pertenece al tema.

Las conexiones y secretos, las sesiones, Meld/OBS y su configuración, Discord, calendario, acceso, puerto, panel, dock, prompter y teleprompter son globales. El HTML, CSS y JavaScript propios y los permisos de los overlays son globales. Su CSS adicional por tema vive en `customOverlayCss`, un mapa `{ idOverlay: css }`: se copia al duplicar y se sustituye al activar. Una entrada ausente equivale a CSS vacío. Cambiar de tema no modifica escenas ni fuentes de navegador.

## Panel y dock

En **Ajustes › Apariencia › Temas** selecciona un tema para ver las capas reales de alerta, objetivo y chat sin activarlo. Las muestras usan sus colores, textos, diseño, medios y CSS guardados. Desde ahí puedes activarlo, duplicarlo, editarlo o borrar uno inactivo. **Nuevo tema** crea una copia completa del tema elegido o parte de **Color de cada plataforma**. El máximo es 10; primero activa otro para borrar el activo.

Al crear o editar un tema puedes asignarle un avatar: imagen, color o ambos (la imagen se recorta en círculo y el color dibuja el anillo). Se muestra en las listas de Apariencia, el selector lateral, el dock y la lista de origen. Sin avatar se usa el acento o el indicador multicolor del tema por plataformas. Se suben imágenes PNG, JPG/JPEG, WebP o GIF; no se admiten SVG, APNG ni AVIF. Duplicar copia el aspecto y ajustes, pero no el avatar: el tema nuevo tiene identidad propia. Quitar un avatar o borrar un tema no borra los archivos de media.

El selector destacado al pie de la barra lateral y la pestaña **Tema** del dock cambian el tema en el momento; las tres superficies se sincronizan sin recargar. Los cambios corrientes y los resets de alertas o Apariencia afectan solo al activo. Si cambias desde el panel con un borrador local, se pide confirmación antes de descartarlo. Si otro cliente activa un tema, el borrador anterior permanece visible, Guardar se bloquea y puedes descartarlo; no se aplica al tema nuevo. La apariencia de serie para instalaciones nuevas usa el color y el logo de cada plataforma. Ya no se ofrece el selector «Punto de partida».

## API

- `GET /api/themes` devuelve `{ "themes": [{ "id", "name", "active", "avatar"? }] }`; `avatar` es `{ "image"?: "foto.png", "color"?: "#RRGGBB" }` y queda fuera del look.
- `GET /api/themes/:id/look` devuelve una proyección resumida sin acciones, comandos, timers ni CSS; el activo se lee de las secciones actuales.
- `GET /api/themes/:id/preview` entrega `activeTheme: { id, name }` y solo los datos necesarios para pintar la alerta de muestra y los widgets de objetivo y chat (incluidos CSS y medios), sin acciones ni secciones operativas. El parámetro opcional `type` elige cualquier tipo de alerta (por defecto `follow`). La vista del overlay lo usa con `?still=<tipo>&previewTheme=<id>` y los widgets con `?demo&previewTheme=<id>`; nunca se activa ni se guarda el tema.
- `POST /api/themes/duplicate` con `{ "from": "normal", "name": "Navidad", "avatar": { "color": "#112233" } }` copia el tema activo o uno inactivo sin copiar su avatar; `avatar` es opcional.
- `POST /api/themes/from-default` con `{ "name": "Plataformas", "avatar": { "image": "foto.png" } }` crea desde la configuración de serie con «Color de cada plataforma» (`platformAccent: true`, `platformBadge: "logo"`); `avatar` es opcional.
- `PUT /api/themes/:id` acepta `name` y/o `avatar`; renombrar no cambia el id. En `avatar`, las claves omitidas se conservan, `image: ""` o `color: ""` quitan solo ese campo y `avatar: null` quita ambos. La imagen debe ser el nombre de un archivo existente en media (sin rutas); súbela primero con `POST /api/media/upload?name=<nombre>` y usa el `name` devuelto.
- `POST /api/themes/:id/activate` activa el tema; repetirlo para el activo no escribe ni crea copia.
- `DELETE /api/themes/:id` borra un tema inactivo. El activo responde 409: «Activa otro tema antes de borrar este».

En **Overlays**, «CSS de este tema» se guarda en el tema activo. Se aplica en vivo tras el CSS propio mediante la shell y `postMessage` al marco sandbox, sin recargarlo ni cambiar `updatedAt` o permisos. Se valida como CSS de hasta 512 KB de JSON por overlay; el mapa admite hasta 50 entradas y 2,5 MB de JSON. También se puede escribir con `POST /api/config/set` y `{ "path": "customOverlayCss.<id>", "value": "…" }`. Las escrituras de elementos del panel llevan `X-Antena-Theme` con el id contra el que se editó. Si ya no es el activo, responden 409 «El tema activo cambió mientras editabas; tus cambios no se guardaron» sin escribir. API y MCP sin esa cabecera conservan el comportamiento de editar el activo.

Los nombres se recortan en los extremos, deben ser únicos sin distinguir mayúsculas y tener de 1 a 40 caracteres. Los ids son slugs únicos; el máximo es 10 temas. Una referencia desconocida responde 404 y un look que no supera el esquema responde 400 antes de guardar. Los cambios genéricos de configuración no pueden escribir `themes`: usa estas rutas. La configuración pública y `/api/state` muestran ids, nombres y cuál está activo, sin los looks inactivos; la exportación completa de configuración sí los incluye.

El `<html>` del overlay, widgets y marco propio recibe `data-tema="<id>"`; las previews `previewTheme` usan el id elegido. Los widgets y el marco propio cambian el marcador inmediatamente; si hay una alerta visible, el overlay difiere el marcador junto con el aspecto hasta que la alerta termine de salir. En `/api/stream`, `?themeInfo=1` añade `activeTheme: { id, name }` después de las tramas iniciales existentes; está separado de `theme` y de su `version`, por lo que renombrar no cambia el hash de apariencia ni las miniaturas. La shell solicita además `customTheme=1` para recibir el snapshot `customOverlayTheme`; los clientes sin estos parámetros conservan su secuencia anterior. En overlays propios `antena.on('theme', fn)` y `antena.state.theme` incluyen `id` y `name` junto con las variables habituales. Una instantánea única lleva identidad, aspecto y CSS del overlay; el SDK aplica ambos CSS y el marcador antes de notificar el evento.

Activar guarda el look saliente, aplica el entrante y actualiza `activeId` en una única escritura atómica con copia local previa. El cambio se difunde a los overlays, widgets y panel. Las alertas que ya están en pantalla o en la cola del overlay conservan los ajustes de alerta y CSS con los que se construyeron; las alertas construidas después del cambio usan los del nuevo tema. El tema global del overlay cambia entre alertas, no durante la salida de la actual. Se descarta cualquier borrador de Apariencia del tema anterior. Un objetivo o variante de chat inexistente se rechaza en su API con 404 sin cambiar contadores ni configuración; los atajos actuales no incluyen acciones de objetivo o variante.

## Stream Deck

`GET /sd/tema/<id>` o `POST /sd/tema/<id>` activa el tema por su id usando la misma transacción y notificaciones que la API. Un id inexistente responde 404 sin cambios.

## MCP

`listar_temas`, `duplicar_tema { id, nombre }`, `renombrar_tema { id, nombre, color?, imagen? }`, `activar_tema { id, confirmar: true }` y `borrar_tema { id, confirmar: true }` usan la misma API. En `renombrar_tema`, `color` e `imagen` son opcionales; una cadena vacía quita ese campo, sin borrar el archivo. La activación y el borrado requieren confirmación de la persona antes de invocar la herramienta. `restaurar_tema` restaura el aspecto de serie del activo; `tema_de_partida` se conserva por compatibilidad solo con el id `plataforma`.

## Migración y copia

Al abrir una configuración anterior a v3 se conserva una copia privada de los bytes anteriores y se crea el tema activo «Normal». Se fusionan y guardan los defaults vigentes de todas las secciones del tema: tema, alertas, overlay, widgets e interactivos, junto con las listas de comandos y timers y el mapa CSS de overlays. En cada variación se guardan las condiciones efectivas, incluidos los defaults ausentes. En comandos y timers antiguos incompletos se materializan además los campos que usa el constructor de su alerta, con sus respectivos defaults efectivos; no se inventan permisos, cooldowns ni ajustes de programación ausentes. Así, cambios posteriores a esos defaults no cambian el aspecto existente. Una instalación nueva usa Color de cada plataforma; una instalación v2 que actualice directamente conserva los defaults anteriores (acento sin plataforma y etiqueta de texto).

La copia local `config.backup-…json` puede contener datos privados y debe protegerse. La exportación e importación completas de configuración incluyen los temas guardados y siguen sus reglas normales de revisión y copia; aún no existe exportación/importación individual de temas.
