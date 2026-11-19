# Vertical output: production and control (#270)

Research for milestone M17. Question: can antena produce and control a second
9:16 output (1080×1920) alongside the horizontal stream? Twitch and YouTube stay
horizontal; the vertical output would go to TikTok or X only. No code changes.

Status: desk research done (2026-11-19). Live tests on a real Meld and OBS are
pending (see [Live tests](#live-tests)); every claim marked *unverified* waits
for them.

## Summary

| Question | Meld Studio | OBS + Aitum Vertical |
| --- | --- | --- |
| Produce a simultaneous vertical output | Yes, Multi Canvas + per-output canvas, no antena code | Yes, vertical canvas with its own outputs |
| Observe vertical output state | No: only a global `isStreaming` | Yes: `status` per canvas + vendor events |
| Start/stop vertical output alone | No: only global `toggleStream` / start/stop | Yes: `start_streaming` / `stop_streaming` per canvas |
| Read TikTok chat from antena | No: stays inside Meld | Not applicable (no TikTok chat in OBS) |
| antena code needed | None to produce; per-output control impossible today | Vendor request + vendor event support in `obs-adapter` |

## Meld Studio

### What the WebChannel API exposes

Source: [WebChannelAPI.md](https://github.com/MeldStudio/streamdeck/blob/main/WebChannelAPI.md)
(read 2026-11-19).

- Properties: `isStreaming`, `isRecording`, `session` (scenes, tracks, layers,
  effects), `version` (absent means API v1).
- Signals: `gainUpdated`, `sessionChanged`, `isStreamingChanged`,
  `isRecordingChanged`.
- Methods: scene, layer, effect, track and gain control; `toggleStream`,
  `toggleRecord`; `sendCommand` (streaming/recording start/stop/toggle, virtual
  camera, screenshots including `meld.screenshot.vertical`, clips, replay,
  chapter markers); `sendStreamEvent`; staged scenes; `setProperty` (v2).

There is **no per-output state or control**. The Meld app itself starts and stops
each destination independently and assigns a canvas per output
([Multistream docs](https://meldstudio.co/docs/outputs/multistream/)), but none of
that reaches the API.

Canvas: undocumented. The official Stream Deck plugin types declare
`vertical?: boolean` on scenes ("True for the vertical-canvas twin of a scene",
`MeldStudio/streamdeck src/meld/types.ts`), and note that `setStagedScene` does
nothing for vertical twins while `showScene` works. antena drops that flag today
(`src/meld.mjs:313-314`), so vertical twins look like ordinary scenes.

*Unverified:* what `isStreaming` reports when only some outputs are live.

### TikTok chat

Meld's TikTok output has a Login that brings TikTok chat, follows and gifts into
Meld's chat dock, activity feed and built-in widgets
([TikTok output docs](https://meldstudio.co/docs/outputs/tiktok/)). None of it is
exposed through WebChannel, a local server or a documented widget URL. antena
cannot read it. *Unverified:* whether a Chat widget layer in `session` carries a
URL.

### Draft feature request to Meld

> **Per-output streaming state and control in the WebChannel API**
>
> Meld already streams to several destinations with independent start/stop and a
> canvas per output, but the WebChannel API only exposes a global `isStreaming`
> and `toggleStream`. Tools that drive Meld (Stream Deck, antena) cannot tell
> which destination is live, or stop a vertical TikTok output without ending the
> horizontal stream.
>
> Request:
> 1. An `outputs` property: `[{ id, name, platform, canvas, isStreaming }]`, with
>    an `outputsChanged` signal (or per-output `isStreamingChanged`).
> 2. Commands to start/stop/toggle one output by `id`.
> 3. The canvas of each scene (`vertical`) documented in `session`.
> 4. Optional: platform chat/activity (including TikTok via the output Login) as a
>    signal, so external tools can use the official chat Meld already receives.

## OBS + Aitum Vertical

Source: [Aitum/obs-vertical-canvas](https://github.com/Aitum/obs-vertical-canvas)
release 1.6.8, `vertical-canvas.cpp`. Called through obs-websocket
`CallVendorRequest` with `vendorName: "aitum-vertical-canvas"`.

| Request | Data | Response |
| --- | --- | --- |
| `version` | – | `version` |
| `status` | `width`/`height` (optional) | `streaming`, `recording`, `backtrack`, `virtual_camera` |
| `start_streaming` / `stop_streaming` / `toggle_streaming` | `width`/`height` (optional) | – |
| `switch_scene`, `current_scene`, `get_scenes` | `scene` / – | `scene` / `scenes` |
| recording, backtrack, virtual camera, chapter, stream key/server requests | see source | – |

- Every response carries `success`; `width`/`height` target the first matching
  canvas (`0` = any). `success: false` means no canvas matched.
- `status.streaming` is one boolean per canvas, even when the canvas has several
  outputs; per-output control inside a canvas is not reachable.
- Vendor events (payload includes `width`/`height`): `streaming_starting`,
  `streaming_started`, `streaming_stopping`, `streaming_stopped` (plus recording,
  backtrack, virtual camera) and `switch_scene`. Since 1.6.5 they include the
  output stop code and error.

antena fit: `src/programs/obs-adapter.mjs` already sends arbitrary obs-websocket
requests (`requestObs`, around `:131-141`), so `CallVendorRequest` needs no new
transport. Missing: the Vendors event bit (`1 << 9`) in `OBS_EVENTS` (`:5`), an
op 5 `VendorEvent` handler, and `CallVendorRequest` in `test/helpers/fake-obs.mjs`.

## Proposed per-output state in `Program`

Goal: one model for the vertical output (this issue) and OBS multistream (#217,
state per destination, aggregate start/stop, partial failures).

```js
status = {
  // unchanged: aggregate, so every current consumer keeps working
  state, streaming, streamingKnown, recording, recordingKnown, ...,
  outputs: [
    {
      id: 'main',             // stable key: 'main', 'vertical', or a #217 destination id
      label: 'Main',
      canvas: 'horizontal',   // 'horizontal' | 'vertical' | null (unknown)
      platform: null,         // 'twitch' | 'youtube' | 'tiktok' | 'x' | null when unknown
      streaming: false,
      streamingKnown: true,
      controllable: true,     // startOutput/stopOutput accepted for this id
      error: null,            // last stop code/error, for partial failures
    },
  ],
}
```

- `status.streaming` stays the aggregate: true when any known output is live.
  The automatic session keeps keying on it, so adding a vertical output does not
  change session behavior. Whether a vertical-only stream should open a session is
  a decision for #273.
- New event `outputs` when any entry changes; the `streaming` event is unchanged.
- New capabilities: `output-status` (entries are real, per output) and
  `output-control` (`startOutput(id)`, `stopOutput(id)`). Without them the methods
  throw 409, like `call()` does today; capabilities never silently drop an action.
- Meld adapter: a single synthetic entry `{ id: 'program', canvas: null,
  controllable: false }` mirroring the global flags, and no `output-status`
  capability, until Meld ships per-output API.
- OBS adapter: `main` from `GetStreamStatus`; `vertical` from Aitum `status`
  (canvas 1080×1920) and its vendor events; #217 adds one entry per plugin
  output from `GetOutputList`/`GetOutputStatus` or its vendor API.

## Live tests

Pending. Probe script used for the tests: `probe.mjs` (attached to the #270
result comment) dumps the Meld API surface, scenes with their `vertical` flag,
widget items, and every streaming signal while outputs are toggled; for OBS it
prints `GetOutputList`, Aitum `version`/`status`/`get_scenes` and all vendor and
output events. Local RTMP receiver: `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/vertical -f null -`.

| Check | Meld | OBS + Aitum |
| --- | --- | --- |
| Versions | pending | pending |
| Vertical output reaches the RTMP receiver at 1080×1920 | pending | pending |
| `isStreaming` / `status` with only the vertical output live | pending | pending |
| Stop vertical alone, horizontal keeps streaming | pending | pending |
| Vendor events received | – | pending |
