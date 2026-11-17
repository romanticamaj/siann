// The left zone: the Inspector (UI redesign spec 3.4, 2.1), ported from the
// mockup's markup (m5-ui-port-inspector, 10.10 P1-14): the block of the
// app.innerHTML template inside aside.leftzone, with the same elements and
// classes in the same order, styled by ui/left-zone.css (and .msr by
// ui/project-zone.css), on the selected track of the read model. Top to bottom:
//
//   .z-head      the title and the key hint of the zone (.k)
//   .i-track     the track block, its left stripe in the track's colour:
//     .i-name    the colour swatch, the name, mono or stereo (<small>)
//     .i-btns    M and S (.msr.m, .msr.s; .on from the track), then the boxes
//                of record, monitor, read, write and e
//     .i-row     Volume: the label, the slider (.hs: its fill <i> and thumb <u>
//                at the taper's position), the value (b.num, dB)
//     .i-row     Pan: the label, the slider (its thumb only), the value (C, L35)
//   six boxes    where sec() draws Routing, Inserts, Sends, Automation, Agent
//                changes and Notepad
//   .z-foot      the Track tab and the box of Editor
//
// The track is the app's selected track (trackId: a header clicked, or the
// selected clip's track), read with the strip's own select() (useTrack), so a
// gesture overlay, a rename or a change made elsewhere shows here and in the
// strip alike. Volume, pan, M and S issue the strip's commands: the sliders
// are value controls (value-gesture.ts: a drag is one gesture and one
// revision, Shift is fine, Ctrl-click sets the default, an arrow key steps;
// the fill and the thumb follow in the pointer handler), a double-click on a
// value types one, and M and S commit through command.execute. With no track
// selected, the zone holds its head and foot and nothing between them.
//
// An absent part keeps its space empty (spec 3.0): the boxes have no role, no
// focus, no data-part id and are hidden from assistive technology; shell.css
// sizes them (the open sections by --hold-inspector-*-h until the features
// that land them, m5b-ui-sends-buses, m5b-ui-inserts-master, m5b-ui-ghosts;
// the shut ones and the buttons by the shared rules' sizes). The capability
// rule (3.0): an unlisted control leaves its box.

import { useRef, type CSSProperties } from 'react';

import { useT } from '../i18n/t';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import { percent, toggleTrack, useTrack } from '../mixer/Strip';
import { isAboveCap, MINUS_INFINITY_MILLI_DB } from '../mixer/taper';
import { ValueReadout } from '../mixer/ValueControl';
import type { ValueKind } from '../mixer/value-control';
import { formatValue, showTooltip, toPosition, useValueGesture } from '../mixer/value-gesture';
import type { TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { ISOLATE } from '../plans/isolate';
import { trackColourVar } from '../timeline/track-colour';
import { useCapabilities } from './Capable';
import { Hold } from './Hold';

export interface InspectorProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly trackId: string | null;
}

// The zone's key hint: the preset's last chord that shows it (Alt+I, as the mockup writes it).
const KEY_HINT = CUBASE_PRESET.filter((binding) => binding.commandId === 'zone.left.toggle').at(-1)?.chord ?? '';

// The sections sec() draws, in its order; an open one holds a body in the mockup.
const SECTIONS: ReadonlyArray<readonly [string, boolean]> = [
  ['routing', true],
  ['inserts', true],
  ['sends', false],
  ['automation', false],
  ['agent-changes', true],
  ['notepad', false],
];

interface SliderProps {
  readonly kind: ValueKind;
  readonly track: TrackEntity;
  readonly gestures: GestureController;
  readonly testId: string;
  readonly label: string;
}

// The mockup's .hs: the volume slider has its fill (<i>) and thumb (<u>), the
// pan slider its thumb only; both at the value's position of the travel.
function Slider({ kind, track, gestures, testId, label }: SliderProps) {
  const slider = useRef<HTMLSpanElement | null>(null);
  const fill = useRef<HTMLElement | null>(null);
  const thumb = useRef<HTMLElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const gain = kind === 'gain';
  const value = gain ? track.gainMilliDb : track.pan;
  const position = toPosition(kind, value);
  const handlers = useValueGesture<HTMLSpanElement>({
    kind,
    orientation: 'horizontal',
    entityRef: `track:${track.id}`,
    value,
    gestures,
    // The thumb is centred on its position, so the travel is the whole slider.
    travel: () => slider.current?.clientWidth ?? 1,
    preview: (_next, at) => {
      if (fill.current) fill.current.style.width = percent(at);
      if (thumb.current) thumb.current.style.left = percent(at);
    },
    tooltip: (text) => showTooltip(tooltip.current, text),
  });
  return (
    <span
      ref={slider}
      className={`hs${gain && isAboveCap(value) ? ' warn' : ''}`}
      data-testid={testId}
      data-position={String(position)}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={gain ? MINUS_INFINITY_MILLI_DB : -10_000}
      aria-valuemax={gain ? 6000 : 10_000}
      aria-valuenow={value}
      aria-valuetext={formatValue(kind, value)}
      {...handlers}
    >
      {gain ? <i ref={fill} style={{ width: percent(position) }} /> : null}
      <u ref={thumb} style={{ left: percent(position) }} />
      <span ref={tooltip} className="value-tooltip" data-testid={`${testId}-tooltip`} role="status" hidden />
    </span>
  );
}

