// The top bar (UI redesign spec 2.1), ported from the mockup
// (m5-ui-alignment-chrome; mockup.html, header.topbar; docs/harness/
// agent-rules.md, "UI fidelity"): its DOM structure and class names are the
// mockup's, so ui/top-bar.css draws it.
//
//   .tb-left    the brand, the session's name, the branch chip
//               (BranchChip.tsx, m5b-ui-audition), a separator, undo and
//               redo (Transport.tsx)
//   .transport  the transport bar of m5-ui-transport and m5-ui-loop-click
//   .tb-right   the DSP load (span.dsp: "DSP", .bar > i, .num; m5b-ui-meter),
//               the zone buttons (the Channel button's box, then left, lower
//               and right) and the Plans button with the number of plans
//               waiting for review
//
// A part whose feature has not landed keeps its box empty (spec 3.0): the
// Channel zone button (m5b-ui-editor-channel) is an element with no role, no
// focus, no id and no text, sized by a --hold-<part> token in shell.css. The
// DSP load has landed and is absent on an engine that does not list
// features.load (or engine.status): its empty box is .dsp-load-empty,
// --dsp-load-empty-w wide. Its values change with every poll, so they are
// written through refs (dsp-load.ts), never through React state (spec 5.6). The
// project zone has no button: it is never hidden. The page's heading is
// there for assistive technology and draws nothing.
//
// The session's name carries the saved mark (m5b-ui-project; UI redesign
// UR-4): while the head revision is newer than the last save, a bullet after
// the name, inside the same .session part and as text, so the part keeps the
// mockup's structure; its tooltip says the session changed since the last
// save. Over the start view the scratch bundle is nobody's project and the
// name is empty.

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { EngineStatusSource } from '../model/engine-status';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import type { LoopClickController } from '../model/loop-click';
import type { TransportController } from '../model/transport';
import type { UndoHistory } from '../model/undo-history';
import { ISOLATE } from '../plans/isolate';
import { BranchChip } from './BranchChip';
import { useCapabilities } from './Capable';
import { Counted } from './Counted';
import { bindDspLoad } from './dsp-load';
import { Hold } from './Hold';
import { Icon, type IconName } from './icons';
import type { EffectiveLayout, Zone } from './layout';
import type { LayoutStore } from './layout-store';
import { Transport, UndoRedo, type TransportPlayhead } from './Transport';

export interface TopBarProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  readonly zones: EffectiveLayout['zones'];
  readonly onToggle: (zone: Zone) => void;
  readonly onPlans: () => void;
  // The transport bar's sources (m5-ui-transport).
  readonly realtime: TransportPlayhead | null;
  readonly engineStatus: EngineStatusSource;
  readonly layout: LayoutStore;
  readonly commands: CommandRegistry;
  readonly transport: TransportController;
  readonly loopClick: LoopClickController;
  // What undo and redo can do now (redo dims with nothing to redo).
  readonly history: Pick<UndoHistory, 'getSnapshot' | 'subscribe'>;
  // The saved mark (model/project.ts SavedMark): true while the head is newer than the last save.
  readonly saved?: { getSnapshot(): boolean; subscribe(listener: () => void): () => void };
  // The start view is up: the scratch bundle's name is not shown.
  readonly nameHidden?: boolean;
  // Studio Setup's opener, for the transport's buttons without a device.
  readonly onStudioSetup?: () => void;
}

const noMark = { getSnapshot: () => false, subscribe: () => () => undefined };

