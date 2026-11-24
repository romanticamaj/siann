// What a confirmation does when it is confirmed (security review: a dialog
// acts on what it showed). The dialog shows a summary built from one snapshot;
// by the time it is confirmed a proposal may be heard (the edit guard), the
// capabilities may have changed, and the document may have moved. Confirm
// rechecks: not allowed any more, no snapshot, or nothing left to act on
// closes the dialog; a summary rebuilt from the snapshot of now that differs
// from the one shown is asked again (the dialog shows the new one) and sends
// nothing; an unchanged one sends the command built from that snapshot, whose
// revision is its expectedRevision, so the engine refuses it
// (revision_mismatch) if the document moves again before it lands.
// Framework-free.

import type { TimelineCommand } from '../timeline/commands';

export type Recheck<P> =
  | { readonly kind: 'close' }
  | { readonly kind: 'ask'; readonly pending: P }
  | { readonly kind: 'send'; readonly command: TimelineCommand };

export function recheck<P>(
  shown: P,
  current: P | null,
  allowed: boolean,
  same: (a: P, b: P) => boolean,
  build: () => TimelineCommand | null,
): Recheck<P> {
  if (!allowed || current === null) return { kind: 'close' };
  if (!same(shown, current)) return { kind: 'ask', pending: current };
  const command = build();
  return command ? { kind: 'send', command } : { kind: 'close' };
}

export const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
