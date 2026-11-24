// Why a control lost the focus (m5b-ui-notepad; UI redesign 3.4): Escape runs
// focus.zoneRoot in the Shell's capture-phase listener, which moves the focus
// to the zone's frame before the control sees the key, so the control's blur
// arrives first. The Shell marks the element Escape leaves just before it
// moves the focus and clears the mark right after, all inside one
// synchronous call: a blur handler reads the mark (escapedFrom) to tell
// "Escape" (discard) from any other leave (commit). No timer and no
// microtask ordering.

let marked: EventTarget | null = null;

// The element Escape is about to leave.
export function markEscape(target: EventTarget | null): void {
  marked = target;
}

export function clearEscape(): void {
  marked = null;
}

// True when `target` is losing the focus to Escape; reading clears the mark.
export function escapedFrom(target: EventTarget | null): boolean {
  if (target === null || marked !== target) return false;
  marked = null;
  return true;
}
