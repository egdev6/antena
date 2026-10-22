# Native signal-child test transport

`test/helpers/signal-child.mjs` exports `launchSignalChild(executable, args, options)`
and `interruptSignalChild(child, signal = 'SIGINT')`. This is test infrastructure,
not an application shutdown API. Baseline native coverage and its limits are below.
El diagnóstico acotado de publicación no corrige el fallo ni establece su causa.

## Platform contract

| Operation | Windows | Unix |
| --- | --- | --- |
| launch | Hidden, real `CREATE_NEW_CONSOLE`; owned native process HANDLE | Native `spawn` result |
| interrupt SIGINT | Real `CTRL_C_EVENT`, never application IPC or `process.emit` | Real `child.kill('SIGINT')` |
| interrupt SIGTERM | Reject unsupported operation; do not remap | Real `child.kill('SIGTERM')` |
| kill SIGINT/SIGTERM/SIGKILL | Forced `TerminateProcess` on the owned HANDLE | Unchanged `ChildProcess.kill` |
| normal exit | Actual native numeric status, including 0 and 1 | Native ChildProcess fields |

Windows forced termination reports its native positive exit code and `signalCode = null`.
A requested signal name is not evidence of an OS-delivered signal or graceful drainage.

## Isolation and transport

Before starting the controller, the still-running Node parent obtains its own creation
FILETIME through a separate read-only PowerShell `-File` query. The query uses
`Process.StartTime.ToFileTimeUtc()` (100-nanosecond ticks) and invariant decimal output;
its PID is a data argument, never interpolated PowerShell code. Its stdout/stderr are
privately buffered, never connected to application stdio. Missing, malformed, overflowing,
or noncanonical output prevents controller startup and produces only a generic error.
`parseParentCreationTime` validates positive canonical uint64 strings without Number
conversion, preserving every tick, and is exported for unit tests.

The launch configuration carries `parentPid` and the exact `parentCreationTime` string.
Before creating any target, the controller opens the parent HANDLE, reads native
`GetProcessTimes`, compares creation strings ordinally, and verifies that the parent is
alive. Missing/invalid identity or a reused PID fails closed: no target or READY report;
only the acquired parent HANDLE is closed, never terminated. The retained matching
HANDLE then supplies lifetime monitoring without further PID-based parent lookups.

The controller retains child and verified parent HANDLEs, records native child creation
identity, and validates launch identity and monotonic request IDs through atomic private JSON files.
Before **every** Ctrl+C event it attaches only to its owned live child's console and
requires exactly two members: target and controller, never the test runner.
Ignoring Ctrl+C is enabled only in the controller, after native child creation/attachment.
The event uses group zero only inside that verified console; no global process kills.

Only three anonymous-pipe client HANDLEs are inherited. Configuration consumes exactly
one UTF-8 stdin line without reader read-ahead. Original host streams are captured before
console attachment; .NET tasks pump raw bytes, without PowerShell runspace callbacks.
Metadata/errors never use the child's stdout/stderr transport. Arguments use Windows CRT
quoting, not shell evaluation; command lines are limited to 32767 UTF-16 units including NUL.
The native child inherits the controller's launch environment (`options.env`).

## Adapter limits and cleanup

Windows supports piped stdin/stdout/stderr, `cwd`, and `env`; `windowsHide` is accepted
but the controller is always hidden. The adapter exposes `pid`, streams, `stdio`, `killed`,
`exitCode`, `signalCode`, `kill`, and EventEmitter events, not the complete ChildProcess API.
`kill` synchronously accepts a control request; execution failures surface as errors.
`exit` follows native status; `close` follows controller exit and output drainage.
Ctrl+C receipts contain `event`, `targetPid`, `controllerPid`, and verified `consolePids`.
Launch readiness means native creation; callers must await application readiness before interrupts.

El reporte temprano `exit.json` (`state: exiting`) y el reporte posterior al drenaje
`complete.json` (`state: complete`) son snapshots separados e inmutables: cada nombre
se intenta publicar como máximo una vez, incluso si falla parcialmente y entra en `finally`.
El adaptador sólo lee `complete.json` al validar el cierre estable del controlador;
exige la misma identidad y exitCode, ACKs completos, controller code 0 y signal null.
No acepta `exit.json` como fallback ni borra un error previo si la recuperación completa.
Las pruebas VM/estructurales de este contrato no demuestran ejecución nativa Windows.

