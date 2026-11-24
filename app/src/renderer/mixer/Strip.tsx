// One MixConsole strip and the master strip (UI redesign spec 3.4, 3.0),
// ported from the mockup's strip() and master (m5-ui-port-mixer-strip, 10.10
// P1-12): the same elements and classes in the same order, styled by
// ui/lower-zone.css, on real data. Top to bottom (Cubase's order):
//
//   .ins          the insert rack (m5b-ui-inserts-master; mixer/InsertSlot.tsx):
//                 a .slot per plugin_slot and the .slot.empty in the positions left
//   .panrow       the PAN label, the knob (svg.knob, the pan slider), the value
//   .btns         M and S (.msr.m, .msr.s; .on from the track), the box of e
//   .fad          .scale (the dB labels at the taper's positions), .ftrack
//                 (the fader: .unity at 0 dB and the .cap), .meter (two .ch)
//   .readout      the level (a double-click types one) and the peak value (.pk)
//   .btns         R and W (empty boxes, m6a-ui-automation) and record enable
//                 (m5b-ui-recording; .msr.r, lit while armed), or an empty box
//                 on an engine without features.recording
//   .nametag      the name on the track colour (--c on the strip)
//
// The fader and the knob keep the behaviour of every value control
// (value-gesture.ts): a drag is one gesture through the GestureController
// (one revision at release), Shift is fine, Ctrl-click sets the default, an
// arrow key steps; the cap and the needle follow in the pointer handler. A
// tooltip shows the value during a drag. Mute and solo commit through
// command.execute and show only what the engine committed. The meter
// channels and the peak value are written by the Mixer's one meter canvas
// (MixerMeters); no meter value passes through React. The strip re-renders
// only when its track (with any gesture overlay) changes: it reads the read
// model's select() for its ref.
//
// The capability rule (spec 3.0): the insert rack exists only when the
// engine lists features.plugins, plugin.instantiate and plugin.registry
// (mixer/inserts.ts) and the Inserts rack switch is on; otherwise .ins is the
// empty box it was in M5. The fader and the knob exist only when
// engine.capabilities lists the gesture methods and feature and the command
// the gesture ends in (track.set_gain, track.set_pan); mute and solo only
// when it lists track.set_mute and track.set_solo. An unlisted control leaves
// its box empty. The level value always reads; it takes a typed value only
// when the fader exists.
//
// An empty box (spec 3.0) has no role, no focus, no data-part id and is
// hidden from assistive technology; the shared rules' rows and columns, or
// the --ms-w / --ms-h of the button it stands for, size it.
//
// The plan under review (m5b-ui-ghosts; UI redesign 4.2) adds to a strip what
// strip() draws for it: a gain change's step badge, the line from the real cap
// to the ghost cap (.gline, .cap.ghost) and both values in the readout (.to in
// the peak value's place); a pan change's badge in the PAN label's place,
// knob()'s ghost tick and the new value in --ai-2; a mute change's badge out
// of the flow and the dashed ring on M (.msr.ghost), a solo change's on S.
// The mockup has no markup for a removed track's strip (an added class,
// .ghost-removed, dims it) or both names of a rename (plans/RenameGhost.tsx,
// the tag's one grid item, so the pair stays on one line).
// A proposed track is a GhostStrip: strip() for the mockup's ghost track, its
// insert row an empty box and nothing to operate. A click on a ghost pins its
// step (plans/ghost-context.ts).
//
// The rack row (m5b-ui-sends-buses; UI redesign 3.4; 10.11, 24) shows the
// rack of the lit switch, one at a time: Inserts (the insert rack), Routing
// (mixer/OutputSelector.tsx: one .slot, the output selector) or Sends
// (mixer/SendSlot.tsx: a .slot per send by the two-slot rule); with none
// lit, or a rack the engine cannot show, it is the empty box. A bus strip
// (mixer/BusStrip.tsx) shares the pan row, the fader, the scale, the meter
// and the readout of this file.

