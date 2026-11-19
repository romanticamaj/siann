// The recording controls (m5b-ui-recording; UI redesign 3.1, 3.3, 3.5; 10.11,
// 16 to 21), ported from the mockup's markup where it draws them:
//
// - RecordEnable: th()'s, strip()'s and the Inspector's `.msr.r` holding the
//   dot (<i>), lit (.on, aria-pressed) while the engine says the track is
//   armed; a click sends one record.arm. Blocked (no device, no input open,
//   a track without an input or with one beyond the open input, recording)
//   it is aria-disabled with the reason in its tooltip and sends nothing.
// - MonitorButton: the Inspector's `.msr` holding ic('mon','s'); a click sends
//   one track.set_monitor (off to input, input or auto to off); lit (.on,
//   aria-pressed) while the document's mode is not off, the mode in its
//   tooltip. Its classes are the mockup's; the app-only lit rule (shell.css)
//   selects [data-part="inspector-monitor"].on.
// - InputRow: the first .irow of sec('Routing'): the label In and the .pick
//   with the input's name and ic('chev','s'), a native <select> over it (the
//   open input's mono ports and stereo pairs, and no input) that sends one
//   track.set_input. Disabled while the track records (track_recording).
// - RecordButton: the transport's `.tbtn.rec` holding ic('rec'), pressed
//   while recording; a click sends transport.record. Without a device or an
//   input it is the way into Studio Setup (aria-disabled, the reason and the
//   hint, a click opens it), as the other transport buttons; with nothing
//   armed it is aria-disabled with that reason. Its tooltip names the record
//   options that are on. A right-click (or the menu key) opens RecordOptions.
// - RecordOptions: an app-only panel (the mockup draws none; shell.css on
//   existing tokens, the pattern of the metronome's level): punch in, punch
//   out, pre-roll and count-in with their bar counts (1 to 8), each showing
//   the engine's state and sending its transport method.
// - PendingTakes: a native dialog listing the pending takes with Keep and
//   Discard per take (record.recover_take).
//
// The edit guard (UI redesign 4.5 C5; 10.11, 22): while a proposal is heard
// Record (a start; a stop stays), the In selector, the monitor and Keep are
// disabled with the guard's reason (useEditGuard); record enable and Discard
// commit nothing onto main and stay.

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';

import type { MessageKey } from '../i18n/en';
import { useT, type T } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import { GUARD_REASON } from '../model/edit-guard';
import { inputLabel, inputPorts, portKey, portOfKey } from '../model/input-ports';
import { clampBars, MAX_BARS, MIN_BARS, type LoopClickController, type TransportState } from '../model/loop-click';
import type { PendingTake } from '../model/pending-takes';
import { monitorOf, type ArmBlock, type RecordBlock, type RecordController } from '../model/record';
import type { SessionClient } from '../model/session-client';
import { useEditGuard } from '../plans/heard-context';
import { formatPosition } from '../timeline/transport-time';
import { Icon } from './icons';
import { useRecordValue, type RecordHost } from './record-context';

const ARM_REASONS: Readonly<Record<ArmBlock, MessageKey>> = {
  disconnected: 'error.disconnected',
  noDevice: 'record.reason.noDevice',
  noInput: 'record.reason.noInput',
  noTrackInput: 'record.reason.noTrackInput',
  inputUnavailable: 'record.reason.inputUnavailable',
  recording: 'record.reason.recording',
};

const RECORD_REASONS: Readonly<Record<RecordBlock, MessageKey>> = {
  disconnected: 'error.disconnected',
  guard: GUARD_REASON,
  noDevice: 'record.reason.noDevice',
  noInput: 'record.reason.noInput',
  nothingArmed: 'record.reason.nothingArmed',
};

export function armReason(block: ArmBlock, track: string, t: T): string {
  return t(ARM_REASONS[block], { track });
}

export interface RecordEnableProps {
  readonly host: RecordHost;
  readonly track: Pick<TrackEntity, 'id' | 'name'>;
  readonly testId: string;
  // data-part-of (a header's or a strip's) or data-part (the Inspector's).
  readonly partOf?: string;
  readonly part?: string;
}

