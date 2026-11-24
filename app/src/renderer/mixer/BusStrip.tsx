// A bus strip (m5b-ui-sends-buses; UI redesign 3.4, 3.0, 4.2; 10.11, 25):
// strip() for a bus, with the track strip's controls from Strip.tsx. Top to
// bottom: the rack row (Inserts: the bus's insert rack; Routing: its output
// selector, the master or another bus; Sends: an empty box, since a send goes
// from a track), the pan row (its drag shows at once and commits one
// bus.set_pan when it ends: the gesture protocol takes only gain on a bus),
// M and S (bus.set_mute, bus.set_solo) and the empty box of e, the fader to
// +6 dB on bus:<id> (a gesture, one bus.set_gain per drag) with its meter on
// the meter key bus:<id>, the level and the peak value, the R W record row
// as an empty box, and the name tag on the colour of its id's palette entry
// (timeline/track-colour.ts), which a double-click renames (Enter commits
// one bus.rename, Escape cancels, an empty or unchanged name sends nothing).
//
// A press on the strip outside its controls selects the bus (mixer/
// bus-selection.ts): .sel and aria-selected, the track selection unchanged.
// A plan's bus.remove dims the strip with its step badge (.ghost-removed, as
// a removed track's strip). The edit guard (4.5 C5): M, S, the pan, the
// selector and the rename are disabled with the reason while a proposal is
// heard (the pan knob stays, aria-disabled with the reason as its tooltip);
// the fader is a gesture and stays.

import { memo, useSyncExternalStore, useState, type CSSProperties, type PointerEvent } from 'react';

import { useT } from '../i18n/t';
import type { BusEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, useGhostView } from '../plans/ghost-context';
import { busGhosts } from '../plans/ghosts';
import { useEditGuard } from '../plans/heard-context';
import { ISOLATE } from '../plans/isolate';
import { useCapabilities } from '../shell/Capable';
import { Hold } from '../shell/Hold';
import type { Rack } from '../shell/layout';
import type { TimelineCommand } from '../timeline/commands';
import { trackColourVar } from '../timeline/track-colour';
import { busPanCommand, busToggleCommand, renameBusCommand } from './bus-commands';
import { InsertRack } from './InsertSlot';
import { pluginsListed } from './inserts';
import { RoutingRack } from './OutputSelector';
import { Fader, Meter, PanRow, PeakValue, Scale } from './Strip';
import { ValueReadout } from './ValueControl';
import { releaseCommit } from './value-gesture';

function send(client: SessionClient, command: TimelineCommand | null): void {
  if (command) void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
}

// The bus as the UI shows it (committed, or with the gesture's overlay).
function useBus(client: SessionClient, busId: string): BusEntity | undefined {
  const ref = `bus:${busId}`;
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.select(ref) as BusEntity | undefined,
    () => client.model.select(ref) as BusEntity | undefined,
  );
}

// A press on a control is the control's; anywhere else on the strip selects the bus.
const CONTROLS = 'button, select, input, [role="slider"], [role="button"], dialog, .ftrack, svg.knob';

export interface BusStripProps {
  readonly busId: string;
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly selected?: boolean;
  readonly rack?: Rack | null;
  readonly onSelect?: (busId: string) => void;
}

function BusRack({ client, bus, rack }: { client: SessionClient; bus: BusEntity; rack: Rack | null }) {
  const can = useCapabilities();
  const view = useGhostView();
  if (rack === 'inserts' && pluginsListed(can)) return <InsertRack client={client} owner={{ kind: 'bus', id: bus.id, name: bus.name, inserts: bus.inserts }} view={view} />;
  if (rack === 'routing' && can.command('bus.set_output')) return <RoutingRack client={client} owner={{ kind: 'bus', id: bus.id }} name={bus.name} />;
  return <div className="ins" aria-hidden="true" />;
}

function NameTag({ client, bus }: { client: SessionClient; bus: BusEntity }) {
  const t = useT();
  const can = useCapabilities();
  const guard = useEditGuard();
  const [renaming, setRenaming] = useState(false);
  const renamable = can.command('bus.rename') && guard === null;
  const finish = (name: string | null) => {
    setRenaming(false);
    const snapshot = client.model.getSnapshot();
    if (name !== null && snapshot) send(client, renameBusCommand(snapshot, bus.id, name));
  };
  return (
    <div className="nametag" data-testid={`strip-name-${bus.id}`} data-part-of="name" dir={ISOLATE.dir} style={{ ...ISOLATE.style }} title={guard ?? bus.name} onDoubleClick={renamable ? () => setRenaming(true) : undefined}>
      {renaming ? (
        <input
          type="text"
          className="bus-rename"
          data-testid={`bus-rename-${bus.id}`}
          aria-label={t('bus.rename', { bus: bus.name })}
          defaultValue={bus.name}
          autoFocus
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') finish(event.currentTarget.value);
            else if (event.key === 'Escape') finish(null);
          }}
          onBlur={() => setRenaming(false)}
        />
      ) : (
        bus.name
      )}
    </div>
  );
}

