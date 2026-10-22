# Server admission: native shutdown contract

## Scope

`test/server-admission.test.mjs` retains its eight original tests and adds one
cross-platform SIGTERM test. Seven graceful SIGINT cases use
`launchSignalChild` and awaited `interruptSignalChild(child, 'SIGINT')`.
The public, non-signal `stopAdmission` test is unchanged. The shared program in
`test/helpers/server-admission-child.mjs` arms an autonomous 30-second watchdog
before importing or starting production `startServer`. Its unreferenced timer
exits with reserved fixture status 86 without writing to potentially closed pipes.
This bounds the target lifetime even if its controller is killed abruptly; it
neither keeps healthy children alive nor changes the original shutdown deadlines.

On Windows, the helper sends real `CTRL_C_EVENT` into an owned console verified
to contain only the target and controller. On Unix it sends native SIGINT.
The existing three piped streams remain intact: stdin releases fixture gates;
it does not deliver signals. No IPC shutdown or synthetic signal event is used.
Application READY and admission markers precede interrupts where required.
Cleanup forces only owned children and waits for `close`, including controller
and output drainage, before removing fixture data. Controller errors remain failures.

The original HTTP 503/no-cookie, OAuth, disk persistence, handler/session-flush
barriers, 100 ms deadline and public idle-promise assertions remain intact.
Existing test, polling and exit timeouts are not increased; no tests are skipped.

## SIGTERM is a different platform contract

The new test admits an incomplete PUT before calling real `.kill('SIGTERM')`.
Unix must run the signal handler, remain alive until the body completes, return
200, exit 0 and persist rate 1.75. Windows accepts a forced owned-HANDLE
`TerminateProcess` request: actual nonzero integer exit status, null signal,
no JS signal marker, no 200 for the unfinished body and unchanged rate 1.5.
Windows never receives the rest of that body. This forced case promises neither
graceful drainage nor post-cut HTTP 503; SIGTERM is never mapped to Ctrl+C.

## Diagnose a close timeout without changing the contract

The 3000 ms close guard remains unchanged. On timeout, `lifecycleAtWatchdog`
freezes the reported exit/close events, exit status and stream flags **before**
SIGKILL. `lifecycleAfterRescue` is separate: a forced exit observed there cannot
be credited as graceful drainage. Rescue errors still fail with their original
identity and the lifecycle context; a healthy close never invokes rescue.

| Observation at the guard | Interpretation |
|---|---|
| Exit reported, close absent | Target exit was reported; controller, stdio or cleanup may still be pending. |
| Exit absent | No exit event was received; this does not prove the target is still alive. |
| Close received | Includes adapter/controller drainage, not just target exit. |

Times are monotonic **local event-receipt** offsets, not kernel exit timestamps.
The passive collector adds no timers, signals or filesystem reads. It records at
most four whitelisted error codes, never messages, PIDs or stream contents.
Owner error handling remains installed. Seven deterministic observer/integration
cases and the nine admission cases pass locally on Linux Node 22/24 (16/16).
The integration cases evaluate the actual `awaitExit` function with lifecycle
doubles; they do not reproduce a Windows kernel/controller failure.

## Evidence boundary

**Baseline evidence only:** run `38668020090` tested the previously delivered
head `0f538a6` (tree `717c4e27a93e5641adbf8080f22080cf497896f4`), not the new
lifecycle-observer candidate. Its merge checkout matches that baseline head;
it does not contain or validate the new observer. In that run, Linux Node 22/24
pass 519/519; Windows 22 passes 433/519 and Windows 24 432/519, all without skips. All seven migrated admission roots pass Windows 22;
Windows 24 passes six, but the partial PUT observes HTTP 200 and SIGNAL then times
out waiting for adapter close. Its final persistence assertion is not reached:
this does not demonstrate persistence failed or distinguish target exit from
controller/stdio-close delay. The new lifecycle diagnostic is not yet measured
natively, and neither a deterministic hang nor flakiness is established.

The standalone EOF/watchdog regression passes both Windows versions, but still
does not reproduce an external controller hard-kill or prove native port release.
This unit does not complete the global migration or establish compatibility with
additional MCP IPC. Keep the original assertions and deadlines; collect lifecycle
evidence rather than increasing timeouts or retrying an unchanged CI failure.