import { memo, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { formatDb, formatPan } from '../format';
import { useLocale, useT } from '../i18n/t';
import type { MasterEntity, TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { LoudnessField } from '../model/loudness-store';
import type { Rack } from '../shell/layout';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, useGhostView, type GhostView } from '../plans/ghost-context';
import { masterGhosts, trackGhosts, type Ghost } from '../plans/ghosts';
import { useEditGuard } from '../plans/heard-context';
import { ISOLATE } from '../plans/isolate';
import { RenameGhost, renameTitle } from '../plans/RenameGhost';
import { useCapabilities } from '../shell/Capable';
import { Hold } from '../shell/Hold';
import { recordGates } from '../model/record';
import { useRecordHost } from '../shell/record-context';
import { RecordEnable } from '../shell/Recording';
import { trackColourVar } from '../timeline/track-colour';
import { InsertRack } from './InsertSlot';
import { pluginsListed } from './inserts';
import { RoutingRack } from './OutputSelector';
import { routingListed, sendsListed } from './routing';
import { SendRack } from './SendSlot';
import { Knob } from './Knob';
import { knobPaths } from './knob-paths';
import { MetersContext } from './meters-context';
import { isAboveCap, MINUS_INFINITY_MILLI_DB, milliDbToPosition } from './taper';
import { TypedValue, ValueReadout } from './ValueControl';
import { commitValue, formatValue, showTooltip, useValueGesture, type ValueGestures } from './value-gesture';

export interface StripProps {
  readonly trackId: string;
  readonly client: SessionClient;
  readonly gestures: GestureController;
  // The track list's selected track (the mockup's .sel).
  readonly selected?: boolean;
  // The rack the rack row shows (the lit rack switch; m5b-ui-inserts-master,
  // m5b-ui-sends-buses), or none: the empty box.
  readonly rack?: Rack | null;
}

// The track as the UI shows it (committed, or with the gesture's overlay).
export function useTrack(client: SessionClient, trackId: string | null): TrackEntity | undefined {
  const ref = trackId ? `track:${trackId}` : null;
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => (ref ? (client.model.select(ref) as TrackEntity | undefined) : undefined),
    () => (ref ? (client.model.select(ref) as TrackEntity | undefined) : undefined),
  );
}

// Mute or solo, flipped from what the engine committed.
export function toggleTrack(client: SessionClient, track: TrackEntity, op: 'track.set_mute' | 'track.set_solo'): void {
  const field = op === 'track.set_mute' ? 'mute' : 'solo';
  const revision = client.model.getSnapshot()?.revision;
  void client.execute([{ op, trackId: track.id, [field]: !track[field] }], revision).catch(() => undefined);
}

// The mockup's SCALE: the dB of each label and its text (no sign, as on a console).
const SCALE: ReadonlyArray<readonly [number, string]> = [
  [6, '6'],
  [0, '0'],
  [-6, '6'],
  [-12, '12'],
  [-24, '24'],
  [-40, '40'],
  [-60, '60'],
];

// A position of the travel as the mockup writes it in a bottom (or a left, a
// width): one decimal of a percent.
export const percent = (position: number) => `${(position * 100).toFixed(1)}%`;

// The fader's dB scale: the labels sit at the taper's positions (spec 4.5 C7).
export function Scale() {
  return (
    <div className="scale" data-part-of="scale" aria-hidden="true">
      {SCALE.map(([db, label]) => (
        <span key={db} style={{ bottom: percent(milliDbToPosition(db * 1000)) }}>
          {label}
        </span>
      ))}
    </div>
  );
}

