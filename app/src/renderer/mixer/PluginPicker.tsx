// The plugin picker (m5b-ui-inserts-master; UI redesign 3.4): a modal dialog
// opened from an empty insert slot, over the window as the confirmation
// dialog is. The mockup draws no picker, so this is app-only markup styled by
// shell.css on the existing tokens: a head with the track's name and a close
// button, a search field, the engine's refusal line (its code and message)
// when there is one, and one row per install of plugin.registry with its name
// and format. An approved install is chosen with its row's button; an
// unapproved one reads "Not approved" and has Approve (when the engine lists
// plugin.approve), which asks first in a ConfirmDialog that names the file.
// Its own keydown handler keeps every key from the shell's dispatcher, and
// Escape closes it. State: mixer/picker.ts. While a proposal is heard (the
// side can flip from another connection while the picker is open) a choice is
// held by the edit guard with its reason (m5b-ui-audition; 4.5 C5).
// The approval's confirmation approves only while the engine still lists
// plugin.approve; a reconnect or a session epoch closes it (App.tsx).

import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';

import { useT } from '../i18n/t';
import type { RegistryEntry } from '../model/plugin-actions';
import { useEditGuard } from '../plans/heard-context';
import { useCapabilities } from '../shell/Capable';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { Icon } from '../shell/icons';
import { buttonsListed } from './inserts';
import { fileName, type PickerController } from './picker';

export interface PluginPickerProps {
  readonly picker: PickerController;
  // The name of the track the picker inserts on.
  readonly trackName?: (trackId: string) => string;
  // The name of the bus it inserts on (m5b-ui-sends-buses: a bus strip's rack).
  readonly busName?: (busId: string) => string;
}

// The install's file name, whatever the separators of its path.
export const fileOf = (entry: RegistryEntry) => fileName(entry.path);

export function PluginPicker({ picker, trackName, busName }: PluginPickerProps) {
  const t = useT();
  const can = useCapabilities();
  const guard = useEditGuard();
  const state = useSyncExternalStore(picker.subscribe, picker.getSnapshot, picker.getSnapshot);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (state.open && !el.open) {
      el.showModal();
      search.current?.focus();
    }
    if (!state.open && el.open) el.close();
  }, [state.open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' && state.confirm === null) {
      event.preventDefault();
      picker.close();
    }
  };
  const buttons = buttonsListed(can);
  const visible = picker.visible();
  const owner = state.owner;
  const track = owner === null ? '' : 'trackId' in owner ? (trackName?.(owner.trackId) ?? '') : (busName?.(owner.busId) ?? '');
  const confirm = state.confirm;
  return (
    <dialog
      ref={dialog}
      className="plugin-picker"
      data-testid="plugin-picker"
      aria-labelledby="plugin-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (state.confirm === null) picker.close();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="picker-head">
        <span id="plugin-picker-title" className="picker-title">
          {t('picker.title', { track })}
        </span>
        <button type="button" className="picker-close" data-testid="picker-close" aria-label={t('picker.close')} onClick={() => picker.close()}>
          <Icon name="x" small />
        </button>
      </div>
      <input
        ref={search}
        type="search"
        className="picker-search"
        data-testid="picker-search"
        placeholder={t('picker.search')}
        aria-label={t('picker.search')}
        value={state.query}
        onChange={(event) => picker.search(event.target.value)}
      />
      {state.error ? (
        <p className="picker-error" role="alert" data-testid="picker-error">
          <code>{state.error.code}</code> {state.error.message}
        </p>
      ) : null}
      {state.installs === null ? (
        <p className="picker-empty">{t('picker.loading')}</p>
      ) : visible.length === 0 ? (
        <p className="picker-empty">{t('picker.none')}</p>
      ) : (
        <ul className="picker-list">
          {visible.map((entry) => (
            <li key={`${entry.format}:${entry.path}`} className="picker-row" data-testid="picker-install" data-name={entry.name} data-file={fileOf(entry)} data-path={entry.path}>
              {entry.approved ? (
                <button type="button" className="picker-choose" data-testid="picker-choose" disabled={state.busy || guard !== null} title={guard ?? entry.path} onClick={() => void picker.choose(entry)}>
                  <span className="picker-name">{entry.name}</span>
                  <span className="picker-format">{entry.format.toUpperCase()}</span>
                </button>
              ) : (
                <>
                  <span className="picker-name" title={entry.path}>
                    {entry.name}
                  </span>
                  <span className="picker-format">{entry.format.toUpperCase()}</span>
                  <span className="picker-state">{t('picker.unapproved')}</span>
                  {buttons.approve ? (
                    <button type="button" className="picker-approve" data-testid="picker-approve" disabled={state.busy} onClick={() => picker.askApprove(entry)}>
                      {t('picker.approve')}
                    </button>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm ? (
        <ConfirmDialog
          open
          message={t('picker.approveConfirm', { name: confirm.name, file: confirm.path })}
          confirmLabel={t('picker.approve')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => (buttons.approve ? void picker.confirmApprove() : picker.cancelApprove())}
          onCancel={() => picker.cancelApprove()}
        />
      ) : null}
    </dialog>
  );
}
