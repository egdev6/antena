# Estado de antena

Foto del proyecto tal y como está hoy, sin planificación futura. Todo lo de abajo lo
declaran el código y el README, o lo respaldan la suite de tests y las PR ya integradas.

## Qué es

antena es una herramienta local de alertas, chat y widgets de directo para **Meld
Studio**, gratis y con identidad EGDEV. Desde la 0.9 es una **app de
escritorio** (Tauri 2 + React) que arranca el servidor Node de siempre como *sidecar*; se controla
desde su panel, el Stream Deck, el panel de chat de Meld (dock) y un servidor MCP. El servidor
sigue sin dependencias (Node ≥ 22); React, esbuild y Tauri son solo de compilación.

## Qué hace hoy

- **Capas de navegador:** overlay de alertas, y capas de chat, objetivo, últimos apoyos,
  ticker, créditos, pregunta, tier list, sorteo y espectadores, servidas por URL local.
- **Espectadores en directo:** `public/widgets/viewers.html` (`/widget/viewers`, 900×160) pinta una
  tarjeta por plataforma con los espectadores de ahora y, si se piden, el pico y el total;
  parámetros `?platforms=twitch,youtube`, `?layout=column`, `?total=0`, `?peak=1`. Recibe solo
  `publicViewers` (live, current, peak y record por plataforma) por SSE `viewers`, el mismo evento
  que el SDK de los overlays propios expone como `viewers`.
- **Alertas de Twitch y YouTube:** doce tipos normalizados (follow, sub, resub, giftsub,
  cheer, raid, redemption; superchat, supersticker, member, milestone, giftmember) con
  tres diseños (tarjeta, vídeo con texto y vídeo de fondo + tarjeta), variaciones, voz y acciones en Meld.
- **Chat y moderación local:** Twitch y YouTube unificados, envío a una o a las dos
  plataformas con resultado por plataforma, filtro local y reflejo de la moderación de Twitch.
- **Comandos y timers multicanal:** comandos con permisos y esperas, y mensajes programados
  con destino Twitch, YouTube o ambos y pausa global.
