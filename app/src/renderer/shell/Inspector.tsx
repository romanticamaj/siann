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
//   five boxes   where sec() draws Routing, Inserts, Sends, Automation and
//                Notepad, and between the last two the Agent changes section
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
// that land them, m5b-ui-sends-buses and m5b-ui-inserts-master; the shut ones
// and the buttons by the shared rules' sizes). The capability rule (3.0): an
// unlisted control leaves its box.
//
// Agent changes (m5b-ui-ghosts; UI redesign 4.2, 4.4) is the mockup's
// sec('Agent changes'): a .hist row for each applied plan that touched the
// track ("r31 · <its step on the track> by <b>plan</b> · N steps", the plan
// named by plans/plan-name.ts until E-7), then a row for each ticked step of
// the plan under review on the track, or the mockup's "No pending change on
// this track."; a step is on the track when it names it or one of its clips
// (plans/track-steps.ts), and the rows come from the plan, so they stay while
// the ghosts are toggled off. The Volume and Pan values show the pending value
// after them (.ghost-to; the current one then without its unit, and shell.css
// lets the value column grow), the name both names of a rename
// (plans/RenameGhost.tsx): elements the mockup has no markup for. The sliders
// carry them too, as the strip's fader and knob do: the Volume slider a ghost
// thumb (.ghost-thumb, the look of the strip's .cap.ghost) at each ticked
// step's new position, joined to the one before it, the real thumb for the
// first, by a violet line (.ghost-line, the strip's .gline); the Pan slider a
// violet tick (.ghost-tick, the knob's ghost needle and its dot). They are
// aria-hidden (the value text says both values) and leave with the ghosts. A
// pending mute or solo rings M or S (.msr.ghost), as the header and the strip do.

import { useRef, useSyncExternalStore, type CSSProperties, type PointerEvent } from 'react';

import { formatDb, formatPan } from '../format';
import { useT } from '../i18n/t';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import { percent, toggleTrack, useTrack } from '../mixer/Strip';
import { isAboveCap, MINUS_INFINITY_MILLI_DB } from '../mixer/taper';
import { ValueReadout } from '../mixer/ValueControl';
import type { ValueKind } from '../mixer/value-control';
import { formatValue, showTooltip, toPosition, useValueGesture } from '../mixer/value-gesture';
import type { TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { describeStep } from '../plans/describe';
import { ghostAttrs, useGhostView, type GhostView } from '../plans/ghost-context';
import { trackGhosts, type ValueGhost } from '../plans/ghosts';
import { useStepNames } from '../plans/hooks';
import { ISOLATE } from '../plans/isolate';
import { planNameParts } from '../plans/plan-name';
import { RenameGhost } from '../plans/RenameGhost';
import { stepsOnTrack } from '../plans/track-steps';
import { Icon } from './icons';
import { trackColourVar } from '../timeline/track-colour';
import { useCapabilities } from './Capable';
import { Hold } from './Hold';

export interface InspectorProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly trackId: string | null;
  // The plans, for the Agent changes section (m5b-ui-ghosts).
  readonly plans?: PlanStore;
}

// The zone's key hint: the preset's last chord that shows it (Alt+I, as the mockup writes it).
const KEY_HINT = CUBASE_PRESET.filter((binding) => binding.commandId === 'zone.left.toggle').at(-1)?.chord ?? '';

// The sections sec() draws, in its order, as the classes of their empty boxes
// (spec 3.0): the section's name, and .shut where the mockup draws it shut (an
// open one holds a body in the mockup). A literal table, so every class is
// spelled out (m5-ui-port-cleanup).
const SECTIONS = ['routing', 'inserts', 'sends', 'automation'] as const;
const SECTION_HOLDS: Readonly<Record<(typeof SECTIONS)[number] | 'notepad', string>> = {
  routing: 'inspector-hold routing',
  inserts: 'inspector-hold inserts',
  sends: 'inspector-hold sends shut',
  automation: 'inspector-hold automation shut',
  notepad: 'inspector-hold notepad shut',
};

const NO_PLANS = { subscribe: () => () => undefined, getSnapshot: () => null };

