// Where each row of a plan's diff is shown on the card (m5-ui-port-plans; UI
// redesign 10.10, P1-13 notes, c; the architecture spec's "Frontend", plan
// review: the selected plan shows its steps and the diff against the current
// revision, every entity of plan.preview). A row belongs to a step's
// disclosure in this order:
//
//   1. every step that names the row's ref (refsOf: the step's own target,
//      and the root for track.add, track.remove and session.*), as two steps
//      on one track both show the track;
//   2. else the first step whose ids appear in what the row changes: the
//      ref's own id, the whole entity of an added or removed row, the changed
//      fields of a modified one. That is how a cascade lands under the step
//      that causes it (track.remove's clips, plugin slots and sends carry the
//      track's id; plugin.remove's track lists the slot in its inserts);
//   3. else the card's "Other changes" row, so no entity of the preview, and
//      no stale mark on one, is ever left out of the card.
//
// Pure: indexes into the rows, nothing rendered.

import type { DiffRow } from './diff';

// The refs a step changes, as plan.preview names its entities.
export function refsOf(step: Record<string, unknown>): string[] {
  const id = (field: string) => (typeof step[field] === 'string' ? (step[field] as string) : undefined);
  const out: string[] = [];
  const op = typeof step.op === 'string' ? step.op : '';
  if (op.startsWith('track.') && id('trackId')) out.push(`track:${id('trackId')}`);
  if (op === 'track.add' || op === 'track.remove' || op.startsWith('session.')) out.push('root:root');
  if (op.startsWith('clip.') && id('clipId')) out.push(`clip:${id('clipId')}`);
  if (op.startsWith('media.') && id('mediaId')) out.push(`media:${id('mediaId')}`);
  if (op.startsWith('plugin.') && id('slotId')) out.push(`plugin_slot:${id('slotId')}`);
  if (op === 'plugin.insert' && id('trackId')) out.push(`track:${id('trackId')}`);
  if (op.startsWith('bus.') && id('busId')) out.push(`bus:${id('busId')}`);
  if (op.startsWith('send.') && id('sendId')) out.push(`send:${id('sendId')}`);
  if (op.startsWith('master.')) out.push('master:master');
  if (op.startsWith('locators.')) out.push('locators:locators');
  return out;
}

// The entity ids a step names: every string field whose key ends in "Id".
export function idsOf(step: Record<string, unknown>): string[] {
  return Object.entries(step)
    .filter(([key, value]) => /Id$/.test(key) && typeof value === 'string' && value !== '')
    .map(([, value]) => value as string);
}

function stringsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out);
}

// The ids a row's change can name: its ref's id and the values it changes.
function changedIds(row: DiffRow): Set<string> {
  const out = new Set<string>([row.ref.slice(row.ref.indexOf(':') + 1)]);
  if (row.kind === 'modified') for (const change of row.changes) stringsIn([change.before, change.after], out);
  else stringsIn([row.before, row.after], out);
  return out;
}

export interface EntityHomes {
  // Per step, the indexes of the rows under its disclosure, in diff order.
  // A row named by several steps is under each of them.
  readonly steps: readonly (readonly number[])[];
  // The rows no step names or causes, for the card's "Other changes" row.
  readonly rest: readonly number[];
}

export function entityHomes(steps: ReadonlyArray<Record<string, unknown>>, rows: readonly DiffRow[]): EntityHomes {
  const refs = steps.map(refsOf);
  const ids = steps.map(idsOf);
  const byStep: number[][] = steps.map(() => []);
  const rest: number[] = [];
  rows.forEach((row, at) => {
    let named = false;
    refs.forEach((list, step) => {
      if (list.includes(row.ref)) {
        byStep[step]!.push(at);
        named = true;
      }
    });
    if (named) return;
    const changed = changedIds(row);
    const home = ids.findIndex((list) => list.some((id) => changed.has(id)));
    if (home < 0) rest.push(at);
    else byStep[home]!.push(at);
  });
  return { steps: byStep, rest };
}
