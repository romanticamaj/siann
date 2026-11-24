// One-line descriptions of plan steps (m5-plan-review, m5-ui-i18n,
// m5-ui-plan-panel; UI redesign spec 6.2 and P1-5), built from the catalogs so
// every locale goes through the same code path. Every op of the engine's
// command set has wording; an unknown op gets a generic line (the raw step is
// behind the row's disclosure). Nothing is named by its id: a track by its
// name (the read model's, or the name an earlier step of the same plan gave
// it), a clip by its track and position, a plugin by its name and track, and
// an entity none of those know by its kind only. dB values and pan go through
// format.ts; positions follow the position display's primary format
// (m5-ui-transport; UI redesign spec 7 P1-5): Bars+Beats through root.tempo
// by default, or Seconds, from the frame string and the root's sample rate;
// lengths are seconds. Names an agent or the user wrote are shown as written,
// each in its own bidi isolate (isolate.ts, isolateName), so a name cannot
// reorder the sentence it is in.

import { formatMilliDb, formatPan, formatSeconds } from '../format';
import { translator, type T } from '../i18n/t';
import type { TempoPoint } from '../model/document';
import type { Snapshot } from '../model/read-model';
import { formatMs } from '../timeline/fades';
import { formatPosition, type TimeFormat } from '../timeline/transport-time';
import { isolateName } from './isolate';

const english = translator('en');

export interface ClipName {
  readonly trackId: string;
  // An audio-domain position in frames, as a decimal string.
  readonly position: string;
  // The clip's length in frames, when known (the step rows' "ends on").
  readonly length?: string;
  // The media it plays, when known: a step names the clip by its media's name (m5b-ui-media).
  readonly mediaId?: string;
}

export interface SlotName {
  readonly trackId: string;
  readonly name: string;
}

// A marker as a step names it (m5b-ui-markers): its number (null while a
// plan's marker.add leaves it to the engine), its name and its kind.
export interface MarkerName {
  readonly number: number | null;
  readonly name: string;
  readonly cycle: boolean;
}

// What the session knows of the entities a step names.
export interface StepNames {
  track(id: string): string | undefined;
  clip(id: string): ClipName | undefined;
  slot(id: string): SlotName | undefined;
  readonly sampleRate: number | undefined;
  // root.tempo (120 BPM when absent) and the position display's primary
  // format (Bars+Beats when absent), for positions.
  readonly tempo?: readonly TempoPoint[];
  readonly timeFormat?: TimeFormat;
  // The track order and the media's names (the step rows of
  // m5-ui-port-plans: "after <last track>", the placed clip's media).
  readonly trackOrder?: readonly string[];
  media?(id: string): string | undefined;
  // A bus by its name and a send by its track and bus (m5b-ui-sends-buses).
  bus?(id: string): string | undefined;
  send?(id: string): SendName | undefined;
  marker?(id: string): MarkerName | undefined;
}

export interface SendName {
  readonly trackId: string;
  readonly busId: string;
}

export const NO_NAMES: StepNames = {
  track: () => undefined,
  clip: () => undefined,
  slot: () => undefined,
  sampleRate: undefined,
};