// The meter: two channel wells the Mixer's canvas paints, and nothing else.
// The Meter tab (m5b-ui-meter) draws the master's with its own canvas; its
// wells are no strip's part (partOf null).
export function Meter({ meterRef, testId, partOf = 'meter' }: { meterRef: string; testId: string; partOf?: string | null }) {
  const meters = useContext(MetersContext);
  const left = useRef<HTMLDivElement | null>(null);
  const right = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!meters || !left.current || !right.current) return undefined;
    const offLeft = meters.slot(meterRef, 0, left.current);
    const offRight = meters.slot(meterRef, 1, right.current);
    return () => {
      offLeft();
      offRight();
    };
  }, [meters, meterRef]);
  return (
    <div className="meter" data-part-of={partOf ?? undefined} data-testid={testId}>
      <div className="ch" ref={left} />
      <div className="ch" ref={right} />
    </div>
  );
}

// The peak value (.pk): its text and clip class are written by the meter
// canvas; a click resets the hold lines, the peak and the clip.
export function PeakValue({ meterRef, testId, label }: { meterRef: string; testId: string; label: string }) {
  const meters = useContext(MetersContext);
  const peak = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!meters || !peak.current) return undefined;
    return meters.peak(meterRef, peak.current);
  }, [meters, meterRef]);
  return <button type="button" ref={peak} className="pk" data-testid={testId} aria-label={label} onClick={() => meters?.reset(meterRef)} />;
}

// A loudness value (m5b-ui-meter): its text is written by the meter surface
// from the LoudnessStore (formatLufs, -inf for silence), never by React.
export function LoudnessValue({ field, testId, style }: { field: LoudnessField; testId: string; style?: CSSProperties }) {
  const meters = useContext(MetersContext);
  const value = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!meters || !value.current) return undefined;
    return meters.loudness(field, value.current);
  }, [meters, field]);
  return <span ref={value} data-testid={testId} style={style} />;
}

// A gain ghost of a fader: the step, the old value (null when unknown) and the new one.
interface GainGhost {
  readonly step: number;
  readonly before: number | null;
  readonly after: number;
  // 'solid' while the proposal is heard (m5b-ui-audition).
  readonly mode?: 'solid';
}

interface FaderProps {
  // The gesture's entity: track:<id>, or master:master (m5b-ui-inserts-master).
  readonly entityRef: string;
  readonly value: number;
  // The test ids' stem (fader-<id>, fader-master) and the slider's name.
  readonly id: string;
  readonly label: string;
  readonly gestures: GestureController;
  readonly ghosts: readonly GainGhost[];
  readonly view: GhostView;
}

// The fader: the mockup's .ftrack with its unity line and cap; the slider. A
// track's and the master's alike (the master's has the track fader's taper).
export function Fader({ entityRef, value, id, label, gestures, ghosts, view }: FaderProps) {
  const ftrack = useRef<HTMLDivElement | null>(null);
  const cap = useRef<HTMLDivElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const position = milliDbToPosition(value);
  const handlers = useValueGesture<HTMLDivElement>({
    kind: 'gain',
    orientation: 'vertical',
    entityRef,
    value,
    gestures,
    // The cap is centred on its position, so the travel is the whole track.
    travel: () => ftrack.current?.clientHeight ?? 1,
    preview: (_next, at) => {
      if (cap.current) cap.current.style.bottom = percent(at);
    },
    tooltip: (text) => showTooltip(tooltip.current, text),
  });
  const text = formatValue('gain', value);
  return (
    <div
      ref={ftrack}
      className={`ftrack${isAboveCap(value) ? ' warn' : ''}`}
      data-part-of="fader"
      data-testid={`fader-${id}`}
      data-position={String(position)}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={MINUS_INFINITY_MILLI_DB}
      aria-valuemax={6000}
      aria-valuenow={value}
      aria-valuetext={text}
      {...handlers}
    >
      <div className="unity" style={{ bottom: percent(milliDbToPosition(0)) }} />
      {ghosts.map((g) => {
        const from = milliDbToPosition(g.mode === 'solid' ? value : (g.before ?? value));
        const to = milliDbToPosition(g.after);
        return [
          <div key={`l${g.step}`} className="gline" data-part-of="gain-line-ghost" {...ghostAttrs(view, [g.step], g.mode)} style={{ bottom: percent(Math.min(from, to)), height: percent(Math.abs(to - from)) }} />,
          <div
            key={`c${g.step}`}
            className="cap ghost"
            data-part-of="cap-ghost"
            data-testid={`fader-${id}-ghost-${g.step}`}
            {...ghostAttrs(view, [g.step], g.mode)}
            style={{ bottom: percent(to) }}
            onPointerDown={(event) => {
              event.stopPropagation();
              view.pin(g.step);
            }}
          />,
        ];
      })}
      <div className="cap" data-part-of="cap" ref={cap} {...(ghosts.some((g) => g.mode === 'solid') ? { 'data-replaced': 'true' } : {})} style={{ bottom: percent(position) }} />
      <span ref={tooltip} className="value-tooltip" data-testid={`fader-${id}-tooltip`} role="status" hidden />
    </div>
  );
}