The identity query has its own 10-second timeout and 128-byte buffer limit per output
stream; timeout/overflow terminates only the owned query process, before any controller
or target exists. It inherits the requested `cwd` and `env`, as does the controller.
Native startup has a separate 10-second deadline after controller spawn; this is not a
single 10-second total launch budget. Acknowledgements also have 10-second deadlines;
output drainage is bounded to 10 seconds, and forced cleanup waits up to 5 seconds on
the owned child HANDLE.
Stdin EOF reaches the child but **does not** mean parent death or cancel pending work.
Parent HANDLE death, explicit cancellation, or controller exceptions trigger owned cleanup.
Abrupt external controller termination cannot execute `finally`; fixtures therefore keep an
independent 20-second watchdog. No claim of protection from arbitrary external hard kills.

The focused tests cover split UTF-8 JSON-RPC, binary output, repeated interrupts, EOF with
pending work, normal native statuses, and platform-specific forced/graceful termination.
The decimal parser tests cover exact strings beyond 2^53, uint64 boundaries, and invalid
or missing identities; these are not Windows kernel tests. Within the existing normal-exit
test, Windows additionally runs the real controller with the live harness PID and a
known-wrong `parentCreationTime` of `'1'`. It requires exit 1, a private error report,
no target marker/READY/exit report, and a surviving harness parent. It does not simulate
PID reuse or claim to exercise every scheduling race.

## Fases fijas del controlador

El catch de ejecución publica `launchId`, el código fijo `NATIVE_CONTROLLER_FAILURE` y
`phase` en el archivo privado `error.json`. La fase indica la última frontera intentada,
no una causa ni una marca temporal del kernel. Cubre configuración, lanzamiento/READY,
comprobaciones de ejecución/propietario/entrada, peticiones, interrupción/terminación,
publicación de ACK, salida, drenaje y espera de sondeo.

`controllerFailure(report, expectedLaunchId)` sólo muestra una fase admitida cuando
coinciden el launch esperado no vacío y el código fijo. Si no, muestra `unknown`.
El mensaje previo es exactamente `Native signal controller failed (phase: <fase>)`.
El error conserva `ERR_SIGNAL_CONTROLLER` y `Object.keys(error)` sigue siendo `['code']`;
no copia excepciones, argumentos, entorno, PIDs, rutas ni `cause`.

Un ACK de rechazo publicado correctamente conserva la fase original de la petición;
si falla su publicación, se informa esa frontera. Los fallos anteriores a la preparación
del reporte y los de `finally` no se reportan ni reclasifican de forma nueva.
El tratamiento de reportes truthy inválidos sigue fallando cerrado; los JSON falsy
(`false`, `0`, `""`, `null`) siguen sin activar esa rama de error.

## Metadatos acotados de `complete-publish`

Sólo un fallo real de `AtomicJson` durante `complete-publish` añade el objeto opcional
`publishFailure` al reporte. Sus **únicas** claves son:

| Campo JSON | Valores admitidos |
| --- | --- |
| `operation` | `write` o `replace` |
| `kind` | Para `replace`: `win32`; para `write`: `io`, `access`, `security`, `argument`, `unsupported`, `unknown` |
| `nativeCode` | `null` o un entero de la lista inferior; `write/unknown` exige `null` |

