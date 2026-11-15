// The transport bar in the top bar (m5-ui-transport; UI redesign spec 3.1,
// 5.3): go to the project start, stop, start/stop, the position display and
// the tempo, then undo and redo; each carries the mockup's data-part id
// (agent-rules "UI fidelity"). Auto-scroll is the project zone toolbar's
// (Timeline.tsx), as in the mockup.
//
// - The position display shows the project cursor in the primary format over
//   the secondary one (Bars+Beats and Seconds; the period key exchanges
//   them; so does its right-click menu). Its digits are written with
//   textContent from one animation-frame loop, never through React state
//   (ADR-0019 point 3), so a playing transport causes no React commit. The
//   loop runs on every animation frame while playing, from the extrapolating
//   clock (transport/playhead-clock.ts: the realtime channel ticks slower
//   than the display), and once after a frame changed while stopped. React
//   hears of the transport only when the playing flag flips (the start
//   button's pressed state), the formats are exchanged or the field opens.
//   Its tooltip says bars are counted in 4/4 (spec 3.0, E-10). Beside it, the
//   tempo in force at the cursor (root.tempo; editing it is phase 3), written
//   the same way.
// - Shift+P opens a real text field over the display, so the dispatcher's
//   text-field rule keeps every key in it; Enter locates to the typed
//   position (read in the primary format), Escape or leaving it cancels, and
//   text that is no position sends nothing.
// - With no audio device (engine.status device null) or no engine the buttons
//   work in this build but not now: they are disabled and their tooltip says
//   why (spec 3.0), the device error's code in front. An engine whose
//   capabilities lack transport.play, transport.stop or transport.locate gets
//   no transport at all (Capable).
// - Undo and redo (spec 3.2) sit beside it, need no device, and are absent
//   without session.undo and session.redo.
// - Locators, cycle and metronome (m5-ui-loop-click; spec 3.1, 3.2): the
//   cycle button between go to start and stop, the locator display between
//   the position display and the tempo, and the click group with the
//   metronome button after them, in the mockup's places and with its ids.
//   Both buttons show the engine's state (model/loop-click.ts: engine.status,
//   transport.changed, method results), are disabled with the reason without
//   a device, as the transport buttons are, and a right-click on the
//   metronome opens its level. The locator display reads the range in bars
//   and beats (4/4) and exists only while the session has locators. Whatever
//   the engine's capabilities do not list is absent and its box stays empty
//   (spec 3.0): an element of the part's size with no role, no focus, no
//   data-part, hidden from assistive technology; the locator display's empty
//   box is --display-locators-empty-w wide.
// - Their markup is the mockup's (agent-rules "UI fidelity"), styled by the
//   shared ui/top-bar.css: cycle and the metronome are `.tbtn` buttons (`.lit`
//   while on), the click group is a `.tgroup`, and the locator display is an
//   `.lcd .cell` with a `.lbl` over a `.val.sm` whose separators are `<em>`.
//   Until m5-ui-alignment-chrome ports the position display into one `.lcd`,
//   the locator cell has an `.lcd` of its own.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';

import type { MessageKey } from '../i18n/en';
import { useT, type T } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { EngineStatus, EngineStatusSource } from '../model/engine-status';
import { MAX_CLICK_GAIN, MIN_CLICK_GAIN, type LoopClickController } from '../model/loop-click';
import type { MeterFrame } from '../model/meter-frames';
import type { SessionClient } from '../model/session-client';
import type { TransportController } from '../model/transport';
import { formatLocators, rangeOf } from '../timeline/locators';
import { formatPosition, formatTempo, otherFormat, parsePosition, tempoAt, type TimeFormat } from '../timeline/transport-time';
import { PlayheadClock } from '../transport/playhead-clock';
import { Capable } from './Capable';
import { Counted } from './Counted';
import type { LayoutStore } from './layout-store';

const DEFAULT_RATE = 48000;

// Animation frames in which the position display's text changed (the
// display-rate e2e reads it through window.__siannTransport).
let writes = 0;
export function displayWrites(): number {
  return writes;
}

export interface TransportAvailability {
  readonly enabled: boolean;
  // Why not, for the tooltip; null when enabled.
  readonly reason: string | null;
}

// Whether the transport can run now: not without an audio device (the device
// error's code in front of the catalog's reason), not without an engine.
// Connected before the first engine.status answer, the engine decides.
export function transportAvailability(status: EngineStatus | null, t: T, connected = true): TransportAvailability {
  return availabilityOf(deviceKey(status), t, connected);
}

