// The renderer's fader gestures (docs/schemas/protocol-gestures-v0.md, "Client
// rules"; spec "Gestures"). One gesture at a time, as the ReadModel holds one
// overlay: begin() opens the overlay and sends gesture.begin; move() shows the
// value at once and sends gesture.update with at most one request in flight
// (moves made meanwhile coalesce into one more update carrying the newest
// value); while the fader is held still gesture.hold renews the lease every
// leaseMs / 2; end() sends one gesture.end carrying the last value. The overlay
// stays after the end until the commit's session.changed applies (ReadModel.
// applyChanged drops an ended overlay when its entity changes). An error
// answer or a disconnect cancels the overlay.
//
// The engine holds one gesture per connection and target and refuses a second
// begin with gesture_open, so a gesture begun before the previous one's end (or
// cancel) is on the wire waits: its overlay shows at once, its begin goes out
// right behind that end. A gesture abandoned while its begin is in flight is
// cancelled once the begin is answered.
//
// Framework-free: the client and the scheduler are injected, as SessionClient's.

import type { GestureField, ReadModel } from './read-model';
import type { ConnectionStatus } from './session-client';

// What the controller needs of a SessionClient.
export interface GestureClient {
  readonly model: ReadModel;
  request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown>;
  getState(): { readonly status: ConnectionStatus };
  subscribe(listener: () => void): () => void;
}

export interface GestureControllerOptions {
  client: GestureClient;
  schedule: (fn: () => void, ms: number) => () => void;
}

export interface GestureTarget {
  readonly ref: string;
  readonly param: 'gain' | 'pan' | 'mute';
}

// The read model's field to the protocol's parameter.
const PARAMS: Readonly<Record<GestureField, GestureTarget['param']>> = { gainMilliDb: 'gain', pan: 'pan' };

// Until gesture.begin answers with the engine's lease.
const DEFAULT_LEASE_MS = 5000;

interface Active {
  readonly target: GestureTarget;
  // The begin is not sent yet: an earlier gesture's end or cancel is not on the wire.
  waiting: boolean;
  // The begin is sent and not answered.
  opening: boolean;
  begun: boolean;
  leaseMs: number;
  inFlight: boolean;
  // A value moved to but not yet sent.
  pending: number | null;
  // end() was called: the last value, or null when the gesture never moved.
  ending: { value: number | null } | null;
  // Nothing more is sent: the end or cancel went out, or the gesture was dropped.
  ended: boolean;
  // Abandoned: no end goes out (a cancel may, once a late begin is answered).
  dropped: boolean;
  // A late begin answer of a dropped gesture is cancelled.
  cancelOnBegin: boolean;
  // Its end or cancel is on the wire, or the engine holds nothing for it.
  released: boolean;
  // The gesture whose begin waits for this one's release.
  next: Active | null;
  hold: (() => void) | null;
}

export class GestureController {
  readonly #client: GestureClient;
  readonly #schedule: GestureControllerOptions['schedule'];
  #active: Active | null = null;
  // The newest gesture not yet released: a new begin waits behind it.
  #tail: Active | null = null;

