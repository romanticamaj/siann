// The ghost model (m5b-ui-ghosts; UI redesign 4.2, P2-1): a pure function of
// a plan's steps, its plan.preview answer, the snapshot and the ticked steps
// to one descriptor per change the window draws in place: a proposed track
// (its header, lane and strip), a placed, moved, trimmed or removed clip, a
// removed track, a gain, pan, mute, solo or name change, and the locators.
// Each carries its step number, the 1-based index in the full plan.
//
// plan.preview answers for the whole plan, not per step (10.11), so:
// - a ghost's old value is the preview's `before` with the ticked steps
//   applied in order (the state walk of plans/step-rows.ts), never `after`;
// - an unticked step contributes no ghost and changes no later old value;
// - a cascade (the clips of a removed track) belongs to the step
//   plans/entity-homes.ts homes it to;
// - a ghost on a track that exists neither in the snapshot nor through a
//   ticked track.add is not produced;
// - the locator ghost takes its new range from the session.set_locators step
//   and its old one from the preview's locators:locators entity (no step is
//   homed to that entity);
// - the first track.add keeps the mockup's ids (key "ghost": track-ghost,
//   lane-ghost, strip-ghost), later ones take "ghost-2", "ghost-3" in step
//   order of the ticked ones;
// - the master-gain ghost takes its new value from the master.set_gain step
//   and its old one from master:master, 0 dB while the entity is absent;
// - an insert ghost (plugin.insert, plugin.remove, plugin.set_bypass) needs
//   its track in the session: an insert on a proposed track gives none (the
//   ghost strip's rack stays empty); an insert's index clamps to the end of
//   the chain as the engine's does, after the ticked steps before it.
// One descriptor per (step, kind, target): two steps on one field give two.

import type { Snapshot } from '../model/read-model';
import { diffRows, type PlanPreview } from './diff';
import { entityHomes } from './entity-homes';

export interface LocatorPair {
  readonly left: string;
  readonly right: string;
}

export type Ghost = (
  | { readonly kind: 'track-add'; readonly step: number; readonly trackId: string; readonly name: string; readonly channels: number | null; readonly key: string }
  | { readonly kind: 'clip-place'; readonly step: number; readonly clipId: string; readonly trackId: string; readonly mediaId: string; readonly position: string; readonly sourceStart: string; readonly length: string }
  | {
      readonly kind: 'clip-move';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly fromTrackId: string;
      readonly trackId: string;
      readonly from: string;
      readonly position: string;
      readonly sourceStart: string;
      readonly length: string;
    }
  | {
      readonly kind: 'clip-trim';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly trackId: string;
      readonly position: string;
      readonly from: { readonly sourceStart: string; readonly length: string };
      readonly to: { readonly sourceStart: string; readonly length: string };
    }
  | {
      readonly kind: 'clip-remove';
      readonly step: number;
      readonly clipId: string;
      readonly mediaId: string;
      readonly trackId: string;
      readonly position: string;
      readonly sourceStart: string;
      readonly length: string;
      readonly cascade: boolean;
    }
  | { readonly kind: 'track-remove'; readonly step: number; readonly trackId: string }
  | ValueGhost<'gain', number>
  | ValueGhost<'pan', number>
  | ValueGhost<'mute', boolean>
  | ValueGhost<'solo', boolean>
  | { readonly kind: 'rename'; readonly step: number; readonly trackId: string; readonly before: string | null; readonly after: string }
  | { readonly kind: 'locators'; readonly step: number; readonly before: LocatorPair | null; readonly after: LocatorPair }
  // m5b-ui-inserts-master: the master gain (0 dB while master:master is absent) and the insert kinds.
  | { readonly kind: 'master-gain'; readonly step: number; readonly before: number; readonly after: number }
  | { readonly kind: 'insert-add'; readonly step: number; readonly trackId: string; readonly slotId: string | null; readonly name: string; readonly index: number }
  | { readonly kind: 'insert-remove'; readonly step: number; readonly trackId: string; readonly slotId: string }
  | { readonly kind: 'insert-bypass'; readonly step: number; readonly trackId: string; readonly slotId: string; readonly before: boolean | null; readonly after: boolean }
) &
  GhostMode;