// What of engine.status the transport depends on, as a primitive for
// useSyncExternalStore: null before an answer, 'device' while one runs, else
// 'none:' and the device error's code. An answer that differs only in what
// the status bar shows (the xrun count) commits nothing in the transport.
type DeviceKey = null | 'device' | `none:${string}`;

function deviceKey(status: EngineStatus | null): DeviceKey {
  if (!status) return null;
  return status.device ? 'device' : `none:${status.deviceError?.code ?? ''}`;
}

// The reason without a device names what is unavailable: the transport, or
// (m5-ui-loop-click) cycle or the metronome.
type NoDeviceKey = Extract<MessageKey, 'transport.noDevice' | 'transport.noDeviceCycle' | 'transport.noDeviceClick'>;

function availabilityOf(key: DeviceKey, t: T, connected: boolean, noDevice: NoDeviceKey = 'transport.noDevice'): TransportAvailability {
  if (key !== null && key !== 'device') {
    const code = key.slice('none:'.length);
    return { enabled: false, reason: code ? `${code}: ${t(noDevice)}` : t(noDevice) };
  }
  if (connected) return { enabled: true, reason: null };
  return { enabled: false, reason: t('error.disconnected') };
}

// The same decision without the words (the key commands' guard).
export function transportEnabled(status: EngineStatus | null, connected: boolean): boolean {
  return connected && !(status && status.device === null);
}

// The realtime playhead (RealtimeClient fits).
export interface TransportPlayhead {
  latest(): MeterFrame | null;
  subscribe(listener: () => void): () => void;
}

export interface TransportProps {
  readonly client: SessionClient;
  readonly realtime: TransportPlayhead | null;
  readonly engineStatus: EngineStatusSource;
  readonly layout: LayoutStore;
  readonly commands: CommandRegistry;
  readonly transport: TransportController;
  readonly loopClick: LoopClickController;
}

const noSubscription = () => () => undefined;

// A 16 px glyph in the text colour: stand-in drawings on spec 1.5's 16 px
// grid until the Lucide sprite is in the repo.
function Icon({ path }: { path: string }) {
  return (
    <svg className="transport-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={path} fill="currentColor" />
    </svg>
  );
}

export function useTransportAvailability(client: SessionClient, engineStatus: EngineStatusSource, noDevice: NoDeviceKey = 'transport.noDevice'): TransportAvailability {
  const t = useT();
  const key = useSyncExternalStore(
    (listener) => engineStatus.subscribe(listener),
    () => deviceKey(engineStatus.getSnapshot()),
    () => deviceKey(engineStatus.getSnapshot()),
  );
  const connected = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().status === 'connected',
    () => client.getState().status === 'connected',
  );
  return availabilityOf(key, t, connected, noDevice);
}

// The cycle flag and the click as the engine last said.
function useTransportState(loopClick: LoopClickController) {
  const cycle = useSyncExternalStore(
    (listener) => loopClick.state.subscribe(listener),
    () => loopClick.state.getSnapshot()?.cycle ?? false,
    () => loopClick.state.getSnapshot()?.cycle ?? false,
  );
  const click = useSyncExternalStore(
    (listener) => loopClick.state.subscribe(listener),
    () => loopClick.state.getSnapshot()?.click.enabled ?? false,
    () => loopClick.state.getSnapshot()?.click.enabled ?? false,
  );
  const gain = useSyncExternalStore(
    (listener) => loopClick.state.subscribe(listener),
    () => loopClick.state.getSnapshot()?.click.gainMilliDb ?? null,
    () => loopClick.state.getSnapshot()?.click.gainMilliDb ?? null,
  );
  return { cycle, click, gain };
}

// The locator display's text ("9.1 – 13.1"), or null without locators.
function useLocatorText(client: SessionClient): string | null {
  const read = () => {
    const snapshot = client.model.getSnapshot();
    const range = rangeOf(snapshot?.locators);
    return range ? formatLocators(range, snapshot?.root?.tempo ?? [], snapshot?.root?.sampleRate ?? DEFAULT_RATE) : null;
  };
  return useSyncExternalStore((listener) => client.model.subscribe(listener), read, read);
}

// A display value as the mockup writes it: the digits, and each separator
// ("." and "–") in an <em> that `.lcd .val em` dims.
function lcdDigits(text: string) {
  return text.split(/([^\d\s]+)/).map((piece, index) => (index % 2 === 1 ? <em key={index}>{piece}</em> : piece));
}

