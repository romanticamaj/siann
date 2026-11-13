// The value controls of the MixConsole and the Inspector (UI redesign spec
// 3.4, 5.1; protocol-gestures-v0.md): a fader (gain on the taper) and a pan
// control, vertical in a strip or horizontal in the Inspector, with the same
// behaviour everywhere:
//
// - a drag is one gesture through the GestureController: it begins on the
//   first move (a click alone sends nothing), each move shows at once (the
//   cap is moved by setting --pos in the pointer handler, and a tooltip shows
//   the value, written with textContent) and goes out as gesture.update, and
//   the release ends it, committing one revision; Shift moves a tenth as far;
// - Ctrl-click (Cmd-click on macOS) sets the default, 0.0 dB or C;
// - an arrow key steps the value; a double-click on the value (ValueReadout,
//   or the pan control itself) takes a typed one;
// - each of the last three is a gesture of one move: one revision, the same
//   path as a drag.
//
// The control shows the value it is given (the read model's select(), with a
// gesture overlay), so a strip and the Inspector reading the same track agree.

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { formatDb, formatPan } from '../format';
import type { GestureController } from '../model/gesture-controller';
import type { GestureField } from '../model/read-model';
import { isAboveCap, milliDbToPosition, MINUS_INFINITY_MILLI_DB, positionToMilliDb } from './taper';
import { defaultValue, dragTo, panToPosition, parseTyped, positionToPan, startDrag, type Drag, type ValueKind } from './value-control';

const FIELDS: Readonly<Record<ValueKind, GestureField>> = { gain: 'gainMilliDb', pan: 'pan' };
// A pointer must travel this far (px) before a press becomes a drag.
const DRAG_THRESHOLD_PX = 2;

export function formatValue(kind: ValueKind, value: number): string {
  return kind === 'gain' ? formatDb(value) : formatPan(value);
}

export function toPosition(kind: ValueKind, value: number): number {
  return kind === 'gain' ? milliDbToPosition(value) : panToPosition(value);
}

function fromPosition(kind: ValueKind, position: number): number {
  return kind === 'gain' ? positionToMilliDb(position) : positionToPan(position);
}

// A begin, one move and an end: one revision (a keyboard step, a Ctrl-click,
// a typed value). False when the read model refuses (another gesture is held).
export function commitValue(gestures: GestureController, ref: string, kind: ValueKind, value: number): boolean {
  try {
    gestures.begin(ref, FIELDS[kind]);
  } catch {
    return false;
  }
  gestures.move(value);
  gestures.end();
  return true;
}

function keyStep(kind: ValueKind, value: number, key: string, fine: boolean): number | null {
  const sign = key === 'ArrowUp' || key === 'ArrowRight' || key === 'PageUp' ? 1 : key === 'ArrowDown' || key === 'ArrowLeft' || key === 'PageDown' ? -1 : 0;
  if (sign === 0) return null;
  const coarse = key === 'PageUp' || key === 'PageDown';
  if (kind === 'pan') {
    const step = coarse ? 1000 : fine ? 100 : 500;
    return Math.max(-10_000, Math.min(10_000, value + sign * step));
  }
  const step = coarse ? 0.1 : fine ? 0.001 : 0.01;
  const position = Math.max(0, Math.min(1, milliDbToPosition(Math.min(value, 6000)) + sign * step));
  return positionToMilliDb(position);
}

interface Press {
  readonly pointerId: number;
  readonly startPx: number;
  drag: Drag;
  began: boolean;
  last: number;
}

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
  const press = useRef<Press | null>(null);
  const [editing, setEditing] = useState(false);
  const position = toPosition(kind, value);
  const text = formatValue(kind, value);
  const warn = kind === 'gain' && isAboveCap(value);

  // Pixels along the control, increasing toward a higher value.
  const along = (event: { clientX: number; clientY: number }) => (orientation === 'vertical' ? -event.clientY : event.clientX);
  const travel = (): number => {
    const el = control.current;
    if (!el) return 1;
    const cap = el.querySelector<HTMLElement>('.fader-cap');
    return orientation === 'vertical' ? el.clientHeight - (cap?.offsetHeight ?? 0) : el.clientWidth - (cap?.offsetWidth ?? 0);
  };
  const showTooltip = (shown: string | null) => {
    const tip = tooltip.current;
    if (!tip) return;
    if (shown === null) {
      tip.hidden = true;
      return;
    }
    tip.textContent = shown;
    tip.hidden = false;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || press.current) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      commitValue(gestures, entityRef, kind, defaultValue(kind));
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const px = along(event);
    press.current = { pointerId: event.pointerId, startPx: px, drag: startDrag(position, px, travel(), event.shiftKey), began: false, last: value };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const px = along(event);
    if (!current.began) {
      if (Math.abs(px - current.startPx) < DRAG_THRESHOLD_PX) return;
      try {
        gestures.begin(entityRef, FIELDS[kind]);
      } catch {
        press.current = null;
        return;
      }
      current.began = true;
    }
    const step = dragTo(current.drag, px, event.shiftKey);
    current.drag = step.drag;
    const next = fromPosition(kind, step.position);
    // The cap follows in this frame, before React hears of the move.
    control.current?.style.setProperty('--pos', String(toPosition(kind, next)));
    showTooltip(formatValue(kind, next));
    if (next === current.last) return;
    current.last = next;
    gestures.move(next);
  };

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current || event.pointerId !== current.pointerId) return;
    press.current = null;
    showTooltip(null);
    if (current.began) gestures.end();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = keyStep(kind, value, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== value) commitValue(gestures, entityRef, kind, next);
  };

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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
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
}

export function ValueReadout({ kind, entityRef, value, gestures, testId, label, typing }: ValueReadoutProps) {
  const [editing, setEditing] = useState(false);
  const text = formatValue(kind, value);
  if (editing && typing) {
    return <TypedValue kind={kind} initial={text} testId={typing.testId} label={typing.label} onDone={(typed) => {
      setEditing(false);
      if (typed !== null) commitValue(gestures, entityRef, kind, typed);
    }} />;
  }
  const warn = kind === 'gain' && isAboveCap(value);
  return (
    <output
      className={`value-readout${warn ? ' warn' : ''}`}
      data-testid={testId}
      aria-label={label}
      onDoubleClick={typing ? () => setEditing(true) : undefined}
    >
      {text}
    </output>
  );
}

interface TypedValueProps {
  readonly kind: ValueKind;
  readonly initial: string;
  readonly testId: string;
  readonly label: string;
  // The parsed value on Enter, or null (Escape, focus lost, or no parse).
  readonly onDone: (value: number | null) => void;
}

function TypedValue({ kind, initial, testId, label, onDone }: TypedValueProps) {
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
