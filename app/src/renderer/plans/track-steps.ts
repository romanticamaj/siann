// The steps of a plan that touch a track (m5b-ui-ghosts; UI redesign 4.4: the
// Inspector's Agent changes lists "which applied plans touched it, and what is
// pending on it"): a step names the track (its own ops, clip.place, the
// target of clip.move, track.remove), or a clip that is on the track when the
// step reaches it (clip.move from it, clip.trim, clip.remove). Where a clip is
// comes from the plan itself (a clip.place or clip.move before the step), else
// from `clipTrack` (the snapshot). A clip the snapshot no longer holds and the
// plan did not place (one an applied plan removed) is not known.

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// The 0-based indexes of the steps of `steps` that touch `trackId`.
export function stepsOnTrack(
  steps: readonly Record<string, unknown>[],
  trackId: string,
  clipTrack: (clipId: string) => string | undefined,
): number[] {
  const owners = new Map<string, string>();
  const owner = (clipId: string) => owners.get(clipId) ?? clipTrack(clipId);
  const out: number[] = [];
  steps.forEach((step, index) => {
    const clipId = str(step.clipId);
    const target = str(step.trackId);
    const from = clipId === undefined ? undefined : owner(clipId);
    if (target === trackId || from === trackId) out.push(index);
    if (clipId !== undefined && target !== undefined && (step.op === 'clip.place' || step.op === 'clip.move')) owners.set(clipId, target);
  });
  return out;
}