export interface PanRowProps {
  // The test ids' stem (pan-<id>) and the name in the labels.
  readonly id: string;
  readonly name: string;
  readonly value: number;
  readonly entityRef: string;
  // The gesture controller, or a bus's releaseCommit() (one bus.set_pan at release).
  readonly gestures: ValueGestures;
  readonly listed: boolean;
  // The edit guard's reason (a bus's pan, a command, while a proposal is
  // heard): the knob stays, aria-disabled, with the reason as its tooltip,
  // and takes no gesture or typed value.
  readonly disabledReason?: string | null;
  readonly ghost?: Extract<Ghost, { kind: 'pan' }>;
  readonly view: GhostView;
}

// The pan row: the PAN label as the mockup styles it, the knob, the value. A
// track's and a bus's alike.
export function PanRow({ id, name, value, entityRef, gestures, listed, disabledReason = null, ghost, view }: PanRowProps) {
  const t = useT();
  const locale = useLocale();
  const row = useRef<HTMLDivElement | null>(null);
  const knob = useRef<SVGSVGElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const track = { id, name };
  const handlers = useValueGesture<SVGSVGElement>({
    kind: 'pan',
    orientation: 'horizontal',
    entityRef,
    value,
    gestures,
    // A drag across the pan row's width spans L100 to R100.
    travel: () => row.current?.clientWidth ?? 1,
    // The needle follows at once; the arc and the value text follow the
    // gesture's overlay when React renders it (text React owns is not written here).
    preview: (next) => {
      knob.current?.querySelector('[data-knob="needle"]')?.setAttribute('d', knobPaths(next).needle);
    },
    tooltip: (text) => showTooltip(tooltip.current, text),
  });
  const text = formatPan(value);
  // The mockup's label: right-aligned in --tx-4, the micro size in Latin, the 10.5 px size in Chinese.
  const label: CSSProperties = { textAlign: 'right', color: 'var(--tx-4)', fontSize: locale.startsWith('zh') ? 'var(--fs-10h)' : 'var(--fs-micro)' };
  return (
    <div className="panrow" data-part-of="pan" ref={row}>
      {ghost && ghost.step > 0 ? (
        <span className="lab" data-part-of="pan-step-ghost" {...ghostAttrs(view, [ghost.step])} style={{ display: 'flex', justifyContent: 'flex-end' }} onClick={() => view.pin(ghost.step)}>
          <span className="stepn">{String(ghost.step)}</span>
        </span>
      ) : (
        <span className="lab" style={label}>
          {t('strip.panRow')}
        </span>
      )}
      {listed && disabledReason !== null ? (
        <Knob
          pan={value}
          ghost={ghost?.after}
          ghostMode={ghost?.mode}
          ref={knob}
          data-part-of="pan-knob"
          data-testid={`pan-${track.id}`}
          role="slider"
          aria-disabled="true"
          aria-label={t('strip.panLabel', { track: track.name })}
          aria-orientation="horizontal"
          aria-valuemin={-10_000}
          aria-valuemax={10_000}
          aria-valuenow={value}
          aria-valuetext={text}
          tooltip={disabledReason}
        />
      ) : listed ? (
        <Knob
          pan={value}
          ghost={ghost?.after}
          ghostMode={ghost?.mode}
          ref={knob}
          data-part-of="pan-knob"
          data-testid={`pan-${track.id}`}
          role="slider"
          tabIndex={0}
          aria-label={t('strip.panLabel', { track: track.name })}
          aria-orientation="horizontal"
          aria-valuemin={-10_000}
          aria-valuemax={10_000}
          aria-valuenow={value}
          aria-valuetext={text}
          {...handlers}
          onDoubleClick={() => setEditing(true)}
        />
      ) : (
        <Hold className="knob" />
      )}
      <span
        className="lab"
        data-testid={`pan-value-${track.id}`}
        {...(ghost ? { 'data-part-of': 'pan-value-ghost', ...ghostAttrs(view, [ghost.step], ghost.mode), style: { color: 'var(--ai-2)' } } : {})}
      >
        {editing ? (
          <TypedValue
            kind="pan"
            initial={text}
            testId={`pan-input-${track.id}`}
            label={t('strip.panInput', { track: track.name })}
            onDone={(typed) => {
              setEditing(false);
              if (typed !== null) commitValue(gestures, entityRef, 'pan', typed);
            }}
          />
        ) : ghost ? (
          formatPan(ghost.after)
        ) : (
          text
        )}
      </span>
      <span ref={tooltip} className="value-tooltip" data-testid={`pan-${track.id}-tooltip`} role="status" hidden />
    </div>
  );
}