  constructor(options: GestureControllerOptions) {
    this.#client = options.client;
    this.#schedule = options.schedule;
    options.client.subscribe(() => {
      if (this.#client.getState().status !== 'connected' && this.#active) this.#abandon(this.#active, false);
    });
  }

  // True from begin() until the gesture's end is answered or it is cancelled.
  get active(): boolean {
    return this.#active !== null;
  }

  // True while a gesture is held with nothing in flight and nothing unsent: the
  // engine has accepted the newest value (the e2e tests wait on it).
  get settled(): boolean {
    const active = this.#active;
    return active !== null && active.begun && !active.inFlight && active.pending === null && !active.ending;
  }

  begin(ref: string, field: GestureField): void {
    // An ending gesture keeps going (its end still goes out and is answered);
    // the new overlay replaces its ended one. Any other is abandoned.
    const previous = this.#active;
    if (previous && !previous.ending) this.#abandon(previous, true);
    this.#client.model.beginGesture(ref, field);
    const active: Active = {
      target: { ref, param: PARAMS[field] },
      waiting: true,
      opening: false,
      begun: false,
      leaseMs: DEFAULT_LEASE_MS,
      inFlight: false,
      pending: null,
      ending: null,
      ended: false,
      dropped: false,
      cancelOnBegin: false,
      released: false,
      next: null,
      hold: null,
    };
    this.#active = active;
    const tail = this.#tail;
    this.#tail = active;
    if (tail) tail.next = active;
    else this.#start(active);
  }

  move(value: number): void {
    const active = this.#active;
    if (!active || active.ending) return;
    this.#client.model.setGesture(value);
    active.pending = value;
    this.#pump(active);
  }

  end(): void {
    const active = this.#active;
    if (!active || active.ending) return;
    active.ending = { value: this.#client.model.endGesture() };
    active.pending = null; // the end carries the last value
    this.#pump(active);
  }

  cancel(): void {
    const active = this.#active;
    if (active) this.#abandon(active, true);
  }

  // Sends the begin of a gesture whose predecessor is released.
  #start(active: Active): void {
    active.waiting = false;
    if (active.dropped) {
      this.#release(active); // dropped before anything was sent
      return;
    }
    active.opening = true;
    this.#send(active, 'gesture.begin', { target: active.target }, (result) => {
      active.begun = true;
      const leaseMs = (result as { leaseMs?: unknown } | null)?.leaseMs;
      if (typeof leaseMs === 'number' && leaseMs > 0) active.leaseMs = leaseMs;
      if (active.dropped) {
        // Abandoned while its begin was in flight: the engine opened a lease.
        if (active.cancelOnBegin) this.#sendCancel(active);
        this.#release(active);
      }
    });
  }

  // The engine holds nothing more for this gesture that a begin could collide
  // with: the gesture waiting behind it begins.
  #release(active: Active): void {
    if (active.released) return;
    active.released = true;
    if (this.#tail === active) this.#tail = null;
    const next = active.next;
    active.next = null;
    if (next) this.#start(next);
  }

  // Sends what is due, when nothing is in flight. An ending gesture goes on
  // after a newer one has replaced it.
  #pump(active: Active): void {
    if (active.waiting || active.inFlight || active.ended) return;
    if (active.ending) {
      const params: Record<string, unknown> = { target: active.target };
      if (active.ending.value !== null) params.value = active.ending.value;
      active.ended = true;
      this.#cancelHold(active);
      this.#send(active, 'gesture.end', params, (result) => {
        const revision = (result as { revision?: { diff?: unknown } | null } | null)?.revision;
        const diff = revision && Array.isArray(revision.diff) ? (revision.diff as unknown[]) : [];
        if (this.#active !== active) return; // a newer gesture owns the overlay
        this.#active = null;
        // Nothing committed on this entity: no session.changed will drop the overlay.
        if (!diff.includes(active.target.ref)) this.#dropOverlay(active);
      });
      this.#release(active); // the end is on the wire, ahead of the next begin
      return;
    }
    if (active.pending !== null) {
      const value = active.pending;
      active.pending = null;
      this.#send(active, 'gesture.update', { target: active.target, value });
    }
  }

  #send(active: Active, method: string, params: Record<string, unknown>, done?: (result: unknown) => void): void {
    active.inFlight = true;
    this.#cancelHold(active);
    this.#client.request(method, params).then(
      (result) => {
        active.inFlight = false;
        active.opening = false;
        done?.(result);
        if (active.ended) return;
        this.#scheduleHold(active);
        this.#pump(active);
      },
      () => {
        active.inFlight = false;
        active.opening = false;
        // A refused begin or end left nothing open on the engine; a refused
        // update or hold may have.
        this.#abandon(active, method !== 'gesture.end' && method !== 'gesture.begin');
        if (method === 'gesture.begin') this.#release(active);
      },
    );
  }

  #scheduleHold(active: Active): void {
    if (!active.begun || active.ending || active.hold) return;
    active.hold = this.#schedule(() => {
      active.hold = null;
      if (this.#active !== active || active.ending || active.inFlight) return;
      this.#send(active, 'gesture.hold', { target: active.target });
    }, active.leaseMs / 2);
  }

  #cancelHold(active: Active): void {
    if (active.hold) {
      active.hold();
      active.hold = null;
    }
  }

  #sendCancel(active: Active): void {
    if (this.#client.getState().status !== 'connected') return;
    this.#client.request('gesture.cancel', { target: active.target }).catch(() => undefined);
  }

  // Drops a gesture (and its overlay, when it is the current one); tells the
  // engine when it may still hold it.
  #abandon(active: Active, tellEngine: boolean): void {
    this.#cancelHold(active);
    if (this.#active === active) {
      this.#active = null;
      this.#dropOverlay(active);
    }
    if (active.ended) return;
    active.ended = true;
    active.dropped = true;
    // Nothing sent yet, or the begin's answer still to come: #start or that
    // answer releases it.
    if (active.waiting || active.opening) {
      active.cancelOnBegin = tellEngine;
      return;
    }
    if (tellEngine && active.begun) this.#sendCancel(active);
    this.#release(active);
  }

  #dropOverlay(active: Active): void {
    const gesture = this.#client.model.getView().gesture;
    if (gesture && gesture.ref === active.target.ref && PARAMS[gesture.field] === active.target.param) {
      this.#client.model.cancelGesture();
    }
  }
}