- **Meld remoto:** escenas, capas, efectos, mute y ganancia, media, comandos y eventos.
- **Panel, MCP y Stream Deck:** panel por API REST, MCP con 142 herramientas y atajos `/sd/…`.
- **Teleprompter:** guiones por bloques que avanzan solos a X palabras/min, con notas entre
  [corchetes] y línea de lectura. Solo lo ves tú (`/widget/teleprompter`, con su propio kind
  de cliente SSE: el texto del guion nunca llega a otros widgets). El servidor es la fuente
  de verdad del avance (ancla + reloj) y comparte el estado con panel, ventana, Stream Deck
  (`/sd/teleprompter*`) y MCP (7 herramientas). Lista de guiones limitada a 50 y un tope total
  de 1.000.000 bytes de JSON, declarado en el esquema de configuración y por debajo del límite
  de cuerpo de 2e6. En la app de escritorio (#144), el botón «Abrir en ventana» y el desplegable
  de pantalla la abren a pantalla completa (comando `open_teleprompter`, quinta ventana con la
  misma guardia de navegación, sin IPC: no está en la capability); «La principal» resuelve el
  monitor primario del sistema.
- **Prompter:** vista 1024×600 para el Elgato Prompter con chat, preguntas, tier list,
  sorteo y cronología. La app la abre a pantalla completa en la pantalla de 1024×600.
- **Panel v2 (jerarquía):** listado → panel a todo el ancho con pestañas en Alertas (y
  variaciones como segundo nivel), Comandos, Mensajes, Widgets, Atajos, Tier list, Guiones del
  teleprompter, Directos anteriores, Archivos y Conexiones; pestañas de página en el resto;
  creación unificada con plantillas y guardado manual (Guardar/Descartar) con aviso al salir.
  El catálogo fijo (alertas, conexiones, widgets) se ve en tarjetas; los objetivos, dentro de la suya.
- **Fuentes para Meld:** `GET /api/sources` y la vista «Fuentes para Meld» listan cada capa
  con su URL y tamaño (un objetivo por cada uno configurado y un overlay por cada overlay propio),
  más el dock y el prompter.
- **Overlays propios:** `src/custom-overlays.mjs`, `src/routes/custom-overlays.mjs` y la vista React
  `app/src/panel/views/Overlays.tsx`. Cada overlay (id, nombre, html, css, js, ancho, alto, fondo
  transparente y permisos) vive en `config.customOverlays` y se valida igual en todas las vías de
  escritura (HTTP y MCP): 50 como mucho, 512 KB de JSON cada uno. El código corre en
  `/custom/<id>/frame` (`Content-Security-Policy: sandbox allow-scripts`), es decir, en un origen
  opaco sin API ni SSE; la shell de confianza `/custom/<id>` le pasa los datos públicos por
  `postMessage` y escucha `customOverlayVersions` para recargar la capa al guardar. El SDK
  (`public/custom/sdk.js`) expone `antena.on`, `antena.state`, `antena.ready` y
  `antena.run(kind, params)`: las acciones solo se ejecutan si el usuario aprobó ese tipo en el
  panel (`PUT …/permissions`, que exige `Sec-Fetch-Site: same-origin`; el MCP solo las pide), con
  un tope de 10 cada 10 s por overlay (429) y aviso en el editor si el código cambió desde la
  aprobación. Seis herramientas MCP: `listar_overlays`, `ver_overlay`, `crear_overlay`,
  `editar_overlay`, `borrar_overlay` y `probar_overlay`.
- **Atajos personalizados:** pasos encadenados (acciones `/sd/…`, pestaña del prompter y
  acciones de Meld/chat/voz) con dirección `/sd/custom/<id>`, editables en el panel y por MCP.
- **Dock:** `/dock`, vista estrecha para el panel de chat de Meld o ventana flotante.
- **Interfaz React** en `app/src` (panel, prompter, dock); el panel clásico `/legacy` se retiró
  en #115: sin `app/dist`, `/`, `/prompter` y `/dock` responden una página mínima que explica
  cómo compilar la interfaz (`pnpm app:build`).
- **Diseño de la interfaz:** panel y prompter siguen el lienzo «antena — Rediseño» (EGDEV
  Foundation en grafito): cabecera en banda, pie de la barra lateral con pausa y estado en un pozo,
  Directo con StatusBadge, Stat, ModuleCard de alertas, cronología y chat; editor de alertas en
  pestañas (Diseño, Mensaje, Sonido y voz, Acciones, Variaciones, CSS) con SelectTile y StageFrame;
  preguntas, tier list, sorteo y Meld con PostCard --row, SelectTile de escenas e IconButton; y el
  prompter rediseñado (Timeline --lg, Tabs --lg). Todo a la densidad compacta de #104: los
  componentes del sistema se reducen en `app/src/styles/panel.css` (sección «Densidad del panel»).
  Del lienzo quedan fuera el mando móvil (función nueva, no solo diseño) y la ganancia de audio
  de Meld, que Meld no informa.
- **Apariencia (tema de pantalla):** `src/theme.mjs` + `src/routes/theme.mjs`. Un único tema
  (`config.theme`, de serie el de EGDEV) para overlay y widgets, servido en `/theme.css` en la capa
  `egdev-theme` (por encima de `egdev`, por debajo del CSS propio) y avisado por SSE `theme`. Las capas
  usan variables (`--red`, `--surface-bg`, `--glow`, `--round`…) en lugar de rojos fijos; lo que no es
  CSS (icono por tipo, etiqueta de plataforma, posición, sonido) lo aplica el overlay (#157, con
  regresión de navegador). El autoguardado del panel (350 ms) no pisa un punto de partida, una
  importación o «Restaurar EGDEV» hechos en ese margen, y si `PUT /api/theme` falla el panel vuelve
  al último tema guardado con un aviso (#157). Fuentes propias
  en media/ (woff2, woff, ttf, otf). El tema se valida igual en todas las vías de escritura
  (`PUT /api/theme`, `PUT /api/config`, `POST /api/config/set` y la carga de `config.json`): lo inválido
  se rechaza con 400 o vuelve a su valor de serie, los rangos se rechazan con el mensaje del esquema
  en todas las vías menos al importar temas antiguos (que recorta), y `/theme.css` no emite nada sin validar (#151).
  Prompter y teleprompter quedan fuera.
- **Récord de espectadores (#142):** `src/viewers.mjs` mira cada minuto Twitch (`streams`) y YouTube
  (`videos.list`) y lanza las alertas `viewers`/`ytviewers` con freno anti-spam (confirmación,
  salto mínimo, espera con pendiente único, calentamiento, mínimo y punto de partida silencioso).
  Son tipos «de sistema»: no cuentan en métricas, objetivos, últimos, ticker ni créditos.

## Qué está reforzado y probado

- Cierre ordenado y persistencia de lo aceptado (#20, #47, #49).
- Secretos enmascarados en la configuración expuesta (#37).
- Acceso LAN endurecido (#59): cookie `egk` con `HttpOnly`, canje de `?key=` con
  redirección a la URL sin la clave, comparación en tiempo constante y clave
  enmascarada en la configuración pública (el enlace del móvil sigue en `GET /api/access`).
- Atajos `/sd/*` protegidos contra navegadores sin `Sec-Fetch-Site` (#60): un GET con
  `Referer` de otro origen o con `Sec-Fetch-Dest`/`Sec-Fetch-User` sin `Sec-Fetch-Site`
  se rechaza con 403; el plugin del Stream Deck (sin cabeceras) y same-origin siguen
  funcionando.
- Chat del panel acotado a 200 mensajes sin perder scroll ni interacción (#48); en React
  la ventana la carga el panel por `/api/chat?limit=200` (#115): la de 50 del widget no
  la pisa, y los borrados siguen llegando por chatDelete/chatClear.
- Validación de la configuración por esquema (#106): `src/config-schema.mjs` describe tipos, rangos y valores permitidos de las secciones escalares; `PUT /api/config` y `POST /api/config/set` responden 400 con campo y motivo antes de guardar nada, un `config.json` con hojas inválidas arranca con el default de ese campo y un aviso en el registro, y las claves desconocidas se aceptan con un aviso único por ruta (llegan antes que su default, p. ej. `prompter.monitor`). Por ruta (`POST /api/config/set`, MCP `fijar_valor`/`borrar_valor`) ningún tramo puede ser `__proto__`, `constructor` ni `prototype` (si las claves vienen dentro del valor se descartan con un aviso que nombra la ruta), no se escribe ni se borra por debajo de un valor simple, un índice de lista mayor que su longitud se rechaza con 400 en vez de dejar agujeros, borrar una hoja o sección del esquema deja su default al momento (igual que al arrancar) y una sección entera se valida campo a campo igual que en `PUT /api/config`; `store.setPath`/`getPath` tampoco tocan el prototipo.
- Validación de las hojas de alerts, commands, timers, shortcuts, interactive y filters (#118): el esquema cubre también las hojas de esas secciones (enums de aspecto y permisos, rangos con significado real, listas con tope de 20 pasos en los atajos). Un valor inválido en cada sección responde 400 con ruta y motivo sin guardar nada; al cargar, la hoja inválida de un elemento de lista (comando, timer, atajo, variación) vuelve al default de esa hoja con un aviso y el elemento se conserva.
- Endurecimiento menor (#62): `X-Content-Type-Options: nosniff` en las respuestas estáticas y JSON del servidor, CSP básica en el HTML de la app React (mismo origen más lo imprescindible: emotes de Twitch en img-src e IPC de Tauri en connect-src; estilos en línea para el `<style>` del prompter), `esc()` también escapa la comilla simple en overlay y widgets (`el panel clásico se retiró en #115`), `deepMerge` (servidor y app) ignora `__proto__`, `constructor` y `prototype`, y `POST /api/probe` acota el cuerpo (64 KB, 413) y exige un esquema mínimo de campos simples (400).
- SSE con presupuesto de bytes por cliente, aviso de `gap` y reconexión con snapshot (#50).
- Contrato único de eventos SSE (#72): `src/events.mjs` declara los nombres y su clasificación
  (snapshot sustituible / efímero); `src/bus.mjs` y la interfaz React (`app/src/lib/live.ts`, con
  `allowJs` en `app/tsconfig.json` para importar el módulo desde `app/src`) lo consumen. Un test de
  contrato (`test/events-contract.test.mjs`) falla si el servidor emite o un consumidor (React,
  overlay o widgets) escucha un evento sin declarar, o si un evento declarado se queda sin emisor
  y sin consumidor. El panel clásico (`public/panel.js`) y `public/prompter.html` se retiraron
  en #115: los consumidores vivos son la interfaz React, el overlay y los widgets.
- Cola del overlay con tope y política de ráfagas (#66): `overlay.queueMax` en la configuración
  (20 por defecto, 0 = sin tope, editable en el panel) cuenta las alertas enviadas al overlay y aún
  sin confirmar. Al superar el tope se agrupan primero los regalos del mismo tipo, donante y tier
  (el lote ejecuta cada acción una sola vez y el overlay actualiza la alerta ya en cola) y, si aun
  así se sigue por encima, se descartan las más antiguas sin ver: se les cancelan acciones y
  fallback, se avisa al overlay (control `drop`) y queda una nota kind `queue` en la cronología
  (agrupada 2 s, tope 5 s). Los tipos `raid`, `superchat` y `supersticker` no se descartan ni se
  fusionan nunca (#94): si solo quedan protegidas por encima del tope, se muestran todas y la nota
  lo indica. La pausa y el «saltar» no cambian; sin ráfaga el comportamiento es idéntico.
- YouTube: tras agotar la cuota o un error de permisos el sondeo se reintenta con espera
  creciente (sin reiniciar la app), con aviso del motivo en panel y dock (#63).
- Mensajes multicanal con resultado por plataforma y pausa global de timers (#45).
- Coste de guardado de la sesión reducido (#67): cada checkpoint serializa el estado
  una sola vez y los ficheros de sesión (primary, copia y archivados) se escriben en
  JSON compacto; el writer compartido conserva su formato indentado para `config.json`.
- Retención y listado barato de sesiones (#68): `GET /api/sessions` lista desde
  metadatos ligeros (`<id>.meta.json` escrito en cada corte; los archivados antiguos
  sin meta se leen completos una vez como compatibilidad) y no parsea cada archivo
  entero. Retención opcional de archivados: `sessions.retention` en `data/config.json`
  (0 = sin límite, por defecto); con N, tras cada corte solo quedan los N archivados
  más recientes junto a sus metadatos. `GET /api/session/events` aplica defecto 500 y
  tope 1.000 sobre `limit`, y `GET /api/timeline` el tope de 300 también al filtrar por
  `kinds`; ambas respuestas documentan el recorte (`limit`, `capped`). El panel muestra
  el tamaño de cada archivo de `media/` y el total de la carpeta. No se borra media.
- IPC de la app de escritorio acotado (#61): la capability `default` solo concede permisos a
  páginas servidas en `http://127.0.0.1` (nunca `localhost` ni otro origen), y solo los cuatro
  comandos que usa la interfaz (monitores, open_prompter, open_dock, desktop_info), declarados en
  `src-tauri/permissions/commands.toml`. Además, una guardia de navegación en `main.rs` solo deja
  cargar en las tres ventanas el propio servidor: mismo puerto y rutas `/`, `/prompter` y `/dock`
  (con tests Rust), y `tauri.conf.json` define una CSP (cubre la pantalla de inicio local; las
  páginas remotas reciben la del servidor, que hoy no envía cabeceras de CSP). Sin prueba manual
  en Windows todavía: pendiente del mantenedor.
- Sidecar sin huérfanos (#88): con `ANTENA_DESKTOP=1` y la entrada estándar en tubería, el
  servidor vigila su fin: si la app muere de golpe, el sistema cierra la tubería y el servidor
  hace el mismo apagado ordenado que con señales (guarda y sale con código 0, puerto libre).
  Sin esa variable no cambia nada (`pnpm start` y el MCP), y el respaldo de desarrollo de
  `start_server` usa también stdin en tubería. Sin prueba manual en Windows todavía: pendiente
  del mantenedor (ver checklist más abajo).
- CI de Linux y Windows preparada (#69): Baseline (con la interfaz React compilada
  con `pnpm app:build`), Code safety y Secrets scan (#32, #43). Se ejecutó el 19-10-2026:
  Linux (Node 22 y 24) y los dos workflows de seguridad en verde. Desde #83 Windows
  (windows-2022, Node 22 y 24) es **obligatorio**: las pruebas de Ctrl+C aceptan en win32 el
  aviso documentado de recuperación bloqueada, el helper de ACL recibe una copia del entorno
  (la cobertura ya no lo rompe), el corte del cliente SSE lento es determinista y las pruebas
  solo POSIX se omiten con motivo explícito, permitido únicamente en win32. Los dos ensayos de
  ACL reales del helper se omiten si el proceso corre **elevado** (el runner alojado lo está: lo
  creado pasa a ser del grupo Administradores y no del SID del usuario); en un Windows sin
  elevar se ejecutan. Siguen pendientes de un Windows real sin elevar (#1), igual que la
  recuperación de alertas retenidas en la app de Windows.
- **Baseline reactivado con el repositorio aún privado** (#162, 22-10-2026), para tener
  Windows en la CI antes de la primera release: consume minutos de Actions del plan, unos
  35 por ejecución, la mayoría en Windows. Windows es obligatorio
  desde #83. Code safety y Secrets scan siguen desactivados a mano hasta que el repositorio
  sea público (`gh workflow enable code-safety.yml` y `secrets-scan.yml`).
- Release manual (#162): `.github/workflows/release.yml` (Actions › Release, solo
  `workflow_dispatch` y solo desde `main`) comprueba la versión con
  `scripts/release-check.mjs`, compila en windows-2022 el instalador NSIS sin firma (con las
  fuentes de la marca y Node empaquetado) y crea un **borrador** de release con el `.exe` y
  las notas de `docs/releases/v<versión>.md`. No crea tags ni publica: eso lo hace el
  mantenedor al revisar el borrador. Sin firma de código ni actualizador automático.
- App de escritorio probada a mano en Windows (#54, 19-10-2026): `desktop:dev` en un clon
  limpio, bandeja, cerrar a la bandeja con las capas vivas, dock, prompter sin Elgato, una
  sola instancia, «Salir» y Ctrl+C sin servidor huérfano, servidor de `pnpm start` ya en marcha,
  puerto ocupado, aviso cuando el servidor muere, e instalador NSIS sin Node instalado,
  con fuentes y desinstalación limpia.

Suite (20-10-2026, Node en Linux): con `app/dist` compilado **1.113 tests, 1.111 pasan y
2 se omiten** (los dos ensayos Windows reales); sin compilar, 976 pasan y 15 se omiten
(las regresiones de navegador React). 0 fallos. `pnpm typecheck` pasa,
y `cargo test` en `src-tauri/` cubre qué carpetas de datos y qué puerto usa la app.
El editor de mensajes y alertas (destino, avisos de longitud, pausa y resultado por plataforma)
se prueba en Chrome en React; el tope de 200 del chat, la reconexión SSE y el aviso de
persistencia tienen regresiones de navegador React, exigidas por la línea base de CI.

## Qué no se ha probado nunca

- Windows real: NTFS/DACL de la recuperación de alertas y el helper PowerShell.
- Cuentas reales de Twitch y YouTube: login, EventSub, cuotas y envío al chat.
- Meld Studio real: todo lo de Meld se ejercita contra el simulador de la suite.
- Stream Deck físico: los atajos se han llamado por HTTP, no con pulsación real.
- Ensayo de directo completo, de principio a fin con todas las capas a la vez.
- App de escritorio: `ANTENA_DATA` con su propio `"port"` en Windows real (lo cubre
  `cargo test`), y la recuperación de alertas retenidas, que en la app de Windows sale como
  «bloqueada o no disponible».
- Meld real con el dock en su panel de chat y las fuentes añadidas desde «Fuentes para Meld».
- El prompter en el Elgato real con la app (detección de 1024×600 y pantalla completa).
- El tema de Apariencia en el navegador de Meld (usa `color-mix`, capas CSS y `translate`; Chromium ≥ 111).
- Lectura real de espectadores en Twitch (`streams`) y YouTube (`concurrentViewers`): la lógica
  anti-spam está probada con lecturas simuladas.
- Un overlay propio en el navegador de Meld: la recarga al guardar se prueba por el contrato SSE
  (`customOverlayVersions`) y el SDK con las acciones aprobadas en un Chrome real, pero nunca
  dentro de Meld.

## Límites y deudas conocidas

- Panel v2: las vistas previas de los widgets (chat, últimos, créditos) muestran lo guardado,
  no el borrador; los objetivos y la tier list se guardan al momento porque se usan en directo.
  El panel no tiene comprobación de tipos en CI (no hay `@types/react`).

- Un cierre ordenado conserva lo aceptado, pero **SIGKILL** puede perder la última ventana
  pendiente; no hay `fsync` ni resistencia a corte de luz.
- Una sola instancia por `data/`: no hay coordinación multiproceso.
- Las alertas retenidas al cerrar se guardan para revisión manual y **no se reproducen**
  al arrancar.
- Tras un `gap` de SSE, el chat se recupera solo con los últimos 50 mensajes (`/api/chat`).
- Seguimientos de SSE, no bloqueantes: `atRisk` no se reinicia en `drain`, la reconexión del
  panel está probada en una sola vista y el README promete más aviso de `gap` del que hay.

## Checklist de prueba real

Pendiente de ejecutar con hardware y cuentas propias. Una línea por familia:

- [ ] Capa overlay: la alerta sale con diseño, sonido y acciones.
- [ ] Capa chat: Twitch y YouTube unificados; mis mensajes no salen.
- [ ] Capa objetivo: sube con eventos y persiste al reiniciar.
- [ ] Capa últimos apoyos: se actualiza y tiene estado vacío legible.
- [ ] Capa ticker: marquesina estable, también sin texto configurado.
- [ ] Capa créditos: cronología y resumen, sin duplicar al lanzar dos veces.
- [ ] Capa pregunta: la cola sale en pantalla y marca la anterior respondida.
- [ ] Apariencia: en Meld, un cambio de tema llega al overlay y a las capas sin recargarlas
      (color, fuente subida, icono por tipo, posición, animación y sonido).
- [ ] Alertas Twitch: follow, sub, resub, giftsub, cheer, raid y recompensa reales.
- [ ] Alertas YouTube: superchat, supersticker, miembro, hito y membresías regaladas.
- [ ] Comandos: permisos, esperas y variables `{user}` y `{args}`.
- [ ] Timers: destino Twitch/YouTube/ambos, límites de 500/200 y fallo parcial.
- [ ] Pausa: detiene alertas y envíos, y al reanudar no hay ráfagas.
- [ ] Meld: escena con vuelta, capa con segundos, efecto, mute/ganancia, media y comando.
- [ ] Meld: referencia inválida y Meld cerrado dan error visible, no éxito.
- [ ] Stream Deck: pausa, saltar, siguiente/ocultar pregunta, marca y agradecido.
- [ ] Móvil: enlace con clave y rotación de clave.
- [x] App: `desktop:dev` compila, arranca el servidor, abre el panel y deja icono en la bandeja.
- [x] App: «Salir» apaga el servidor guardando (verificado en #54); falta la prueba de #88:
- [ ] App (#88): con `desktop:dev` abierto, matar `antena.exe` desde el Administrador de
      tareas no deja ningún `node.exe` de la app vivo y el puerto 4500 queda libre.
- [ ] App: «Abrir en el Prompter» va a pantalla completa al Elgato.
- [x] App: `desktop:build` genera el instalador y funciona sin Node instalado.
- [ ] Meld: el dock en el panel de chat; botones, atajos y chat funcionan.
- [ ] Stream Deck: un atajo propio de varios pasos con `/sd/custom/<id>`.

Preguntas abiertas: hardware (PC, Stream Deck, Prompter, micrófono), versiones (Windows,
Meld Studio, navegadores), eventos reales sin comprar nada, presupuestos y activos de prueba.

## Fuera de alcance por ahora

- OBS: no hay integración.
- Sorteos y tier list: el código existe, pero no se acreditan en esta fase.
- Moderación remota: no hay ban ni timeout lanzados desde antena.

El historial de planificación anterior (ODD, roadmap #31) se puede consultar en git.

Higiene de la auditoría (#75): la versión del MCP sale de `package.json`, sin referencias
ODD-xx en `src/`, comentarios y tests de la familia held-recovery en castellano, skill
`contribute` con pnpm, export de vistas renombrada a `Vistas`, ruta de datos de desarrollo
canonizada en la app, test de puerto Rust independiente del entorno y precedencia del puerto
documentada en `src/server.mjs`.