// The mockup's span.dsp (mockup.html line 242): DSP, the bar, the percentage.
function DspLoad({ source }: { source: EngineStatusSource }) {
  const t = useT();
  const root = useRef<HTMLSpanElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const num = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const { getLoad, subscribeLoad } = source;
    if (!root.current || !bar.current || !num.current || !getLoad || !subscribeLoad) return undefined;
    const channel = { getLoad: () => getLoad.call(source), subscribeLoad: (listener: () => void) => subscribeLoad.call(source, listener) };
    return bindDspLoad(channel, { root: root.current, bar: bar.current, num: num.current }, (percent) => t('topbar.dspPeak', { percent }));
  }, [source, t]);
  return (
    <Counted id="dsp-load">
      <span ref={root} className="dsp" data-part="dsp-load" data-testid="dsp-load" role="meter" aria-label={t('topbar.dspLoad')} aria-valuemin={0} aria-valuemax={100}>
        {t('topbar.dsp')} <span className="bar">
          <i ref={bar} />
        </span>
        <span ref={num} className="num" style={{ color: 'var(--tx-2)' }} />
      </span>
    </Counted>
  );
}

const ZONE_ORDER: readonly Zone[] = ['left', 'lower', 'right'];
const ZONE_ICON: Readonly<Record<Zone, IconName>> = { left: 'zLeft', lower: 'zLow', right: 'zRight' };

export function TopBar({
  client,
  plans,
  zones,
  onToggle,
  onPlans,
  realtime,
  engineStatus,
  layout,
  commands,
  transport,
  loopClick,
  history,
  saved = noMark,
  nameHidden = false,
  onStudioSetup,
}: TopBarProps) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const pending = useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.getSnapshot().plans.filter((plan) => plan.state === 'validated').length,
    () => plans.getSnapshot().plans.filter((plan) => plan.state === 'validated').length,
  );
  const marked = useSyncExternalStore(saved.subscribe, saved.getSnapshot, saved.getSnapshot);
  const name = nameHidden ? '' : (snapshot?.root?.name ?? '');
  const unsaved = marked && name !== '';
  const can = useCapabilities();
  const load = can.feature('load') && can.has('engine.status');
  return (
    <header className="topbar" data-region="top-bar" data-testid="top-bar">
      <div className="tb-left">
        <h1 className="visually-hidden">{t('app.title')}</h1>
        <div className="brand" data-part="brand">
          <b>
            <i />
          </b>
        </div>
        <div
          className="session"
          data-part="session-name"
          data-testid="session-name"
          data-unsaved={unsaved ? 'true' : undefined}
          title={unsaved ? t('session.unsavedTitle', { name }) : name}
        >
          <span {...ISOLATE}>{name}</span>
          {unsaved ? ` ${t('session.unsavedMark')}` : null} <Icon name="chev" small />
        </div>
        <BranchChip client={client} plans={plans} revision={snapshot?.revision ?? null} />
        <span className="sep" />
        <UndoRedo transport={transport} history={history} />
      </div>
      <Transport
        client={client}
        realtime={realtime}
        engineStatus={engineStatus}
        layout={layout}
        commands={commands}
        transport={transport}
        loopClick={loopClick}
        onStudioSetup={onStudioSetup}
      />
      <div className="tb-right">
        {load ? <DspLoad source={engineStatus} /> : <Hold className="dsp-load-empty" />}
        <span className="zones" data-part="zone-buttons" role="group" aria-label={t('zone.buttons')}>
          <Hold className="hold-zone-button-channel" />
          {ZONE_ORDER.map((zone) => (
            <button
              key={zone}
              type="button"
              className={zones[zone].visible ? 'iconbtn on' : 'iconbtn'}
              data-testid={`zone-button-${zone}`}
              data-part={`zone-button-${zone}`}
              aria-pressed={zones[zone].visible}
              aria-label={t(`zone.${zone}`)}
              title={t(`zone.${zone}`)}
              onClick={() => onToggle(zone)}
            >
              <Icon name={ZONE_ICON[zone]} />
            </button>
          ))}
        </span>
        <button type="button" className="aibtn" data-testid="plans-button" data-part="plans-button" aria-pressed={zones.right.visible} onClick={onPlans}>
          <Icon name="spark" />
          {t('topbar.plans')}
          {pending > 0 ? (
            <span className="n" data-testid="plans-count" data-part="plans-count" aria-label={t('topbar.pending', { count: pending })}>
              {String(pending)}
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