// A track strip's rack row: the rack of the lit switch, when the engine can show it.
function TrackRack({ client, gestures, track, rack, view }: { client: SessionClient; gestures: GestureController; track: TrackEntity; rack: Rack | null; view: GhostView }) {
  const can = useCapabilities();
  if (rack === 'inserts' && pluginsListed(can)) return <InsertRack client={client} owner={{ kind: 'track', id: track.id, name: track.name, inserts: track.inserts }} view={view} />;
  if (rack === 'routing' && routingListed(can)) return <RoutingRack client={client} owner={{ kind: 'track', id: track.id }} name={track.name} />;
  if (rack === 'sends' && sendsListed(can)) return <SendRack client={client} gestures={gestures} track={track} view={view} />;
  return <div className="ins" aria-hidden="true" />;
}

export const Strip = memo(function Strip({ trackId, client, gestures, selected = false, rack = 'inserts' }: StripProps) {
  const t = useT();
  const can = useCapabilities();
  const record = useRecordHost();
  const recordHost = record && recordGates(can).record ? record : null;
  const track = useTrack(client, trackId);
  const view = useGhostView();
  const guard = useEditGuard();
  if (!track) return null;
  const ghosts = trackGhosts(view.ghosts, trackId);
  const gain = ghosts.gain.at(-1);
  const mute = ghosts.mute.at(-1);
  const solo = ghosts.solo.at(-1);
  const rename = ghosts.rename.at(-1);
  const ref = `track:${trackId}`;
  const gesturable = can.has('gesture.begin') && can.feature('gestures');
  const faderListed = gesturable && can.command('track.set_gain');
  const panListed = gesturable && can.command('track.set_pan');
  const style = { '--c': `var(${trackColourVar(trackId)})` } as CSSProperties;
  const classes = ['strip', track.mute ? 'muted' : '', selected ? 'sel' : '', ghosts.remove ? 'ghost-removed' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={classes}
      data-testid={`mixer-strip-${trackId}`}
      data-part-item="strip"
      role="group"
      aria-label={track.name}
      style={style}
      {...(ghosts.steps.length > 0 ? ghostAttrs(view, ghosts.steps) : {})}
    >
      {gain && gain.step > 0 ? (
        <span className="stepn" data-part-of="gain-step-ghost" {...ghostAttrs(view, [gain.step])} style={{ right: 'var(--space)', top: 'var(--strip-gain-step-top)' }} onClick={() => view.pin(gain.step)}>
          {String(gain.step)}
        </span>
      ) : null}
      <TrackRack client={client} gestures={gestures} track={track} rack={rack} view={view} />
      <PanRow id={track.id} name={track.name} value={track.pan} entityRef={ref} gestures={gestures} listed={panListed} ghost={ghosts.pan.at(-1)} view={view} />
      <div className="btns" data-part-of="buttons">
        {mute && mute.step > 0 ? (
          <span className="stepn" data-part-of="mute-step-ghost" {...ghostAttrs(view, [mute.step])} style={{ position: 'absolute', zIndex: 2, left: 0 }} onClick={() => view.pin(mute.step)}>
            {String(mute.step)}
          </span>
        ) : null}
        {solo && solo.step > 0 ? (
          <span className="stepn" data-part-of="solo-step-ghost" {...ghostAttrs(view, [solo.step])} style={{ position: 'absolute', zIndex: 2, left: 'var(--ms-w)' }} onClick={() => view.pin(solo.step)}>
            {String(solo.step)}
          </span>
        ) : null}
        {can.command('track.set_mute') ? (
          <button type="button" className={`msr m${track.mute ? ' on' : ''}${mute ? ' ghost' : ''}`} data-testid={`mute-${trackId}`} data-part-of="mute" {...(mute?.mode ? { 'data-ghost-mode': mute.mode } : {})} disabled={guard !== null} title={guard ?? undefined} aria-label={t('strip.muteLabel', { track: track.name })} aria-pressed={track.mute} onClick={() => toggleTrack(client, track, 'track.set_mute')}>
            M
          </button>
        ) : (
          <Hold className="msr-box" />
        )}
        {can.command('track.set_solo') ? (
          <button type="button" className={`msr s${track.solo ? ' on' : ''}${solo ? ' ghost' : ''}`} data-testid={`solo-${trackId}`} data-part-of="solo" {...(solo?.mode ? { 'data-ghost-mode': solo.mode } : {})} disabled={guard !== null} title={guard ?? undefined} aria-label={t('strip.soloLabel', { track: track.name })} aria-pressed={track.solo} onClick={() => toggleTrack(client, track, 'track.set_solo')}>
            S
          </button>
        ) : (
          <Hold className="msr-box" />
        )}
        <Hold className="msr-box" />
      </div>
      <div className="fad" data-part-of="fader-area">
        <Scale />
        {faderListed ? (
          <Fader entityRef={ref} value={track.gainMilliDb} id={trackId} label={t('strip.gainLabel', { track: track.name })} gestures={gestures} ghosts={ghosts.gain} view={view} />
        ) : (
          <div aria-hidden="true" />
        )}
        <Meter meterRef={ref} testId={`meter-${trackId}`} />
      </div>
      <div className="readout" data-part-of="readout">
        <ValueReadout
          kind="gain"
          entityRef={ref}
          value={track.gainMilliDb}
          gestures={gestures}
          testId={`fader-value-${trackId}`}
          label={t('strip.levelLabel', { track: track.name })}
          typing={faderListed ? { testId: `gain-input-${trackId}`, label: t('strip.gainInput', { track: track.name }) } : undefined}
        />
        {gain ? (
          <span className="to" data-testid={`fader-value-${trackId}-ghost`} {...ghostAttrs(view, [gain.step], gain.mode)}>
            {`→ ${formatDb(gain.after).replace(/ dB$/, '')}`}
          </span>
        ) : (
          <PeakValue meterRef={ref} testId={`peak-value-${trackId}`} label={t('strip.peakLabel', { track: track.name })} />
        )}
      </div>
      {recordHost ? (
        <div className="btns">
          <Hold className="msr-box" />
          <Hold className="msr-box" />
          <RecordEnable host={recordHost} track={track} testId={`strip-record-${trackId}`} partOf="record" />
        </div>
      ) : (
        <div className="btns" aria-hidden="true" />
      )}
      <div className="nametag" data-testid={`strip-name-${trackId}`} data-part-of="name" dir={ISOLATE.dir} style={{ ...ISOLATE.style }} title={renameTitle(track.name, rename?.after)}>
        {rename ? <RenameGhost before={track.name} after={rename.after} step={rename.step} view={view} /> : track.name}
      </div>
    </div>
  );
});