Lista cerrada en C# y JS: `2, 3, 5, 6, 8, 14, 17, 19, 21, 32, 33, 80, 87, 112, 123,
145, 183, 206, 995`. Los demás códigos se reducen a `null`. C# toma los 16 bits bajos
de `Exception.HResult` únicamente si los bits altos corresponden a `HRESULT_FROM_WIN32`
(`0x80070000`) y la categoría es conocida. No serializa HRESULT completo ni texto.
Las categorías de escritura corresponden a `IOException`, `UnauthorizedAccessException`,
`SecurityException`, `ArgumentException`, `NotSupportedException` o tipo desconocido.
`Path.Combine` está dentro de esa misma guarda de escritura; las excepciones se relanzan.

Después de un `MoveFileEx` falso, la primera captura es `Marshal.GetLastWin32Error()`,
antes de construir el snapshot o ejecutar otras llamadas administradas. La categoría es
siempre `replace/win32`; se conserva `Require` con `InvalidOperationException` y
`Native operation failed`. No se intenta recuperar el último error desde un catch.

`SignalHost.LastPublishFailure` contiene un snapshot con getters públicos y setters privados
`Operation`, `Kind`, `NativeCode`. Cada `AtomicJson` lo reinicia; una publicación correcta
lo deja vacío. `Publish` también lo reinicia **antes** de `ConvertTo-Json`, evitando datos
obsoletos si falla la serialización. El catch guarda la referencia inmutable **antes** de
publicar `error.json`; esa publicación no puede borrar el snapshot guardado. Las demás
fases, incluida la negativa FILETIME en `native-launch`, conservan exactamente el payload
base de tres campos, sin claves nuevas null/unknown.

Sólo con identidad, código, fase y objeto completos válidos se añade el sufijo literal
`; publish: <operation>/<kind>/<nativeCode>`, usando `unknown` para `null`. Por ejemplo:
`Native signal controller failed (phase: complete-publish); publish: replace/win32/32`.
Arrays, campos extra, parejas incompatibles, strings o fracciones como códigos y códigos
no admitidos descartan el sufijo entero; el mensaje previo queda idéntico. No hay reintentos
ni cambios de llamadas/flags nativos, señales, tiempos, sondeo, propiedad o limpieza.

## Límite de la evidencia

La ejecución anterior `38697353563` (`c9e807b`) no contenía `phase`: sus fallos genéricos
no establecían causa. Antes de esta ampliación, la instrumentación de fases había pasado
verificaciones Linux 531/531 y análisis sintáctico host WindowsPowerShell 5.1. Esas pruebas
no verifican estos nuevos metadatos ni la ejecución nativa de `AtomicJson`.

La ejecución real `38735766779` sí muestra `complete-publish` en el helper de salida normal
de Windows 2022 / Node 22. El helper pasa salida normal 0/1 y la negativa FILETIME en
Node 24. Linux pasa 531/531 en ambas versiones; Windows Node 22 registra 444 PASS / 87 FAIL
y Node 24 445 PASS / 86 FAIL de 531, sin omisiones. Los fallos anteriores de OAuth/PUT
no reaparecieron: no se usan para atribuir este fallo. La fase sigue al drenaje y al intento
de sustituir `exit.json` de `exiting` a `complete`; no demuestra un escritor concurrente
ni qué flags de compartición usa el lector. CI global sigue roja, sin reparación afirmada.

Las pruebas locales del nuevo contrato dan RED 4 PASS / 6 FAIL y GREEN 10/10 en
Node 22.14 y 24.20, con un límite de 30 segundos por comando. Cubren validación, privacidad,
el `_poll` real con dobles de transporte y estructura/orden del C#/PowerShell real, no un
modelo JS del kernel. No son una compilación C#, ejecución PowerShell ni reproducción de
GitHub Windows 2022. La suite local completa pasa 536/536 con cobertura y guards en ambos Node.

Un probe host WindowsPowerShell Desktop 5.1.26100.9444 extrae con AST y compila el C# exacto,
sin instanciar `SignalHost` ni lanzar target/controlador. Sus cinco casos pasan: escritura y
reemplazo correctos; reemplazo bloqueado por un HANDLE propio, con código 5 confirmado por
una llamada `MoveFileEx` independiente; escritura sobre directorio `.tmp` con categoría
`access`/5; directorio ausente con `io`/3; reinicio tras éxito y conservación del snapshot
guardado después de publicar otro reporte. Conserva los tipos originales de excepción.
El probe inicial esperaba 32 y falló: el fixture host realmente devuelve 5; no se cambió
el producto para satisfacer aquel supuesto. Análisis sintáctico: cero errores; stderr vacío,
exit 0 en el probe final. Es evidencia del `AtomicJson` real en ese host, no del controlador,
de GitHub Windows 2022 ni de la causa del fallo observado en CI. El analizador PowerShell
local no está disponible. Aún no hay causa ni reparación demostrada.
