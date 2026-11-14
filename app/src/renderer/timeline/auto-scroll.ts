// Auto-scroll in page mode (m5-ui-transport; UI redesign spec 3.1, Cubase's
// F): while playing with auto-scroll on, a project cursor that leaves the
// event display turns the page so the cursor is at its left edge; nothing
// moves while stopped, with auto-scroll off or while a drag is held (spec:
// "suspended while editing"). The decision only, pure: TimelineCanvas applies
// it in its overlay frame. Frames are decimal strings and BigInt, as in
// geometry.ts.

export interface AutoScrollInput {
  readonly view: { readonly scrollFrames: string; readonly framesPerPixel: number; readonly width: number };
  // The project cursor's frame, or null without a playhead.
  readonly cursor: string | null;
  readonly playing: boolean;
  readonly enabled: boolean;
  readonly dragging: boolean;
}

// The view's next scrollFrames, or null to leave it.
export function nextScroll(input: AutoScrollInput): string | null {
  if (!input.enabled || !input.playing || input.dragging || input.cursor === null) return null;
  if (!/^-?\d+$/.test(input.cursor)) return null;
  const cursor = BigInt(input.cursor);
  const left = BigInt(input.view.scrollFrames);
  const width = BigInt(Math.max(1, Math.round(input.view.width * input.view.framesPerPixel)));
  if (cursor >= left && cursor < left + width) return null;
  // Forward past the right edge, or back before the left (a locate, a
  // cycle's wrap): the page that starts at the cursor.
  const next = cursor < 0n ? 0n : cursor;
  return next === left ? null : next.toString();
}
