// The tempo field (m5b-ui-keymap; UI redesign 3.1, 3.6; research/cubase.md
// 7.1, Enter Tempo on Shift+T): what the field over the tempo cell reads and
// sends. A typed tempo is BPM with up to two decimals, 1.00 to 999.99 (the
// engine's range is 1,000 to 999,999 milli-BPM, kMinMilliBpm and
// kMaxMilliBpm of siann-time; the display shows two decimals). Enter sends
// one command.execute with one session.set_tempo carrying the whole map, in
// which only the point in force at the cursor has the typed tempo: one
// revision, one undo. An empty map (a new session's 120 BPM) gets its one
// point at the start. The tempo stays while a proposal is heard (4.5 C5:
// session.set_tempo is not structural), and the field exists only where the
// engine lists the command (3.0). Framework-free.

import type { CapabilitySelector } from '../model/capabilities';
import type { TempoPoint } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { TimelineCommand } from './commands';
import { DEFAULT_MILLI_BPM, tempoSegments } from './musical-time';

export const MIN_MILLI_BPM = 1_000;
export const MAX_MILLI_BPM = 999_990;
const TYPED = /^(\d{1,6})(?:\.(\d{1,2}))?$/;

// A typed tempo in milli-BPM, or null for text that is no tempo.
export function parseTempo(text: string): number | null {
  const match = TYPED.exec(text.trim());
  if (!match) return null;
  const milliBpm = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(2, '0')) * 10;
  return milliBpm >= MIN_MILLI_BPM && milliBpm <= MAX_MILLI_BPM ? milliBpm : null;
}

// The map with the point in force at `cursor` set to `milliBpm`, or null
// when that changes nothing.
export function replaceTempoAt(tempo: readonly TempoPoint[], sampleRate: number, cursor: bigint, milliBpm: number): TempoPoint[] | null {
  if (tempo.length === 0) return milliBpm === DEFAULT_MILLI_BPM ? null : [{ ticks: '0', milliBpm }];
  const points = [...tempo].sort((a, b) => Number(a.ticks) - Number(b.ticks));
  const segments = tempoSegments(points, sampleRate);
  const frame = Number(cursor < 0n ? 0n : cursor);
  let found = 0;
  segments.forEach((segment, index) => {
    if (segment.startFrame <= frame) found = index;
  });
  if (points[found]!.milliBpm === milliBpm) return null;
  return points.map((point, index) => (index === found ? { ticks: point.ticks, milliBpm } : { ticks: point.ticks, milliBpm: point.milliBpm }));
}

export function tempoCommand(snapshot: Snapshot, cursor: bigint, milliBpm: number): TimelineCommand | null {
  const root = snapshot.root;
  if (!root) return null;
  const tempo = replaceTempoAt(root.tempo, root.sampleRate, cursor, milliBpm);
  return tempo ? { expectedRevision: snapshot.revision, commands: [{ op: 'session.set_tempo', tempo }] } : null;
}

// Shift+T and the field exist where the engine lists session.set_tempo.
export function tempoEntryAllowed(can: CapabilitySelector): boolean {
  return can.command('session.set_tempo');
}