// While the proposal is heard (m5b-ui-audition; plans/heard-ghosts.ts): mode
// 'solid' (what is playing; absent for the dashed ghosts of plan.preview) and
// the value the ghost replaces, main's, which is drawn as the faint outline.
// A solid ghost of a value no step names has step 0 and carries no number.
export interface GhostMode {
  readonly mode?: 'solid';
  readonly replaced?: number | boolean | string | null;
}

// A change of one track field: its old value (null when unknown) and the new one.
export interface ValueGhost<K extends string, V> {
  readonly kind: K;
  readonly step: number;
  readonly trackId: string;
  readonly before: V | null;
  readonly after: V;
}

export type GhostKind = Ghost['kind'];

// The ghosts that sit on a track's header, strip and Inspector rows.
export type TrackGhost = Extract<Ghost, { readonly kind: 'gain' | 'pan' | 'mute' | 'solo' | 'rename' | 'track-remove' }>;

type Entity = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const frames = (position: unknown): string | undefined => {
  const p = position as { domain?: unknown; value?: unknown } | null | undefined;
  return p?.domain === 'audio' && typeof p.value === 'string' && /^\d+$/.test(p.value) ? p.value : undefined;
};

// The track ops that set one field, and that field.
const TRACK_FIELDS: Readonly<Record<string, { readonly kind: 'gain' | 'pan' | 'mute' | 'solo' | 'rename'; readonly field: string }>> = {
  'track.set_gain': { kind: 'gain', field: 'gainMilliDb' },
  'track.set_pan': { kind: 'pan', field: 'pan' },
  'track.set_mute': { kind: 'mute', field: 'mute' },
  'track.set_solo': { kind: 'solo', field: 'solo' },
  'track.rename': { kind: 'rename', field: 'name' },
};

