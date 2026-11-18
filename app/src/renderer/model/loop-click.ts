// Locators, cycle and metronome over the session client (m5-ui-loop-click; UI
// redesign spec 3.1, 3.2; docs/schemas/protocol-engine-v0.md, "Cycle and
// click"; protocol-events-v1.md, "transport.changed").
//
// - TransportStateStore holds what the engine says of the cycle flag and the
//   click: read from engine.status after each auth and each session.sync
//   (a gap's sync covers events the client never hands over), then kept by
//   transport.changed, which the engine publishes to every connection
//   whoever asked, and by the result of each transport method. An answer of
//   engine.status that was asked before a newer event or result is dropped.
//   Null while the engine is away or has not answered.
// - LoopClickController sends what a key, a button or the band asks for:
//   session.set_locators through command.execute (no device needed), and
//   transport.set_cycle, transport.set_click, transport.locate and
//   transport.play, which need a device (the engine answers no_device), so
//   without one they send nothing. Nothing is optimistic: the band follows
//   session.changed, the buttons the store. A refusal becomes one toast.
//   Loop Selection (Alt+P) sends, in order, session.set_locators for the
//   selection, transport.set_cycle {enabled: true}, transport.locate to the
//   left locator and transport.play (spec 3.2).
// - Punch, pre-roll and count-in (m5b-ui-recording; spec 3.1; 10.11, 17 and
//   18; protocol-engine-v0.md, "Punch, pre-roll and count-in") are three more
//   states of the same store, from the same answers and transport.changed
//   (null on an engine before m5b-engine-punch-count-in); the controller
//   sends transport.set_punch {in, out} with both flags, and
//   transport.set_preroll / set_count_in {enabled, bars?} with bars an
//   integer clamped to 1..8. I and O toggle the punch in and out.
// - bindLoopClickCommands registers the window-scope keys of the Cubase
//   preset: each declines (the key keeps its default) when it would send
//   nothing.
// Framework-free.

import { refusalLine } from '../i18n/errors';
import type { Locale } from '../i18n/locale';
import type { CommandRegistry } from '../keys/commands';
import { fromSelection, rangeOf, sameRange, setLeft, setRight, type LocatorRange } from '../timeline/locators';
import { capabilitySelector, type CapabilitySelector } from './capabilities';
import type { Snapshot } from './read-model';
import type { EventMessage, SessionClient } from './session-client';

export const MIN_CLICK_GAIN = -60000;
export const MAX_CLICK_GAIN = 0;

export interface ClickState {
  readonly enabled: boolean;
  readonly gainMilliDb: number;
}

export interface PunchState {
  readonly in: boolean;
  readonly out: boolean;
}

export interface BarsOption {
  readonly enabled: boolean;
  readonly bars: number;
}

export interface TransportState {
  readonly cycle: boolean;
  readonly click: ClickState;
  // m5b-engine-punch-count-in: absent where the answer has no such field (an
  // engine before it), null where the field is malformed.
  readonly punch?: PunchState | null;
  readonly preroll?: BarsOption | null;
  readonly countIn?: BarsOption | null;
}

export const MIN_BARS = 1;
export const MAX_BARS = 8;

// A bar count the engine takes: an integer in [1, 8].
export function clampBars(bars: number): number {
  if (!Number.isFinite(bars)) return MIN_BARS;
  return Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(bars)));
}

function parsePunch(value: unknown): PunchState | null {
  const raw = value as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.in !== 'boolean' || typeof raw.out !== 'boolean') return null;
  return Object.freeze({ in: raw.in, out: raw.out });
}

function parseBars(value: unknown): BarsOption | null {
  const raw = value as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean' || !Number.isInteger(raw.bars)) return null;
  return Object.freeze({ enabled: raw.enabled, bars: raw.bars as number });
}

// {cycle, click: {enabled, gainMilliDb}, punch, preroll, countIn} out of
// engine.status, a transport method's result or a transport.changed event;
// null when it has neither cycle nor the click.
export function parseTransportState(value: unknown): TransportState | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const click = raw.click as Record<string, unknown> | null | undefined;
  if (typeof raw.cycle !== 'boolean' || !click || typeof click.enabled !== 'boolean' || !Number.isInteger(click.gainMilliDb)) return null;
  return Object.freeze({
    cycle: raw.cycle,
    click: Object.freeze({ enabled: click.enabled, gainMilliDb: click.gainMilliDb as number }),
    ...('punch' in raw ? { punch: parsePunch(raw.punch) } : {}),
    ...('preroll' in raw ? { preroll: parseBars(raw.preroll) } : {}),
    ...('countIn' in raw ? { countIn: parseBars(raw.countIn) } : {}),
  });
}