// sec('Agent changes') for the track: the applied plans that touched it, then what is pending on it.
function AgentChanges({ client, track, plans }: { client: SessionClient; track: TrackEntity; plans?: PlanStore }) {
  const t = useT();
  const can = useCapabilities();
  const names = useStepNames(client);
  const view = useGhostView();
  const store = plans ?? NO_PLANS;
  const snapshot = useSyncExternalStore((l) => store.subscribe(l), () => store.getSnapshot(), () => store.getSnapshot());
  const session = useSyncExternalStore((l) => client.model.subscribe(l), () => client.model.getSnapshot(), () => client.model.getSnapshot());
  const clipTrack = (clipId: string) => {
    const clip = session?.entities[`clip:${clipId}` as keyof NonNullable<typeof session>['entities']] as { trackId?: unknown } | undefined;
    return typeof clip?.trackId === 'string' ? clip.trackId : undefined;
  };
  // The steps on the track: its own and its clips' (plans/track-steps.ts).
  const onTrack = (steps: readonly Record<string, unknown>[]) => stepsOnTrack(steps, track.id, clipTrack);
  const applied = (snapshot?.plans ?? [])
    .filter((p) => p.state === 'applied' && p.appliedRevision !== undefined)
    .map((p) => ({ plan: p, first: onTrack(p.steps)[0] }))
    .filter((row): row is { plan: typeof row.plan; first: number } => row.first !== undefined)
    .map(({ plan: p, first }) => ({ plan: p, step: p.steps[first]!, name: planNameParts(p, t, names, can)! }));
  // What approving the plan under review would do on the track: its ticked
  // steps on it, whether the ghosts are shown or toggled off.
  const ticked = view.ticked ?? null;
  const pending = view.plan ? onTrack(view.plan.steps).filter((i) => ticked === null || ticked.has(i)).map((i) => i + 1) : [];
  const reviewed = planNameParts(view.plan, t, names, can);
  return (
    <div className="sec" data-part="inspector-agent-changes">
      <div className="sec-h">
        <Icon name="chev" small />
        {t('inspector.agentChanges')}
        <span />
      </div>
      <div className="sec-b">
        {applied.map(({ plan, step, name }) => (
          <div key={plan.hash} className="hist" data-testid={`agent-change-${plan.hash.slice(7, 15)}`} {...ISOLATE}>
            <span className="mono">{plan.appliedRevision}</span>
            {` · ${t('agent.appliedBy', { change: describeStep(step, t, names) })} `}
            <b>{name.lead}</b>
            {` · ${name.steps}`}
          </div>
        ))}
        {pending.length > 0 && view.plan ? (
          pending.map((n) => (
            <div key={`pending-${n}`} className="hist" data-testid={`agent-pending-${n}`} {...ghostAttrs(view, [n])} {...ISOLATE}>
              <span className="mono">{t('agent.step', { n })}</span>
              {` · ${describeStep(view.plan!.steps[n - 1] ?? {}, t, names)} ${t('agent.pendingIn')} `}
              <b>{reviewed?.lead ?? ''}</b>
              {` · ${reviewed?.steps ?? ''}`}
            </div>
          ))
        ) : (
          <div className="hist" style={{ color: 'var(--tx-3)' }}>
            {t('agentChanges.none')}
          </div>
        )}
      </div>
    </div>
  );
}

interface SliderProps {
  readonly kind: ValueKind;
  readonly track: TrackEntity;
  readonly gestures: GestureController;
  readonly testId: string;
  readonly label: string;
  // The ticked steps' pending values of this slider (m5b-ui-ghosts), in step order.
  readonly ghosts: readonly ValueGhost<string, number>[];
  readonly view: GhostView;
}