export const BusStrip = memo(function BusStrip({ busId, client, gestures, selected = false, rack = 'inserts', onSelect }: BusStripProps) {
  const t = useT();
  const can = useCapabilities();
  const guard = useEditGuard();
  const view = useGhostView();
  const bus = useBus(client, busId);
  // One stand-in per strip, so a revision arriving mid-drag keeps the drag's last value.
  const [pan] = useState(() =>
    releaseCommit((value) => {
      const snapshot = client.model.getSnapshot();
      if (snapshot) send(client, busPanCommand(snapshot, busId, value));
    }),
  );
  if (!bus) return null;
  const removal = busGhosts(view.ghosts, busId).remove;
  const ref = `bus:${busId}`;
  const gesturable = can.has('gesture.begin') && can.feature('gestures');
  const faderListed = gesturable && can.command('bus.set_gain');
  const panListed = can.command('bus.set_pan');
  const style = { '--c': `var(${trackColourVar(busId)})` } as CSSProperties;
  const classes = ['strip', bus.mute ? 'muted' : '', selected ? 'sel' : '', removal ? 'ghost-removed' : ''].filter(Boolean).join(' ');
  const toggle = (field: 'mute' | 'solo') => {
    const snapshot = client.model.getSnapshot();
    if (snapshot) send(client, busToggleCommand(snapshot, busId, field));
  };
  const select = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest?.(CONTROLS)) return;
    onSelect?.(busId);
  };
  return (
    <div
      className={classes}
      data-testid={`mixer-strip-bus-${busId}`}
      data-part-item="strip"
      data-part-key={`bus-${busId}`}
      role="group"
      aria-label={bus.name}
      aria-selected={selected}
      style={style}
      {...(removal ? ghostAttrs(view, [removal.step], removal.mode) : {})}
      onPointerDown={select}
    >
      {removal ? (
        <span className="stepn" {...ghostAttrs(view, [removal.step])} style={{ right: 'var(--space)', top: 'var(--strip-gain-step-top)' }} onClick={() => view.pin(removal.step)}>
          {String(removal.step)}
        </span>
      ) : null}
      <BusRack client={client} bus={bus} rack={rack} />
      <PanRow id={busId} name={bus.name} value={bus.pan} entityRef={ref} gestures={pan} listed={panListed} disabledReason={guard} view={view} />
      <div className="btns" data-part-of="buttons">
        {can.command('bus.set_mute') ? (
          <button type="button" className={`msr m${bus.mute ? ' on' : ''}`} data-testid={`mute-${busId}`} data-part-of="mute" disabled={guard !== null} title={guard ?? undefined} aria-label={t('strip.muteLabel', { track: bus.name })} aria-pressed={bus.mute} onClick={() => toggle('mute')}>
            M
          </button>
        ) : (
          <Hold className="msr-box" />
        )}
        {can.command('bus.set_solo') ? (
          <button type="button" className={`msr s${bus.solo ? ' on' : ''}`} data-testid={`solo-${busId}`} data-part-of="solo" disabled={guard !== null} title={guard ?? undefined} aria-label={t('strip.soloLabel', { track: bus.name })} aria-pressed={bus.solo} onClick={() => toggle('solo')}>
            S
          </button>
        ) : (
          <Hold className="msr-box" />
        )}
        <Hold className="msr-box" />
      </div>
      <div className="fad" data-part-of="fader-area">
        <Scale />
        {faderListed ? <Fader entityRef={ref} value={bus.gainMilliDb} id={busId} label={t('strip.gainLabel', { track: bus.name })} gestures={gestures} ghosts={[]} view={view} /> : <div aria-hidden="true" />}
        <Meter meterRef={ref} testId={`meter-${busId}`} />
      </div>
      <div className="readout" data-part-of="readout">
        <ValueReadout
          kind="gain"
          entityRef={ref}
          value={bus.gainMilliDb}
          gestures={gestures}
          testId={`fader-value-${busId}`}
          label={t('strip.levelLabel', { track: bus.name })}
          typing={faderListed ? { testId: `gain-input-${busId}`, label: t('strip.gainInput', { track: bus.name }) } : undefined}
        />
        <PeakValue meterRef={ref} testId={`peak-value-${busId}`} label={t('strip.peakLabel', { track: bus.name })} />
      </div>
      <div className="btns" aria-hidden="true" />
      <NameTag client={client} bus={bus} />
    </div>
  );
});
