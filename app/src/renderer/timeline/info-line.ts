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

import { MINUS_INFINITY_MILLI_DB, formatDb2 } from '../format';
import type { ClipEntity, MediaEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { clipTitle } from './clip-title';
import type { TimelineCommand } from './commands';
import { GAIN_MAX_MILLI_DB, GAIN_MIN_MILLI_DB, moveSelectionCommand } from './edit-commands';
import { TICKS_PER_BAR, TICKS_PER_QUARTER, TICKS_PER_SIXTEENTH, formatLength, formatPosition, framesToTicks, ticksToFrames } from './musical-time';
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

// ---- m5b-ui-edit-more (spec 3.2, "Info line"): typed values and the edit.

// A whole part of a typed value: digits only.
function wholeParts(text: string, most: number): number[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split('.');
  if (parts.length > most || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

// A position as the info line writes it, bar.beat.sixteenth.tick with the
// bar, beat and sixteenth 1-based; trailing parts may be left out (9 is
// 9.1.1.0). In ticks, or null when it does not parse.
export function parsePosition(text: string): number | null {
  const parts = wholeParts(text, 4);
  if (!parts) return null;
  const [bar, beat = 1, sixteenth = 1, tick = 0] = parts;
  if (bar! < 1 || beat < 1 || sixteenth < 1) return null;
  return (bar! - 1) * TICKS_PER_BAR + (beat - 1) * TICKS_PER_QUARTER + (sixteenth - 1) * TICKS_PER_SIXTEENTH + tick;
}

// A length or offset as the info line writes it, bars.beats.sixteenths.ticks
// from zero; trailing parts may be left out. In ticks, or null.
export function parseLength(text: string): number | null {
  const parts = wholeParts(text, 4);
  if (!parts) return null;
  const [bars, beats = 0, sixteenths = 0, ticks = 0] = parts;
  return bars! * TICKS_PER_BAR + beats * TICKS_PER_QUARTER + sixteenths * TICKS_PER_SIXTEENTH + ticks;
}

// A volume in dB, the unit optional (-3.5, +1.25 dB, -inf). In milli-dB, or null.
export function parseDb(text: string): number | null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)|-inf)\s*(?:db)?\s*$/i.exec(text);
  if (!match) return null;
  if (match[1]!.toLowerCase() === '-inf') return MINUS_INFINITY_MILLI_DB;
  return Math.round(Number(match[1]) * 1000);
}

export type InfoField = 'start' | 'length' | 'offset' | 'volume';
export const INFO_EDIT_FIELDS: readonly InfoField[] = ['start', 'length', 'offset', 'volume'];

