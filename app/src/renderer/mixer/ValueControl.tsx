// A value as text (ValueReadout) and the field a double-click opens to type
// one (TypedValue), used by the MixConsole strip's readout and pan row and by
// the Inspector's volume and pan rows (UI redesign spec 3.4). The sliders
// themselves are the mockup's markup: the strip's .ftrack and knob (Strip.tsx)
// and the Inspector's .hs (Inspector.tsx), all on value-gesture.ts.

import { useRef, useState } from 'react';

import type { GestureController } from '../model/gesture-controller';
import { isAboveCap } from './taper';
import { parseTyped, type ValueKind } from './value-control';
import { commitValue, formatValue } from './value-gesture';

export { commitValue, formatValue, toPosition } from './value-gesture';

// A value as text; a double-click types a new one (the fader's level value).
export interface ValueReadoutProps {
  readonly kind: ValueKind;
  readonly entityRef: string;
  readonly value: number;
  readonly gestures: GestureController;
  readonly testId: string;
  readonly label: string;
  // Absent: the value is shown and cannot be typed (the command is not listed).
  readonly typing?: { readonly testId: string; readonly label: string };
  // The element and its class: the strip's readout is the mockup's bare span,
  // the Inspector's value its b.num.
  readonly tag?: 'span' | 'b';
  readonly className?: string;
}

export function ValueReadout({ kind, entityRef, value, gestures, testId, label, typing, tag: Tag = 'span', className }: ValueReadoutProps) {
  const [editing, setEditing] = useState(false);
  const text = formatValue(kind, value);
  if (editing && typing) {
    return <TypedValue kind={kind} initial={text} testId={typing.testId} label={typing.label} onDone={(typed) => {
      setEditing(false);
      if (typed !== null) commitValue(gestures, entityRef, kind, typed);
    }} />;
  }
  const warn = kind === 'gain' && isAboveCap(value);
  const classes = [className, warn ? 'warn' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <Tag className={classes} data-testid={testId} aria-label={label} onDoubleClick={typing ? () => setEditing(true) : undefined}>
      {text}
    </Tag>
  );
}

export interface TypedValueProps {
  readonly kind: ValueKind;
  readonly initial: string;
  readonly testId: string;
  readonly label: string;
  // The parsed value on Enter, or null (Escape, focus lost, or no parse).
  readonly onDone: (value: number | null) => void;
}

export function TypedValue({ kind, initial, testId, label, onDone }: TypedValueProps) {
  const done = useRef(false);
  const finish = (value: number | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      type="text"
      className="value-input"
      data-testid={testId}
      aria-label={label}
      defaultValue={initial}
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(parseTyped(kind, event.currentTarget.value));
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(null)}
    />
  );
}