// A proposed track's strip (m5b-ui-ghosts): strip() for the mockup's ghost
// track, .strip.ghost on the AI colour, its rows with the mockup's ids, NEW ·
// STEP n in its buttons row, the fader at 0 dB and C, its insert row an empty
// box (a proposed track has no slots) and nothing to operate. A click pins
// its step.
// A proposed bus (m5b-ui-sends-buses) is the same dashed strip, after the bus strips.
export function GhostStrip({ ghost, view }: { ghost: Extract<Ghost, { kind: 'track-add' | 'bus-add' }>; view: GhostView }) {
  const t = useT();
  const locale = useLocale();
  const label: CSSProperties = { textAlign: 'right', color: 'var(--tx-4)', fontSize: locale.startsWith('zh') ? 'var(--fs-10h)' : 'var(--fs-micro)' };
  const tag: CSSProperties = { fontSize: 'var(--fs-9h)', color: 'var(--ai-2)', fontWeight: 'var(--fw-strong)', letterSpacing: 'var(--letter-spacing-04)' } as CSSProperties;
  const unity = percent(milliDbToPosition(0));
  return (
    <div
      className="strip ghost"
      data-testid={`mixer-strip-${ghost.key}`}
      data-part-item="strip"
      data-part-key={ghost.key}
      role="group"
      aria-label={t(ghost.kind === 'bus-add' ? 'ghost.proposedBus' : 'ghost.proposedTrack', { name: ghost.name })}
      style={{ '--c': 'var(--ai)' } as CSSProperties}
      {...ghostAttrs(view, [ghost.step], ghost.mode)}
      onClick={() => view.pin(ghost.step)}
    >
      <div className="ins" data-part-of="inserts" aria-hidden="true" />
      <div className="panrow" data-part-of="pan">
        <span className="lab" style={label}>
          {t('strip.panRow')}
        </span>
        <Knob pan={0} data-part-of="pan-knob" aria-hidden="true" />
        <span className="lab">{formatPan(0)}</span>
      </div>
      <div className="btns" data-part-of="buttons">
        <span style={tag}>{t('ghost.newStep', { n: ghost.step })}</span>
      </div>
      <div className="fad" data-part-of="fader-area">
        <Scale />
        <div className="ftrack" data-part-of="fader">
          <div className="unity" style={{ bottom: unity }} />
          <div className="cap" data-part-of="cap" style={{ bottom: unity }} />
        </div>
        <div className="meter" data-part-of="meter">
          <div className="ch" />
          <div className="ch" />
        </div>
      </div>
      <div className="readout" data-part-of="readout">
        <span>{formatDb(0)}</span>
        <span className="pk" />
      </div>
      <div className="btns" data-part-of="automation" />
      <div className="nametag" data-part-of="name" dir={ISOLATE.dir} style={{ ...ISOLATE.style }} title={ghost.name}>
        {ghost.name}
      </div>
    </div>
  );
}

