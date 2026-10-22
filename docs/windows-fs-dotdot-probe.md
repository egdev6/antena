# FS2 — medir symlink y `..` antes de cambiar el oráculo

## Pregunta

Los dos grupos de regresión symlink/`..` de #35 siguen fallando en Windows.
¿La creación del enlace conserva su texto? ¿Una escritura directa a
`bridge/../out.json` alcanza el mismo fichero que una escritura por el enlace?

## Medición

`test/fs-dotdot-probe.test.mjs` crea un directorio privado con `bridge` apuntando
hacia `foreign/child`, y un enlace de fichero relativo o absoluto con `..`.
Antes de escribir, registra el resultado del detector para ambos candidatos.
Después de escribir por el enlace y, por separado, por la ruta directa, lee
`root/out.json` y `foreign/out.json` y exige que solo uno contenga el sentinel.
La salida TAP registra el argumento de creación, `readlink` efectivo, destino
observado y detector con destino ausente/existente. Los paths privados se redactan.
No escoge el candidato por `process.platform`; el filesystem decide la medición.

## Límites

Este corte añade observación, no arregla ni sustituye los tests fallidos existentes.
No cambia `scripts/baseline.mjs`, señales, workflows ni cobertura Chrome.
No hay skips ni relajación de errores de creación de symlinks.
La evidencia Linux no sustituye la ejecución física Windows Node 22/24.

En [Node 22.23.0, `preprocessSymlinkDestination`](https://github.com/nodejs/node/blob/v22.23.0/lib/internal/fs/utils.js),
los enlaces de fichero absolutos pasan por `toNamespacedPath`; los relativos
solo convierten `/` a `\\` en JavaScript. Esto orienta el probe, pero no prueba
cómo el backend Windows resuelve `..`. Primero observaremos CI; después
separaremos defectos del resolver de expectativas incorrectas del fixture.
