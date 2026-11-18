// The editing clipboard (m5b-ui-edit-more; UI redesign spec 3.2, "Editing"):
// the clips Ctrl+C or Ctrl+X last copied, as the pure value copyClips builds
// (edit-commands.ts), for Ctrl+V and Alt+V to place. In memory and in the
// renderer only: it is not the system clipboard, so a copy in a text field
// keeps its own meaning, and a reload starts empty. Framework-free.

import type { ClipboardContent } from './edit-commands';

export class Clipboard {
  #content: ClipboardContent | null = null;

  get(): ClipboardContent | null {
    return this.#content;
  }

  set(content: ClipboardContent | null): void {
    this.#content = content;
  }
}

// The window's clipboard: one per renderer, shared by every timeline it mounts.
export const CLIPBOARD = new Clipboard();
