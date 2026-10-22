# FS1: identidad física de padres para destinos ausentes

Refs #30. Primer corte de filesystem; no resuelve toda la matriz Windows.

`destinationCollision` detecta colas idénticas bajo padres que son el mismo
objeto físico aunque `realpath` conserve grafías distintas (`Results`/`results`).
Compara `dev`/`ino` del ancestro existente, no minúsculas globales.

## Qué revisar

1. `test/baseline.test.mjs`: modelo aislado con identidad física compartida pero
   grafía conservada; comprueba ambas direcciones y colas de varias profundidades.
2. `scripts/baseline.mjs`: tras resolver componentes, comparar cola exacta y
   ancestros físicos. Padres distintos y colas con nombres/case distintos no
   se convierten en colisiones por normalización indiscriminada.
3. En Windows real, ejecutar el test nativo de sensibilidad del filesystem;
   el modelo Linux no sustituye esa validación.

## Evidencia local

- RED: modelo reforzado, código sin corregir, Node 22/24 exit 1
  (`false !== true`, mismo destino ausente).
- GREEN: `node --test --test-reporter=tap test/baseline.test.mjs`, Linux
  Node 22.14.0 y 24.20.0: 47/47, sin fallos, skips ni cancelaciones.
- La suite completa y la verificación independiente son controles adicionales;
  el estado de su ejecución se recoge en la entrega, no se presupone aquí.

## Límites y siguiente corte

No se cambia el recorrido de symlinks/`..`, el CLI, los tests de señales,
Chrome, workflows ni permisos. La interpretación física Windows de symlink/`..`
requiere su propia caracterización; no se fuerza el oráculo Unix en Windows.

No se infiere sensibilidad de componentes todavía ausentes, ni se garantiza
atomicidad frente a modificaciones concurrentes del filesystem. El corte no
promete CI Windows verde: todavía quedan fallos independientes por resolver.

Rollback: retirar el comparador de ancestros y su llamada; conservar la regresión
como evidencia de la colisión que volvería a quedar sin detectar.
