# Protocol peaks v0

Peak pyramids of the native protocol server: the file the engine caches for each media file and the HTTP route the renderer fetches it from (architecture spec, "siann-protocol", Protocol v0 item 23; "Sample rate and media"; "Session bundle"; m5-timeline). The renderer draws a clip's waveform from it; nothing in the document changes.

## File

`<bundle>/peaks/<sha256 hex>.peaks`, where the hex is the media entity's `contentHash` without the `sha256:` prefix. Written atomically through siann-io (`writeFileAtomic`). The file is regenerable: a missing or unparseable file is rebuilt, never an error.

All integers are little-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"SPKS"` |
| 4 | 1 | version, u8 = 1 |
| 5 | 1 | channels, u8 (1 to 255) |
| 6 | 1 | levels, u8 |
| 7 | 1 | reserved, u8 = 0 |
| 8 | 8 | frames, u64 |
| 16 | 4 | sampleRate, u32 |

Then, for each level k = 0 .. levels - 1:

| Size | Field |
|---|---|
| 4 | binFrames, u32 = 256 * 4^k |
| 4 | binCount, u32 = ceil(frames / binFrames) |
| binCount * channels * 4 | for each bin, for each channel: min int16, max int16 |

- The last level is the first whose bin count is at most 1 (a media of at most 256 frames has one level).
- Bin `i` of a level covers frames `[i * binFrames, min((i + 1) * binFrames, frames))`: a partial last bin holds only the frames the media has, never zeros past its end.
- A sample `x` (float, nominal range [-1, 1]) becomes `floor(x * 32767 + 0.5)` in double precision, clamped to [-32768, 32767] (saturating); NaN is 0. Full scale is therefore +-32767, and anything beyond saturates.
- Level k + 1 is level k with every four bins merged (min of the mins, max of the maxes), which equals computing it from the samples.
- Media longer than 256 * 4^11 frames (1,073,741,824, about 6 h at 48 kHz) or with more than 255 channels is `too_large`.
- A file whose magic, version, reserved byte, level layout or size does not match is unparseable (`decode_failed` in `media::decodePeaks`).

`fixtures/peaks/` holds pyramids of small synthetic signals written by `scripts/generate-peaks-fixtures.js` from a plain Node implementation of this section; the C++ producer (`native/libs/media`, `computePeaks` and `encodePeaks`) and the renderer's decoder (`app/src/renderer/model/peaks.ts`) are tested against the same bytes.

## GET /v0/peaks/&lt;sha256 hex&gt;

Request: `Authorization: Bearer <UI token>` (the token of the ready line, as for `/v0/health`; the MCP token is 401). Checked in this order:

| Condition | Status | Body |
|---|---|---|
| no or wrong bearer | 401 | `{ok: false, error: {code: "unauthenticated"}}` |
| an Origin header not in the allow list | 403 | `origin_not_allowed` |
| a method other than GET (or OPTIONS, below) | 404 | `not_found` |
| the path segment is not 64 lowercase hex digits | 404 | `not_found` |
| no media entity of the served head document has this `contentHash` | 404 | `not_found` |
| the media file `<bundle>/media/<hex>.<wav or flac>` is absent | 404 | `media_missing` |
| the cache file parses | 200 | the whole file, `application/octet-stream` |
| a computation for this hash failed since the last request | 500 | the job's code (`decode_failed`, `unsupported_media`, `too_large`, ...), once |
| otherwise | 202 | `{ok: false, error: {code: "peaks_pending"}}` |

The hash is checked for form and against the document before any file is named, so no other bundle file is readable through the route. A 202 queues the computation on the jobs worker (Jobs v0: one job at a time, off the command and audio threads) unless a job for the hash is already queued or running; the client retries under the sync retry backoff (`SYNC_RETRY_MS` doubling up to `SYNC_RETRY_MAX_MS`). A pyramid is served from the cache file without the command thread: the protocol thread reads a copy of the head's media table, which the command thread refreshes after every request it handles and every revision it publishes. `peaks_pending` is a stable code; `engine.capabilities.features.peaks` is true.

### CORS

The renderer loads from `siann://app` and the engine listens on `http://127.0.0.1:<port>`, so the fetch is cross-origin and the `Authorization` header makes the browser send a preflight first:

- `OPTIONS /v0/peaks/<hex>` with an Origin in the allow list (no token: browsers never send one on a preflight) answers 204 with `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: authorization`, `Access-Control-Max-Age: 600` and `Vary: Origin`. Any other Origin is 403.
- Every answer to a request with an allowed Origin carries `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin`, so the renderer can read the 202 and error bodies too.

## Example

```text
GET /v0/peaks/9f2c...e1 HTTP/1.1
Authorization: Bearer 4b1d...
Origin: siann://app

HTTP/1.1 202 Accepted
Access-Control-Allow-Origin: siann://app
Content-Type: application/json

{"error":{"code":"peaks_pending","message":"the peak pyramid is being computed; retry"},"ok":false}
```

A later request with the same headers answers `200` with `Content-Type: application/octet-stream` and the file bytes.