// The master gain as the UI shows it: master:master (committed, or with the
// gesture's overlay), 0 dB while the entity is absent.
export function useMasterGain(client: SessionClient): number {
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => (client.model.select('master:master') as MasterEntity | undefined)?.gainMilliDb ?? 0,
    () => (client.model.select('master:master') as MasterEntity | undefined)?.gainMilliDb ?? 0,
  );
}

const MASTER_REF = 'master:master';

// The master's loudness row (m5b-ui-meter; the mockup's master, line 201):
// .panrow with the LUFS-S label and the short-term value, on an engine that
// lists features.loudness; the empty .panrow the shared rules size otherwise.
function LoudnessRow() {
  const t = useT();
  const can = useCapabilities();
  if (!can.feature('loudness')) return <div className="panrow" aria-hidden="true" />;
  return (
    <div className="panrow" data-part-of="loudness" data-testid="strip-master-loudness">
      <span style={{ color: 'var(--tx-4)' }}>{t('strip.loudnessShortTerm')}</span>
      <LoudnessValue field="shortTerm" testId="strip-master-lufs" style={{ color: 'var(--tx-1)' }} />
    </div>
  );
}

// The master strip (the mockup's master): the dB scale, the fader
// (m5b-ui-inserts-master: the mockup's .ftrack with its unity line and cap,
// bound to master:master with the track fader's taper and modifiers, one
// master.set_gain per gesture) and the meter in its fader area, the level and
// the peak value, the name. Without features.masterGain, master.set_gain or
// the gesture methods it is the M5 meter: the fader column an empty box, the
// readout the peak value only. Its loudness row is LoudnessRow (m5b-ui-meter).
// The master's M, rack and e are M6c's (m6c-ui-master-channel; spec 3.0): they
// stay empty boxes, as does its automation row. A plan's master.set_gain adds
// the ghost cap joined to the real cap and both values (UI redesign 4.2).
export function MasterStrip({ client, gestures }: { client: SessionClient; gestures: GestureController }) {
  const t = useT();
  const can = useCapabilities();
  const view = useGhostView();
  const value = useMasterGain(client);
  const style = { '--c': 'var(--lit-1)' } as CSSProperties;
  const listed = can.has('gesture.begin') && can.feature('gestures') && can.feature('masterGain') && can.command('master.set_gain');
  const ghosts = listed ? masterGhosts(view.ghosts) : [];
  const ghost = ghosts.at(-1);
  const name = t('strip.master');
  return (
    <div
      className="strip master"
      data-testid="mixer-strip-master"
      data-part-item="strip"
      data-part-key="master"
      role="group"
      aria-label={name}
      style={style}
      {...(ghosts.length > 0 ? ghostAttrs(view, ghosts.map((g) => g.step)) : {})}
    >
      <div className="ins" aria-hidden="true" />
      <LoudnessRow />
      <div className="btns" aria-hidden="true" />
      <div className="fad" data-part-of="fader-area">
        <Scale />
        {listed ? <Fader entityRef={MASTER_REF} value={value} id="master" label={t('strip.gainLabel', { track: name })} gestures={gestures} ghosts={ghosts} view={view} /> : <div aria-hidden="true" />}
        <Meter meterRef="master" testId="meter-master" />
      </div>
      <div className="readout" data-part-of="readout">
        {listed ? (
          <ValueReadout
            kind="gain"
            entityRef={MASTER_REF}
            value={value}
            gestures={gestures}
            testId="fader-value-master"
            label={t('strip.levelLabel', { track: name })}
            typing={{ testId: 'gain-input-master', label: t('strip.gainInput', { track: name }) }}
          />
        ) : null}
        {ghost ? (
          <span className="to" data-testid="fader-value-master-ghost" {...ghostAttrs(view, [ghost.step], ghost.mode)}>
            {`→ ${formatDb(ghost.after).replace(/ dB$/, '')}`}
          </span>
        ) : (
          <PeakValue meterRef="master" testId="peak-value-master" label={t('strip.peakLabel', { track: name })} />
        )}
      </div>
      <div className="btns" aria-hidden="true" />
      <div className="nametag" data-part-of="name">
        {t('strip.master')}
      </div>
    </div>
  );
}