export function RecordEnable({ host, track, testId, partOf, part }: RecordEnableProps) {
  const t = useT();
  const armed = useRecordValue(host, (c) => c.isArmed(track.id), false);
  const block = useRecordValue<ArmBlock | null>(host, (c) => c.armBlock(track.id), null);
  const label = t('record.enable', { track: track.name });
  return (
    <button
      type="button"
      className={`msr r${armed ? ' on' : ''}`}
      data-testid={testId}
      {...(partOf ? { 'data-part-of': partOf } : {})}
      {...(part ? { 'data-part': part } : {})}
      aria-pressed={armed}
      aria-label={label}
      {...(block ? { 'aria-disabled': 'true' as const } : {})}
      title={block ? armReason(block, track.name, t) : label}
      onClick={() => host.controller.toggleArm(track.id)}
    >
      <i />
    </button>
  );
}

export function MonitorButton({ host, track }: { host: RecordHost; track: TrackEntity }) {
  const t = useT();
  const guard = useEditGuard();
  const mode = monitorOf(track);
  const on = mode !== 'off';
  return (
    <button
      type="button"
      className={`msr${on ? ' on' : ''}`}
      data-testid="inspector-monitor"
      data-part="inspector-monitor"
      aria-pressed={on}
      aria-label={t('monitor.label', { track: track.name })}
      disabled={guard !== null}
      title={guard ?? t('monitor.tooltip', { mode: t(mode === 'input' ? 'monitor.mode.input' : mode === 'auto' ? 'monitor.mode.auto' : 'monitor.mode.off') })}
      onClick={() => host.controller.toggleMonitor(track.id)}
    >
      <Icon name="mon" small />
    </button>
  );
}

export function InputRow({ host, track }: { host: RecordHost; track: TrackEntity }) {
  const t = useT();
  const open = useRecordValue<number | null>(host, (c) => c.openChannels(), null);
  const guard = useEditGuard();
  const recording = useRecordValue(host, (c) => c.inputBlock(track.id) === 'recording', false);
  const blocked = recording || guard !== null;
  const current = track.input ?? null;
  const ports = inputPorts(open ?? 0);
  const currentKey = portKey(current);
  const listed = current === null || ports.some((p) => portKey(p) === currentKey);
  return (
    <div className="irow" data-testid="inspector-in-row">
      <span>{t('input.label')}</span>
      <span className="pick">
        <span className="pick-name" data-testid="inspector-input-name">
          {inputLabel(current, open, t)}
        </span>
        <Icon name="chev" small />
        <select
          className="pick-select"
          data-testid="inspector-input"
          aria-label={t('input.select', { track: track.name })}
          value={currentKey}
          disabled={blocked}
          title={recording ? t('input.reason.recording') : (guard ?? undefined)}
          onChange={(event) => host.controller.setInput(track.id, portOfKey(event.currentTarget.value))}
        >
          <option value="none">{t('input.none')}</option>
          {listed ? null : <option value={currentKey}>{inputLabel(current, open, t)}</option>}
          {ports.map((port) => (
            <option key={portKey(port)} value={portKey(port)}>
              {inputLabel(port, open, t)}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}

// The record options that are on, by name, for Record's tooltip.
function optionsOn(state: TransportState | null, t: T): string[] {
  if (!state) return [];
  const on: string[] = [];
  if (state.punch?.in) on.push(t('record.option.punchIn'));
  if (state.punch?.out) on.push(t('record.option.punchOut'));
  if (state.preroll?.enabled) on.push(t('record.option.preroll'));
  if (state.countIn?.enabled) on.push(t('record.option.countIn'));
  return on;
}

export interface RecordButtonProps {
  readonly host: RecordHost;
  readonly loopClick: LoopClickController;
  readonly onStudioSetup?: () => void;
}

export function RecordButton({ host, loopClick, onStudioSetup }: RecordButtonProps) {
  const t = useT();
  const recording = useRecordValue(host, (c) => c.recording(), false);
  const read = useRecordValue<RecordBlock | null>(host, (c) => c.recordBlock(), null);
  // The edit guard holds a start, never a stop (10.11, 22).
  const guard = useEditGuard();
  const block: RecordBlock | null = guard !== null && !recording && read !== 'disconnected' ? 'guard' : read;
  const options = useSyncExternalStore(
    (listener) => loopClick.state.subscribe(listener),
    () => optionsOn(loopClick.state.getSnapshot(), t).join(', '),
    () => optionsOn(loopClick.state.getSnapshot(), t).join(', '),
  );
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const label = t('transport.record');
  const gates = loopClick.recordOptionGates();
  const hasOptions = gates.punch || gates.preroll || gates.countIn;
  let title = options ? `${label}\n${t('record.optionsOn', { options })}` : label;
  let onClick: () => void = () => void host.controller.toggleRecord();
  let disabled: Record<string, unknown> = {};
  if (block === 'disconnected') {
    title = t('error.disconnected');
    disabled = { disabled: true };
  } else if (block) {
    const reason = t(RECORD_REASONS[block]);
    const setup = (block === 'noDevice' || block === 'noInput') && onStudioSetup;
    title = setup ? `${reason}\n${t('transport.studioSetupHint')}` : reason;
    onClick = setup ? onStudioSetup : () => undefined;
    disabled = { 'aria-disabled': 'true' };
  }
  const openAt = (x: number, y: number) => {
    if (hasOptions) setPanel({ x, y });
  };
  return (
    <>
      <button
        type="button"
        className="tbtn rec"
        data-testid="transport-record"
        data-part="transport-record"
        aria-pressed={recording}
        aria-label={label}
        aria-haspopup={hasOptions ? 'dialog' : undefined}
        title={title}
        {...disabled}
        onClick={onClick}
        onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          openAt(event.clientX, event.clientY);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          openAt(box.left, box.bottom);
        }}
      >
        <Icon name="rec" />
      </button>
      {panel ? <RecordOptions loopClick={loopClick} x={panel.x} y={panel.y} onClose={() => setPanel(null)} /> : null}
    </>
  );
}

export interface RecordOptionsProps {
  readonly loopClick: LoopClickController;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}

function BarsField({ testId, label, bars, disabled, onChoose }: { testId: string; label: string; bars: number; disabled: boolean; onChoose: (bars: number) => void }) {
  const [text, setText] = useState(String(bars));
  useEffect(() => setText(String(bars)), [bars]);
  const commit = (value: string) => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n)) {
      setText(String(bars));
      return;
    }
    const next = clampBars(n);
    setText(String(next));
    if (next !== bars) onChoose(next);
  };
  return (
    <input
      type="number"
      className="record-bars"
      data-testid={testId}
      aria-label={label}
      min={MIN_BARS}
      max={MAX_BARS}
      step={1}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(event.currentTarget.value);
        }
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      onPointerUp={(event) => commit(event.currentTarget.value)}
    />
  );
}