// The names of a read-model snapshot (null: nothing known).
export function namesFromSnapshot(snapshot: Snapshot | null, timeFormat: TimeFormat = 'bars'): StepNames {
  if (!snapshot) return { ...NO_NAMES, timeFormat };
  const entity = (ref: string) => snapshot.entities[ref] as unknown as Record<string, unknown> | undefined;
  return {
    track: (id) => {
      const name = entity(`track:${id}`)?.name;
      return typeof name === 'string' ? name : undefined;
    },
    clip: (id) => {
      const clip = entity(`clip:${id}`);
      const position = clip?.position as { domain?: unknown; value?: unknown } | undefined;
      if (typeof clip?.trackId !== 'string' || position?.domain !== 'audio' || typeof position.value !== 'string') return undefined;
      return {
        trackId: clip.trackId,
        position: position.value,
        ...(typeof clip.length === 'string' ? { length: clip.length } : {}),
        ...(typeof clip.mediaId === 'string' ? { mediaId: clip.mediaId } : {}),
      };
    },
    media: (id) => {
      const name = entity(`media:${id}`)?.name;
      return typeof name === 'string' && name !== '' ? name : undefined;
    },
    trackOrder: snapshot.trackOrder,
    marker: (id) => {
      const marker = entity(`marker:${id}`);
      if (typeof marker?.name !== 'string' || typeof marker.number !== 'number') return undefined;
      return { number: marker.number, name: marker.name, cycle: typeof marker.length === 'string' };
    },
    slot: (id) => {
      const slot = entity(`plugin_slot:${id}`);
      if (typeof slot?.trackId !== 'string' || typeof slot.name !== 'string' || slot.name === '') return undefined;
      return { trackId: slot.trackId, name: slot.name };
    },
    bus: (id) => {
      const name = entity(`bus:${id}`)?.name;
      return typeof name === 'string' && name !== '' ? name : undefined;
    },
    send: (id) => {
      const send = entity(`send:${id}`);
      return typeof send?.trackId === 'string' && typeof send.busId === 'string' ? { trackId: send.trackId, busId: send.busId } : undefined;
    },
    sampleRate: snapshot.root?.sampleRate,
    tempo: snapshot.root?.tempo ?? [],
    timeFormat,
  };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function audioFrames(position: unknown): string | undefined {
  const p = position as { domain?: unknown; value?: unknown } | null | undefined;
  return p?.domain === 'audio' && typeof p.value === 'string' ? p.value : undefined;
}

// The names the session holds, then the ones earlier steps of the plan gave.
export function overlay(names: StepNames, earlier: readonly Record<string, unknown>[]): StepNames {
  const tracks = new Map<string, string>();
  const clips = new Map<string, ClipName>();
  const slots = new Map<string, SlotName>();
  const buses = new Map<string, string>();
  const sends = new Map<string, SendName>();
  const markers = new Map<string, MarkerName>();
  for (const step of earlier) {
    const trackId = str(step.trackId);
    const clipId = str(step.clipId);
    switch (step.op) {
      case 'track.add':
      case 'track.rename':
        if (trackId && typeof step.name === 'string') tracks.set(trackId, step.name);
        break;
      case 'clip.place': {
        const position = audioFrames(step.position);
        const length = str(step.length);
        const mediaId = str(step.mediaId);
        if (clipId && trackId && position !== undefined) {
          clips.set(clipId, { trackId, position, ...(length !== undefined ? { length } : {}), ...(mediaId !== undefined ? { mediaId } : {}) });
        }
        break;
      }
      case 'clip.move': {
        const known = clipId ? (clips.get(clipId) ?? names.clip(clipId)) : undefined;
        const position = audioFrames(step.position);
        if (clipId && known && position !== undefined) clips.set(clipId, { ...known, trackId: trackId ?? known.trackId, position });
        break;
      }
      case 'plugin.insert': {
        const name = str((step.descriptor as Record<string, unknown> | undefined)?.name);
        const slotId = str(step.slotId);
        if (slotId && trackId && name) slots.set(slotId, { trackId, name });
        break;
      }
      case 'bus.add':
      case 'bus.rename': {
        const busId = str(step.busId);
        if (busId && typeof step.name === 'string') buses.set(busId, step.name);
        break;
      }
      case 'send.add': {
        const sendId = str(step.sendId);
        const busId = str(step.busId);
        if (sendId && trackId && busId) sends.set(sendId, { trackId, busId });
        break;
      }
      case 'marker.add': {
        const markerId = str(step.markerId);
        if (markerId) markers.set(markerId, { number: typeof step.number === 'number' ? step.number : null, name: str(step.name) ?? '', cycle: typeof step.length === 'string' });
        break;
      }
      default:
        break;
    }
  }
  return {
    // A rename in the plan does not hide the name the user sees now.
    track: (id) => names.track(id) ?? tracks.get(id),
    clip: (id) => clips.get(id) ?? names.clip(id),
    slot: (id) => slots.get(id) ?? names.slot(id),
    sampleRate: names.sampleRate,
    tempo: names.tempo,
    timeFormat: names.timeFormat,
    ...(names.trackOrder ? { trackOrder: names.trackOrder } : {}),
    ...(names.media ? { media: names.media } : {}),
    // A rename in the plan does not hide the bus name the user sees now.
    bus: (id) => names.bus?.(id) ?? buses.get(id),
    send: (id) => sends.get(id) ?? names.send?.(id),
    // A marker the plan adds is named from its step; a rename in the plan does not hide the name the user sees now.
    marker: (id) => names.marker?.(id) ?? markers.get(id),
  };
}

// A position as the position display shows it in its primary format: the
// same bytes in every locale, no catalog word around it.
function position(frames: string | undefined, names: StepNames): string | undefined {
  const rate = names.sampleRate;
  if (frames === undefined || !rate || !/^\d+$/.test(frames)) return undefined;
  return formatPosition(frames, names.tempo ?? [], rate, names.timeFormat ?? 'bars');
}

// A length in seconds.
function seconds(frames: string | undefined, names: StepNames, t: T): string | undefined {
  const rate = names.sampleRate;
  if (frames === undefined || !rate || !/^-?\d+$/.test(frames)) return undefined;
  return t('step.seconds', { value: formatSeconds(Number(frames) / rate) });
}

// A known name, isolated; an unknown or empty one is undefined (the caller
// then says "a track").
function named(name: string | undefined): string | undefined {
  return name === undefined || name === '' ? undefined : isolateName(name);
}

function trackOf(id: unknown, names: StepNames, t: T): string {
  return named(typeof id === 'string' ? names.track(id) : undefined) ?? t('step.aTrack');
}

// "a clip on Keys" (at its position with `at`), or "a clip".
function clipOf(id: unknown, names: StepNames, t: T, at: boolean): string {
  const clip = typeof id === 'string' ? names.clip(id) : undefined;
  if (!clip) return t('step.aClip');
  const track = named(names.track(clip.trackId));
  if (!track) return t('step.aClip');
  const time = at ? position(clip.position, names) : undefined;
  return time ? t('step.clipOnAt', { track, time }) : t('step.clipOn', { track });
}

function busOf(id: unknown, names: StepNames): string | undefined {
  return named(typeof id === 'string' ? names.bus?.(id) : undefined);
}

// "the send from Keys to Verb", or undefined when its track or bus is unknown.
function sendOf(id: unknown, names: StepNames, t: T): string | undefined {
  const send = typeof id === 'string' ? names.send?.(id) : undefined;
  if (!send) return undefined;
  const track = named(names.track(send.trackId));
  const bus = busOf(send.busId, names);
  return track && bus ? t('step.sendOf', { track, bus }) : undefined;
}

// An output: a bus by its name, or the master (null).
function targetOf(output: unknown, names: StepNames, t: T): string | undefined {
  if (output === null) return t('step.theMaster');
  return busOf((output as { busId?: unknown } | undefined)?.busId, names);
}

function pluginOf(slot: SlotName | undefined, names: StepNames, t: T): string {
  if (!slot) return t('step.aPlugin');
  const track = named(names.track(slot.trackId));
  const plugin = isolateName(slot.name);
  return track ? t('step.pluginOn', { plugin, track }) : plugin;
}

// "marker 3 Chorus", "cycle marker 1", "marker Bridge" (a plan's marker
// without its number yet), or "a marker".
function markerOf(id: unknown, names: StepNames, t: T): string {
  const marker = typeof id === 'string' ? names.marker?.(id) : undefined;
  if (!marker) return t('step.aMarker');
  const name = named(marker.name);
  if (marker.number === null) return name ? t('step.markerNamed', { name }) : t('step.aMarker');
  if (marker.cycle) return name ? t('step.cycleMarkerNamed', { number: marker.number, name }) : t('step.cycleMarker', { number: marker.number });
  return name ? t('step.positionMarkerNamed', { number: marker.number, name }) : t('step.positionMarker', { number: marker.number });
}

// A marker step's end: position + length.
function endOf(position: string | undefined, length: unknown): string | undefined {
  if (position === undefined || typeof length !== 'string' || !/^\d+$/.test(position) || !/^\d+$/.test(length)) return undefined;
  return (BigInt(position) + BigInt(length)).toString();
}

// An entity ref ("<type>:<id>", as plan_stale's changedEntities name them)
// in user wording: a track by its name, a clip by its track, a plugin by its
// name and track, anything else by its kind or as "something in the session".
export function describeRef(ref: string, t: T = english, names: StepNames = NO_NAMES): string {
  const colon = ref.indexOf(':');
  const type = colon < 0 ? '' : ref.slice(0, colon);
  const id = ref.slice(colon + 1);
  if (type === 'track') return trackOf(id, names, t);
  if (type === 'clip') return clipOf(id, names, t, false);
  if (type === 'plugin_slot') return pluginOf(names.slot(id), names, t);
  if (type === 'bus') return busOf(id, names) ?? t('step.aBus');
  if (type === 'send') return sendOf(id, names, t) ?? t('step.aSend');
  return t('step.anEntity');
}

// One side of a clip.set_fade step: its length in frames, undefined when the
// step omits the side, null when the side is malformed.
function fadeSide(value: unknown): bigint | undefined | null {
  if (value === undefined) return undefined;
  const length = (value as { length?: unknown } | null)?.length;
  return typeof length === 'string' && /^\d+$/.test(length) ? BigInt(length) : null;
}

function bpm(milliBpm: unknown): string {
  return typeof milliBpm === 'number' ? String(Number((milliBpm / 1000).toFixed(3))) : '?';
}

// `earlier` are the plan's steps before this one: what they add or name is
// named from them.
export function describeStep(
  step: Record<string, unknown>,
  t: T = english,
  sessionNames: StepNames = NO_NAMES,
  earlier: readonly Record<string, unknown>[] = [],
): string {
  const names = earlier.length > 0 ? overlay(sessionNames, earlier) : sessionNames;
  const track = () => trackOf(step.trackId, names, t);
  switch (step.op) {
    case 'track.add':
      if (typeof step.name === 'string') return t('step.addTrack', { name: isolateName(step.name) });
      break;
    case 'track.remove':
      return t('step.removeTrack', { track: track() });
    case 'track.rename':
      if (typeof step.name === 'string') return t('step.renameTrack', { track: track(), name: isolateName(step.name) });
      break;
    case 'track.set_gain':
      if (typeof step.gainMilliDb === 'number') return t('step.setGain', { track: track(), gain: formatMilliDb(step.gainMilliDb) });
      break;
    case 'track.set_pan':
      if (typeof step.pan === 'number') return t('step.setPan', { track: track(), pan: formatPan(step.pan) });
      break;
    case 'track.set_mute':
      return t(step.mute ? 'step.mute' : 'step.unmute', { track: track() });
    case 'track.set_solo':
      return t(step.solo ? 'step.solo' : 'step.unsolo', { track: track() });
    case 'track.set_input': {
      if (step.input === null) return t('step.clearInput', { track: track() });
      const input = step.input as Record<string, unknown> | undefined;
      if (input && typeof input.port === 'number' && typeof input.channels === 'number') {
        const first = input.port + 1;
        if (input.channels === 2) return t('step.setInputPair', { track: track(), first, second: first + 1 });
        return t('step.setInput', { track: track(), input: first });
      }
      break;
    }
    case 'track.set_monitor':
      if (step.monitor === 'off') return t('step.setMonitorOff', { track: track() });
      if (step.monitor === 'auto') return t('step.setMonitorAuto', { track: track() });
      if (step.monitor === 'input') return t('step.setMonitorInput', { track: track() });
      break;
    case 'track.set_notes':
      // Named by the track; the notes are free text and stay out of the sentence.
      if (typeof step.notes === 'string') return t(step.notes === '' ? 'step.clearTrackNotes' : 'step.setTrackNotes', { track: track() });
      break;
    case 'track.explode':
      return t('step.explodeTrack', { track: track() });
    case 'clip.place': {
      // Named by its media (m5b-ui-media), when the media has a name.
      const time = position(audioFrames(step.position), names) ?? t('step.newPosition');
      const media = named(typeof step.mediaId === 'string' ? names.media?.(step.mediaId) : undefined);
      return media ? t('step.placeMedia', { media, track: track(), time }) : t('step.placeClip', { track: track(), time });
    }
    case 'clip.move': {
      const clip = clipOf(step.clipId, names, t, false);
      const time = position(audioFrames(step.position), names) ?? t('step.newPosition');
      if (typeof step.trackId === 'string') return t('step.moveClipTo', { clip, track: track(), time });
      return t('step.moveClip', { clip, time });
    }
    case 'clip.trim':
      return t('step.trimClip', {
        clip: clipOf(step.clipId, names, t, false),
        length: seconds(str(step.length), names, t) ?? t('step.newLength'),
      });
    case 'clip.remove':
      return t('step.removeClip', { clip: clipOf(step.clipId, names, t, true) });
    case 'clip.set_gain':
      if (typeof step.gainMilliDb === 'number') {
        return t('step.setClipGain', { clip: clipOf(step.clipId, names, t, false), gain: formatMilliDb(step.gainMilliDb) });
      }
      break;
    case 'clip.set_fade': {
      // m5b-ui-fades (10.11, 23): named by its clip, the lengths in ms, a side at 0 removed.
      const fadeIn = fadeSide(step.fadeIn);
      const fadeOut = fadeSide(step.fadeOut);
      if (fadeIn === null || fadeOut === null || (fadeIn === undefined && fadeOut === undefined)) break;
      const clip = clipOf(step.clipId, names, t, false);
      const ms = (frames: bigint) => (names.sampleRate ? formatMs(frames, names.sampleRate) : t('step.newLength'));
      if (fadeIn !== undefined && fadeOut !== undefined) {
        if (fadeIn === 0n && fadeOut === 0n) return t('step.removeFades', { clip });
        if (fadeOut === 0n) return t('step.setFadeInRemoveOut', { clip, length: ms(fadeIn) });
        if (fadeIn === 0n) return t('step.removeFadeInSetOut', { clip, length: ms(fadeOut) });
        return t('step.setFades', { clip, fadeIn: ms(fadeIn), fadeOut: ms(fadeOut) });
      }
      if (fadeIn !== undefined) return fadeIn === 0n ? t('step.removeFadeIn', { clip }) : t('step.setFadeIn', { clip, length: ms(fadeIn) });
      return fadeOut === 0n ? t('step.removeFadeOut', { clip }) : t('step.setFadeOut', { clip, length: ms(fadeOut!) });
    }
    case 'marker.add': {
      // m5b-ui-markers (4.2): a flag at its position, or a range from its start to its end.
      const at = str(step.position);
      const time = position(at, names) ?? t('step.newPosition');
      const name = named(str(step.name));
      if (typeof step.length === 'string') {
        const end = position(endOf(at, step.length), names) ?? t('step.newPosition');
        return name ? t('step.addCycleMarker', { name, time, end }) : t('step.addCycleMarkerUnnamed', { time, end });
      }
      return name ? t('step.addMarker', { name, time }) : t('step.addMarkerUnnamed', { time });
    }
    case 'marker.move': {
      const marker = markerOf(step.markerId, names, t);
      const at = str(step.position);
      const time = position(at, names) ?? t('step.newPosition');
      if (typeof step.length === 'string') return t('step.resizeMarker', { marker, time, end: position(endOf(at, step.length), names) ?? t('step.newPosition') });
      return t('step.moveMarker', { marker, time });
    }
    case 'marker.rename':
      if (typeof step.name === 'string') return t('step.renameMarker', { marker: markerOf(step.markerId, names, t), name: isolateName(step.name) });
      break;
    case 'marker.remove':
      return t('step.removeMarker', { marker: markerOf(step.markerId, names, t) });
    case 'media.add':
      return t('step.addMedia');
    case 'media.remove':
      return t('step.removeMedia');
    case 'media.rename':
      if (typeof step.name === 'string') return t('step.renameMedia', { name: isolateName(step.name) });
      if (step.name === null) return t('step.unnameMedia');
      break;
    case 'plugin.insert': {
      const name = str((step.descriptor as Record<string, unknown> | undefined)?.name);
      const trackId = str(step.trackId);
      const slot = name && trackId ? { trackId, name } : undefined;
      return t('step.insertPlugin', { plugin: slot ? pluginOf(slot, names, t) : t('step.aPlugin') });
    }
    case 'plugin.remove':
      return t('step.removePlugin', { plugin: pluginOf(str(step.slotId) ? names.slot(step.slotId as string) : undefined, names, t) });
    case 'plugin.set_bypass': {
      const plugin = pluginOf(str(step.slotId) ? names.slot(step.slotId as string) : undefined, names, t);
      return t(step.bypass ? 'step.bypassPlugin' : 'step.unbypassPlugin', { plugin });
    }
    // m5b-ui-sends-buses: the fourteen bus, send and routing commands.
    case 'bus.add':
      if (typeof step.name === 'string') return t('step.addBus', { name: isolateName(step.name) });
      break;
    case 'bus.remove': {
      const bus = busOf(step.busId, names);
      return bus ? t('step.removeBus', { bus }) : t('step.removeABus');
    }
    case 'bus.rename':
    case 'bus.set_gain':
    case 'bus.set_pan':
    case 'bus.set_mute':
    case 'bus.set_solo':
    case 'bus.set_output': {
      const bus = busOf(step.busId, names) ?? t('step.aBus');
      if (step.op === 'bus.rename' && typeof step.name === 'string') return t('step.renameBus', { bus, name: isolateName(step.name) });
      if (step.op === 'bus.set_gain' && typeof step.gainMilliDb === 'number') return t('step.setBusGain', { bus, gain: formatMilliDb(step.gainMilliDb) });
      if (step.op === 'bus.set_pan' && typeof step.pan === 'number') return t('step.setBusPan', { bus, pan: formatPan(step.pan) });
      if (step.op === 'bus.set_mute') return t(step.mute ? 'step.muteBus' : 'step.unmuteBus', { bus });
      if (step.op === 'bus.set_solo') return t(step.solo ? 'step.soloBus' : 'step.unsoloBus', { bus });
      if (step.op === 'bus.set_output') {
        const target = targetOf(step.output, names, t);
        if (target) return t('step.routeBus', { bus, target });
      }
      break;
    }
    case 'track.set_output': {
      const target = targetOf(step.output, names, t);
      if (target) return t('step.routeTrack', { track: track(), target });
      break;
    }
    case 'send.add':
      return t('step.addSend', { track: track(), bus: busOf(step.busId, names) ?? t('step.aBus') });
    case 'send.remove': {
      const send = sendOf(step.sendId, names, t);
      return send ? t('step.removeSend', { send }) : t('step.removeASend');
    }
    case 'send.set_level':
    case 'send.set_pre':
    case 'send.set_enabled': {
      const send = sendOf(step.sendId, names, t) ?? t('step.aSend');
      if (step.op === 'send.set_level' && typeof step.levelMilliDb === 'number') return t('step.setSendLevel', { send, gain: formatMilliDb(step.levelMilliDb) });
      if (step.op === 'send.set_pre') return t(step.pre ? 'step.sendPre' : 'step.sendPost', { send });
      if (step.op === 'send.set_enabled') return t(step.enabled ? 'step.sendOn' : 'step.sendOff', { send });
      break;
    }
    case 'session.rename':
      if (typeof step.name === 'string') return t('step.renameSession', { name: isolateName(step.name) });
      break;
    case 'session.set_tempo':
      if (Array.isArray(step.tempo)) {
        const points = step.tempo as Array<Record<string, unknown>>;
        if (points.length === 1) return t('step.setTempo', { bpm: bpm(points[0]!.milliBpm) });
        return t('step.setTempoMap', { count: points.length });
      }
      break;
    default:
      break;
  }
  return t('step.unknown');
}

// Every step of a plan, each named with what the steps before it made.
export function describePlan(steps: readonly Record<string, unknown>[], t: T = english, names: StepNames = NO_NAMES): string[] {
  return steps.map((step, index) => describeStep(step, t, names, steps.slice(0, index)));
}