export function ghostsOf(
  steps: readonly Record<string, unknown>[],
  preview: PlanPreview | null,
  snapshot: Snapshot | null,
  ticked: ReadonlySet<number> | null,
): Ghost[] {
  if (!preview) return [];
  const isTicked = (index: number) => ticked === null || ticked.has(index);
  // The entities as each step finds them: the head (the preview's before,
  // else the snapshot's), then the ticked steps applied in order.
  const before = new Map<string, Entity | null>(preview.entities.map((e) => [e.ref, e.before ? { ...e.before } : null]));
  const state = new Map<string, Entity | null>();
  const read = (ref: string): Entity | null => {
    if (state.has(ref)) return state.get(ref)!;
    if (before.has(ref)) return before.get(ref)!;
    const entity = snapshot?.entities[ref as keyof Snapshot['entities']] as unknown as Entity | undefined;
    return entity ? { ...entity } : null;
  };
  const trackKnown = (id: string | undefined): id is string => id !== undefined && read(`track:${id}`) !== null;
  // The tracks a ticked track.add proposes: they have no rack.
  const proposedTracks = new Set<string>();
  const rackTrack = (id: string | undefined): id is string => trackKnown(id) && !proposedTracks.has(id);
  const insertsOf = (track: Entity | null): string[] => (Array.isArray(track?.inserts) ? (track.inserts as unknown[]).filter((s): s is string => typeof s === 'string') : []);

  // The cascades of plan.preview: the removed clips of a removed track that
  // no clip.remove names, each under the step entityHomes homes it to when
  // that step is on the same track (its rule 2 can also home a clip to an
  // earlier step that only shares its media id: then the track.remove's).
  const rows = diffRows(preview);
  const homes = entityHomes(steps, rows);
  const homeOf = (at: number) => homes.steps.findIndex((list) => list.includes(at));
  const cascadeOf = (index: number, trackId: string): Array<{ ref: string; step: number }> =>
    rows
      .map((row, at) => ({ row, at }))
      .filter(({ row }) => row.kind === 'removed' && row.ref.startsWith('clip:') && row.before?.trackId === trackId)
      .filter(({ row }) => !steps.some((s) => s.op === 'clip.remove' && `clip:${str(s.clipId)}` === row.ref))
      .map(({ row, at }) => {
        const home = homeOf(at);
        const onTrack = home >= 0 && steps[home]!.trackId === trackId && isTicked(home);
        return { ref: row.ref, step: (onTrack ? home : index) + 1 };
      });

  const out: Ghost[] = [];
  const removedTracks = new Set<string>();
  let proposed = 0;
  steps.forEach((step, index) => {
    if (!isTicked(index)) return;
    const n = index + 1;
    const trackId = str(step.trackId);
    const clipId = str(step.clipId);
    const op = str(step.op) ?? '';
    const field = TRACK_FIELDS[op];
    if (field) {
      if (!trackKnown(trackId)) return;
      const ref = `track:${trackId}`;
      const track = read(ref) ?? {};
      const value = step[field.field];
      if (field.kind === 'gain' || field.kind === 'pan') {
        const after = num(value);
        if (after === undefined) return;
        out.push({ kind: field.kind, step: n, trackId, before: num(track[field.field]) ?? null, after });
      } else if (field.kind === 'mute' || field.kind === 'solo') {
        const after = bool(value);
        if (after === undefined) return;
        out.push({ kind: field.kind, step: n, trackId, before: bool(track[field.field]) ?? null, after });
      } else {
        const after = str(value);
        if (after === undefined) return;
        out.push({ kind: 'rename', step: n, trackId, before: str(track.name) ?? null, after });
      }
      state.set(ref, { ...track, [field.field]: value });
      return;
    }
    switch (op) {
      case 'track.add': {
        if (trackId === undefined) return;
        proposed += 1;
        proposedTracks.add(trackId);
        out.push({ kind: 'track-add', step: n, trackId, name: str(step.name) ?? '', channels: num(step.channels) ?? null, key: proposed === 1 ? 'ghost' : `ghost-${proposed}` });
        state.set(`track:${trackId}`, { id: trackId, name: step.name, channels: step.channels, gainMilliDb: 0, pan: 0, mute: false, solo: false });
        return;
      }
      case 'track.remove': {
        if (!trackKnown(trackId)) return;
        out.push({ kind: 'track-remove', step: n, trackId });
        removedTracks.add(trackId);
        // Its clips, under the step entity-homes gives them (this one, as a rule).
        for (const { ref, step: home } of cascadeOf(index, trackId)) {
          const clip = read(ref);
          if (!clip) continue;
          const g = removal(clip, home, ref.slice('clip:'.length), true);
          if (g) out.push(g);
          state.set(ref, null);
        }
        state.set(`track:${trackId}`, null);
        return;
      }
      case 'clip.place': {
        const position = frames(step.position);
        const length = str(step.length);
        const mediaId = str(step.mediaId);
        if (clipId === undefined || !trackKnown(trackId) || position === undefined || length === undefined || mediaId === undefined) return;
        const sourceStart = str(step.sourceStart) ?? '0';
        out.push({ kind: 'clip-place', step: n, clipId, trackId, mediaId, position, sourceStart, length });
        state.set(`clip:${clipId}`, { id: clipId, trackId, mediaId, position: step.position, sourceStart, length });
        return;
      }
      case 'clip.move': {
        const ref = `clip:${clipId}`;
        const clip = clipId !== undefined ? read(ref) : null;
        const position = frames(step.position);
        const from = frames(clip?.position);
        const fromTrackId = str(clip?.trackId);
        const target = trackId ?? fromTrackId;
        if (!clip || clipId === undefined || position === undefined || from === undefined || !trackKnown(fromTrackId) || !trackKnown(target)) return;
        out.push({
          kind: 'clip-move',
          step: n,
          clipId,
          mediaId: str(clip.mediaId) ?? '',
          fromTrackId,
          trackId: target,
          from,
          position,
          sourceStart: str(clip.sourceStart) ?? '0',
          length: str(clip.length) ?? '0',
        });
        state.set(ref, { ...clip, position: step.position, trackId: target });
        return;
      }
      case 'clip.trim': {
        const ref = `clip:${clipId}`;
        const clip = clipId !== undefined ? read(ref) : null;
        const position = frames(clip?.position);
        const sourceStart = str(step.sourceStart);
        const length = str(step.length);
        const owner = str(clip?.trackId);
        if (!clip || clipId === undefined || position === undefined || sourceStart === undefined || length === undefined || !trackKnown(owner)) return;
        out.push({
          kind: 'clip-trim',
          step: n,
          clipId,
          mediaId: str(clip.mediaId) ?? '',
          trackId: owner,
          position,
          from: { sourceStart: str(clip.sourceStart) ?? '0', length: str(clip.length) ?? '0' },
          to: { sourceStart, length },
        });
        state.set(ref, { ...clip, sourceStart, length });
        return;
      }
      case 'clip.remove': {
        const ref = `clip:${clipId}`;
        const clip = clipId !== undefined ? read(ref) : null;
        if (!clip || clipId === undefined) return;
        const g = removal(clip, n, clipId, false);
        if (g && trackKnown(g.trackId)) out.push(g);
        state.set(ref, null);
        return;
      }
      case 'master.set_gain': {
        const after = num(step.gainMilliDb);
        if (after === undefined) return;
        const current = read('master:master');
        out.push({ kind: 'master-gain', step: n, before: num(current?.gainMilliDb) ?? 0, after });
        state.set('master:master', after === 0 ? null : { ...(current ?? { id: 'master' }), gainMilliDb: after });
        return;
      }
      case 'plugin.insert': {
        if (!rackTrack(trackId)) return;
        const ref = `track:${trackId}`;
        const track = read(ref);
        const inserts = insertsOf(track);
        const at = Math.min(Math.max(0, Math.trunc(num(step.index) ?? inserts.length)), inserts.length);
        const descriptor = (step.descriptor ?? {}) as Record<string, unknown>;
        const slotId = str(step.slotId) ?? null;
        out.push({ kind: 'insert-add', step: n, trackId, slotId, name: str(descriptor.name) ?? str(descriptor.uid) ?? '', index: at });
        if (slotId !== null) {
          state.set(ref, { ...track, inserts: [...inserts.slice(0, at), slotId, ...inserts.slice(at)] });
          state.set(`plugin_slot:${slotId}`, { id: slotId, trackId, name: descriptor.name, bypass: false });
        }
        return;
      }
      case 'plugin.remove':
      case 'plugin.set_bypass': {
        const slotId = str(step.slotId);
        const ref = `plugin_slot:${slotId}`;
        const slot = slotId !== undefined ? read(ref) : null;
        const owner = str(slot?.trackId);
        if (!slot || slotId === undefined || !rackTrack(owner)) return;
        if (op === 'plugin.remove') {
          out.push({ kind: 'insert-remove', step: n, trackId: owner, slotId });
          const track = read(`track:${owner}`);
          state.set(`track:${owner}`, { ...track, inserts: insertsOf(track).filter((s) => s !== slotId) });
          state.set(ref, null);
          return;
        }
        const after = bool(step.bypass);
        if (after === undefined) return;
        out.push({ kind: 'insert-bypass', step: n, trackId: owner, slotId, before: bool(slot.bypass) ?? null, after });
        state.set(ref, { ...slot, bypass: after });
        return;
      }
      case 'session.set_locators': {
        const left = str(step.left);
        const right = str(step.right);
        if (left === undefined || right === undefined) return;
        const current = read('locators:locators');
        const old = current && typeof current.left === 'string' && typeof current.right === 'string' ? { left: current.left, right: current.right } : null;
        out.push({ kind: 'locators', step: n, before: old, after: { left, right } });
        state.set('locators:locators', { ...(current ?? {}), left, right });
        return;
      }
      default:
        return;
    }
  });
  return out;
}

