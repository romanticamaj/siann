// The value controls of the Inspector (UI redesign spec 3.4, 5.1;
// protocol-gestures-v0.md): a fader (gain on the taper) and a pan control,
// laid out horizontally, with the behaviour of every value control
// (value-gesture.ts: a drag is one gesture, Shift is fine, Ctrl-click sets the
// default, an arrow key steps; one revision each). The MixConsole strip's own
// fader and knob are the mockup's markup (Strip.tsx, m5-ui-port-mixer-strip)
// and use the same behaviour; the Inspector's are ported by
// m5-ui-port-inspector. The cap moves with --pos, set in the pointer handler
// during a drag.
//
// ValueReadout is a value as text, TypedValue the field a double-click opens
// to type one (both used by the strip and the Inspector).

import { useRef, useState, type CSSProperties } from 'react';

import type { GestureController } from '../model/gesture-controller';
import { isAboveCap, MINUS_INFINITY_MILLI_DB } from './taper';
import { parseTyped, type ValueKind } from './value-control';
import { commitValue, formatValue, showTooltip, toPosition, useValueGesture } from './value-gesture';

export { commitValue, formatValue, toPosition } from './value-gesture';

export interface ValueControlProps {
  readonly kind: ValueKind;
  readonly orientation: 'vertical' | 'horizontal';
  // The entity the gesture targets ("track:<id>").
  readonly entityRef: string;
  readonly value: number;
  readonly gestures: GestureController;
  readonly testId: string;
  readonly label: string;
  // Given: a double-click on the control types a value into this field.
  readonly typing?: { readonly testId: string; readonly label: string };
  // Shown inside the control (the pan's L35 / C / R40).
  readonly showText?: boolean;
}

export function ValueControl({ kind, orientation, entityRef, value, gestures, testId, label, typing, showText }: ValueControlProps) {
  const control = useRef<HTMLDivElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const position = toPosition(kind, value);
  const text = formatValue(kind, value);
  const warn = kind === 'gain' && isAboveCap(value);
  const handlers = useValueGesture<HTMLDivElement>({
    kind,
    orientation,
    entityRef,
    value,
    gestures,
    travel: () => {
      const el = control.current;
      if (!el) return 1;
      const cap = el.querySelector<HTMLElement>('.fader-cap');
      return orientation === 'vertical' ? el.clientHeight - (cap?.offsetHeight ?? 0) : el.clientWidth - (cap?.offsetWidth ?? 0);
    },
    preview: (_next, at) => control.current?.style.setProperty('--pos', String(at)),
    tooltip: (shown) => showTooltip(tooltip.current, shown),
  });

  if (editing && typing) {
    return <TypedValue kind={kind} initial={text} testId={typing.testId} label={typing.label} onDone={(typed) => {
      setEditing(false);
      if (typed !== null) commitValue(gestures, entityRef, kind, typed);
    }} />;
  }

  const style = { '--pos': String(position) } as CSSProperties;
  return (
    <div className={`value-control value-control-${kind} ${orientation}`}>
      <div
        ref={control}
        role="slider"
        tabIndex={0}
        className={`fader ${orientation}${warn ? ' warn' : ''}`}
        data-testid={testId}
        data-position={String(position)}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuemin={kind === 'gain' ? MINUS_INFINITY_MILLI_DB : -10_000}
        aria-valuemax={kind === 'gain' ? 6000 : 10_000}
        aria-valuenow={value}
        aria-valuetext={text}
        style={style}
        {...handlers}
        onDoubleClick={typing ? () => setEditing(true) : undefined}
      >
        {showText ? <span className="fader-text">{text}</span> : null}
        <span className="fader-cap" aria-hidden="true" />
      </div>
      <span ref={tooltip} className="value-tooltip" data-testid={`${testId}-tooltip`} role="status" hidden />
    </div>
  );
}

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
  // The strip's readout is the mockup's bare span; the Inspector's an output.value-readout.
  readonly bare?: boolean;
}

export function ValueReadout({ kind, entityRef, value, gestures, testId, label, typing, bare }: ValueReadoutProps) {
  const [editing, setEditing] = useState(false);
  const text = formatValue(kind, value);
  if (editing && typing) {
    return <TypedValue kind={kind} initial={text} testId={typing.testId} label={typing.label} onDone={(typed) => {
      setEditing(false);
      if (typed !== null) commitValue(gestures, entityRef, kind, typed);
    }} />;
  }
  const warn = kind === 'gain' && isAboveCap(value);
  const Tag = bare ? 'span' : 'output';
  const className = bare ? (warn ? 'warn' : undefined) : `value-readout${warn ? ' warn' : ''}`;
  return (
    <Tag className={className} data-testid={testId} aria-label={label} onDoubleClick={typing ? () => setEditing(true) : undefined}>
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