export interface TransportStateSource {
  getSnapshot(): TransportState | null;
  subscribe(listener: () => void): () => void;
}

type StoreClient = Pick<SessionClient, 'request' | 'subscribe' | 'getState' | 'onEvent'>;

export class TransportStateStore implements TransportStateSource {
  readonly #client: StoreClient;
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void> = [];
  #snapshot: TransportState | null = null;
  // Bumped by every event and result: an engine.status asked before one is stale.
  #version = 0;
  // The connection and sync the last read was for.
  #read: string | null = null;

  constructor(client: StoreClient) {
    this.#client = client;
    this.#offs.push(client.subscribe(() => this.#check()));
    this.#offs.push(client.onEvent('transport.changed', (event: EventMessage) => this.apply(event)));
    this.#check();
  }

  getSnapshot(): TransportState | null {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // A transport method's result or an event: the engine's state now.
  apply(value: unknown): void {
    const next = parseTransportState(value);
    if (!next) return;
    this.#version += 1;
    this.#set(next);
  }

  destroy(): void {
    for (const off of this.#offs.splice(0)) off();
    this.#listeners.clear();
  }

  #check(): void {
    const state = this.#client.getState();
    if (state.status !== 'connected') {
      this.#read = null;
      this.#set(null);
      return;
    }
    const methods = state.capabilities?.methods;
    if (!Array.isArray(methods) || !methods.includes('engine.status')) return;
    const key = `${state.connections}:${state.syncCount}`;
    if (key === this.#read) return;
    const connection = this.#read === null || this.#read.split(':')[0] !== String(state.connections);
    this.#read = key;
    // A new connection may be another engine: forget the old answer first.
    if (connection) this.#set(null);
    const asked = this.#version;
    this.#client.request('engine.status', {}).then(
      (result) => {
        if (this.#read === key && this.#version === asked) this.#set(parseTransportState(result));
      },
      () => undefined,
    );
  }

  #set(next: TransportState | null): void {
    const same = next === this.#snapshot || (next !== null && this.#snapshot !== null && JSON.stringify(next) === JSON.stringify(this.#snapshot));
    if (same) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

export interface LoopClickToasts {
  push(text: string, reword?: (locale: Locale) => string): number;
}

export interface LoopClickOptions {
  readonly client: Pick<SessionClient, 'request' | 'execute'>;
  readonly model: { getSnapshot(): Snapshot | null };
  readonly state: TransportStateStore;
  // A device runs, so the transport methods may be sent.
  readonly deviceReady: () => boolean;
  // engine.capabilities as last known.
  readonly capabilities: () => CapabilitySelector;
  readonly toasts: LoopClickToasts;
  readonly locale: () => Locale;
}

export type SelectionSpan = { readonly start: bigint; readonly end: bigint } | null;

// What the controls of this feature need from engine.capabilities (spec 3.0):
// the band and the locator display the command and the feature, the cycle
// button the method and the feature, the metronome likewise.
export function loopClickGates(can: CapabilitySelector): { locators: boolean; cycle: boolean; click: boolean } {
  return {
    locators: can.command('session.set_locators') && can.feature('locators'),
    cycle: can.has('transport.set_cycle') && can.feature('cycle'),
    click: can.has('transport.set_click') && can.feature('click'),
  };
}

// The record options (m5b-ui-recording): each needs its method and feature.
export function recordOptionGates(can: CapabilitySelector): { punch: boolean; preroll: boolean; countIn: boolean } {
  return {
    punch: can.has('transport.set_punch') && can.feature('punch'),
    preroll: can.has('transport.set_preroll') && can.feature('preroll'),
    countIn: can.has('transport.set_count_in') && can.feature('countIn'),
  };
}

export class LoopClickController {
  readonly #options: LoopClickOptions;
  #selection: (() => SelectionSpan) | null = null;

  constructor(options: LoopClickOptions) {
    this.#options = options;
  }

  get state(): TransportStateStore {
    return this.#options.state;
  }

  gates(): { locators: boolean; cycle: boolean; click: boolean } {
    return loopClickGates(this.#options.capabilities());
  }

  deviceReady(): boolean {
    return this.#options.deviceReady();
  }

  // The document's locators, or null while none is set.
  locators(): LocatorRange | null {
    return rangeOf(this.#options.model.getSnapshot()?.locators);
  }

  // The selection P and Alt+P take (the event display's, registered by the timeline).
  useSelection(source: () => SelectionSpan): () => void {
    this.#selection = source;
    return () => {
      if (this.#selection === source) this.#selection = null;
    };
  }

  selection(): SelectionSpan {
    return this.#selection?.() ?? null;
  }

  // One session.set_locators; nothing for null, for the range already set,
  // or without the capability. Resolves true when the engine took it.
  async setLocators(range: LocatorRange | null): Promise<boolean> {
    if (!range || !this.gates().locators || sameRange(range, this.locators())) return false;
    return this.#execute([{ op: 'session.set_locators', left: range.left.toString(), right: range.right.toString() }]);
  }

  // Ctrl+Num 1 / Ctrl+Num 2, Ctrl-click / Alt-click: one locator at a frame (spec 3.2).
  setLeftAt(frame: bigint): Promise<boolean> {
    return this.setLocators(setLeft(this.locators(), frame));
  }

  setRightAt(frame: bigint): Promise<boolean> {
    return this.setLocators(setRight(this.locators(), frame));
  }

  // Whether toggling cycle would send now: the method, a device, a known state.
  canToggleCycle(): boolean {
    return this.gates().cycle && this.deviceReady() && this.state.getSnapshot() !== null;
  }

  canClick(): boolean {
    return this.gates().click && this.deviceReady() && this.state.getSnapshot() !== null;
  }

  toggleCycle(): boolean {
    const state = this.state.getSnapshot();
    if (!state || !this.canToggleCycle()) return false;
    void this.#transport('transport.set_cycle', { enabled: !state.cycle });
    return true;
  }

  toggleClick(): boolean {
    const state = this.state.getSnapshot();
    if (!state || !this.canClick()) return false;
    void this.#transport('transport.set_click', { enabled: !state.click.enabled });
    return true;
  }

  // The click's level, an integer in [-60000, 0] mdB; the on / off state kept.
  setClickLevel(gainMilliDb: number): boolean {
    const state = this.state.getSnapshot();
    if (!state || !this.canClick()) return false;
    if (!Number.isInteger(gainMilliDb) || gainMilliDb < MIN_CLICK_GAIN || gainMilliDb > MAX_CLICK_GAIN) return false;
    if (gainMilliDb === state.click.gainMilliDb) return false;
    void this.#transport('transport.set_click', { enabled: state.click.enabled, gainMilliDb });
    return true;
  }

  recordOptionGates(): { punch: boolean; preroll: boolean; countIn: boolean } {
    return recordOptionGates(this.#options.capabilities());
  }

  // Punch in and out (I, O): transport.set_punch with both flags.
  setPunch(punchIn: boolean, punchOut: boolean): boolean {
    const punch = this.state.getSnapshot()?.punch;
    if (!punch || !this.recordOptionGates().punch || !this.deviceReady()) return false;
    if (punch.in === punchIn && punch.out === punchOut) return false;
    void this.#transport('transport.set_punch', { in: punchIn, out: punchOut });
    return true;
  }

  togglePunchIn(): boolean {
    const punch = this.state.getSnapshot()?.punch;
    return punch ? this.setPunch(!punch.in, punch.out) : false;
  }

  togglePunchOut(): boolean {
    const punch = this.state.getSnapshot()?.punch;
    return punch ? this.setPunch(punch.in, !punch.out) : false;
  }

  setPreroll(enabled: boolean): boolean {
    return this.#bars('preroll', enabled, null);
  }

  setPrerollBars(bars: number): boolean {
    const now = this.state.getSnapshot()?.preroll;
    return now ? this.#bars('preroll', now.enabled, bars) : false;
  }

  setCountIn(enabled: boolean): boolean {
    return this.#bars('countIn', enabled, null);
  }

  setCountInBars(bars: number): boolean {
    const now = this.state.getSnapshot()?.countIn;
    return now ? this.#bars('countIn', now.enabled, bars) : false;
  }

  #bars(which: 'preroll' | 'countIn', enabled: boolean, bars: number | null): boolean {
    const now = this.state.getSnapshot()?.[which];
    if (!now || !this.recordOptionGates()[which] || !this.deviceReady()) return false;
    const next = bars === null ? null : clampBars(bars);
    if (now.enabled === enabled && (next === null || next === now.bars)) return false;
    void this.#transport(which === 'preroll' ? 'transport.set_preroll' : 'transport.set_count_in', next === null ? { enabled } : { enabled, bars: next });
    return true;
  }

  // Num 1 / Num 2 (Shift+1 / Shift+2): the project cursor to a locator.
  goToLeft(): boolean {
    return this.#goTo(this.locators()?.left ?? null);
  }

  goToRight(): boolean {
    return this.#goTo(this.locators()?.right ?? null);
  }

  // P: the locators to the selection (no device needed).
  locatorsToSelection(): boolean {
    const range = fromSelection(this.selection());
    if (!range || !this.gates().locators || sameRange(range, this.locators())) return false;
    void this.setLocators(range);
    return true;
  }

  // Alt+P, Loop Selection: set_locators, set_cycle on, locate to the left
  // locator, play, in that order; nothing without a device.
  loopSelection(): boolean {
    const range = fromSelection(this.selection());
    const can = this.#options.capabilities();
    if (!range || !this.gates().locators || !this.gates().cycle || !this.deviceReady()) return false;
    if (!can.has('transport.locate') || !can.has('transport.play')) return false;
    void (async () => {
      if (!sameRange(range, this.locators()) && !(await this.setLocators(range))) return;
      if (!(await this.#transport('transport.set_cycle', { enabled: true }))) return;
      if (!(await this.#transport('transport.locate', { frames: range.left.toString() }))) return;
      await this.#transport('transport.play', {});
    })();
    return true;
  }

  #goTo(frame: bigint | null): boolean {
    if (frame === null || !this.deviceReady() || !this.#options.capabilities().has('transport.locate')) return false;
    void this.#transport('transport.locate', { frames: frame.toString() });
    return true;
  }

  async #execute(commands: readonly unknown[]): Promise<boolean> {
    try {
      await this.#options.client.execute(commands);
      return true;
    } catch (error) {
      this.#refused(error);
      return false;
    }
  }

  async #transport(method: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      const result = await this.#options.client.request(method, params);
      this.state.apply(result);
      return true;
    } catch (error) {
      this.#refused(error);
      return false;
    }
  }

  #refused(error: unknown): void {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    const known = typeof code === 'string' ? code : null;
    this.#options.toasts.push(refusalLine(known, message, this.#options.locale()), (locale) => refusalLine(known, message, locale));
  }
}

export interface LoopClickBindings {
  // The project cursor (a decimal string of frames), or null.
  readonly cursor: () => string | null;
}

export function bindLoopClickCommands(commands: CommandRegistry, controller: LoopClickController, bindings: LoopClickBindings): () => void {
  const cursor = (): bigint | null => {
    const at = bindings.cursor();
    return at !== null && /^\d+$/.test(at) ? BigInt(at) : null;
  };
  const setAt = (which: 'left' | 'right') => (): boolean => {
    const at = cursor();
    if (at === null || !controller.gates().locators) return false;
    const range = which === 'left' ? setLeft(controller.locators(), at) : setRight(controller.locators(), at);
    if (!range || sameRange(range, controller.locators())) return false;
    void controller.setLocators(range);
    return true;
  };
  const offs = [
    commands.register('window', 'transport.cycleToggle', () => controller.toggleCycle()),
    commands.register('window', 'transport.metronomeToggle', () => controller.toggleClick()),
    commands.register('window', 'transport.locatorsToSelection', () => controller.locatorsToSelection()),
    commands.register('window', 'transport.loopSelection', () => controller.loopSelection()),
    commands.register('window', 'transport.toLeftLocator', () => controller.goToLeft()),
    commands.register('window', 'transport.toRightLocator', () => controller.goToRight()),
    commands.register('window', 'transport.setLeftLocator', setAt('left')),
    commands.register('window', 'transport.setRightLocator', setAt('right')),
    commands.register('window', 'transport.punchIn', () => controller.togglePunchIn()),
    commands.register('window', 'transport.punchOut', () => controller.togglePunchOut()),
  ];
  return () => offs.forEach((off) => off());
}

// The capability selector of the client's last known capabilities.
export function clientCapabilities(client: Pick<SessionClient, 'getState'>): () => CapabilitySelector {
  return () => capabilitySelector(client.getState().capabilities);
}
