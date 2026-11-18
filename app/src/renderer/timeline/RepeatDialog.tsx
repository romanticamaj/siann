// Ctrl+K's count (m5b-ui-edit-more; UI redesign spec 3.2, "Editing"): the
// confirmation dialog's chrome (ConfirmDialog, shell.css's .confirm-dialog)
// with a labelled number field, 1 to MAX_REPEAT, focused and selected when it
// opens. Enter or Repeat confirms a whole count in range, Cancel or Escape
// closes; its keydown handler keeps every key from the shell's dispatcher.
// The mockup has no such dialog: it is the app's own, from the shell's rules.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../i18n/t';
import { MAX_REPEAT } from './edit-commands';

export interface RepeatDialogProps {
  readonly open: boolean;
  readonly onConfirm: (count: number) => void;
  readonly onCancel: () => void;
}

// A count typed into the field, or null when it is not a whole number in range.
export function repeatCount(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const count = Number(text);
  return count >= 1 && count <= MAX_REPEAT ? count : null;
}

export function RepeatDialog({ open, onConfirm, onCancel }: RepeatDialogProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('1');
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setText('1');
      dialog.showModal();
      field.current?.focus();
      field.current?.select();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const count = repeatCount(text);
  const confirm = () => {
    if (count !== null) onConfirm(count);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.target as Element | null)?.tagName !== 'BUTTON') {
      event.preventDefault();
      confirm();
    }
  };
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      data-testid="repeat-dialog"
      aria-labelledby="repeat-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <p id="repeat-dialog-title" className="confirm-dialog-message">
        {t('repeat.title')}
      </p>
      <label className="repeat-dialog-field">
        {t('repeat.count')}
        <input
          ref={field}
          type="number"
          min={1}
          max={MAX_REPEAT}
          step={1}
          inputMode="numeric"
          data-testid="repeat-count"
          value={text}
          aria-invalid={count === null}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="confirm-dialog-buttons">
        <button type="button" data-testid="repeat-cancel" onClick={onCancel}>
          {t('confirm.cancel')}
        </button>
        <button type="button" data-testid="repeat-ok" disabled={count === null} onClick={confirm}>
          {t('repeat.confirm')}
        </button>
      </div>
    </dialog>
  );
}