export function RecordOptions({ loopClick, x, y, onClose }: RecordOptionsProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const state = useSyncExternalStore(
    (listener) => loopClick.state.subscribe(listener),
    () => loopClick.state.getSnapshot(),
    () => loopClick.state.getSnapshot(),
  );
  const gates = loopClick.recordOptionGates();
  const ready = loopClick.deviceReady();
  const [at, setAt] = useState({ x, y });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    // Inside the window.
    const box = ref.current?.getBoundingClientRect();
    if (box) setAt({ x: Math.max(0, Math.min(x, window.innerWidth - box.width)), y: Math.max(0, Math.min(y, window.innerHeight - box.height)) });
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
  }, [onClose, x, y]);
  const punch = state?.punch ?? null;
  const preroll = state?.preroll ?? null;
  const countIn = state?.countIn ?? null;
  return (
    <div className="record-options" data-testid="record-options" role="dialog" aria-label={t('record.options')} style={{ left: at.x, top: at.y }} ref={ref}>
      {gates.punch && punch ? (
        <>
          <label className="record-option">
            <input type="checkbox" data-testid="record-option-punch-in" checked={punch.in} disabled={!ready} onChange={(event) => void loopClick.setPunch(event.currentTarget.checked, punch.out)} />
            {t('record.option.punchIn')}
          </label>
          <label className="record-option">
            <input type="checkbox" data-testid="record-option-punch-out" checked={punch.out} disabled={!ready} onChange={(event) => void loopClick.setPunch(punch.in, event.currentTarget.checked)} />
            {t('record.option.punchOut')}
          </label>
        </>
      ) : null}
      {gates.preroll && preroll ? (
        <div className="record-option">
          <label className="record-option">
            <input type="checkbox" data-testid="record-option-preroll" checked={preroll.enabled} disabled={!ready} onChange={(event) => void loopClick.setPreroll(event.currentTarget.checked)} />
            {t('record.option.preroll')}
          </label>
          <BarsField testId="record-option-preroll-bars" label={t('record.option.prerollBars')} bars={preroll.bars} disabled={!ready} onChoose={(bars) => void loopClick.setPrerollBars(bars)} />
          <span className="record-bars-unit">{t('record.option.barsUnit')}</span>
        </div>
      ) : null}
      {gates.countIn && countIn ? (
        <div className="record-option">
          <label className="record-option">
            <input type="checkbox" data-testid="record-option-count-in" checked={countIn.enabled} disabled={!ready} onChange={(event) => void loopClick.setCountIn(event.currentTarget.checked)} />
            {t('record.option.countIn')}
          </label>
          <BarsField testId="record-option-count-in-bars" label={t('record.option.countInBars')} bars={countIn.bars} disabled={!ready} onChoose={(bars) => void loopClick.setCountInBars(bars)} />
          <span className="record-bars-unit">{t('record.option.barsUnit')}</span>
        </div>
      ) : null}
    </div>
  );
}

