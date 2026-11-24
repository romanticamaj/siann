// The Inspector's Notepad section (m5b-ui-notepad, UR-17; UI redesign 3.4,
// 10.11 item 24), ported from the mockup's sec('Notepad',''): div.sec, .shut
// while closed, with its head div.sec-h (the chevron, the title, an empty
// span) styled by ui/left-zone.css. The head is a toggle: role=button,
// tabindex 0 and aria-expanded are added to the mockup's markup, and a click,
// Enter or Space opens or closes it (the Shell keeps the state in
// siann.layout.v1). Open, .sec-b holds the text area with the selected
// track's notes, then the refusal line and the "changed elsewhere" line when
// there is something to say; the mockup draws no open state, so these are
// app-only shell.css rules on existing tokens.
//
// The drafts are notepad.ts's store: a leave of the area (a click elsewhere,
// Tab, F6) or Mod+Enter (Ctrl+Enter; Cmd+Return on macOS, handled here and
// not by a preset binding) commits one track.set_notes for the track the
// draft belongs to; Escape discards it. The Shell's capture listener runs
// Escape's focus.zoneRoot before the area sees the key, so the blur it causes
// is told apart by keys/escape-intent.ts. Keys of an input-method composition
// are the input method's. While a proposal is heard (useEditGuard) the area
// is read-only with the guard's reason and sends nothing; a draft is kept.

import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';

import { useLocale, useT } from '../i18n/t';
import { CANCEL_CHORD, currentPlatform, formatChord } from '../keys/chord-label';
import { composingKey, platformOf } from '../keys/dispatcher';
import { escapedFrom } from '../keys/escape-intent';
import type { TrackEntity } from '../model/document';
import { namesFromSnapshot } from '../plans/describe';
import { useEditGuard } from '../plans/heard-context';
import { RefusalLine } from '../plans/RefusalLine';
import { Icon } from './icons';
import { draftOf, textOf, type NotepadStore } from './notepad';

const NO_NAMES = namesFromSnapshot(null);

export interface NotepadProps {
  readonly track: TrackEntity;
  readonly store: NotepadStore;
  readonly open: boolean;
  readonly onToggle: () => void;
}

// Mod+Enter: Ctrl+Enter, Cmd+Return on macOS, without Alt or Shift.
function isCommitKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false;
  const mac = typeof navigator !== 'undefined' && platformOf(navigator.platform) === 'mac';
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function Notepad({ track, store, open, onToggle }: NotepadProps) {
  const t = useT();
  const locale = useLocale();
  const guard = useEditGuard();
  const state = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  const area = useRef<HTMLTextAreaElement | null>(null);
  // The track whose draft the focused area holds.
  const editing = useRef<string | null>(null);
  const entry = draftOf(state, track.id);

  // The selection moved while the area had the focus: the draft is the old track's.
  useEffect(() => {
    const was = editing.current;
    if (was !== null && was !== track.id) {
      store.commit(was);
      editing.current = typeof document !== 'undefined' && document.activeElement === area.current ? track.id : null;
    }
  }, [store, track.id]);

  const head = (
    <div
      className="sec-h"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (composingKey(event.nativeEvent)) return;
        event.preventDefault();
        onToggle();
      }}
    >
      <Icon name="chev" small />
      {t('inspector.notepad')}
      <span />
    </div>
  );
  if (!open) {
    return (
      <div className="sec shut" data-part="inspector-notepad">
        {head}
      </div>
    );
  }
  return (
    <div className="sec" data-part="inspector-notepad">
      {head}
      <div className="sec-b">
        <textarea
          ref={area}
          className="notepad-text"
          data-testid="notepad-text"
          aria-label={t('notepad.label', { track: track.name })}
          value={textOf(state, track.id)}
          readOnly={guard !== null}
          title={guard ?? undefined}
          spellCheck={false}
          onChange={(event) => store.typed(track.id, event.target.value)}
          onFocus={() => {
            editing.current = track.id;
          }}
          onBlur={(event) => {
            const id = editing.current ?? track.id;
            editing.current = null;
            if (escapedFrom(event.currentTarget)) store.discard(id);
            else store.commit(id);
          }}
          onKeyDown={(event) => {
            if (composingKey(event.nativeEvent)) return;
            if (event.key === 'Escape') {
              // Without the Shell (a zone rendered alone) the key reaches the area itself.
              store.discard(editing.current ?? track.id);
              return;
            }
            if (!isCommitKey(event)) return;
            event.preventDefault();
            store.commit(editing.current ?? track.id);
            // The focus goes back to the left zone, as Escape's does; the blur sends nothing more.
            event.currentTarget.closest<HTMLElement>('[data-zone]')?.focus({ preventScroll: true });
          }}
        />
        {entry?.refusal ? <RefusalLine refusal={entry.refusal} locale={locale} names={NO_NAMES} testId="notepad-refusal" className="notepad-refusal" role="status" /> : null}
        {entry?.changedElsewhere ? (
          <div className="notepad-changed" data-testid="notepad-changed" role="status">
            {t('notepad.changedElsewhere', { key: formatChord(CANCEL_CHORD, currentPlatform()) })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
