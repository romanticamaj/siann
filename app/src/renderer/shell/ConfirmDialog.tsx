// A confirmation before a destructive action (UI redesign spec 3.3: Shift+
// Delete removes the selected tracks "with confirmation"; m5-ui-edit-basics).
// A modal <dialog> with role alertdialog: the message, then Cancel (focused
// first, so Enter alone never removes anything) and the action. Its own
// keydown handler keeps every key from the shell's dispatcher, as the About
// panel's does, and Escape cancels. All text comes from the catalogs.

import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({ open, message, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancel.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      data-testid="confirm-dialog"
      role="alertdialog"
      aria-describedby="confirm-dialog-message"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <p id="confirm-dialog-message" className="confirm-dialog-message">
        {message}
      </p>
      <div className="confirm-dialog-buttons">
        <button type="button" ref={cancel} data-testid="confirm-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="danger" data-testid="confirm-ok" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
