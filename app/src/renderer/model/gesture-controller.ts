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
  begun: boolean;
  leaseMs: number;
  inFlight: boolean;
  // A value moved to but not yet sent.
  pending: number | null;
  // end() was called: the last value, or null when the gesture never moved.
  ending: { value: number | null } | null;
  ended: boolean;
  hold: (() => void) | null;
}

export class GestureController {
  readonly #client: GestureClient;
  readonly #schedule: GestureControllerOptions['schedule'];
  #active: Active | null = null;

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
    // A gesture still waiting for its end's answer keeps going; the new
    // overlay replaces its ended one.
    if (this.#active && !this.#active.ended) this.#abandon(this.#active, true);
    this.#client.model.beginGesture(ref, field);
    const active: Active = {
      target: { ref, param: PARAMS[field] },
      begun: false,
      leaseMs: DEFAULT_LEASE_MS,
      inFlight: true,
      pending: null,
      ending: null,
      ended: false,
      hold: null,
    };
    this.#active = active;
    this.#send(active, 'gesture.begin', { target: active.target }, (result) => {
      active.begun = true;
      const leaseMs = (result as { leaseMs?: unknown } | null)?.leaseMs;
      if (typeof leaseMs === 'number' && leaseMs > 0) active.leaseMs = leaseMs;
    });
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

  // Sends what is due, when nothing is in flight.
  #pump(active: Active): void {
    if (this.#active !== active || active.inFlight || active.ended) return;
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
        done?.(result);
        if (this.#active !== active) return;
        this.#scheduleHold(active);
        this.#pump(active);
      },
      () => {
        active.inFlight = false;
        // A refused begin or end left nothing open on the engine; a refused
        // update or hold may have.
        if (this.#active === active) this.#abandon(active, method !== 'gesture.end' && method !== 'gesture.begin');
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

  // Drops the current gesture and its overlay; tells the engine when it may
  // still hold it.
  #abandon(active: Active, tellEngine: boolean): void {
    this.#cancelHold(active);
    if (this.#active !== active) return;
    this.#active = null;
    this.#dropOverlay(active);
    if (tellEngine && active.begun && !active.ended && this.#client.getState().status === 'connected') {
      active.ended = true;
      this.#client.request('gesture.cancel', { target: active.target }).catch(() => undefined);
    }
    active.ended = true;
  }

  #dropOverlay(active: Active): void {
    const gesture = this.#client.model.getView().gesture;
    if (gesture && gesture.ref === active.target.ref && PARAMS[gesture.field] === active.target.param) {
      this.#client.model.cancelGesture();
    }
  }
}
