// The send slots (m5b-ui-sends-buses; UI redesign 3.4, 4.2; 10.11, 25): a
// track strip's Sends rack (strip()'s .ins with the Sends switch lit) and the
// Inspector's sec('Sends', body, count). A send slot is the insert slot's
// markup (.slot / .islot) with the elements this feature adds, on the
// shell.css rules the insert slot already has (.slot-btn / .islot-btn,
// .slot-name / .islot-name): an on button (send.set_enabled, pressed while
// on), the target bus's name, which is the level control (a horizontal drag
// is one gesture on {ref: send:<id>, param: level} and one revision, Shift
// fine, Ctrl-click 0 dB, a double-click types a value, an arrow key steps,
// the value in its tooltip and aria-valuetext; the level fills the name's
// box from the left at the fader's taper), a pre/post switch (send.set_pre,
// reading PRE or POST) and Remove (send.remove). The rack follows the insert
// rack's two-slot rule (mixer/inserts.ts): with fewer than two sends the
// remaining positions are empty + slots, with two or more every send then one
// empty slot; the Inspector lists every send, then one .islot.empty
// "+ Add send". An empty slot opens the bus picker (BusPicker: the plugin
// picker's dialog without the search field), which lists the buses in
// busOrder and sends one send.add post-fader at 0 dB; with no bus it is
// aria-disabled with the reason.
//
// The plan under review (4.2): a proposed send is a dashed slot numbered by
// its step (at the end of the sends), a removed one dims (a bus.remove's
// cascade too). The edit guard (4.5 C5): while a proposal is heard on, pre,
// Remove and the empty slot are disabled with the reason; the level is a
// gesture and stays.
//
// In a strip's 80 px slot the level keeps the room (shell.css, .send-slot):
// hover or focus shows on and Remove beside the bus name, never PRE / POST,
// which shows there only while it holds the keyboard focus (it stays in the
// tab order; the Inspector's slot always shows it); a pre-fader send's name
// is set in italics, and the slot's tooltip names PRE or POST.

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { useT } from '../i18n/t';
import type { BusEntity, Entity, SendEntity, TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, type GhostView } from '../plans/ghost-context';
import { sendGhosts, type Ghost, type SendGhosts } from '../plans/ghosts';
import { useEditGuard } from '../plans/heard-context';
import { Icon } from '../shell/icons';
import type { TimelineCommand } from '../timeline/commands';
import { addSendCommand, removeSendCommand, sendEnabledCommand, sendPreCommand } from './bus-commands';
import { RACK_POSITIONS } from './inserts';
import { MINUS_INFINITY_MILLI_DB, milliDbToPosition } from './taper';
import { TypedValue } from './ValueControl';
import { commitValue, formatValue, showTooltip, useValueGesture } from './value-gesture';

const percent = (position: number) => `${(position * 100).toFixed(1)}%`;

function send(client: SessionClient, command: TimelineCommand | null): void {
  if (command) void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
}

