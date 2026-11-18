// The edit guard (m5b-ui-audition; UI redesign 4.5 C5): while a proposal is
// heard, structural edits are disabled, because command.execute commits onto
// main while the sound is the branch's, until it can target the branch.
// Fader and pan gestures (gesture.*) commit onto the side heard and stay;
// so do the locators, the tempo and undo / redo. One predicate and one
// table, framework-free: every control that sends a structural command, an
// import or record disables itself through them (later features too), with
// the one reason GUARD_REASON words.

export const GUARD_REASON = 'guard.structural' as const;

// True while the side heard is a proposal branch (not main, not unknown).
export function structuralBlocked(heard: string | null): boolean {
  return heard !== null && heard !== 'main';
}

// Track ops sent as commands that change the structure or a value the
// engine commits onto main: add, remove, rename, mute, solo, pan and gain.
const TRACK_OPS = new Set(['track.add', 'track.remove', 'track.rename', 'track.set_mute', 'track.set_solo', 'track.set_pan', 'track.set_gain', 'track.set_input', 'track.set_output']);
const OTHER_OPS = new Set(['media.import', 'transport.record']);

export function isStructural(op: string): boolean {
  if (op.startsWith('clip.') || op.startsWith('marker.')) return true;
  return TRACK_OPS.has(op) || OTHER_OPS.has(op);
}
