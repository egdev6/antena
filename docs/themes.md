# Temas guardados (API y MCP)

Un tema es una copia completa de `theme`, `alerts`, `overlay`, `widgets`, la **configuración** de interactivos (preguntas, tier list y sorteo), `commands` y `timers`. Viajan también sus valores operativos: acciones, plataformas, mínimos, objetivos y mensajes, no solo colores o CSS. Los cambios corrientes editan el tema activo. El estado del directo (cola, preguntas, votos, participantes y contadores) no pertenece al tema.

Las conexiones y secretos, las sesiones, Meld/OBS y su configuración, Discord, calendario, acceso, puerto, panel, dock, prompter y teleprompter son globales. El código y permisos de los overlays propios también son globales. `customOverlayCss` reserva un mapa `{ idOverlay: css }` por tema, pero **todavía no se aplica** a los overlays. Cambiar de tema no modifica escenas ni fuentes de navegador.

Esta fase ofrece la gestión por API y MCP; todavía no hay selector de temas guardados en el panel o el dock. Apariencia sigue editando el tema activo y conserva sus puntos de partida. Los resets de alertas o Apariencia afectan solo al tema activo.

## API

- `GET /api/themes` devuelve `{ "themes": [{ "id", "name", "active" }] }`.
- `POST /api/themes/duplicate` con `{ "from": "normal", "name": "Navidad" }` copia el tema activo o uno inactivo.
- `POST /api/themes/from-default` con `{ "name": "Plataformas" }` crea desde la configuración de serie con «Color de cada plataforma» (`platformAccent: true`, `platformBadge: "logo"`). No cambia todavía el default ni los puntos de partida existentes.
- `PUT /api/themes/:id` con `{ "name": "Nuevo nombre" }` renombra sin cambiar el id.
- `POST /api/themes/:id/activate` activa el tema; repetirlo para el activo no escribe ni crea copia.
- `DELETE /api/themes/:id` borra un tema inactivo. El activo responde 409: «Activa otro tema antes de borrar este».

Los nombres se recortan en los extremos, deben ser únicos sin distinguir mayúsculas y tener de 1 a 40 caracteres. Los ids son slugs únicos; el máximo es 10 temas. Una referencia desconocida responde 404 y un look que no supera el esquema responde 400 antes de guardar. Los cambios genéricos de configuración no pueden escribir `themes`: usa estas rutas. La configuración pública y `/api/state` muestran ids, nombres y cuál está activo, sin los looks inactivos; la exportación completa de configuración sí los incluye.

Activar guarda el look saliente, aplica el entrante y actualiza `activeId` en una única escritura atómica con copia local previa. El cambio se difunde a los overlays, widgets y panel. Las alertas que ya están en pantalla o en la cola del overlay conservan los ajustes de alerta y CSS con los que se construyeron; las alertas construidas después del cambio usan los del nuevo tema. El tema global del overlay cambia entre alertas, no durante la salida de la actual. Se descarta cualquier borrador de Apariencia del tema anterior. Un objetivo o variante de chat inexistente se rechaza en su API con 404 sin cambiar contadores ni configuración; los atajos actuales no incluyen acciones de objetivo o variante.

## MCP

`listar_temas`, `duplicar_tema { id, nombre }`, `renombrar_tema { id, nombre }`, `activar_tema { id, confirmar: true }` y `borrar_tema { id, confirmar: true }` usan la misma API. La activación y el borrado requieren confirmación de la persona antes de invocar la herramienta.

## Migración y copia

Al abrir una configuración anterior a v3 se conserva una copia privada de los bytes anteriores y se crea el tema activo «Normal». Se fusionan y guardan los defaults vigentes de todas las secciones del tema: tema, alertas, overlay, widgets e interactivos, junto con las listas de comandos y timers y el mapa CSS reservado. En cada variación se guardan las condiciones efectivas, incluidos los defaults ausentes. En comandos y timers antiguos incompletos se materializan además los campos que usa el constructor de su alerta, con sus respectivos defaults efectivos; no se inventan permisos, cooldowns ni ajustes de programación ausentes. Así, cambios posteriores a esos defaults no cambian el aspecto existente. Una instalación nueva sigue usando el aspecto de serie anterior en esta fase.

La copia local `config.backup-…json` puede contener datos privados y debe protegerse. La exportación e importación completas de configuración incluyen los temas guardados y siguen sus reglas normales de revisión y copia; aún no existe exportación/importación individual de temas.