// The box an absent part keeps (spec 3.0): nothing in it, no role, no focus,
// no data-part, hidden from assistive technology.
function Hold({ className }: { className: string }) {
  return <span className={className} aria-hidden="true" />;
}

function TransportBar({ client, realtime, engineStatus, layout, commands, transport, loopClick }: TransportProps) {
  const t = useT();
  const { enabled, reason } = useTransportAvailability(client, engineStatus);
  const cycleAvailability = useTransportAvailability(client, engineStatus, 'transport.noDeviceCycle');
  const clickAvailability = useTransportAvailability(client, engineStatus, 'transport.noDeviceClick');
  const gates = loopClick.gates();
  const { cycle, click, gain } = useTransportState(loopClick);
  const locatorText = useLocatorText(client);
  // The click level control (right-click on the metronome), where it opened.
  const [level, setLevel] = useState<{ x: number; y: number } | null>(null);
  const closeLevel = useCallback(() => setLevel(null), []);
  // The playing flag: a commit only when it flips.
  const playing = useSyncExternalStore(
    realtime ? (listener) => realtime.subscribe(listener) : noSubscription,
    () => realtime?.latest()?.playing ?? false,
    () => false,
  );
  const primary = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.timeFormat,
    () => layout.getSnapshot().layout.timeFormat,
  );
  const primaryRef = useRef<HTMLSpanElement | null>(null);
  const secondaryRef = useRef<HTMLSpanElement | null>(null);
  const tempoRef = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  // The time format menu (right-click on the display), where it opened.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // The display's digits, outside React: on every animation frame while
  // playing (the clock extrapolates between realtime frames), once after a
  // change while stopped.
  useEffect(() => {
    const primaryEl = primaryRef.current;
    const secondaryEl = secondaryRef.current;
    const tempoEl = tempoRef.current;
    if (!primaryEl || !secondaryEl || !tempoEl) return undefined;
    const clock = new PlayheadClock({ now: () => performance.now() });
    let frame: number | null = null;
    const write = () => {
      frame = null;
      clock.observe(realtime?.latest() ?? null);
      const root = client.model.getSnapshot()?.root;
      const rate = root?.sampleRate ?? DEFAULT_RATE;
      const tempo = root?.tempo ?? [];
      const position = clock.position(rate) ?? '0';
      const first = formatPosition(position, tempo, rate, primary);
      const second = formatPosition(position, tempo, rate, otherFormat(primary));
      let changed = false;
      if (primaryEl.textContent !== first) {
        primaryEl.textContent = first;
        changed = true;
      }
      if (secondaryEl.textContent !== second) {
        secondaryEl.textContent = second;
        changed = true;
      }
      const bpm = formatTempo(tempoAt(position, tempo, rate));
      if (tempoEl.textContent !== bpm) tempoEl.textContent = bpm;
      if (changed) writes += 1;
      if (clock.playing()) schedule();
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(write);
    };
    write();
    const offs = [realtime?.subscribe(schedule), client.model.subscribe(schedule)];
    return () => {
      for (const off of offs) off?.();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [client, realtime, primary]);

  // Shift+P: the position field.
  useEffect(
    () =>
      commands.register('window', 'transport.enterPosition', () => {
        if (!enabledRef.current) return false;
        setInvalid(false);
        setEditing(true);
        return true;
      }),
    [commands],
  );

  const close = () => {
    setEditing(false);
    setInvalid(false);
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    const root = client.model.getSnapshot()?.root;
    const frames = parsePosition(event.currentTarget.value, root?.tempo ?? [], root?.sampleRate ?? DEFAULT_RATE, primary);
    if (frames === null) {
      setInvalid(true);
      return;
    }
    close();
    void transport.locate(frames);
  };

  const title = (label: string) => (enabled ? label : (reason ?? label));
  return (
    <div className="transport" data-testid="transport" data-part="transport" role="group" aria-label={t('transport.label')}>
      {/* The mockup's order: go to start, cycle, stop, start. */}
      <div className="transport-buttons" data-part="transport-buttons">
        <button
          type="button"
          className="transport-button"
          data-testid="transport-to-start"
          data-part="transport-start"
          disabled={!enabled}
          title={title(t('transport.toStart'))}
          aria-label={t('transport.toStart')}
          onClick={() => void transport.toStart()}
        >
          <Icon path="M3 2h2v12H3zM14 2v12L6 8z" />
        </button>
        {gates.cycle ? (
          <button
            type="button"
            className={`tbtn${cycle ? ' lit' : ''}`}
            data-testid="transport-cycle"
            data-part="transport-cycle"
            disabled={!enabled}
            aria-pressed={cycle}
            title={cycleAvailability.enabled ? t('transport.cycle') : (cycleAvailability.reason ?? t('transport.cycle'))}
            aria-label={t('transport.cycle')}
            onClick={() => void loopClick.toggleCycle()}
          >
            <Icon path="M3 5h8V3l3 3-3 3V7H5v2H3zm10 6H5v2l-3-3 3-3v2h6V7h2z" />
          </button>
        ) : (
          <Hold className="transport-hold transport-hold-tbtn" />
        )}
        <button
          type="button"
          className="transport-button"
          data-testid="transport-stop"
          data-part="transport-stop"
          disabled={!enabled}
          title={title(t('transport.stop'))}
          aria-label={t('transport.stop')}
          onClick={() => void transport.stop()}
        >
          <Icon path="M3 3h10v10H3z" />
        </button>
        <button
          type="button"
          className="transport-button transport-play"
          data-testid="transport-play"
          data-part="transport-play"
          disabled={!enabled}
          aria-pressed={playing}
          title={title(t('transport.startStop'))}
          aria-label={t('transport.startStop')}
          onClick={() => void transport.toggle()}
        >
          <Icon path="M4 2v12l10-6z" />
        </button>
      </div>
      <div
        className="position-display"
        data-testid="position-display"
        data-part="display"
        data-primary={primary}
        data-editing={editing ? 'true' : undefined}
        role="group"
        aria-label={t('transport.position')}
        title={t('transport.fourFour')}
        onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span className="position-primary" data-testid="position-primary" data-part="display-position" ref={primaryRef} />
        <span className="position-secondary" data-testid="position-secondary" data-part="display-time" ref={secondaryRef} />
        {editing ? (
          <input
            className="position-field"
            data-testid="position-field"
            aria-label={t('transport.positionField')}
            aria-invalid={invalid ? 'true' : undefined}
            defaultValue={primaryRef.current?.textContent ?? ''}
            autoFocus
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onChange={() => setInvalid(false)}
            onKeyDown={onFieldKey}
            onBlur={close}
          />
        ) : null}
      </div>
      {menu ? (
        <TimeFormatMenu
          primary={primary}
          x={menu.x}
          y={menu.y}
          onChoose={(format) => {
            setMenu(null);
            if (format !== primary) layout.dispatch({ type: 'exchangeFormats' });
          }}
          onClose={closeMenu}
        />
      ) : null}
      {gates.locators && locatorText !== null ? (
        <div className="lcd transport-locators">
          <div
            className="cell"
            data-testid="display-locators"
            data-part="display-locators"
            title={t('transport.locators')}
            aria-label={`${t('transport.locators')} ${locatorText}`}
          >
            <span className="lbl" aria-hidden="true">
              {t('transport.locators')}
            </span>
            <span className="val sm" data-testid="display-locators-value">
              {lcdDigits(locatorText)}
            </span>
          </div>
        </div>
      ) : (
        <Hold className="transport-locators-empty" />
      )}
      <span className="transport-tempo" data-testid="transport-tempo" data-part="display-tempo" title={t('transport.tempo')} ref={tempoRef} />
      {gates.click ? (
        <div className="tgroup" data-testid="transport-click" data-part="transport-click" role="group" aria-label={t('transport.click')}>
          <button
            type="button"
            className={`tbtn${click ? ' lit' : ''}`}
            data-testid="transport-metronome"
            data-part="transport-metronome"
            disabled={!enabled}
            aria-pressed={click}
            title={clickAvailability.enabled ? t('transport.metronome') : (clickAvailability.reason ?? t('transport.metronome'))}
            aria-label={t('transport.metronome')}
            onClick={() => void loopClick.toggleClick()}
            onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              if (enabled) setLevel({ x: event.clientX, y: event.clientY });
            }}
          >
            <Icon path="M6 1h4l3 13H3zm1 2-1 4 5-3zM5 9l-.8 3.5h7.6L11 9z" />
          </button>
        </div>
      ) : (
        <Hold className="transport-hold transport-hold-tgroup" />
      )}
      {level && gates.click ? (
        <ClickLevel gainMilliDb={gain} x={level.x} y={level.y} onChoose={(value) => void loopClick.setClickLevel(value)} onClose={closeLevel} />
      ) : null}
    </div>
  );
}