function Head() {
  const t = useT();
  return (
    <div className="z-head" data-part="inspector-head">
      {t('inspector.label')}
      <span className="k">{KEY_HINT}</span>
    </div>
  );
}

// The Track tab, and the box of Editor (m5b-ui-editor-channel).
function Foot() {
  const t = useT();
  return (
    <div className="z-foot" data-part="inspector-tabs">
      <span className="on">{t('tab.track')}</span>
      <span aria-hidden="true" />
    </div>
  );
}

export function Inspector({ client, gestures, trackId }: InspectorProps) {
  const t = useT();
  const can = useCapabilities();
  const track = useTrack(client, trackId);
  if (!track) {
    return (
      <>
        <Head />
        <Foot />
      </>
    );
  }
  const ref = `track:${track.id}`;
  const colour = `var(${trackColourVar(track.id)})`;
  const gesturable = can.has('gesture.begin') && can.feature('gestures');
  const gainListed = gesturable && can.command('track.set_gain');
  const panListed = gesturable && can.command('track.set_pan');
  // The swatch as the mockup styles it inline, in the track's colour.
  const swatch: CSSProperties = { width: 'var(--inspector-swatch)', height: 'var(--inspector-swatch)', borderRadius: 'var(--radius-s)', background: colour };
  // The shared rule draws the stripe in Vox Lead's colour (--track-6); here it is the selected track's.
  const stripe: CSSProperties = { boxShadow: `inset var(--space-3q) 0 0 ${colour}` };
  return (
    <>
      <Head />
      <div className="i-track" data-part="inspector-track" style={stripe}>
        <div className="i-name" data-part="inspector-name">
          <span data-testid="inspector-colour" style={swatch} />
          <span data-testid="inspector-track" dir={ISOLATE.dir} style={{ ...ISOLATE.style }}>
            {track.name}
          </span>
          <small>{t(track.channels === 1 ? 'inspector.mono' : 'inspector.stereo')}</small>
        </div>
        <div className="i-btns" data-part="inspector-buttons">
          {can.command('track.set_mute') ? (
            <button type="button" className={`msr m${track.mute ? ' on' : ''}`} data-testid="inspector-mute" data-part="inspector-mute" aria-label={t('strip.muteLabel', { track: track.name })} aria-pressed={track.mute} onClick={() => toggleTrack(client, track, 'track.set_mute')}>
              M
            </button>
          ) : (
            <Hold className="msr-box" />
          )}
          {can.command('track.set_solo') ? (
            <button type="button" className={`msr s${track.solo ? ' on' : ''}`} data-testid="inspector-solo" data-part="inspector-solo" aria-label={t('strip.soloLabel', { track: track.name })} aria-pressed={track.solo} onClick={() => toggleTrack(client, track, 'track.set_solo')}>
              S
            </button>
          ) : (
            <Hold className="msr-box" />
          )}
          {/* Record and monitor (m5b-ui-recording), read and write (m6a-ui-automation), e (m5b-ui-inserts-master). */}
          <Hold className="msr-box" />
          <Hold className="msr-box" />
          <Hold className="msr-box" />
          <Hold className="msr-box" />
          <Hold className="msr-box" />
        </div>
        <div className="i-row" data-part="inspector-volume">
          <span>{t('inspector.volume')}</span>
          {gainListed ? <Slider kind="gain" track={track} gestures={gestures} testId="inspector-volume" label={t('strip.gainLabel', { track: track.name })} /> : <Hold className="hs-box" />}
          <ValueReadout
            tag="b"
            className="num"
            kind="gain"
            entityRef={ref}
            value={track.gainMilliDb}
            gestures={gestures}
            testId="inspector-volume-value"
            label={t('strip.levelLabel', { track: track.name })}
            typing={gainListed ? { testId: 'inspector-volume-input', label: t('strip.gainInput', { track: track.name }) } : undefined}
          />
        </div>
        <div className="i-row" data-part="inspector-pan">
          <span>{t('strip.pan')}</span>
          {panListed ? <Slider kind="pan" track={track} gestures={gestures} testId="inspector-pan" label={t('strip.panLabel', { track: track.name })} /> : <Hold className="hs-box" />}
          <ValueReadout
            tag="b"
            className="num"
            kind="pan"
            entityRef={ref}
            value={track.pan}
            gestures={gestures}
            testId="inspector-pan-value"
            label={t('strip.panLabel', { track: track.name })}
            typing={panListed ? { testId: 'inspector-pan-input', label: t('strip.panInput', { track: track.name }) } : undefined}
          />
        </div>
      </div>
      {SECTIONS.map(([name, open]) => (
        <Hold key={name} className={`inspector-hold ${name}${open ? '' : ' shut'}`} />
      ))}
      <Foot />
    </>
  );
}
