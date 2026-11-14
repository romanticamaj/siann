// The top bar (UI redesign spec 2.1): the session's name, the zone buttons
// for the left, lower and right zones (the Channel button arrives with the
// Channel tab in phase 3, by the rule of 3.0) and the Plans button with the
// number of plans waiting for review, and the transport bar of
// m5-ui-transport (Transport.tsx). The project zone has no button: it is
// never hidden.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { EngineStatusSource } from '../model/engine-status';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import type { TransportController } from '../model/transport';
import type { EffectiveLayout, Zone } from './layout';
import type { LayoutStore } from './layout-store';
import { Transport, type TransportPlayhead } from './Transport';

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
}

const ZONE_ORDER: readonly Zone[] = ['left', 'lower', 'right'];

export function TopBar({ client, plans, zones, onToggle, onPlans, realtime, engineStatus, layout, commands, transport }: TopBarProps) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
  );
  const pending = useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.getSnapshot().plans.filter((plan) => plan.state === 'validated').length,
  );
  return (
    <header className="top-bar" data-testid="top-bar" data-region="top-bar">
      <h1>{t('app.title')}</h1>
      <span className="session-name" data-testid="session-name" data-part="session-name">
        {snapshot?.root?.name ?? ''}
      </span>
      <Transport client={client} realtime={realtime} engineStatus={engineStatus} layout={layout} commands={commands} transport={transport} />
      <span className="spacer" />
      <div className="zone-buttons" data-part="zone-buttons" role="group" aria-label={t('zone.buttons')}>
        {ZONE_ORDER.map((zone) => (
          <button
            key={zone}
            type="button"
            data-testid={`zone-button-${zone}`} data-part={`zone-button-${zone}`}
            aria-pressed={zones[zone].visible}
            onClick={() => onToggle(zone)}
          >
            {t(`zone.${zone}`)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="plans-button"
        data-testid="plans-button" data-part="plans-button"
        aria-pressed={zones.right.visible}
        onClick={onPlans}
      >
        {t('topbar.plans')}
        {pending > 0 ? (
          <span className="plans-count" data-testid="plans-count" data-part="plans-count" aria-label={t('topbar.pending', { count: pending })}>
            {String(pending)}
          </span>
        ) : null}
      </button>
    </header>
  );
}
