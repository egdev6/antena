# Calendario externo de directos

En **Conexiones › Programación**, guarda la URL y una credencial de cliente con permiso de lectura; usa **Probar** para consultar el evento actual. La opción «Usar el evento programado al empezar el directo» está desactivada por defecto y exige una credencial ya guardada. La URL admite solo una dirección base HTTP o HTTPS a `localhost`, `127.0.0.1` o `[::1]`, sin ruta (salvo `/`), usuario, contraseña, consulta ni fragmento. La credencial se guarda por separado en el almacén local de secretos, se enmascara en el panel y no se exporta ni se importa con la configuración. Las redirecciones no se siguen.

Al iniciar la sesión, antena consulta una vez el calendario con un límite de unos tres segundos. Si encuentra un vídeo de YouTube válido, lo usa sin `search.list`, sin modificar `youtube.video`, y vincula el evento con la sesión y con el campo aditivo `scheduledEventId` de las métricas v1. Si hay título o ID de categoría de Twitch, los aplica al arrancar con el permiso `channel:manage:broadcast`; un fallo se muestra, pero no detiene el directo. No cambia el título de YouTube ni modifica el aviso de inicio de Discord. Sin evento, ante error, credencial incorrecta o vencimiento del plazo, vuelve al descubrimiento habitual de YouTube y muestra el estado.

## Contrato del calendario

`GET <url>/api/v1/live-events/current?at=<ms>` con `Authorization: Bearer <credencial>`; `at` es el inicio de la sesión en milisegundos Unix. El proveedor elige el inicio programado más próximo en `[at−180 min, at+60 min]`.

Una respuesta 200 contiene `{eventId, criterioEventId, youtube: {broadcastId, url}, title, scheduledStart, durationMin, state, twitch: {title, category, categoryId}}`. Los campos pueden ser nulos en eventos adoptados; `state` es `scheduled` o `live`. Sin un `broadcastId` de YouTube de 11 caracteres se usa la búsqueda habitual. `categoryId` puede ser nulo; en ese caso no se envía la categoría a Twitch. Si llega, puede ser un entero positivo o una cadena de dígitos y se envía como cadena.

`scheduledStart` llega en milisegundos desde epoch (también se acepta una fecha ISO); antena la guarda en la sesión como fecha ISO. Puede ser `null` en eventos adoptados.

Los errores devuelven solo `{ "code": "…" }`: 400 `invalid_input`, 401 `unauthenticated`, 403 `scope_denied`, 404 `no_current_event`. `POST /api/schedule-calendar/test` prueba la conexión guardada con la hora actual y devuelve el estado y, si existe, el título y la fecha del evento.
