# FS2 — resolución Win32 ordinaria de symlink y `..`

El candidato local ajusta el detector a la IO Windows medida; Unix conserva
symlink-antes-de-`..`. GREEN local verificado; Windows físico del fix pendiente.

## Evidencia física

Run **38644974828**, Windows Node **22.23.3 / 24.21.0**:
`test/fs-dotdot-probe.test.mjs` midió alias y ruta directa, relativos y absolutos.
Con `bridge -> foreign/child`, las cuatro escrituras alcanzaron `root/out.json`;
en Unix las cuatro alcanzaron `foreign/out.json`.

- Windows almacenó el alias relativo como `bridge\..\out.json`, conservando dots.
- Node almacenó el alias absoluto normalizado a `root/out.json`.
- Alias relativo y rutas directas: detector ausente `{root:false, foreign:true}`;
  existente `{root:true, foreign:true}`. Ambos contradicen la IO medida.
- El alias absoluto normalizado fue el control correcto en ambos estados.

## Cambio y revisión

`scripts/baseline.mjs` normaliza con el módulo path nativo solo Win32 ordinario:
la entrada antes del recorrido y el readlink relativo concatenado con su padre.
Conserva la lógica drive-relative. No aplica normalización universal a Unix.
El fixture mide alias y directo por separado, captura el readlink almacenado,
limpia el sentinel y exige el ganador físico: Windows root, Unix foreign.

## Validación y límites

RED local Node **22.14.0 / 24.20.0**: exit 1, 61 tests, 52 pass, 9 fail, 0 skip;
seis aserciones del modelo Win32 fallaron, ambos controles absolutos pasaron.
GREEN focal 61/61 y suite Linux+Chrome 502/502, exit 0 y cero skips en ambos Node.
Linux/modelo no sustituye Windows físico; verificación independiente y revisión aparte.
`\\?\` y `\\.\`, incluso con `/` alternativos, quedan fuera del normalizador:
conservan el tratamiento previo, sin afirmar cobertura nativa de namespaces.
Contexto y método del probe: [medición FS2](windows-fs-dotdot-probe.md).
