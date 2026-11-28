# Rendimiento: renders por ráfaga de chat y tamaño del bundle

Medir antes de optimizar (#360, hito M20). Este documento explica cómo se mide y recoge los números de
partida y sus comparaciones. No hay umbrales de CI: ni el comando ni ningún workflow fallan por un número.

## Cómo medirlo

```
pnpm perf
```

Un solo comando que imprime dos tablas:

1. **Renders por componente** con una ráfaga de chat en el panel, el dock y el prompter (Chrome real contra
   un servidor de pruebas con datos sintéticos; nunca Twitch, YouTube, Meld ni OBS).
2. **Tamaño del bundle** de producción: JS y CSS, bruto y gzip.

Necesita `pnpm install` hecho y Chrome (si no está en la ruta habitual, define `CHROME_PATH`); tarda unos
10 s. No toca `app/dist`: compila en directorios temporales que borra al terminar.

| Opción | Qué hace |
| --- | --- |
| `--only size` | Solo el tamaño del bundle (no necesita Chrome). |
| `--only renders` | Solo los renders de la ráfaga. |
| `--messages N` | Mensajes de chat de la ráfaga (100 por defecto). |
| `--viewers-every N` | Una lectura de espectadores cada N mensajes (10 por defecto). |
| `--ticks N` | Ticks del reloj de 1 s que se miden aparte (10 por defecto). |
| `--json` | El mismo resultado como JSON, para comparar antes y después con un script. |

Para comparar un cambio, corre `pnpm perf` en `main` y en tu rama con los mismos parámetros, equipo y
versión de Chrome. Repite la medición y pega en la PR los valores observados (o el intervalo si varían),
junto con el entorno. Para guardar los resultados: `pnpm perf --json > antes.json` y lo mismo después.

## Qué mide la ráfaga

Cada página se mide contra un servidor nuevo (`createApp` sobre un directorio temporal) y un Chrome nuevo
que carga un build instrumentado (ver más abajo). Con la página estable:

- Se envían N mensajes de chat (`engine.handleChat`, uno cada 5 ms) y, cada V mensajes, una lectura de
  espectadores (lectores sintéticos inyectados en `app.viewers`; el récord queda muy por encima de las
  cifras, así que no hay alertas ni guardados a mitad de la ráfaga). Cada mensaje es un evento `chat` del
  flujo y cada lectura un evento `viewers`: la ráfaga por defecto son 110 eventos.
- Se espera a que la página haya recibido todas las tramas (y, en las vistas de chat, a que el último mensaje
  esté pintado) y a que deje de renderizar.
- **Ráfaga**: renders de cada componente durante esos eventos.
- **Reloj**: los intervalos de 1 s de la página se congelan al cargar, para que el tiempo real no sume
  renders, y el escenario los dispara a mano N veces sin tráfico. La columna dice cuánto cuesta un tick
  (Directo, el `Status` del dock y el `Top` del prompter tienen cada uno el suyo).

Un «render» es una ejecución de la función del componente; no se mide tiempo ni coste de DOM. La prueba de
navegador comprueba que, al repetir el escenario, llegan los mismos eventos y el chat muestra las mismas
filas en el mismo orden. Los renders de la ráfaga pueden variar incluso entre dos ejecuciones en el mismo
equipo: el navegador, el hardware y la carga influyen en cuándo llega el trabajo a React y en qué
actualizaciones agrupa (*batching*). El comando muestra los valores medidos, no cifras esperadas. Si a una
página llega algún evento ajeno a la ráfaga, la salida lo avisa (`aviso: …`).

| Página | Componentes medidos | Fuente |
| --- | --- | --- |
| `panel/directo` | `panel/Sidebar`, `panel/Directo` | `app/src/panel/Sidebar.tsx`, `app/src/panel/views/Directo.tsx` |
| `panel/chat` | `panel/Sidebar`, `panel/Chat` | `app/src/panel/Sidebar.tsx`, `app/src/panel/views/Chat.tsx` |
| `dock` | `dock/Status` | `app/src/dock/Dock.tsx` |
| `prompter` | `prompter/Top`, `prompter/Eventos`, `prompter/Chat` | `app/src/prompter/Prompter.tsx` |

## El contador de renders (solo para tests)

- `app/src/lib/render-count.ts`: `countRender('superficie/Componente')`, al principio de un componente, suma
  uno en `globalThis.__antenaRenderCounts`.
- La constante de compilación `__RENDER_COUNT__` la define `scripts/build-app.mjs` y vale `false` salvo con
  `--render-count`, que solo usa la medición. Con `false`, esbuild elimina la función y todas sus llamadas:
  el bundle de producción no lleva el contador ni paga su coste. Se comprueba así tras `pnpm app:build`:
  `grep -c __antenaRenderCounts app/dist/assets/*.js` da 0 en cada fichero (lo cubre también
  `test/render-counter.test.mjs`).
- Para medir otro componente: añade su `countRender` y su etiqueta en `test/render-surfaces.mjs`. El escenario
  vive en `test/render-scenario.mjs`.

## Línea base (28-11-2026)

Medición de referencia sobre `main` en `02ec843`, con Node 24.22.2, Chrome 148, esbuild 0.28.2 y React 19.3.1
(en Linux). Estas cifras corresponden a ese entorno y esa ejecución; no son umbrales ni predicen cuántos
renders habrá en otra ejecución.

`pnpm perf --only renders` (100 mensajes de chat, 10 lecturas de espectadores, 10 ticks de reloj):

```
Página         Componente        Ráfaga  Reloj
panel/directo  panel/Sidebar        110      0
panel/directo  panel/Directo        110     10
panel/chat     panel/Sidebar        110      0
panel/chat     panel/Chat           100      0
dock           dock/Status          110     10
prompter       prompter/Top         110     10
prompter       prompter/Eventos     110      0
prompter       prompter/Chat        200      0
```

En esa medición:

- `Sidebar`, `Directo`, `Status`, `Top` y `Eventos` registraron 110 renders cada uno. En esa versión leen el
  estado entero (`useLive(x => x)`), aunque ninguno pinte el chat y solo `Directo` pinte espectadores.
- `panel/Chat` registró 100 renders; su selección del estado no incluye las lecturas de espectadores.
- `prompter/Chat` registró 200 renders; en esa versión el efecto de scroll llama a `setUnseen(0)` incluso
  cuando el contador ya vale 0.
- `Directo`, `Status` y `Top` registraron 10 renders cada uno con los 10 ticks manuales.

`pnpm perf --only size` (build de producción, bytes; gzip nivel 9):

```
Archivo        Bruto    gzip
panel.js      420519  121390
chunk.js      265339   82778
dock.js        32260    9591
prompter.js    17804    5930
chunk.js        5205    2298
panel.css     101247   18799
dock.css       14288    3455
prompter.css   11502    2921

Total   Bruto    gzip
JS     741127  221987
CSS    127037   25175
```

En total, 723,8 KiB de JS (216,8 KiB con gzip) y 124,1 KiB de CSS (24,6 KiB con gzip). Los nombres salen sin el
hash de contenido; los dos `chunk.js` son los trozos compartidos entre el panel, el prompter y el dock.

## Vistas del panel bajo demanda (#366)

Directo y la barra lateral se cargan al arrancar. Las demás vistas se cargan al abrirlas o se precargan al
pasar el cursor o enfocar su enlace en la barra lateral. Una descarga pendiente muestra «Cargando vista…»
sin ocultar la barra lateral. Si falla, se puede abrir otra vista o elegir «Recargar panel» para volver a
intentar la misma dirección, incluidos sus parámetros en el hash.

Comparación de producción en bytes (`node scripts/perf.mjs --only size`, gzip nivel 9 por archivo), antes
(`8f5c830`, con #360 y #361) y después:

| JavaScript | Antes (bruto) | Después (bruto) | Antes (gzip) | Después (gzip) |
| --- | ---: | ---: | ---: | ---: |
| Entrada `panel.js` | 422373 | 34682 | 122133 | 11710 |
| Arranque del panel (entrada e imports estáticos) | 692917 | 340027 | 207209 | 111678 |
| Todos los archivos JS de `app/dist/assets` | 742981 | 752674 | 222730 | 244485 |

El JS de arranque baja un 51 % en bruto y un 46 % con gzip, aunque pasa de 3 a 15 archivos. El total crece
al dividir el código en más trozos; los estilos no cambian. Estas cifras miden tamaño, no tiempo de arranque.

`node --test --test-timeout=300000 test/panel-lazy-routes-browser.test.mjs` comprueba las rutas y los
chunks de producción servidos en `/assets/` por el servidor local, con HTTPS externo bloqueado en Chrome.
Tauri empaqueta ese mismo `app/dist` para el sidecar; queda pendiente probar el instalador y WebView2 en
Windows real.

## Límites

- La ráfaga está espaciada (5 ms entre mensajes) para no saturar el flujo. Se cuentan las ejecuciones de cada
  componente durante toda la ráfaga, no los renders atribuibles a cada evento ni cuánto tarda el navegador.
- Los tamaños se midieron con las versiones de `pnpm-lock.yaml`; con otras versiones de esbuild o React pueden
  cambiar.
- El servidor de pruebas arranca con datos vacíos: el chat empieza sin historial y las vistas no tienen
  alertas, objetivos ni directos archivados. Los límites de filas de cada chat siguen vigentes.
