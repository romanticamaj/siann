// A plan's step rows in the mockup's wording (m5-ui-port-plans; mockup.html
// step(); UI redesign 10.7, 3): each step a title, with the names the mockup
// sets in <b> marked as names, and a detail line, the old value struck and
// the new one emphasised (<s>, <em>): "Vox BG gain / -9.0 dB → -6.0 dB",
// "Unmute FX / muted → on", "Move a clip on FX / bar 6.1 → bar 7.1 · ends
// on 9.1". Old values are plan.preview's `before` with the plan's earlier
// steps applied; with no preview (an applied, rolled-back or refused plan)
// the line gives the new value only. A clip has no name of its own before
// E-4, so a step that names a clip names it by its track (the mockup's clip
// titles are m5b-ui-media's). dB is one decimal and pan L/C/R, as the strip
// shows them (format.ts); positions are bar.beat as the locator display
// reads them. Every name is its own bidi isolate (isolate.ts). The dot is
// the step's track colour, the AI colour for a track the plan adds.
//
// The catalogs give the sentences; the parts a sentence emphasises are
// marked with private-use delimiters around the interpolated values and
// split into segments after translation, so every locale orders them itself.

import { formatDb, formatPan, formatSeconds } from '../format';
import { translator, type T } from '../i18n/t';
import { barBeat } from '../timeline/locators';
import { trackColourVar } from '../timeline/track-colour';
import { describeStep, overlay, type StepNames } from './describe';
import type { PlanPreview } from './diff';
import { isolateName } from './isolate';

export type SegmentKind = 'plain' | 'name' | 'struck' | 'em';

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

export interface StepRow {
  readonly title: readonly Segment[];
  readonly detail: readonly Segment[];
  // A colour token's name (--ai, --track-N, --tx-4), for the dot's --c.
  readonly colour: string;
}

const MARKS: Record<Exclude<SegmentKind, 'plain'>, readonly [string, string]> = {
  name: ['', ''],
  struck: ['', ''],
  em: ['', ''],
};
const OPEN = new Map(Object.entries(MARKS).map(([kind, [open]]) => [open, kind as SegmentKind]));
const CLOSE = new Set(Object.values(MARKS).map(([, close]) => close));

const mark = (kind: Exclude<SegmentKind, 'plain'>, text: string) => `${MARKS[kind][0]}${text}${MARKS[kind][1]}`;

// A translated line with marks, as segments (adjacent plain text merged).
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = [];
  let kind: SegmentKind = 'plain';
  let buffer = '';
  const flush = () => {
    if (buffer === '') return;
    const last = out[out.length - 1];
    if (kind === 'plain' && last?.kind === 'plain') out[out.length - 1] = { kind, text: last.text + buffer };
    else out.push({ kind, text: buffer });
    buffer = '';
  };
  for (const ch of text) {
    const opened = OPEN.get(ch);
    if (opened) {
      flush();
      kind = opened;
    } else if (CLOSE.has(ch)) {
      flush();
      kind = 'plain';
    } else buffer += ch;
  }
  flush();
  return out;
}

type Entity = Record<string, unknown>;

// The track field each track op sets.
const TRACK_FIELDS: Readonly<Record<string, string>> = {
  'track.rename': 'name',
  'track.set_gain': 'gainMilliDb',
  'track.set_pan': 'pan',
  'track.set_mute': 'mute',
  'track.set_solo': 'solo',
};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const frames = (position: unknown): string | undefined => {
  const p = position as { domain?: unknown; value?: unknown } | null | undefined;
  return p?.domain === 'audio' && typeof p.value === 'string' && /^\d+$/.test(p.value) ? p.value : undefined;
};

// "old → new", or the new value alone when the old one is not known.
function change(before: string | undefined, after: string): string {
  return before !== undefined ? `${mark('struck', before)} → ${mark('em', after)}` : mark('em', after);
}