export interface PendingTakesProps {
  readonly controller: RecordController;
  readonly client: SessionClient;
}

const DEFAULT_RATE = 48000;

// The pending takes (a crash left them): Keep and Discard per take. Closed
// with Decide later (or Escape) until the next connection lists them again.
export function PendingTakes({ controller, client }: PendingTakesProps) {
  const t = useT();
  // Keep commits onto main: the edit guard holds it; Discard moves the files to the trash and stays.
  const guard = useEditGuard();
  const ref = useRef<HTMLDialogElement | null>(null);
  const read = () => controller.pendingTakes().map((take) => take.takeId).join(' ');
  const ids = useSyncExternalStore((listener) => controller.subscribePending(listener), read, read);
  const connections = useSyncExternalStore((listener) => client.subscribe(listener), () => client.getState().connections, () => client.getState().connections);
  const [later, setLater] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const takes: readonly PendingTake[] = ids ? controller.pendingTakes() : [];
  const open = takes.length > 0 && later !== connections;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (takes.length === 0) return null;
  const snapshot = client.model.getSnapshot();
  const name = (trackId: string | null) => {
    const track = trackId ? (snapshot?.entities[`track:${trackId}`] as TrackEntity | undefined) : undefined;
    return track?.name ?? t('pending.unknownTrack');
  };
  const position = (frame: string | null) =>
    frame === null ? t('pending.noAudio') : formatPosition(frame, snapshot?.root?.tempo ?? [], snapshot?.root?.sampleRate ?? DEFAULT_RATE, 'bars');
  const decide = async (takeId: string, accept: boolean) => {
    setBusy(takeId);
    await controller.recoverTake(takeId, accept);
    setBusy(null);
  };
  return (
    <dialog
      ref={ref}
      className="pending-takes"
      data-testid="pending-takes"
      aria-labelledby="pending-takes-title"
      onCancel={(event) => {
        event.preventDefault();
        setLater(connections);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <h2 id="pending-takes-title" className="pending-takes-title">
        {t('pending.title')}
      </h2>
      <p className="pending-takes-intro">{t('pending.intro')}</p>
      <ul className="pending-takes-list">
        {takes.map((take) => (
          <li key={take.takeId} className="pending-take" data-testid={`pending-take-${take.takeId}`}>
            <span className="pending-take-name">{t('pending.take', { track: name(take.trackId), position: position(take.startFrame) })}</span>
            <button type="button" data-testid={`pending-take-keep-${take.takeId}`} aria-label={t('pending.keepLabel', { track: name(take.trackId) })} disabled={busy !== null || take.startFrame === null || guard !== null} title={guard ?? undefined} onClick={() => void decide(take.takeId, true)}>
              {t('pending.keep')}
            </button>
            <button type="button" className="danger" data-testid={`pending-take-discard-${take.takeId}`} aria-label={t('pending.discardLabel', { track: name(take.trackId) })} disabled={busy !== null} onClick={() => void decide(take.takeId, false)}>
              {t('pending.discard')}
            </button>
          </li>
        ))}
      </ul>
      <div className="pending-takes-buttons">
        <button type="button" data-testid="pending-takes-later" onClick={() => setLater(connections)}>
          {t('pending.later')}
        </button>
      </div>
    </dialog>
  );
}
