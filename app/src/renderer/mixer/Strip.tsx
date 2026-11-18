// One MixConsole strip and the master strip (UI redesign spec 3.4, 3.0),
// ported from the mockup's strip() and master (m5-ui-port-mixer-strip, 10.10
// P1-12): the same elements and classes in the same order, styled by
// ui/lower-zone.css, on real data. Top to bottom (Cubase's order):
//
//   .ins          the insert rack: an empty box until m5b-ui-inserts-master
//   .panrow       the PAN label, the knob (svg.knob, the pan slider), the value
//   .btns         M and S (.msr.m, .msr.s; .on from the track), the box of e
//   .fad          .scale (the dB labels at the taper's positions), .ftrack
//                 (the fader: .unity at 0 dB and the .cap), .meter (two .ch)
//   .readout      the level (a double-click types one) and the peak value (.pk)
//   .btns         R, W and record: an empty box (m6a-ui-automation, m5b-ui-recording)
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
// The capability rule (spec 3.0): the fader and the knob exist only when
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

import { memo, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { formatDb, formatPan } from '../format';
import { useLocale, useT } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, useGhostView, type GhostView } from '../plans/ghost-context';
import { trackGhosts, type Ghost, type TrackGhosts } from '../plans/ghosts';
import { useEditGuard } from '../plans/heard-context';
import { ISOLATE } from '../plans/isolate';
import { RenameGhost, renameTitle } from '../plans/RenameGhost';
import { useCapabilities } from '../shell/Capable';
import { Hold } from '../shell/Hold';
import { trackColourVar } from '../timeline/track-colour';
import { Knob } from './Knob';
import { knobPaths } from './knob-paths';
import { MetersContext } from './meters-context';
import { isAboveCap, MINUS_INFINITY_MILLI_DB, milliDbToPosition } from './taper';
import { TypedValue, ValueReadout } from './ValueControl';
import { commitValue, formatValue, showTooltip, useValueGesture } from './value-gesture';

export interface StripProps {
  readonly trackId: string;
  readonly client: SessionClient;
  readonly gestures: GestureController;
  // The track list's selected track (the mockup's .sel).
  readonly selected?: boolean;
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
function Scale() {
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
function Meter({ meterRef, testId }: { meterRef: string; testId: string }) {
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
    <div className="meter" data-part-of="meter" data-testid={testId}>
      <div className="ch" ref={left} />
      <div className="ch" ref={right} />
    </div>
  );
}

// The peak value (.pk): its text and clip class are written by the meter
// canvas; a click resets the hold lines, the peak and the clip.
function PeakValue({ meterRef, testId, label }: { meterRef: string; testId: string; label: string }) {
  const meters = useContext(MetersContext);
  const peak = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!meters || !peak.current) return undefined;
    return meters.peak(meterRef, peak.current);
  }, [meters, meterRef]);
  return <button type="button" ref={peak} className="pk" data-testid={testId} aria-label={label} onClick={() => meters?.reset(meterRef)} />;
}

interface ControlProps {
  readonly track: TrackEntity;
  readonly gestures: GestureController;
}

// The fader: the mockup's .ftrack with its unity line and cap; the slider.
function Fader({ track, gestures, ghosts, view }: ControlProps & { ghosts: TrackGhosts['gain']; view: GhostView }) {
  const t = useT();
  const ftrack = useRef<HTMLDivElement | null>(null);
  const cap = useRef<HTMLDivElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const value = track.gainMilliDb;
  const position = milliDbToPosition(value);
  const handlers = useValueGesture<HTMLDivElement>({
    kind: 'gain',
    orientation: 'vertical',
    entityRef: `track:${track.id}`,
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
      data-testid={`fader-${track.id}`}
      data-position={String(position)}
      role="slider"
      tabIndex={0}
      aria-label={t('strip.gainLabel', { track: track.name })}
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
            data-testid={`fader-${track.id}-ghost-${g.step}`}
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
      <span ref={tooltip} className="value-tooltip" data-testid={`fader-${track.id}-tooltip`} role="status" hidden />
    </div>
  );
}

// The pan row: the PAN label as the mockup styles it, the knob, the value.
function PanRow({ track, gestures, listed, ghost, view }: ControlProps & { listed: boolean; ghost?: Extract<Ghost, { kind: 'pan' }>; view: GhostView }) {
  const t = useT();
  const locale = useLocale();
  const row = useRef<HTMLDivElement | null>(null);
  const knob = useRef<SVGSVGElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const value = track.pan;
  const entityRef = `track:${track.id}`;
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
      {listed ? (
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

export const Strip = memo(function Strip({ trackId, client, gestures, selected = false }: StripProps) {
  const t = useT();
  const can = useCapabilities();
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
      <div className="ins" aria-hidden="true" />
      <PanRow track={track} gestures={gestures} listed={panListed} ghost={ghosts.pan.at(-1)} view={view} />
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
        {faderListed ? <Fader track={track} gestures={gestures} ghosts={ghosts.gain} view={view} /> : <div aria-hidden="true" />}
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
      <div className="btns" aria-hidden="true" />
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
export function GhostStrip({ ghost, view }: { ghost: Extract<Ghost, { kind: 'track-add' }>; view: GhostView }) {
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
      aria-label={t('ghost.proposedTrack', { name: ghost.name })}
      style={{ '--c': 'var(--ai)' } as CSSProperties}
      {...ghostAttrs(view, [ghost.step])}
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

// The master strip (the mockup's master): the dB scale and the meter in its
// fader area, the peak value and the name. Its fader, buttons, inserts and
// loudness row are m5b-ui-inserts-master's and m5b-ui-meter's (spec 3.0, E-11)
// and stay empty boxes; so do its automation row and its fader column.
export function MasterStrip() {
  const t = useT();
  const style = { '--c': 'var(--lit-1)' } as CSSProperties;
  return (
    <div className="strip master" data-testid="mixer-strip-master" data-part-item="strip" data-part-key="master" role="group" aria-label={t('strip.master')} style={style}>
      <div className="ins" aria-hidden="true" />
      <div className="panrow" aria-hidden="true" />
      <div className="btns" aria-hidden="true" />
      <div className="fad" data-part-of="fader-area">
        <Scale />
        <div aria-hidden="true" />
        <Meter meterRef="master" testId="meter-master" />
      </div>
      <div className="readout" data-part-of="readout">
        <PeakValue meterRef="master" testId="peak-value-master" label={t('strip.peakLabel', { track: t('strip.master') })} />
      </div>
      <div className="btns" aria-hidden="true" />
      <div className="nametag" data-part-of="name">
        {t('strip.master')}
      </div>
    </div>
  );
}