function removal(clip: Entity, step: number, clipId: string, cascade: boolean): Extract<Ghost, { kind: 'clip-remove' }> | null {
  const position = frames(clip.position);
  const trackId = str(clip.trackId);
  if (position === undefined || trackId === undefined) return null;
  return {
    kind: 'clip-remove',
    step,
    clipId,
    mediaId: str(clip.mediaId) ?? '',
    trackId,
    position,
    sourceStart: str(clip.sourceStart) ?? '0',
    length: str(clip.length) ?? '0',
    cascade,
  };
}

// The ghosts on one track's header, strip and Inspector rows, by kind.
export interface TrackGhosts {
  readonly gain: ReadonlyArray<Extract<Ghost, { kind: 'gain' }>>;
  readonly pan: ReadonlyArray<Extract<Ghost, { kind: 'pan' }>>;
  readonly mute: ReadonlyArray<Extract<Ghost, { kind: 'mute' }>>;
  readonly solo: ReadonlyArray<Extract<Ghost, { kind: 'solo' }>>;
  readonly rename: ReadonlyArray<Extract<Ghost, { kind: 'rename' }>>;
  readonly remove: Extract<Ghost, { kind: 'track-remove' }> | null;
  // Every step number with a ghost on this track.
  readonly steps: readonly number[];
}