// The send entities of a track's sends, in its order, stable while none changes.
function useSends(client: SessionClient, ids: readonly string[] | undefined): readonly (SendEntity | undefined)[] {
  const cache = useRef<readonly (Entity | undefined)[]>([]);
  const read = () => {
    const next = (ids ?? []).map((id) => client.model.select(`send:${id}`));
    const last = cache.current;
    if (next.length === last.length && next.every((e, i) => e === last[i])) return last;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore((l) => client.model.subscribe(l), read, read) as readonly (SendEntity | undefined)[];
}

// The buses to send to, in busOrder, by id and name.
function useBuses(client: SessionClient): ReadonlyArray<{ readonly id: string; readonly name: string }> {
  const cache = useRef<ReadonlyArray<{ id: string; name: string }>>([]);
  const read = () => {
    const snapshot = client.model.getSnapshot();
    const next = (snapshot?.busOrder ?? []).map((id) => ({ id, name: (snapshot?.entities[`bus:${id}`] as BusEntity | undefined)?.name ?? id }));
    const last = cache.current;
    if (next.length === last.length && next.every((b, i) => b.id === last[i]!.id && b.name === last[i]!.name)) return last;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore((l) => client.model.subscribe(l), read, read);
}

const activate = (fn: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fn();
  }
};

// The classes of the strip's and the Inspector's slots, as literal tables.
const SLOT_CLASS = { strip: 'slot', inspector: 'islot' } as const;
const BUTTON_CLASS = { strip: 'slot-btn', inspector: 'islot-btn' } as const;
const NAME_CLASS = { strip: 'slot-name', inspector: 'islot-name' } as const;
const TEST_PREFIX = { strip: '', inspector: 'islot-' } as const;

type Variant = 'strip' | 'inspector';

interface SlotProps {
  readonly variant: Variant;
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly sendId: string;
  readonly entity: SendEntity | undefined;
  readonly busName: string;
  readonly ghosts: SendGhosts;
  readonly view: GhostView;
  // Before every test id (the Channel zone's strip: 'channel-'; m5b-ui-editor-channel).
  readonly prefix?: string;
}

function FilledSlot({ variant, client, gestures, sendId, entity, busName, ghosts, view, prefix: before = '' }: SlotProps) {
  const t = useT();
  const guard = useEditGuard();
  const name = useRef<HTMLSpanElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const level = entity?.levelMilliDb ?? 0;
  const enabled = entity?.enabled !== false;
  const pre = entity?.pre === true;
  const ref = `send:${sendId}`;
  const handlers = useValueGesture<HTMLSpanElement>({
    kind: 'gain',
    field: 'levelMilliDb',
    orientation: 'horizontal',
    entityRef: ref,
    value: level,
    gestures,
    travel: () => name.current?.clientWidth ?? 1,
    preview: (_next, at) => name.current?.style.setProperty('--send-fill', percent(at)),
    tooltip: (text) => showTooltip(tooltip.current, text),
  });
  const removal = ghosts.remove.find((g) => g.sendId === sendId);
  const prefix = `${before}${TEST_PREFIX[variant]}`;
  const btn = BUTTON_CLASS[variant];
  const classes = [SLOT_CLASS[variant], 'send-slot', enabled ? '' : 'off', pre ? 'send-pre' : '', removal ? 'ghost-removed' : ''].filter(Boolean).join(' ');
  const text = formatValue('gain', level);
  const mode = pre ? t('send.pre') : t('send.post');
  const snapshot = () => client.model.getSnapshot();
  const fill = { '--send-fill': percent(milliDbToPosition(level)) } as CSSProperties;
  return (
    <div className={classes} data-testid={`${prefix}send-${sendId}`} data-send-id={sendId} title={`${busName} · ${text} · ${mode}`} {...(removal ? ghostAttrs(view, [removal.step], removal.mode) : {})}>
      <button
        type="button"
        className={`${BUTTON_CLASS[variant]}${enabled ? ' on' : ''}`}
        data-testid={`${prefix}send-on-${sendId}`}
        aria-pressed={enabled}
        aria-label={t('send.on', { bus: busName })}
        title={guard ?? t('send.on', { bus: busName })}
        disabled={guard !== null}
        onClick={() => {
          const now = snapshot();
          if (now) send(client, sendEnabledCommand(now, sendId, !enabled));
        }}
      >
        <Icon name="power" small />
      </button>
      <span
        ref={name}
        className={`${NAME_CLASS[variant]} send-level`}
        data-testid={`${prefix}send-level-${sendId}`}
        role="slider"
        tabIndex={0}
        aria-label={t('send.level', { bus: busName })}
        aria-orientation="horizontal"
        aria-valuemin={MINUS_INFINITY_MILLI_DB}
        aria-valuemax={6000}
        aria-valuenow={level}
        aria-valuetext={text}
        style={fill}
        {...handlers}
        onDoubleClick={() => setEditing(true)}
      >
        {editing ? (
          <TypedValue
            kind="gain"
            initial={text}
            testId={`${prefix}send-level-input-${sendId}`}
            label={t('send.levelInput', { bus: busName })}
            onDone={(typed) => {
              setEditing(false);
              if (typed !== null) commitValue(gestures, ref, 'gain', typed, 'levelMilliDb');
            }}
          />
        ) : (
          busName
        )}
      </span>
      <span ref={tooltip} className="value-tooltip" data-testid={`${prefix}send-level-tooltip-${sendId}`} role="status" hidden />
      <button
        type="button"
        className={`${BUTTON_CLASS[variant]} pre${pre ? ' on' : ''}`}
        data-testid={`${prefix}send-pre-${sendId}`}
        aria-pressed={pre}
        aria-label={t('send.preLabel', { bus: busName })}
        title={guard ?? t('send.preLabel', { bus: busName })}
        disabled={guard !== null}
        onClick={() => {
          const now = snapshot();
          if (now) send(client, sendPreCommand(now, sendId, !pre));
        }}
      >
        {mode}
      </button>
      <button
        type="button"
        className={btn}
        data-testid={`${prefix}send-remove-${sendId}`}
        aria-label={t('send.remove', { bus: busName })}
        title={guard ?? t('send.remove', { bus: busName })}
        disabled={guard !== null}
        onClick={() => {
          const now = snapshot();
          if (now) send(client, removeSendCommand(now, sendId));
        }}
      >
        <Icon name="x" small />
      </button>
    </div>
  );
}

function GhostSlot({ variant, ghost, view, prefix = '' }: { variant: Variant; ghost: Extract<Ghost, { kind: 'send-add' }>; view: GhostView; prefix?: string }) {
  return (
    <div className={`${SLOT_CLASS[variant]} ghost`} data-testid={`${prefix}${TEST_PREFIX[variant]}send-ghost-${ghost.step}`} {...ghostAttrs(view, [ghost.step], ghost.mode)} title={ghost.busName} onClick={() => view.pin(ghost.step)}>
      <span className="stepn">{String(ghost.step)}</span>
      <span className={NAME_CLASS[variant]}>{ghost.busName}</span>
    </div>
  );
}

// The bus picker: the plugin picker's dialog (shell.css .plugin-picker) without its search field.
export function BusPicker({ client, track, onClose }: { client: SessionClient; track: Pick<TrackEntity, 'id' | 'name'>; onClose: () => void }) {
  const t = useT();
  const guard = useEditGuard();
  const buses = useBuses(client);
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="plugin-picker bus-picker"
      data-testid="bus-picker"
      aria-labelledby="bus-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // The dialog sits inside the empty slot it opens from: its clicks stay its own.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="picker-head">
        <span id="bus-picker-title" className="picker-title">
          {t('busPicker.title', { track: track.name })}
        </span>
        <button type="button" className="picker-close" data-testid="picker-close" aria-label={t('picker.close')} onClick={onClose}>
          <Icon name="x" small />
        </button>
      </div>
      <ul className="picker-list">
        {buses.map((bus) => (
          <li key={bus.id} className="picker-row">
            <button
              type="button"
              className="picker-choose"
              data-testid="bus-picker-choose"
              data-bus-id={bus.id}
              disabled={guard !== null}
              title={guard ?? bus.name}
              onClick={() => {
                const now = client.model.getSnapshot();
                if (now) send(client, addSendCommand(now, track.id, bus.id));
                onClose();
              }}
            >
              <span className="picker-name">{bus.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

// An empty slot: the bus picker for the track, or aria-disabled with the reason (no bus, the guard).
function EmptySlot({ variant, client, track, id, children, prefix = '' }: { variant: Variant; client: SessionClient; track: Pick<TrackEntity, 'id' | 'name'>; id: string; children: ReactNode; prefix?: string }) {
  const t = useT();
  const guard = useEditGuard();
  const buses = useBuses(client);
  const [open, setOpen] = useState(false);
  const reason = guard ?? (buses.length === 0 ? t('sends.noBus') : null);
  const press = () => {
    if (reason === null) setOpen(true);
  };
  return (
    <div
      className={`${SLOT_CLASS[variant]} empty`}
      role="button"
      tabIndex={0}
      aria-label={t('sends.addFrom', { track: track.name })}
      {...(reason !== null ? { 'aria-disabled': true, title: reason } : {})}
      data-testid={`${prefix}${TEST_PREFIX[variant]}send-add-${id}`}
      onClick={press}
      onKeyDown={activate(press)}
    >
      {children}
      {open ? <BusPicker client={client} track={track} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

type Row =
  | { readonly kind: 'send'; readonly sendId: string; readonly entity: SendEntity | undefined }
  | { readonly kind: 'ghost'; readonly ghost: Extract<Ghost, { kind: 'send-add' }> }
  | { readonly kind: 'empty' };

// The sends in the track's order, the proposed ones after them, then the empty slots.
function rows(ids: readonly string[], entities: readonly (SendEntity | undefined)[], ghosts: SendGhosts, positions: number): Row[] {
  const out: Row[] = ids.map((sendId, i) => ({ kind: 'send', sendId, entity: entities[i] }));
  for (const ghost of ghosts.add) out.push({ kind: 'ghost', ghost });
  const empties = out.length >= positions ? 1 : positions - out.length;
  for (let i = 0; i < empties; i += 1) out.push({ kind: 'empty' });
  return out;
}

interface RackProps {
  readonly client: SessionClient;
  readonly gestures?: GestureController;
  readonly track: TrackEntity;
  readonly view: GhostView;
  // Before every test id (the Channel zone's strip: 'channel-').
  readonly prefix?: string;
}

const NO_GESTURES = { begin: () => undefined, move: () => undefined, end: () => undefined } as unknown as GestureController;

function useBusName(client: SessionClient) {
  const buses = useBuses(client);
  return (busId: string | undefined) => buses.find((b) => b.id === busId)?.name ?? '';
}

function Slots({ variant, client, gestures = NO_GESTURES, track, view, positions, plus, prefix = '' }: RackProps & { variant: Variant; positions: number; plus: string }) {
  const ids = track.sends ?? [];
  const entities = useSends(client, ids);
  const busName = useBusName(client);
  const ghosts = sendGhosts(view.ghosts, track.id);
  return (
    <>
      {rows(ids, entities, ghosts, positions).map((row, i) =>
        row.kind === 'send' ? (
          <FilledSlot key={row.sendId} variant={variant} client={client} gestures={gestures} sendId={row.sendId} entity={row.entity} busName={busName(row.entity?.busId)} ghosts={ghosts} view={view} prefix={prefix} />
        ) : row.kind === 'ghost' ? (
          <GhostSlot key={`g${row.ghost.step}`} variant={variant} ghost={row.ghost} view={view} prefix={prefix} />
        ) : (
          <EmptySlot key={`e${i}`} variant={variant} client={client} track={track} id={variant === 'strip' ? `${track.id}-${i}` : track.id} prefix={prefix}>
            {plus}
          </EmptySlot>
        ),
      )}
    </>
  );
}

// A track strip's Sends rack: strip()'s .ins with the send slots.
export function SendRack(props: RackProps) {
  const t = useT();
  return (
    <div className="ins" role="group" aria-label={t('sends.rack', { track: props.track.name })}>
      <Slots {...props} variant="strip" positions={RACK_POSITIONS} plus="+" />
    </div>
  );
}

// The Inspector's sec('Sends', body, count): every send, then one empty slot.
export function InspectorSends(props: RackProps) {
  const t = useT();
  return (
    <div className="sec" data-part="inspector-sends">
      <div className="sec-h">
        <Icon name="chev" small />
        {t('inspector.sends')}
        <span>{String(props.track.sends?.length ?? 0)}</span>
      </div>
      <div className="sec-b">
        <Slots {...props} variant="inspector" positions={1} plus={`+ ${t('sends.add')}`} />
      </div>
    </div>
  );
}