// The mockup's .hs: the volume slider has its fill (<i>) and thumb (<u>), the
// pan slider its thumb only; both at the value's position of the travel. A
// pending value adds its ghost marks before the thumb (aria-hidden; a press
// on one pins its step, as on the strip's ghost cap).
function Slider({ kind, track, gestures, testId, label, ghosts, view }: SliderProps) {
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
      {ghosts.map((g) => {
        const to = toPosition(kind, g.after);
        const pin = (event: PointerEvent) => {
          event.stopPropagation();
          view.pin(g.step);
        };
        if (!gain) return <span key={`t${g.step}`} className="ghost-tick" aria-hidden="true" data-testid={`${testId}-ghost-${g.step}`} {...ghostAttrs(view, [g.step])} style={{ left: percent(to) }} onPointerDown={pin} />;
        const from = toPosition(kind, g.before ?? value);
        return [
          <span key={`l${g.step}`} className="ghost-line" aria-hidden="true" data-testid={`${testId}-ghost-line-${g.step}`} {...ghostAttrs(view, [g.step])} style={{ left: percent(Math.min(from, to)), width: percent(Math.abs(to - from)) }} />,
          <span key={`c${g.step}`} className="ghost-thumb" aria-hidden="true" data-testid={`${testId}-ghost-${g.step}`} {...ghostAttrs(view, [g.step])} style={{ left: percent(to) }} onPointerDown={pin} />,
        ];
      })}
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

export function Inspector({ client, gestures, trackId, plans }: InspectorProps) {
  const t = useT();
  const can = useCapabilities();
  const track = useTrack(client, trackId);
  const view = useGhostView();
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
  const ghosts = trackGhosts(view.ghosts, track.id);
  const gain = ghosts.gain.at(-1);
  const pan = ghosts.pan.at(-1);
  const rename = ghosts.rename.at(-1);
  const mute = ghosts.mute.at(-1);
  const solo = ghosts.solo.at(-1);
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
            {rename ? <RenameGhost before={track.name} after={rename.after} step={rename.step} view={view} /> : track.name}
          </span>
          <small>{t(track.channels === 1 ? 'inspector.mono' : 'inspector.stereo')}</small>
        </div>
        <div className="i-btns" data-part="inspector-buttons">
          {can.command('track.set_mute') ? (
            <button type="button" className={`msr m${track.mute ? ' on' : ''}${mute ? ' ghost' : ''}`} {...(mute ? ghostAttrs(view, [mute.step]) : {})} data-testid="inspector-mute" data-part="inspector-mute" aria-label={t('strip.muteLabel', { track: track.name })} aria-pressed={track.mute} onClick={() => toggleTrack(client, track, 'track.set_mute')}>
              M
            </button>
          ) : (
            <Hold className="msr-box" />
          )}
          {can.command('track.set_solo') ? (
            <button type="button" className={`msr s${track.solo ? ' on' : ''}${solo ? ' ghost' : ''}`} {...(solo ? ghostAttrs(view, [solo.step]) : {})} data-testid="inspector-solo" data-part="inspector-solo" aria-label={t('strip.soloLabel', { track: track.name })} aria-pressed={track.solo} onClick={() => toggleTrack(client, track, 'track.set_solo')}>
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
          {gainListed ? <Slider kind="gain" track={track} gestures={gestures} testId="inspector-volume" label={t('strip.gainLabel', { track: track.name })} ghosts={ghosts.gain} view={view} /> : <Hold className="hs-box" />}
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
            suffix={gain ? <span className="ghost-to" {...ghostAttrs(view, [gain.step])}>{`→ ${formatDb(gain.after)}`}</span> : undefined}
          />
        </div>
        <div className="i-row" data-part="inspector-pan">
          <span>{t('strip.pan')}</span>
          {panListed ? <Slider kind="pan" track={track} gestures={gestures} testId="inspector-pan" label={t('strip.panLabel', { track: track.name })} ghosts={ghosts.pan} view={view} /> : <Hold className="hs-box" />}
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
            suffix={pan ? <span className="ghost-to" {...ghostAttrs(view, [pan.step])}>{`→ ${formatPan(pan.after)}`}</span> : undefined}
          />
        </div>
      </div>
      {SECTIONS.map((name) => (
        <Hold key={name} className={SECTION_HOLDS[name]} />
      ))}
      <AgentChanges client={client} track={track} plans={plans} />
      <Hold className={SECTION_HOLDS.notepad} />
      <Foot />
    </>
  );
}
