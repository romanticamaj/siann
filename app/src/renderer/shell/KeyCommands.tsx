// The Key Commands list (m5b-ui-keymap; UI redesign 3.6, UR-11; tour state
// 39): Help > Key Commands. A modal <dialog> on the About panel's chrome
// (shell.css, existing tokens only; the mockup has no such dialog): its
// title, a search field, then every command of COMMAND_IDS once, grouped by
// category (keys/command-names.ts), each row the command's name from the
// catalogs and its keys from the preset written for the platform
// (keys/chord-label.ts), a command without a key with an empty key cell.
// The search narrows the list by name or by key, as written; an empty result
// says so. Read-only: no row is a control and nothing rebinds a key (the
// key-command editor is phase 3). Escape, the dialog's cancel and Close
// close it; the search field has the focus when it opens. Closed, the
// dialog element is empty.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../i18n/t';
import { currentPlatform, type Platform } from '../keys/chord-label';
import { keyCommandGroups } from '../keys/command-names';

export interface KeyCommandsProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly platform?: Platform;
  // The search's text when the list opens (unit tests; the list opens empty).
  readonly initialQuery?: string;
}

export function KeyCommands({ open, onClose, platform = currentPlatform(), initialQuery = '' }: KeyCommandsProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery(initialQuery);
      dialog.showModal();
      search.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialQuery]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  // Built while open only: closed, the dialog holds nothing (no hidden rows in the DOM).
  const groups = open ? keyCommandGroups(t, platform, query) : [];
  return (
    <dialog
      className="key-commands"
      data-testid="key-commands"
      aria-labelledby="key-commands-title"
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {open ? (
        <>
          <h2 id="key-commands-title">{t('keys.title')}</h2>
          <input
            type="search"
            className="key-commands-search"
            data-testid="key-commands-search"
            aria-label={t('keys.search')}
            placeholder={t('keys.search')}
            spellCheck={false}
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="key-commands-list" data-testid="key-commands-list">
            {groups.length === 0 ? (
              <p className="key-commands-none" data-testid="key-commands-none">
                {t('keys.none')}
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.category} aria-labelledby={`key-commands-${group.category}`}>
                  <h3 id={`key-commands-${group.category}`}>{group.label}</h3>
                  <table>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={row.commandId} data-command={row.commandId}>
                          <th scope="row">{row.name}</th>
                          <td className="keys">
                            {row.keys.map((key) => (
                              <kbd key={key}>{key}</kbd>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}
          </div>
          <div className="confirm-dialog-buttons">
            <button type="button" data-testid="key-commands-close" onClick={onClose}>
              {t('keys.close')}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
