// The info line's values (UI redesign spec 3.2, "Info line", read-only in
// phase 1): the selected clip's start and end as bar.beat.tick positions
// through root.tempo, its length and its offset into the media (sourceStart)
// as bars.beats.ticks lengths measured from the clip's start, and its gain in
// dB with one decimal. The same text in every locale; the labels around it
// come from the catalogs. Null when nothing (or nothing the snapshot holds) is
// selected, or for a music-domain clip. Framework-free.

import { formatDb } from '../format';
import type { ClipEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { formatBbt, formatBbtLength, framesToTicks } from './musical-time';

export interface InfoLineValues {
  readonly start: string;
  readonly end: string;
  readonly length: string;
  readonly offset: string;
  readonly gain: string;
}

export function infoLine(snapshot: Snapshot | null, clipId: string | null): InfoLineValues | null {
  if (!snapshot || !clipId) return null;
  const clip = snapshot.entities[`clip:${clipId}`] as ClipEntity | undefined;
  if (!clip || clip.schema !== 'siann.entity.clip.v1' || clip.position.domain !== 'audio') return null;
  const tempo = snapshot.root?.tempo ?? [];
  const rate = snapshot.root?.sampleRate ?? 48000;
  const ticks = (frames: number) => framesToTicks(frames, tempo, rate);
  const position = Number(clip.position.value);
  const start = ticks(position);
  const end = ticks(position + Number(clip.length));
  const offset = ticks(position + Number(clip.sourceStart)) - start;
  return {
    start: formatBbt(start),
    end: formatBbt(end),
    length: formatBbtLength(end - start),
    offset: formatBbtLength(offset),
    gain: formatDb(clip.gainMilliDb),
  };
}
