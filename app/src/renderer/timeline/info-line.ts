// The info line's values (UI redesign spec 3.2, "Info line", 6.2 and 10.8, 2;
// read-only in phase 1): the selected clip's name (its title, clipTitle:
// media.name, else the media id) and its track's colour (the custom property
// trackColourVar names), its start and end as bar.beat.sixteenth.tick
// positions through root.tempo, its length and its offset into the media
// (sourceStart) as bars.beats.sixteenths.ticks lengths measured from the
// clip's start, and its volume in dB with two decimals, as the mockup's row
// reads them (9.1.1.0, 12.4.1.0, 3.3.0.0, 1.0.2.0, 0.00 dB). The same text in
// every locale; the labels around it come from the catalogs. Null when
// nothing (or nothing the snapshot holds) is selected, or for a music-domain
// clip. Framework-free.

import { formatDb2 } from '../format';
import type { ClipEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { clipTitle } from './clip-title';
import { formatLength, formatPosition, framesToTicks } from './musical-time';
import { trackColourVar } from './track-colour';

export interface InfoLineValues {
  readonly name: string;
  // The custom property of the track's colour (--track-N).
  readonly colour: string;
  readonly start: string;
  readonly end: string;
  readonly length: string;
  readonly offset: string;
  readonly volume: string;
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
    name: clipTitle(snapshot, clip),
    colour: trackColourVar(clip.trackId),
    start: formatPosition(start),
    end: formatPosition(end),
    length: formatLength(end - start),
    offset: formatLength(offset),
    volume: formatDb2(clip.gainMilliDb),
  };
}
