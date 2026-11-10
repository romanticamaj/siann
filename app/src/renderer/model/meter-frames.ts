// The realtime channel's binary meter frames (docs/schemas/protocol-events-v1.md,
// "Frame layout"): little-endian, magic "SMTR", version 1, a 32-byte header and
// one entry per metered entity. 64-bit fields stay decimal strings, as the
// events doc carries them, because numbers lose precision above 2^53.
// Framework-free and DOM-free.

export const METER_HEADER_BYTES = 32;
const MAGIC = [0x53, 0x4d, 0x54, 0x52]; // "SMTR"
const VERSION = 1;

export interface MeterEntry {
  // The index into the legend of the frame's epoch.
  readonly entityIndex: number;
  readonly channels: number;
  // Linear gain per channel.
  readonly peak: readonly number[];
  readonly rms: readonly number[];
}

export interface MeterFrame {
  readonly epoch: string;
  readonly engineTimestampMicros: string;
  readonly playheadSamples: string;
  readonly playing: boolean;
  readonly entries: readonly MeterEntry[];
}

// {epoch, entities} of a meters.legend event, an auth reply or a sync chunk.
export interface MeterLegend {
  readonly epoch: string;
  readonly entities: readonly string[];
}

export function isMeterLegend(value: unknown): value is MeterLegend {
  if (!value || typeof value !== 'object') return false;
  const legend = value as { epoch?: unknown; entities?: unknown };
  return (
    typeof legend.epoch === 'string' &&
    Array.isArray(legend.entities) &&
    legend.entities.every((entity) => typeof entity === 'string')
  );
}

function view(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

// One frame, or null when it is malformed (wrong magic or version, a playing
// byte other than 0 and 1, or a length that differs from the entries' sum).
export function decodeMeterFrame(data: ArrayBuffer | ArrayBufferView): MeterFrame | null {
  const bytes = view(data);
  if (bytes.byteLength < METER_HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes.getUint8(i) !== MAGIC[i]) return null;
  if (bytes.getUint8(4) !== VERSION) return null;
  const playing = bytes.getUint8(29);
  if (playing !== 0 && playing !== 1) return null;
  const entryCount = bytes.getUint16(30, true);
  const entries: MeterEntry[] = [];
  let offset = METER_HEADER_BYTES;
  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 3 > bytes.byteLength) return null;
    const entityIndex = bytes.getUint16(offset, true);
    const channels = bytes.getUint8(offset + 2);
    offset += 3;
    if (offset + 8 * channels > bytes.byteLength) return null;
    const peak: number[] = [];
    const rms: number[] = [];
    for (let c = 0; c < channels; c += 1) peak.push(bytes.getFloat32(offset + 4 * c, true));
    offset += 4 * channels;
    for (let c = 0; c < channels; c += 1) rms.push(bytes.getFloat32(offset + 4 * c, true));
    offset += 4 * channels;
    entries.push({ entityIndex, channels, peak, rms });
  }
  if (offset !== bytes.byteLength) return null;
  return {
    epoch: bytes.getBigUint64(5, true).toString(),
    engineTimestampMicros: bytes.getBigInt64(13, true).toString(),
    playheadSamples: bytes.getBigInt64(21, true).toString(),
    playing: playing === 1,
    entries,
  };
}
