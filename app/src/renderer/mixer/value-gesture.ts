// The pointer and key behaviour of every value control (UI redesign spec 3.4,
// 5.1; protocol-gestures-v0.md), shared by the MixConsole strip's fader
// (.ftrack) and pan knob (m5-ui-port-mixer-strip) and the Inspector's volume
// and pan sliders (.hs, m5-ui-port-inspector):
//
// - a drag is one gesture through the GestureController: it begins on the
//   first move past a 2 px threshold (a click alone sends nothing), each move
//   shows at once (the caller's preview writes the DOM in the pointer handler,
//   before React hears of the move) and goes out as gesture.update, and the
//   release ends it, committing one revision; Shift moves a tenth as far;
// - Ctrl-click (Cmd-click on macOS) sets the default, 0.0 dB or C;
// - an arrow key steps the value (Shift finer, Page Up/Down coarser);
// - each of the last two is a gesture of one move: one revision, the same
//   path as a drag (commitValue).
//
// The control shows the value it is given (the read model's select(), with a
// gesture overlay), so a strip and the Inspector reading the same track agree.
//
// m5b-ui-sends-buses: a send's level is a gain on the levelMilliDb field (the
// gesture target {ref: send:<id>, param: level}), so a control may name its
// field; and a bus's pan, which the gesture protocol does not take, drives
// the same handlers through releaseCommit(): nothing goes out while it is
// dragged, and its last value is one command at release.

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { formatDb, formatPan } from '../format';
import type { GestureController } from '../model/gesture-controller';
import type { GestureField } from '../model/read-model';
import { milliDbToPosition, positionToMilliDb } from './taper';
import { defaultValue, dragTo, panToPosition, positionToPan, startDrag, type Drag, type ValueKind } from './value-control';

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

// What the handlers drive: the GestureController, or releaseCommit()'s stand-in.
export type ValueGestures = Pick<GestureController, 'begin' | 'move' | 'end'>;

// A stand-in for the gesture controller that sends nothing until the end, and
// then its last value through `commit` (a bus's pan: one bus.set_pan).
export function releaseCommit(commit: (value: number) => void): ValueGestures {
  let last: number | null = null;
  return {
    begin: () => {
      last = null;
    },
    move: (value) => {
      last = value;
    },
    end: () => {
      const value = last;
      last = null;
      if (value !== null) commit(value);
    },
  };
}

// A begin, one move and an end: one revision (a keyboard step, a Ctrl-click,
// a typed value). False when the read model refuses (another gesture is held).
export function commitValue(gestures: ValueGestures, ref: string, kind: ValueKind, value: number, field: GestureField = FIELDS[kind]): boolean {
  try {
    gestures.begin(ref, field);
  } catch {
    return false;
  }
  gestures.move(value);
  gestures.end();
  return true;
}

export function keyStep(kind: ValueKind, value: number, key: string, fine: boolean): number | null {
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

export interface ValueGestureOptions {
  readonly kind: ValueKind;
  readonly orientation: 'vertical' | 'horizontal';
  // The entity the gesture targets ("track:<id>").
  readonly entityRef: string;
  readonly value: number;
  readonly gestures: ValueGestures;
  // The gesture's field when it is not the kind's own (a send's levelMilliDb).
  readonly field?: GestureField;
  // The travel of the whole range, in px, measured when a press begins.
  readonly travel: () => number;
  // Shows a value during a drag, in the pointer handler (the cap, the needle).
  readonly preview: (value: number, position: number) => void;
  // The value tooltip's text, or null to hide it.
  readonly tooltip: (text: string | null) => void;
}

export interface ValueGestureHandlers<E extends Element> {
  readonly onPointerDown: (event: PointerEvent<E>) => void;
  readonly onPointerMove: (event: PointerEvent<E>) => void;
  readonly onPointerUp: (event: PointerEvent<E>) => void;
  readonly onPointerCancel: (event: PointerEvent<E>) => void;
  readonly onKeyDown: (event: KeyboardEvent<E>) => void;
}

export function useValueGesture<E extends Element>(options: ValueGestureOptions): ValueGestureHandlers<E> {
  const press = useRef<Press | null>(null);
  const { kind, orientation, entityRef, value, gestures } = options;
  const field = options.field ?? FIELDS[kind];
  // Pixels along the control, increasing toward a higher value.
  const along = (event: { clientX: number; clientY: number }) => (orientation === 'vertical' ? -event.clientY : event.clientX);

  const onPointerDown = (event: PointerEvent<E>) => {
    if (event.button !== 0 || press.current) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      commitValue(gestures, entityRef, kind, defaultValue(kind), field);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const px = along(event);
    press.current = { pointerId: event.pointerId, startPx: px, drag: startDrag(toPosition(kind, value), px, options.travel(), event.shiftKey), began: false, last: value };
  };

  const onPointerMove = (event: PointerEvent<E>) => {
    const current = press.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const px = along(event);
    if (!current.began) {
      if (Math.abs(px - current.startPx) < DRAG_THRESHOLD_PX) return;
      try {
        gestures.begin(entityRef, field);
      } catch {
        press.current = null;
        return;
      }
      current.began = true;
    }
    const step = dragTo(current.drag, px, event.shiftKey);
    current.drag = step.drag;
    const next = fromPosition(kind, step.position);
    // The control follows in this frame, before React hears of the move.
    options.preview(next, toPosition(kind, next));
    options.tooltip(formatValue(kind, next));
    if (next === current.last) return;
    current.last = next;
    gestures.move(next);
  };

  const release = (event: PointerEvent<E>) => {
    const current = press.current;
    if (!current || event.pointerId !== current.pointerId) return;
    press.current = null;
    options.tooltip(null);
    if (current.began) gestures.end();
  };

  const onKeyDown = (event: KeyboardEvent<E>) => {
    const next = keyStep(kind, value, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== value) commitValue(gestures, entityRef, kind, next, field);
  };

  return { onPointerDown, onPointerMove, onPointerUp: release, onPointerCancel: release, onKeyDown };
}

// Writes the tooltip element: its text, or hidden.
export function showTooltip(tip: HTMLElement | null, text: string | null): void {
  if (!tip) return;
  if (text === null) {
    tip.hidden = true;
    return;
  }
  tip.textContent = text;
  tip.hidden = false;
}
