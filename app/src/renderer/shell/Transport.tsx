// The transport bar in the top bar (m5-ui-transport; UI redesign spec 3.1,
// 5.3): go to the project start, start/stop, stop, the position display and
// auto-scroll.
//
// - The position display shows the project cursor in the primary format over
//   the secondary one (Bars+Beats and Seconds; the period key exchanges
//   them). Its digits are written with textContent from an animation frame
//   scheduled by the realtime channel, never through React state (ADR-0019
//   point 3), so a playing transport causes no React commit. React hears of
//   the transport only when the playing flag flips (the start button's
//   pressed state). Its tooltip says bars are counted in 4/4 (spec 3.0, E-10).
//   Beside it, the tempo in force at the cursor (root.tempo; editing it is
//   phase 3), written the same way.
// - Shift+P opens a real text field over the display, so the dispatcher's
//   text-field rule keeps every key in it; Enter locates to the typed
//   position (read in the primary format), Escape or leaving it cancels, and
//   text that is no position sends nothing.
// - With no audio device (engine.status device null) or no engine the buttons
//   work in this build but not now: they are disabled and their tooltip says
//   why (spec 3.0), the device error's code in front. An engine whose
//   capabilities lack transport.play, transport.stop or transport.locate gets
//   no transport at all (Capable).

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import { useT, type T } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { EngineStatus, EngineStatusSource } from '../model/engine-status';
import type { MeterFrame } from '../model/meter-frames';
import type { SessionClient } from '../model/session-client';
import type { TransportController } from '../model/transport';
import { formatPosition, formatTempo, otherFormat, parsePosition, tempoAt } from '../timeline/transport-time';
import { Capable } from './Capable';
import type { LayoutStore } from './layout-store';

const DEFAULT_RATE = 48000;

export interface TransportAvailability {
  readonly enabled: boolean;
  // Why not, for the tooltip; null when enabled.
  readonly reason: string | null;
}

// Whether the transport can run now: not without an audio device (the device
// error's code in front of the catalog's reason), not without an engine.
// Connected before the first engine.status answer, the engine decides.
export function transportAvailability(status: EngineStatus | null, t: T, connected = true): TransportAvailability {
  if (transportEnabled(status, connected)) return { enabled: true, reason: null };
  if (status && status.device === null) {
    const code = status.deviceError?.code;
    return { enabled: false, reason: code ? `${code}: ${t('transport.noDevice')}` : t('transport.noDevice') };
  }
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

export function useTransportAvailability(client: SessionClient, engineStatus: EngineStatusSource): TransportAvailability {
  const t = useT();
  const status = useSyncExternalStore(
    (listener) => engineStatus.subscribe(listener),
    () => engineStatus.getSnapshot(),
    () => engineStatus.getSnapshot(),
  );
  const connected = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().status === 'connected',
    () => client.getState().status === 'connected',
  );
  return transportAvailability(status, t, connected);
}

function TransportBar({ client, realtime, engineStatus, layout, commands, transport }: TransportProps) {
  const t = useT();
  const { enabled, reason } = useTransportAvailability(client, engineStatus);
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
  const autoScroll = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.getSnapshot().layout.autoScroll,
    () => layout.getSnapshot().layout.autoScroll,
  );
  const primaryRef = useRef<HTMLSpanElement | null>(null);
  const secondaryRef = useRef<HTMLSpanElement | null>(null);
  const tempoRef = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // The display's digits, outside React: one write per animation frame in
  // which the playhead (or the tempo map) changed.
  useEffect(() => {
    const primaryEl = primaryRef.current;
    const secondaryEl = secondaryRef.current;
    const tempoEl = tempoRef.current;
    if (!primaryEl || !secondaryEl || !tempoEl) return undefined;
    let frame: number | null = null;
    let position = '0';
    const write = () => {
      frame = null;
      const latest = realtime?.latest() ?? null;
      if (latest) position = latest.playheadSamples;
      const root = client.model.getSnapshot()?.root;
      const rate = root?.sampleRate ?? DEFAULT_RATE;
      const tempo = root?.tempo ?? [];
      const first = formatPosition(position, tempo, rate, primary);
      const second = formatPosition(position, tempo, rate, otherFormat(primary));
      if (primaryEl.textContent !== first) primaryEl.textContent = first;
      if (secondaryEl.textContent !== second) secondaryEl.textContent = second;
      const bpm = formatTempo(tempoAt(position, tempo, rate));
      if (tempoEl.textContent !== bpm) tempoEl.textContent = bpm;
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
    <div className="transport" data-testid="transport" role="group" aria-label={t('transport.label')}>
      <button
        type="button"
        className="transport-button"
        data-testid="transport-to-start"
        disabled={!enabled}
        title={title(t('transport.toStart'))}
        aria-label={t('transport.toStart')}
        onClick={() => void transport.toStart()}
      >
        <Icon path="M3 2h2v12H3zM14 2v12L6 8z" />
      </button>
      <button
        type="button"
        className="transport-button transport-play"
        data-testid="transport-play"
        disabled={!enabled}
        aria-pressed={playing}
        title={title(t('transport.startStop'))}
        aria-label={t('transport.startStop')}
        onClick={() => void transport.toggle()}
      >
        <Icon path="M4 2v12l10-6z" />
      </button>
      <button
        type="button"
        className="transport-button"
        data-testid="transport-stop"
        disabled={!enabled}
        title={title(t('transport.stop'))}
        aria-label={t('transport.stop')}
        onClick={() => void transport.stop()}
      >
        <Icon path="M3 3h10v10H3z" />
      </button>
      <div
        className="position-display"
        data-testid="position-display"
        data-primary={primary}
        data-editing={editing ? 'true' : undefined}
        role="group"
        aria-label={t('transport.position')}
        title={t('transport.fourFour')}
      >
        <span className="position-primary" data-testid="position-primary" ref={primaryRef} />
        <span className="position-secondary" data-testid="position-secondary" ref={secondaryRef} />
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
      <span className="transport-tempo" data-testid="transport-tempo" title={t('transport.tempo')} ref={tempoRef} />
      <button
        type="button"
        className="transport-button auto-scroll"
        data-testid="auto-scroll"
        aria-pressed={autoScroll}
        title={t('transport.autoScroll')}
        aria-label={t('transport.autoScroll')}
        onClick={() => layout.dispatch({ type: 'autoScroll' })}
      >
        <Icon path="M1 7h9V4l5 4-5 4V9H1z" />
      </button>
    </div>
  );
}

export function Transport(props: TransportProps) {
  return (
    <Capable method="transport.play">
      <Capable method="transport.stop">
        <Capable method="transport.locate">
          <TransportBar {...props} />
        </Capable>
      </Capable>
    </Capable>
  );
}