// The command a typed value ends in over the selection (`ids`, the primary
// among them): relative (absolute false), the primary's change applied to
// every clip; absolute, every clip set to the value. Start is clip.move (the
// selection stopping at the timeline's start), length clip.trim (one frame up
// to the media's end), offset clip.trim of the source start (0 up to the media
// less the clip's length; the clip stays put), volume clip.set_gain within -60
// to +6 dB. Null when the text does not parse, the primary is unknown or
// nothing changes. The line shows values rounded (to a tick, to 0.01 dB), so
// a typed value equal to the one shown (as parsed: 9 is 9.1.1.0) is no change
// to the primary: relative, nothing is sent; absolute, the primary keeps its
// exact value and only the other clips are set.
export function infoLineEditCommand(
  snapshot: Snapshot,
  ids: readonly string[],
  primaryId: string,
  field: InfoField,
  typed: string,
  absolute: boolean,
): TimelineCommand | null {
  const clip = (id: string): ClipEntity | null => {
    const found = snapshot.entities[`clip:${id}`] as ClipEntity | undefined;
    return found && found.schema === 'siann.entity.clip.v1' && found.position.domain === 'audio' ? found : null;
  };
  const primary = clip(primaryId);
  if (!primary) return null;
  const parse = field === 'volume' ? parseDb : field === 'start' ? parsePosition : parseLength;
  const typedValue = parse(typed);
  if (typedValue === null) return null;
  const shown = infoLine(snapshot, primaryId);
  const unchanged = shown !== null && parse(shown[field]) === typedValue;
  if (unchanged && !absolute) return null;
  const seen = new Set<string>();
  // Unchanged and absolute: the primary is where the value says already.
  if (unchanged) seen.add(primaryId);
  const clips: ClipEntity[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = clip(id);
    if (found) clips.push(found);
  }
  if (clips.length === 0) return null;
  const tempo = snapshot.root?.tempo ?? [];
  const rate = snapshot.root?.sampleRate ?? 48000;
  const toTicks = (frames: bigint) => framesToTicks(Number(frames), tempo, rate);
  const toFrames = (ticks: number) => BigInt(Math.max(0, ticksToFrames(ticks, tempo, rate)));
  const issue = (commands: Array<Record<string, unknown>>): TimelineCommand | null => (commands.length === 0 ? null : { expectedRevision: snapshot.revision, commands });
  const mediaFrames = (c: ClipEntity): bigint | null => {
    const media = snapshot.entities[`media:${c.mediaId}`] as MediaEntity | undefined;
    return media && media.schema === 'siann.entity.media.v1' ? BigInt(media.frames) : null;
  };
  const clamp = (value: bigint, low: bigint, high: bigint) => (value < low ? low : value > high ? high : value);

  if (field === 'volume') {
    const target = parseDb(typed);
    if (target === null) return null;
    const held = (milli: number) => Math.min(GAIN_MAX_MILLI_DB, Math.max(GAIN_MIN_MILLI_DB, milli));
    const delta = held(target) - held(primary.gainMilliDb);
    return issue(
      clips
        .map((c) => ({ c, gain: absolute ? held(target) : held(held(c.gainMilliDb) + delta) }))
        .filter(({ c, gain }) => gain !== c.gainMilliDb)
        .map(({ c, gain }) => ({ op: 'clip.set_gain', clipId: c.id, gainMilliDb: gain })),
    );
  }

  if (field === 'start') {
    const ticks = parsePosition(typed);
    if (ticks === null) return null;
    const target = toFrames(ticks);
    if (!absolute) {
      const delta = target - BigInt(primary.position.value);
      return moveSelectionCommand(snapshot, clips.map((c) => c.id), delta, 0);
    }
    return issue(
      clips
        .filter((c) => BigInt(c.position.value) !== target)
        .map((c) => ({ op: 'clip.move', clipId: c.id, position: { domain: 'audio', value: target.toString() } })),
    );
  }

  const ticks = parseLength(typed);
  if (ticks === null) return null;
  // The typed length or offset in frames, measured from a clip's start.
  const fromStart = (c: ClipEntity) => {
    const start = BigInt(c.position.value);
    return toFrames(toTicks(start) + ticks) - start;
  };
  const commands: Array<Record<string, unknown>> = [];
  if (field === 'length') {
    const delta = fromStart(primary) - BigInt(primary.length);
    for (const c of clips) {
      const media = mediaFrames(c);
      if (media === null) continue;
      const wanted = absolute ? fromStart(c) : BigInt(c.length) + delta;
      const length = clamp(wanted, 1n, media - BigInt(c.sourceStart));
      if (length.toString() === c.length) continue;
      commands.push({ op: 'clip.trim', clipId: c.id, sourceStart: c.sourceStart, length: length.toString() });
    }
    return issue(commands);
  }
  const delta = fromStart(primary) - BigInt(primary.sourceStart);
  for (const c of clips) {
    const media = mediaFrames(c);
    if (media === null) continue;
    const wanted = absolute ? fromStart(c) : BigInt(c.sourceStart) + delta;
    const top = media - BigInt(c.length);
    const sourceStart = clamp(wanted, 0n, top < 0n ? 0n : top);
    if (sourceStart.toString() === c.sourceStart) continue;
    commands.push({ op: 'clip.trim', clipId: c.id, sourceStart: sourceStart.toString(), length: c.length });
  }
  return issue(commands);
}
