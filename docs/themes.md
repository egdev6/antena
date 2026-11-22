# Temas guardados (API y MCP)

Un tema es una copia completa de `theme`, `alerts`, `overlay`, `widgets`, la **configuración** de interactivos (preguntas, tier list y sorteo), `commands` y `timers`. Viajan también sus valores operativos: acciones, plataformas, mínimos, objetivos y mensajes, no solo colores o CSS. Los cambios corrientes editan el tema activo. El estado del directo (cola, preguntas, votos, participantes y contadores) no pertenece al tema.

Las conexiones y secretos, las sesiones, Meld/OBS y su configuración, Discord, calendario, acceso, puerto, panel, dock, prompter y teleprompter son globales. El código y permisos de los overlays propios también son globales. `customOverlayCss` reserva un mapa `{ idOverlay: css }` por tema, pero **todavía no se aplica** a los overlays. Cambiar de tema no modifica escenas ni fuentes de navegador.

## Panel y dock

En **Ajustes › Apariencia › Temas** selecciona un tema para ver las capas reales de alerta, objetivo y chat sin activarlo. Las muestras usan sus colores, textos, diseño, medios y CSS guardados. Desde ahí puedes activarlo, duplicarlo, renombrarlo o borrar uno inactivo. **Nuevo tema** crea una copia completa del tema elegido o parte de **Color de cada plataforma**. El máximo es 10; primero activa otro para borrar el activo.

El selector destacado al pie de la barra lateral y la pestaña **Tema** del dock cambian el tema en el momento; las tres superficies se sincronizan sin recargar. Los cambios corrientes y los resets de alertas o Apariencia afectan solo al activo. Si cambias desde el panel con un borrador local, se pide confirmación antes de descartarlo. Si otro cliente activa un tema, el borrador anterior permanece visible, Guardar se bloquea y puedes descartarlo; no se aplica al tema nuevo. La apariencia de serie para instalaciones nuevas usa el color y el logo de cada plataforma. Ya no se ofrece el selector «Punto de partida».

## API

- `GET /api/themes` devuelve `{ "themes": [{ "id", "name", "active" }] }`.
- `GET /api/themes/:id/look` devuelve una proyección resumida sin acciones, comandos, timers ni CSS; el activo se lee de las secciones actuales.
- `GET /api/themes/:id/preview` entrega solo los datos necesarios para pintar la alerta de muestra y los widgets de objetivo y chat (incluidos CSS y medios), sin acciones ni secciones operativas. La vista del overlay solo lo usa con `?still=follow&previewTheme=<id>` y los widgets solo con `?demo&previewTheme=<id>`; nunca se activa ni se guarda el tema.
- `POST /api/themes/duplicate` con `{ "from": "normal", "name": "Navidad" }` copia el tema activo o uno inactivo.
- `POST /api/themes/from-default` con `{ "name": "Plataformas" }` crea desde la configuración de serie con «Color de cada plataforma» (`platformAccent: true`, `platformBadge: "logo"`).
- `PUT /api/themes/:id` con `{ "name": "Nuevo nombre" }` renombra sin cambiar el id.
- `POST /api/themes/:id/activate` activa el tema; repetirlo para el activo no escribe ni crea copia.
- `DELETE /api/themes/:id` borra un tema inactivo. El activo responde 409: «Activa otro tema antes de borrar este».

Las escrituras de elementos del panel llevan `X-Antena-Theme` con el id contra el que se editó. Si ya no es el activo, responden 409 «El tema activo cambió mientras editabas; tus cambios no se guardaron» sin escribir. API y MCP sin esa cabecera conservan el comportamiento de editar el activo.

Los nombres se recortan en los extremos, deben ser únicos sin distinguir mayúsculas y tener de 1 a 40 caracteres. Los ids son slugs únicos; el máximo es 10 temas. Una referencia desconocida responde 404 y un look que no supera el esquema responde 400 antes de guardar. Los cambios genéricos de configuración no pueden escribir `themes`: usa estas rutas. La configuración pública y `/api/state` muestran ids, nombres y cuál está activo, sin los looks inactivos; la exportación completa de configuración sí los incluye.

Activar guarda el look saliente, aplica el entrante y actualiza `activeId` en una única escritura atómica con copia local previa. El cambio se difunde a los overlays, widgets y panel. Las alertas que ya están en pantalla o en la cola del overlay conservan los ajustes de alerta y CSS con los que se construyeron; las alertas construidas después del cambio usan los del nuevo tema. El tema global del overlay cambia entre alertas, no durante la salida de la actual. Se descarta cualquier borrador de Apariencia del tema anterior. Un objetivo o variante de chat inexistente se rechaza en su API con 404 sin cambiar contadores ni configuración; los atajos actuales no incluyen acciones de objetivo o variante.

## Stream Deck

`GET /sd/tema/<id>` o `POST /sd/tema/<id>` activa el tema por su id usando la misma transacción y notificaciones que la API. Un id inexistente responde 404 sin cambios.

## MCP

`listar_temas`, `duplicar_tema { id, nombre }`, `renombrar_tema { id, nombre }`, `activar_tema { id, confirmar: true }` y `borrar_tema { id, confirmar: true }` usan la misma API. La activación y el borrado requieren confirmación de la persona antes de invocar la herramienta. `restaurar_tema` restaura el aspecto de serie del activo; `tema_de_partida` se conserva por compatibilidad solo con el id `plataforma`.

## Migración y copia

Al abrir una configuración anterior a v3 se conserva una copia privada de los bytes anteriores y se crea el tema activo «Normal». Se fusionan y guardan los defaults vigentes de todas las secciones del tema: tema, alertas, overlay, widgets e interactivos, junto con las listas de comandos y timers y el mapa CSS reservado. En cada variación se guardan las condiciones efectivas, incluidos los defaults ausentes. En comandos y timers antiguos incompletos se materializan además los campos que usa el constructor de su alerta, con sus respectivos defaults efectivos; no se inventan permisos, cooldowns ni ajustes de programación ausentes. Así, cambios posteriores a esos defaults no cambian el aspecto existente. Una instalación nueva usa Color de cada plataforma; una instalación v2 que actualice directamente conserva los defaults anteriores (acento sin plataforma y etiqueta de texto).

La copia local `config.backup-…json` puede contener datos privados y debe protegerse. La exportación e importación completas de configuración incluyen los temas guardados y siguen sus reglas normales de revisión y copia; aún no existe exportación/importación individual de temas.