export function stepRows(steps: readonly Record<string, unknown>[], preview: PlanPreview | null, names: StepNames, t: T = translator('en')): StepRow[] {
  // The entities as each step finds them: the head (plan.preview's before),
  // then each step applied. Without a preview only what the plan's own steps
  // create is known, and no old value is shown.
  const state = new Map<string, Entity>();
  for (const entity of preview?.entities ?? []) if (entity.before) state.set(entity.ref, { ...entity.before });
  const known = preview !== null;
  const added = new Set<string>();
  const order = [...(names.trackOrder ?? [])];
  const rate = names.sampleRate;
  const tempo = names.tempo ?? [];
  const bar = (value: string | undefined) => (value !== undefined && rate ? barBeat(BigInt(value), tempo, rate) : undefined);
  const plus = (a: string | undefined, b: string | undefined) => (a !== undefined && b !== undefined && /^\d+$/.test(b) ? String(BigInt(a) + BigInt(b)) : undefined);
  const seconds = (value: string | undefined) =>
    value !== undefined && rate && /^\d+$/.test(value) ? t('step.seconds', { value: formatSeconds(Number(value) / rate) }) : undefined;

  return steps.map((step, index) => {
    const here = overlay(names, steps.slice(0, index));
    const trackId = str(step.trackId);
    const clipId = str(step.clipId);
    const trackRef = trackId !== undefined ? `track:${trackId}` : undefined;
    const clipRef = clipId !== undefined ? `clip:${clipId}` : undefined;
    const track = trackRef ? state.get(trackRef) : undefined;
    const clip = clipRef ? state.get(clipRef) : undefined;
    const clipName = clipId !== undefined ? here.clip(clipId) : undefined;
    const clipTrack = str(clip?.trackId) ?? clipName?.trackId;
    const nameOf = (id: string | undefined) => {
      const name = id !== undefined ? here.track(id) : undefined;
      return name !== undefined && name !== '' ? isolateName(name) : t('step.aTrack');
    };
    const bold = (id: string | undefined) => {
      const name = id !== undefined ? here.track(id) : undefined;
      return name !== undefined && name !== '' ? mark('name', isolateName(name)) : t('step.aTrack');
    };
    const colourOf = (id: string | undefined) => (id === undefined ? '--tx-4' : added.has(id) ? '--ai' : trackColourVar(id));
    const old = <V>(value: V | undefined) => (known ? value : undefined);

    let title = '';
    let detail: string[] = [];
    let colour = colourOf(trackId ?? clipTrack);
    switch (step.op) {
      case 'track.add': {
        // The track before it: the last one, or, when the head already holds
        // the track (an applied plan), the one in front of it.
        const at = trackId !== undefined ? order.indexOf(trackId) : -1;
        const last = [...(at >= 0 ? order.slice(0, at) : order)].reverse().find((id) => here.track(id) !== undefined);
        title = t('row.addTrack', { name: mark('name', isolateName(str(step.name) ?? '')) });
        const channels = step.channels === 1 ? t('row.mono') : step.channels === 2 ? t('row.stereo') : undefined;
        detail = [...(channels ? [channels] : []), ...(last !== undefined ? [t('row.after', { track: nameOf(last) })] : [])];
        colour = '--ai';
        break;
      }
      case 'track.remove':
        title = t('row.removeTrack', { track: bold(trackId) });
        break;
      case 'track.rename': {
        title = t('row.rename', { track: bold(trackId) });
        const before = str(old(track?.name));
        if (typeof step.name === 'string') detail = [change(before !== undefined ? isolateName(before) : undefined, isolateName(step.name))];
        break;
      }
      case 'track.set_gain': {
        title = t('row.gain', { track: bold(trackId) });
        const before = num(old(track?.gainMilliDb));
        if (typeof step.gainMilliDb === 'number') detail = [change(before !== undefined ? formatDb(before) : undefined, formatDb(step.gainMilliDb))];
        break;
      }
      case 'track.set_pan': {
        title = t('row.pan', { track: bold(trackId) });
        const before = num(old(track?.pan));
        if (typeof step.pan === 'number') detail = [change(before !== undefined ? formatPan(before) : undefined, formatPan(step.pan))];
        break;
      }
      case 'track.set_mute': {
        title = t(step.mute ? 'row.mute' : 'row.unmute', { track: bold(trackId) });
        const word = (muted: unknown) => t(muted ? 'row.muted' : 'row.on');
        const before = old(track?.mute);
        detail = [change(before !== undefined ? word(before) : undefined, word(step.mute))];
        break;
      }
      case 'track.set_solo': {
        title = t(step.solo ? 'row.solo' : 'row.unsolo', { track: bold(trackId) });
        const word = (soloed: unknown) => t(soloed ? 'row.soloed' : 'row.off');
        const before = old(track?.solo);
        detail = [change(before !== undefined ? word(before) : undefined, word(step.solo))];
        break;
      }
      case 'clip.place': {
        title = t('row.placeClip', { track: nameOf(trackId) });
        const start = bar(frames(step.position));
        const end = bar(plus(frames(step.position), str(step.length)));
        const mediaId = str(step.mediaId);
        const media = mediaId !== undefined ? here.media?.(mediaId) : undefined;
        detail = [...(start !== undefined && end !== undefined ? [t('row.range', { start, end })] : []), ...(media !== undefined ? [isolateName(media)] : [])];
        colour = colourOf(trackId);
        break;
      }
      case 'clip.move': {
        const target = trackId ?? clipTrack;
        title = trackId !== undefined && trackId !== clipTrack ? t('row.moveClipTo', { track: nameOf(trackId) }) : t('row.moveClip', { track: nameOf(clipTrack) });
        const to = frames(step.position);
        const from = old(frames(clip?.position));
        const length = str(clip?.length) ?? clipName?.length;
        if (to !== undefined && rate) {
          const ends = plus(to, length);
          detail = [
            change(from !== undefined ? t('row.bar', { bar: bar(from)! }) : undefined, t('row.bar', { bar: bar(to)! })),
            ...(ends !== undefined ? [t('row.endsOn', { bar: bar(ends)! })] : []),
          ];
        }
        colour = colourOf(target);
        break;
      }
      case 'clip.remove': {
        title = t('row.removeClip', { track: nameOf(clipTrack) });
        const start = frames(clip?.position) ?? clipName?.position;
        const end = plus(start, str(clip?.length) ?? clipName?.length);
        if (start !== undefined && end !== undefined && rate) detail = [t('row.range', { start: bar(start)!, end: bar(end)! })];
        break;
      }
      case 'clip.trim': {
        title = t('row.trimClip', { track: nameOf(clipTrack) });
        const after = seconds(str(step.length));
        if (after !== undefined) detail = [change(seconds(str(old(clip?.length))), after)];
        break;
      }
      case 'clip.set_gain': {
        title = t('row.clipGain', { track: nameOf(clipTrack) });
        const before = num(old(clip?.gainMilliDb));
        if (typeof step.gainMilliDb === 'number') detail = [change(before !== undefined ? formatDb(before) : undefined, formatDb(step.gainMilliDb))];
        break;
      }
      default:
        title = describeStep(step, t, names, steps.slice(0, index));
        break;
    }

    // The step applied, for the steps after it.
    switch (step.op) {
      case 'track.add':
        if (trackId !== undefined) {
          added.add(trackId);
          if (!order.includes(trackId)) order.push(trackId);
          state.set(`track:${trackId}`, { name: step.name, gainMilliDb: 0, pan: 0, mute: false, solo: false });
        }
        break;
      case 'track.remove':
        if (trackId !== undefined && order.includes(trackId)) order.splice(order.indexOf(trackId), 1);
        break;
      case 'track.rename':
      case 'track.set_gain':
      case 'track.set_pan':
      case 'track.set_mute':
      case 'track.set_solo': {
        const field = TRACK_FIELDS[step.op as string]!;
        if (trackRef) state.set(trackRef, { ...(track ?? {}), [field]: step[field] });
        break;
      }
      case 'clip.place':
        if (clipRef) state.set(clipRef, { trackId: step.trackId, position: step.position, length: step.length, gainMilliDb: 0 });
        break;
      case 'clip.move':
        if (clipRef) {
          const base = clip ?? (clipName ? { trackId: clipName.trackId, position: { domain: 'audio', value: clipName.position }, length: clipName.length } : {});
          state.set(clipRef, { ...base, position: step.position, ...(trackId !== undefined ? { trackId } : {}) });
        }
        break;
      case 'clip.trim':
      case 'clip.set_gain':
        if (clipRef) {
          const base = clip ?? (clipName ? { trackId: clipName.trackId, position: { domain: 'audio', value: clipName.position }, length: clipName.length } : {});
          const field = step.op === 'clip.trim' ? 'length' : 'gainMilliDb';
          state.set(clipRef, { ...base, [field]: step[field] });
        }
        break;
      default:
        break;
    }
    return { title: segmentsOf(title), detail: segmentsOf(detail.join(' · ')), colour };
  });
}
