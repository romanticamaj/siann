// Ghosts while the proposal is heard (m5b-ui-audition; UI redesign 4.3):
// a pure function of the plan's ghosts (plans/ghosts.ts, the dashed ghosts of
// plan.preview), the branch snapshot (model/branch-snapshot.ts) and main's
// snapshot. With the snapshot every ghost is solid (what is playing): its new
// value is the branch entity's where the snapshot holds it, else the step's,
// and `replaced` is main's value, drawn as the faint outline. A gain, pan,
// mute or solo of a track main and the snapshot both hold that differs from
// main and that no ghost names (a gesture made while the proposal is heard)
// is a solid ghost of step 0, without a number. Without a snapshot the ghosts
// come back as they are.

import type { BranchSnapshot } from '../model/branch-snapshot';
import type { Snapshot } from '../model/read-model';
import type { Ghost } from './ghosts';

type Entity = Readonly<Record<string, unknown>>;

const FIELDS = { gain: 'gainMilliDb', pan: 'pan', mute: 'mute', solo: 'solo' } as const;
type ValueKind = keyof typeof FIELDS;

function value(entity: Entity | null | undefined, field: string): number | boolean | undefined {
  const v = entity?.[field];
  return typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}

export function heardGhosts(ghosts: readonly Ghost[], branch: BranchSnapshot | null, main: Snapshot | null): readonly Ghost[] {
  if (!branch) return ghosts;
  const fromBranch = (ref: string): Entity | null | undefined => branch.entities.get(ref);
  const fromMain = (ref: string): Entity | undefined => main?.entities[ref] as Entity | undefined;
  const out: Ghost[] = ghosts.map((g): Ghost => {
    switch (g.kind) {
      case 'gain':
      case 'pan':
      case 'mute':
      case 'solo': {
        const ref = `track:${g.trackId}`;
        const field = FIELDS[g.kind];
        const after = value(fromBranch(ref), field) ?? g.after;
        const replaced = value(fromMain(ref), field) ?? g.before;
        return { ...g, after, mode: 'solid', replaced } as Ghost;
      }
      case 'rename': {
        const ref = `track:${g.trackId}`;
        const name = fromBranch(ref)?.name;
        const was = fromMain(ref)?.name;
        return { ...g, after: typeof name === 'string' ? name : g.after, mode: 'solid', replaced: typeof was === 'string' ? was : g.before };
      }
      case 'clip-place':
      case 'clip-move': {
        const clip = fromBranch(`clip:${g.clipId}`);
        const position = (clip?.position as { domain?: unknown; value?: unknown } | undefined)?.value;
        const trackId = clip?.trackId;
        return {
          ...g,
          ...(typeof position === 'string' ? { position } : {}),
          ...(typeof trackId === 'string' ? { trackId } : {}),
          mode: 'solid',
        } as Ghost;
      }
      default:
        return { ...g, mode: 'solid' };
    }
  });
  // The values no ghost names: a gesture's, on a track main holds too.
  const named = new Set(out.filter((g) => g.kind in FIELDS).map((g) => `${(g as { trackId: string }).trackId} ${g.kind}`));
  for (const [ref, entity] of branch.entities) {
    if (!ref.startsWith('track:') || !entity) continue;
    const before = fromMain(ref);
    if (!before) continue;
    const trackId = ref.slice('track:'.length);
    for (const kind of Object.keys(FIELDS) as ValueKind[]) {
      if (named.has(`${trackId} ${kind}`)) continue;
      const now = value(entity, FIELDS[kind]);
      const was = value(before, FIELDS[kind]);
      if (now === undefined || was === undefined || now === was) continue;
      out.push({ kind, step: 0, trackId, before: was, after: now, mode: 'solid', replaced: was } as Ghost);
    }
  }
  return out;
}
