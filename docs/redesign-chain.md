# Revisión del rediseño por cortes

El rediseño se integra mediante una rama tracker y tres cortes dependientes. La futura PR tracker queda en borrador y no se integra en `main` hasta revisar todos los cortes.

## Recorrido de revisión

| Orden | Rama | Base de la PR | Resultado |
|---|---|---|---|
| Tracker | `feat/redesign-integration` | `main` | Este plan; después, integración final |
| 1 | `feat/redesign-foundation` | `feat/redesign-integration` | Foundation y shell visual del panel |
| 2 | `feat/redesign-stream-tools` | `feat/redesign-foundation` | Cronología, chat multiplataforma, OAuth y contratos de control |
| 3 | `feat/redesign-prompter` | `feat/redesign-stream-tools` | Vista Prompter, ajustes y cierre del alcance |

Revisamos cada hijo contra su base inmediata, no contra `main`. Al integrar un padre, comprobamos la base del siguiente para no repetir cambios.

## Fuente y límites

- Base local verificada: `main`, commit `2dfc7d9`.
- Snapshot local de la implementación y sus correcciones: `feat/new-redesign`, commit `7891ab7`; incorpora el orden de `/sd/agradecido`, el rechazo MCP de `valor:false` sin `id` (corte 2) y el cierre del editor de marcas para mantener viva la cronología (corte 3). Los commits originales se conservan; Prompter hereda el fix MCP mediante un merge local.
- Código y README finales deben conservar el contenido del snapshot. Los dos archivos adicionales de esta cadena son este plan y `test/foundation.test.mjs`, que verifica los artefactos CSS.
- Los tests y las secciones del README acompañan al comportamiento que comprueban. El README existente se reparte sin migración de marca ni traducción.
- Los CSS de Foundation suman 1.952 líneas y son artefactos indivisibles. Los cortes pueden superar la referencia orientativa de 400 líneas; no se comprime ni elimina código para aparentar un diff menor.

## Verificación por corte

1. Comprobamos el diff contra la base inmediata y ejecutamos `npm test`.
2. Comprobamos sintaxis, rutas/imports y el funcionamiento del panel con un navegador local.
3. En el corte final, verificamos Prompter a 1024×600, respuestas de navegación obsoletas y foco de las acciones de chat.
4. Comparamos la integración con el snapshot fuente, admitiendo únicamente los dos archivos adicionales indicados arriba.

Las fuentes locales ausentes y el favicon ya provocaban 404 en la base; no son parte del rediseño. El acceso LAN con clave, Elgato/Meld y las cuentas reales de Twitch/YouTube requieren verificación en el entorno de uso. Las pruebas locales no certifican esas integraciones ni el CI remoto.

## Antes de publicar o integrar

- [ ] Issue aprobada enlazada: los hijos usan `Refs`; la integración final usa `Closes`.
- [ ] Exactamente una etiqueta `type:feature` por PR, disponible y autorizada.
- [ ] Cada corte conserva sus pruebas y documentación; bases sin diffs repetidos.
- [ ] Checks exigidos por la política de destino comprobados y limitaciones registradas.
- [ ] Autorización explícita para push y creación de issue/PRs; preparar ramas locales no la concede.

Kick, voces de pago, migración del README y rediseño Show de overlays quedan fuera de esta cadena. La deuda heredada de sorteo/subidas no se mezcla con estos cortes.