export interface TimeFormatMenuProps {
  readonly primary: TimeFormat;
  // Where it opened (client coordinates).
  readonly x: number;
  readonly y: number;
  readonly onChoose: (format: TimeFormat) => void;
  readonly onClose: () => void;
}

const FORMATS: readonly TimeFormat[] = ['bars', 'seconds'];

// The two-item time format menu (spec 3.2, P1-2): Bars+Beats and Seconds,
// the primary one checked. Escape or a press outside closes it.
export function TimeFormatMenu({ primary, x, y, onChoose, onClose }: TimeFormatMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return (
    <div
      className="time-format-menu"
      data-testid="time-format-menu"
      role="menu"
      aria-label={t('transport.formatMenu')}
      style={{ left: x, top: y }}
      ref={ref}
    >
      {FORMATS.map((format) => (
        <button
          key={format}
          type="button"
          role="menuitemradio"
          className="time-format-item"
          data-testid={`time-format-${format}`}
          aria-checked={primary === format}
          onClick={() => onChoose(format)}
        >
          {t(format === 'bars' ? 'transport.formatBars' : 'transport.formatSeconds')}
        </button>
      ))}
    </div>
  );
}

export interface ClickLevelProps {
  // The click's level as the engine last said (mdB), null when unknown.
  readonly gainMilliDb: number | null;
  // Where it opened (client coordinates).
  readonly x: number;
  readonly y: number;
  // A new level in mdB, on release (one transport.set_click).
  readonly onChoose: (gainMilliDb: number) => void;
  readonly onClose: () => void;
}

