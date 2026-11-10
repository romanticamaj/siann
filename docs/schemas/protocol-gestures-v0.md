# SIANN Protocol Gestures v0

Date: 2026-11-10

Status: Implemented in `native/libs/protocol` and `native/apps/engine` (m5-mixer)

## Purpose

A fader drag, a pan knob turn or a held mute button is a continuous gesture
(architecture spec, "Gestures", and Protocol v0 item 23). The sound follows every
movement at once through the parameter channel, and only the end of the gesture
creates a revision. This document defines the five protocol methods that hold such
a gesture, the client lease that bounds it, and the `gesture.ended` event.

Envelopes, the token handshake, `expectedRevision` and the idempotency cache are
those of Protocol v0; events are those of `protocol-events-v1.md`.

## Target and value

```json
{"ref": "track:trk_1", "param": "gain"}
```

- `ref` is `"track:<id>"`. Any other entity type is `invalid_params`; a track the
  document does not hold is `not_found`.
- `param` is `"gain"`, `"pan"` or `"mute"`, the three track fader parameters.
- `value` is a number in the track entity's own units: `gain` in milli-dB (the
  entity's `gainMilliDb`; `-2147483648` is minus infinity, the fader minimum),
  `pan` from `-10000` to `10000`, `mute` `0` or `1`. A value that is not a number,
  or a mute value other than 0 and 1, is `invalid_params`. A gain or pan out of the
  entity's range moves the sound as far as the fader allows (a gain is clamped to
  `-144000`..`24000`, one at or below `-2147483648` is minus infinity; a pan to
  `-10000`..`10000`) and is refused by the commit at `gesture.end`
  (`invalid_gain`, `invalid_pan`).

## Methods

All five run on the command thread through `ServerOptions::gesturePort`
(`protocol::GesturePort`, which the engine host implements over
`playback::PlaybackEngine`). Without a port each answers `not_supported`. They are
not MCP tools: an agent changes a fader through commands and plans.

| Method | Params | Result | Cached |
|---|---|---|---|
| `gesture.begin` | `{target}` | `{target, startValue, leaseMs}` | yes |
| `gesture.update` | `{target, value}` | `{}` | no |
| `gesture.hold` | `{target}` | `{}` | no |
| `gesture.end` | `{target, value?}` | `{target, startValue, value, revision}` | yes |
| `gesture.cancel` | `{target}` | `{}` | yes |

- `gesture.begin` opens the gesture. `startValue` is the head document's value of
  the parameter; `leaseMs` is how long the lease lasts without a renewal.
- `gesture.update` moves the sound (a short ramp) and records the value as the
  gesture's last accepted one. It changes no document and publishes nothing. It is
  not cached: a retry with the same `requestId` runs again, which changes nothing
  because the newest value wins.
- `gesture.hold` only renews the lease: the client holds the fader still.
- `gesture.end` commits the last accepted value as one `track.set_gain`,
  `track.set_pan` or `track.set_mute` revision on the side heard (main, or the
  auditioned proposal) and publishes its `session.changed` (or `proposal.changed`),
  then `gesture.ended`. A given `value` is one last update first. `revision` is the
  revision envelope `command.execute` returns, or `null` when the gesture never
  moved (no update was accepted), in which case nothing is committed.
- `gesture.cancel` ends the gesture without a commit; the sound returns to the
  document's value.

Every method honours `expectedRevision` (a stale one is `revision_mismatch` and runs
nothing).

### Errors

| Code | When |
|---|---|
| `gesture_held` | another connection holds a gesture on the target |
| `gesture_open` | `gesture.begin` while this connection already holds the target |
| `no_gesture` | `update`, `hold`, `end` or `cancel` with no open gesture on the target |
| `invalid_params` | a bad target or value |
| `not_found` | no such track |
| `invalid_gain`, `invalid_pan`, `invalid_mute` | the commit refused the end value |
| `audition_not_found` | the heard proposal was closed on the session during the gesture |
| `not_supported` | no gesture port |

A commit that fails closes the gesture as cancelled: the sound returns to the
document's value and `gesture.ended` says `cancelled`.

## Lease

A gesture belongs to the connection that began it. `leaseMs` is
`ServerOptions::gestureLeaseMs` (default 5000), measured on
`ServerOptions::steadyClock` (the steady clock unless a test injects one). Every
`gesture.*` request of the owner on the target renews the lease; a client that
holds a fader still sends `gesture.hold` at least every `leaseMs / 2`.

- The command thread's `pump()` ends a lease that was not renewed for `leaseMs`:
  reason `lease_expired`.
- Closing the connection ends its gestures at once, and never another
  connection's: reason `disconnected`. The close reaches the command thread through
  the request inbox, after the requests the connection queued before it.

Both commit the last accepted value with the server's actor, exactly as
`gesture.end` does, and publish `gesture.ended`. `session.open` drops every open
gesture of the old session without a commit (reason `cancelled`).

## `gesture.ended`

Published once for every gesture that closes, after the commit's `session.changed`:

```json
{"type": "gesture.ended", "target": {"ref": "track:trk_1", "param": "gain"},
 "reason": "ended", "startValue": -6000, "value": -3500, "committed": "r9"}
```

- `reason` is `ended` (`gesture.end`), `cancelled` (`gesture.cancel`, a refused
  commit, or `session.open`), `lease_expired` or `disconnected`.
- `startValue` is the value at `gesture.begin`; `value` the value the gesture
  committed, or the start value when it committed nothing.
- `committed` is the id of the revision the gesture committed, or `null`. (The
  envelope's own `revision` is the head when the event was published.)

## Client rules (the renderer's GestureController)

- `gesture.begin` once per drag; the read model's overlay (`ReadModel.beginGesture`)
  shows the moved value at once, before the engine answers.
- At most one `gesture.update` in flight; moves made meanwhile coalesce into one
  more update carrying the newest value.
- `gesture.hold` every `leaseMs / 2` while the pointer is held still.
- `gesture.end` with the last value on release. The overlay stays until the
  `session.changed` of that commit applies to the read model.
- Any error or a disconnect cancels the overlay.
- Mute and solo buttons do not use gestures: they commit through
  `command.execute` (`track.set_mute`, `track.set_solo`).
