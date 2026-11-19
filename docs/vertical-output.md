# Vertical output: production and control (#270)

Research for milestone M17. Question: can antena produce and control a second
9:16 output (1080×1920) alongside the horizontal stream? Twitch and YouTube stay
horizontal; the vertical output would go to TikTok or X only. No code changes.

Status (2026-11-19): desk research done; Meld live test done (Meld Studio
0.10.8.5, WebChannel API v3); OBS + Aitum live test pending. Claims marked
*unverified* still wait for a live test.

## Summary

| Question | Meld Studio | OBS + Aitum Vertical |
| --- | --- | --- |
| Produce a simultaneous vertical output | Yes, Multi Canvas + per-output canvas, no antena code | Yes, vertical canvas with its own outputs |
| Observe vertical output state | No: only a global `isStreaming`, unchanged when one output stops (tested) | Yes: `status` per canvas + vendor events |
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

Live test (Meld 0.10.8.5): `isStreaming` reflects the Go Live intent only. It
turned `true` while no output could connect, stayed `true` and emitted nothing
(no property update, no session change, no signal) when the vertical output was
stopped and restarted on its own, and turned `false` only on End Stream.

### TikTok chat

Meld's TikTok output has a Login that brings TikTok chat, follows and gifts into
Meld's chat dock, activity feed and built-in widgets
([TikTok output docs](https://meldstudio.co/docs/outputs/tiktok/)). None of it is
exposed through WebChannel, a local server or a documented widget URL. antena
cannot read it. In the live test, the only layers exposing a `url` in `session`
were antena's own browser sources (`http://127.0.0.1:4500/widget/...`).

### Draft feature request to Meld

> **Per-output streaming state and control in the WebChannel API**
>
> Meld already streams to several destinations with independent start/stop and a
> canvas per output, but the WebChannel API only exposes a global `isStreaming`
> and `toggleStream`. Tools that drive Meld (Stream Deck, antena) cannot tell
> which destination is live, or stop a vertical TikTok output without ending the
> horizontal stream. Tested on Meld Studio 0.10.8.5 (API v3): stopping or
> starting one output emits nothing, and `isStreaming` stays `true` even when
> every output fails to connect.
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

Setup (2026-11-19, Windows 11 + WSL2):

- Probe script `probe.mjs` (attached to the #270 result comment): dumps the
  Meld API surface, scenes with their `vertical` flag and layers with a `url`,
  and logs every property update and signal while outputs are toggled. For OBS
  it prints `GetOutputList`, Aitum `version`/`status`/`get_scenes` and all vendor
  and output events. Run with Windows `node.exe`.
- Local RTMP receivers, one per output, with Windows FFmpeg:
  `ffmpeg -listen 1 -i rtmp://127.0.0.1:1935/live/vertical -f null -` and the
  same on port 1936 for `main`.
- Meld outputs: two Custom RTMP outputs, `Main` canvas to `:1936` and
  `Portrait` canvas to `:1935`; real platform outputs had "Start this stream
  when going live" off.

Gotchas found while testing:

- With WSL in NAT mode, Windows cannot reach a receiver listening in WSL
  (Hyper-V firewall); run receivers on the Windows side.
- WebChannel v3 lists no `isStreamingChanged` in `signals`: property notify
  signals come from each property entry, and the client must send `idle` after
  every `propertyUpdate`, or Meld stops sending updates.

Meld timeline (Meld Studio 0.10.8.5, API v3):

| Time | Action in Meld | Receivers | WebChannel |
| --- | --- | --- | --- |
| 23:30:52 | Go Live | both connect at 23:30:53 | `isStreaming = true` |
| 23:31:42 | Stop vertical output only | vertical closes, main keeps streaming | nothing |
| 23:32:04 | Start vertical output only | vertical reconnects | nothing |
| 23:32:21 | End Stream | both close | `isStreaming = false` |

Earlier run: `isStreaming` turned `true` on Go Live while both outputs were
failing to connect (receivers unreachable).

| Check | Meld | OBS + Aitum |
| --- | --- | --- |
| Versions | Meld Studio 0.10.8.5, WebChannel API v3 | pending |
| Simultaneous outputs reach the receivers | Yes: Main 1920×1080 16:9 and Portrait 1080×1920 9:16, H.264 High 60 fps 4000 kb/s, AAC 160 kb/s | pending |
| API reflects one output stopping/starting | No | pending |
| Stop vertical alone, horizontal keeps streaming | Yes, from the Meld UI only | pending |
| API reflects a failed output | No: `isStreaming` stays `true` | pending |
| Vendor events received | – | pending |
