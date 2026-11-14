// One-line descriptions of plan steps (m5-plan-review, m5-ui-i18n,
// m5-ui-plan-panel; UI redesign spec 6.2 and P1-5), built from the catalogs so
// every locale goes through the same code path. Every op of the engine's
// command set has wording; an unknown op gets a generic line (the raw step is
// behind the row's disclosure). Nothing is named by its id: a track by its
// name (the read model's, or the name an earlier step of the same plan gave
// it), a clip by its track and position, a plugin by its name and track, and
// an entity none of those know by its kind only. dB values and pan go through
// format.ts and positions are seconds from the frame string and the root's
// sample rate (bars and beats arrive with m5-ui-transport). Names an agent or
// the user wrote are shown as written.

import { formatMilliDb, formatPan, formatSeconds } from '../format';
import { translator, type T } from '../i18n/t';
import type { Snapshot } from '../model/read-model';

const english = translator('en');

export interface ClipName {
  readonly trackId: string;
  // An audio-domain position in frames, as a decimal string.
  readonly position: string;
}

export interface SlotName {
  readonly trackId: string;
  readonly name: string;
}

// What the session knows of the entities a step names.
export interface StepNames {
  track(id: string): string | undefined;
  clip(id: string): ClipName | undefined;
  slot(id: string): SlotName | undefined;
  readonly sampleRate: number | undefined;
}

export const NO_NAMES: StepNames = {
  track: () => undefined,
  clip: () => undefined,
  slot: () => undefined,
  sampleRate: undefined,
};

// The names of a read-model snapshot (null: nothing known).
export function namesFromSnapshot(snapshot: Snapshot | null): StepNames {
  if (!snapshot) return NO_NAMES;
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
      return { trackId: clip.trackId, position: position.value };
    },
    slot: (id) => {
      const slot = entity(`plugin_slot:${id}`);
      if (typeof slot?.trackId !== 'string' || typeof slot.name !== 'string' || slot.name === '') return undefined;
      return { trackId: slot.trackId, name: slot.name };
    },
    sampleRate: snapshot.root?.sampleRate,
  };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function audioFrames(position: unknown): string | undefined {
  const p = position as { domain?: unknown; value?: unknown } | null | undefined;
  return p?.domain === 'audio' && typeof p.value === 'string' ? p.value : undefined;
}

// The names the session holds, then the ones earlier steps of the plan gave.
function overlay(names: StepNames, earlier: readonly Record<string, unknown>[]): StepNames {
  const tracks = new Map<string, string>();
  const clips = new Map<string, ClipName>();
  const slots = new Map<string, SlotName>();
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
        if (clipId && trackId && position !== undefined) clips.set(clipId, { trackId, position });
        break;
      }
      case 'clip.move': {
        const known = clipId ? (clips.get(clipId) ?? names.clip(clipId)) : undefined;
        const position = audioFrames(step.position);
        if (clipId && known && position !== undefined) clips.set(clipId, { trackId: trackId ?? known.trackId, position });
        break;
      }
      case 'plugin.insert': {
        const name = str((step.descriptor as Record<string, unknown> | undefined)?.name);
        const slotId = str(step.slotId);
        if (slotId && trackId && name) slots.set(slotId, { trackId, name });
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
  };
}

function seconds(frames: string | undefined, names: StepNames, t: T): string | undefined {
  const rate = names.sampleRate;
  if (frames === undefined || !rate || !/^-?\d+$/.test(frames)) return undefined;
  return t('step.seconds', { value: formatSeconds(Number(frames) / rate) });
}

function trackOf(id: unknown, names: StepNames, t: T): string {
  return (typeof id === 'string' ? names.track(id) : undefined) ?? t('step.aTrack');
}

// "a clip on Keys" (at its position with `at`), or "a clip".
function clipOf(id: unknown, names: StepNames, t: T, at: boolean): string {
  const clip = typeof id === 'string' ? names.clip(id) : undefined;
  if (!clip) return t('step.aClip');
  const track = names.track(clip.trackId);
  if (!track) return t('step.aClip');
  const time = at ? seconds(clip.position, names, t) : undefined;
  return time ? t('step.clipOnAt', { track, time }) : t('step.clipOn', { track });
}

function pluginOf(slot: SlotName | undefined, names: StepNames, t: T): string {
  if (!slot) return t('step.aPlugin');
  const track = names.track(slot.trackId);
  return track ? t('step.pluginOn', { plugin: slot.name, track }) : slot.name;
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
  return t('step.anEntity');
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
      if (typeof step.name === 'string') return t('step.addTrack', { name: step.name });
      break;
    case 'track.remove':
      return t('step.removeTrack', { track: track() });
    case 'track.rename':
      if (typeof step.name === 'string') return t('step.renameTrack', { track: track(), name: step.name });
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
    case 'track.explode':
      return t('step.explodeTrack', { track: track() });
    case 'clip.place':
      return t('step.placeClip', { track: track(), time: seconds(audioFrames(step.position), names, t) ?? t('step.newPosition') });
    case 'clip.move': {
      const clip = clipOf(step.clipId, names, t, false);
      const time = seconds(audioFrames(step.position), names, t) ?? t('step.newPosition');
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
    case 'media.add':
      return t('step.addMedia');
    case 'media.remove':
      return t('step.removeMedia');
    case 'media.rename':
      if (typeof step.name === 'string') return t('step.renameMedia', { name: step.name });
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
    case 'session.rename':
      if (typeof step.name === 'string') return t('step.renameSession', { name: step.name });
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
