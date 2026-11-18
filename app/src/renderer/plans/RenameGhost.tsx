// Both names of a pending rename (m5b-ui-ghosts; UI redesign 4.2, "Header
// shows `FX → FX Riser`", "Name shows both"), as the track header, the
// MixConsole's name tag and the Inspector's name draw it: one element, so a
// grid parent (.nametag) lays it out as one item on one line, holding the old
// name, the arrow and the new name each in its own span. shell.css lets the
// old name give way first where the two do not fit, so the new name, the
// change under review, is the last to be cut; the caller's title carries both.
// An element the mockup has no markup for.

import { ghostAttrs, type GhostView } from './ghost-context';

export function RenameGhost({ before, after, step, view }: { before: string; after: string; step: number; view: GhostView }) {
  return (
    <span className="ghost-rename" {...ghostAttrs(view, [step])}>
      <span className="ghost-was">{before}</span>
      <span className="ghost-arrow">{' → '}</span>
      <span className="ghost-name">{after}</span>
    </span>
  );
}

// The title of a name with a pending rename: both names.
export const renameTitle = (before: string, after: string | undefined): string => (after === undefined ? before : `${before} → ${after}`);