export function trackGhosts(ghosts: readonly Ghost[], trackId: string): TrackGhosts {
  const on = ghosts.filter((g): g is TrackGhost => 'trackId' in g && g.trackId === trackId && (g.kind === 'gain' || g.kind === 'pan' || g.kind === 'mute' || g.kind === 'solo' || g.kind === 'rename' || g.kind === 'track-remove'));
  const of = <K extends TrackGhost['kind']>(kind: K) => on.filter((g): g is TrackGhost & { kind: K } => g.kind === kind);
  return {
    gain: of('gain'),
    pan: of('pan'),
    mute: of('mute'),
    solo: of('solo'),
    rename: of('rename'),
    remove: of('track-remove')[0] ?? null,
    steps: [...new Set(on.map((g) => g.step))],
  };
}

// The slot ghosts of one track's rack and Inspector section, by kind (m5b-ui-inserts-master).
export interface SlotGhosts {
  readonly add: ReadonlyArray<Extract<Ghost, { kind: 'insert-add' }>>;
  readonly remove: ReadonlyArray<Extract<Ghost, { kind: 'insert-remove' }>>;
  readonly bypass: ReadonlyArray<Extract<Ghost, { kind: 'insert-bypass' }>>;
}

export function slotGhosts(ghosts: readonly Ghost[], trackId: string): SlotGhosts {
  const on = <K extends 'insert-add' | 'insert-remove' | 'insert-bypass'>(kind: K) =>
    ghosts.filter((g): g is Extract<Ghost, { kind: K }> => g.kind === kind && (g as { trackId?: string }).trackId === trackId);
  return { add: on('insert-add'), remove: on('insert-remove'), bypass: on('insert-bypass') };
}

// The master fader's ghosts, in step order.
export function masterGhosts(ghosts: readonly Ghost[]): ReadonlyArray<Extract<Ghost, { kind: 'master-gain' }>> {
  return ghosts.filter((g): g is Extract<Ghost, { kind: 'master-gain' }> => g.kind === 'master-gain');
}

const STRIP_KINDS: ReadonlySet<GhostKind> = new Set<GhostKind>(['track-add', 'track-remove', 'gain', 'pan', 'mute', 'solo', 'rename', 'master-gain', 'insert-add', 'insert-remove', 'insert-bypass']);

// Whether a step has a ghost on a MixConsole strip (the target button shows the MixConsole for it).
export function hasStripGhost(ghosts: readonly Ghost[], step: number): boolean {
  return ghosts.some((g) => g.step === step && STRIP_KINDS.has(g.kind));
}
