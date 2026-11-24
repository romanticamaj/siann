// The info line (m5-ui-port-toolbar; UI redesign spec 3.2, "Info line",
// 10.8 and 10.9), ported from the mockup's app.innerHTML template
// (mockup.html, div.infoline): one span.f per field, the name first (the
// track's colour in <i>, the clip's title in <b>), then start, end, length,
// offset and volume, each its label and b.num, styled by
// ui/project-zone.css, then Fade In and Fade Out (m5b-ui-fades), the same
// span.f, while the engine lists features.clipFades and clip.set_fade; on an
// engine without them neither is rendered and no box replaces them, since
// they end the line (spec 3.0). The values are info-line.ts's. With no clip
// selected the line holds nothing between its edges. data-clip names the
// selected clip for the e2e.
//
// Editing (m5b-ui-edit-more; spec 3.2, "Info line"): with an edit handler,
// start, length, offset and volume (and the fade fields) take the focus; a click (or Enter) puts a
// text field inside their b.num holding the value, the template's structure
// otherwise unchanged; Enter applies it relatively to the selection, Mod+Enter
// absolutely, Escape or leaving the field cancels (infoLineEditCommand turns
// it into one command list). End stays read-only.

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import { useT, type MessageKey } from '../i18n/t';
import type { SessionClient } from '../model/session-client';
import { useCapabilities } from '../shell/Capable';
import { infoLine, type InfoField, type InfoLineValues } from './info-line';

type ValueField = Exclude<keyof InfoLineValues, 'name' | 'colour'>;

// The value fields in the template's order: the part id, the value and its label.
const FIELDS: ReadonlyArray<readonly [string, ValueField, MessageKey]> = [
  ['info-start', 'start', 'info.start'],
  ['info-end', 'end', 'info.end'],
  ['info-length', 'length', 'info.length'],
  ['info-offset', 'offset', 'info.offset'],
  ['info-volume', 'volume', 'info.volume'],
];
// The fade fields (m5b-ui-fades), last in the template.
const FADE_FIELDS: ReadonlyArray<readonly [string, ValueField, MessageKey]> = [
  ['info-fade-in', 'fadeIn', 'info.fadeIn'],
  ['info-fade-out', 'fadeOut', 'info.fadeOut'],
];

const EDITABLE: ReadonlySet<ValueField> = new Set<ValueField>(['start', 'length', 'offset', 'volume', 'fadeIn', 'fadeOut']);

export interface InfoLineProps {
  readonly client: SessionClient;
  // The primary selected clip: the one whose values the line shows.
  readonly clipId: string | null;
  // Every selected clip (an edit applies to all of them).
  readonly selection?: readonly string[];
  // A typed value committed: relative, or absolute with Mod. Absent: read-only.
  readonly onEdit?: (field: InfoField, text: string, absolute: boolean) => void;
}

export function InfoLine({ client, clipId, onEdit }: InfoLineProps) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const [editing, setEditing] = useState<ValueField | null>(null);
  const can = useCapabilities();
  const fades = can.feature('clipFades') && can.command('clip.set_fade');
  const values = infoLine(snapshot, clipId);
  // A new primary clip (or none) ends an edit.
  useEffect(() => setEditing(null), [clipId]);
  return (
    <div className="infoline" data-testid="info-line" data-part="info-line" data-clip={values ? (clipId ?? '') : ''} aria-label={t('info.label')}>
      {values ? (
        <>
          <span className="f" data-part="info-name">
            <i style={{ background: `var(${values.colour})` }} />
            <b data-testid="info-name" dir="auto">
              {values.name}
            </b>
          </span>
          {(fades ? [...FIELDS, ...FADE_FIELDS] : FIELDS).map(([part, field, label]) => (
            <InfoValueField
              key={part}
              part={part}
              label={t(label)}
              value={values[field]}
              editable={onEdit !== undefined && EDITABLE.has(field)}
              editing={editing === field}
              onBegin={() => setEditing(field)}
              onCommit={(text, absolute) => {
                setEditing(null);
                onEdit?.(field as InfoField, text, absolute);
              }}
              onCancel={() => setEditing(null)}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

export interface InfoValueFieldProps {
  readonly part: string;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly editing: boolean;
  readonly onBegin: () => void;
  readonly onCommit: (text: string, absolute: boolean) => void;
  readonly onCancel: () => void;
}

// One value field: span.f with its label and b.num; while edited, a text
// field inside b.num.
export function InfoValueField({ part, label, value, editable, editing, onBegin, onCommit, onCancel }: InfoValueFieldProps) {
  const t = useT();
  const input = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!editing) return;
    done.current = false;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'NumpadEnter') {
      event.preventDefault();
      event.stopPropagation();
      done.current = true;
      onCommit(event.currentTarget.value, event.ctrlKey || event.metaKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      done.current = true;
      onCancel();
    }
  };
  const editableProps = editable
    ? {
        tabIndex: 0,
        'data-editable': 'true',
        'aria-label': label,
        title: t('info.editHint'),
        onClick: () => {
          if (!editing) onBegin();
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          if (editing || event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          onBegin();
        },
      }
    : {};
  return (
    <span className="f" data-part={part}>
      {label}
      <b className="num" data-testid={part} {...editableProps}>
        {editable && editing ? (
          <input
            ref={input}
            type="text"
            className="info-edit"
            data-testid={`${part}-input`}
            aria-label={label}
            defaultValue={value}
            size={Math.max(4, value.length)}
            spellCheck={false}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!done.current) onCancel();
            }}
          />
        ) : (
          value
        )}
      </b>
    </span>
  );
}
