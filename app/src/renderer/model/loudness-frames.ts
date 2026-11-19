// The realtime channel's loudness frames (docs/schemas/protocol-events-v1.md,
// "Loudness frame"; m5b-ui-meter): little-endian, magic "SLUD", version 1, the
// meter frame's engine timestamp and the master's momentary, short-term and
// integrated loudness in LUFS as f32, exactly 25 bytes. Silence is minus
// infinity. The same socket carries the meter frames ("SMTR"): frameKind
// tells the two apart by the magic. Framework-free and DOM-free.

export const LOUDNESS_FRAME_BYTES = 25;
const LOUDNESS_MAGIC = [0x53, 0x4c, 0x55, 0x44]; // "SLUD"
const METER_MAGIC = [0x53, 0x4d, 0x54, 0x52]; // "SMTR"
const VERSION = 1;

export interface LoudnessFrame {
  // A decimal string, as the events doc carries 64-bit fields.
  readonly engineTimestampMicros: string;
  readonly momentary: number;
  readonly shortTerm: number;
  readonly integrated: number;
}

function view(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function hasMagic(bytes: DataView, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes.getUint8(i) !== magic[i]) return false;
  return true;
}

// Which frame a binary message is, by its magic, or null for neither.
export function frameKind(data: ArrayBuffer | ArrayBufferView): 'meter' | 'loudness' | null {
  const bytes = view(data);
  if (hasMagic(bytes, METER_MAGIC)) return 'meter';
  if (hasMagic(bytes, LOUDNESS_MAGIC)) return 'loudness';
  return null;
}

// One frame, or null when it is malformed (another magic or version, or a
// length other than 25 bytes).
export function decodeLoudnessFrame(data: ArrayBuffer | ArrayBufferView): LoudnessFrame | null {
  const bytes = view(data);
  if (bytes.byteLength !== LOUDNESS_FRAME_BYTES || !hasMagic(bytes, LOUDNESS_MAGIC)) return null;
  if (bytes.getUint8(4) !== VERSION) return null;
  return {
    engineTimestampMicros: bytes.getBigInt64(5, true).toString(),
    momentary: bytes.getFloat32(13, true),
    shortTerm: bytes.getFloat32(17, true),
    integrated: bytes.getFloat32(21, true),
  };
}