const DEFAULT_CLICK_GAIN = -12000;

// The metronome's level (right-click on its button; spec 3.1, P1-7): a fader
// from -60 dB to 0 dB in whole dB with its value, sent when released.
// Escape or a press outside closes it.
export function ClickLevel({ gainMilliDb, x, y, onChoose, onClose }: ClickLevelProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const current = gainMilliDb ?? DEFAULT_CLICK_GAIN;
  const [value, setValue] = useState(Math.round(current / 1000));
  useEffect(() => setValue(Math.round(current / 1000)), [current]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  const commit = (db: number) => {
    const milli = db * 1000;
    if (milli !== current) onChoose(milli);
  };
  return (
    <div className="click-level" data-testid="click-level" role="group" aria-label={t('transport.clickLevel')} style={{ left: x, top: y }} ref={ref}>
      <input
        type="range"
        data-testid="click-level-input"
        aria-label={t('transport.clickLevel')}
        min={MIN_CLICK_GAIN / 1000}
        max={MAX_CLICK_GAIN / 1000}
        step={1}
        value={value}
        onChange={(event) => setValue(Number(event.currentTarget.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (event.key !== 'Escape') commit(Number(event.currentTarget.value));
        }}
      />
      <span className="click-level-value" data-testid="click-level-value">
        {t('transport.clickLevelValue', { db: String(value) })}
      </span>
    </div>
  );
}

// Undo and redo (spec 3.2): they need no device. While the engine is away
// the request is refused like any other, as a toast.
function UndoRedo({ transport }: { transport: TransportController }) {
  const t = useT();
  return (
    <div className="transport undo-redo" data-testid="undo-redo" role="group" aria-label={t('transport.undoRedo')}>
      <button
        type="button"
        className="transport-button"
        data-testid="undo"
        data-part="undo"
        title={t('transport.undo')}
        aria-label={t('transport.undo')}
        onClick={() => void transport.undo()}
      >
        <Icon path="M6 3 1 7.5 6 12V9h4a3 3 0 0 1 0 6H8v1h2a4 4 0 0 0 0-8H6z" />
      </button>
      <button
        type="button"
        className="transport-button"
        data-testid="redo"
        data-part="redo"
        title={t('transport.redo')}
        aria-label={t('transport.redo')}
        onClick={() => void transport.redo()}
      >
        <Icon path="M10 3l5 4.5-5 4.5V9H6a3 3 0 0 0 0 6h2v1H6a4 4 0 0 1 0-8h4z" />
      </button>
    </div>
  );
}

export function Transport(props: TransportProps) {
  return (
    <>
      <Capable method="transport.play">
        <Capable method="transport.stop">
          <Capable method="transport.locate">
            <Counted id="transport">
              <TransportBar {...props} />
            </Counted>
          </Capable>
        </Capable>
      </Capable>
      <Capable method="session.undo">
        <Capable method="session.redo">
          <UndoRedo transport={props.transport} />
        </Capable>
      </Capable>
    </>
  );
}
