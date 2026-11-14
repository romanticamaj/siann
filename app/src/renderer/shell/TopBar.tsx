// The top bar (UI redesign spec 2.1): the session's name, the zone buttons
// for the left, lower and right zones (the Channel button arrives with the
// Channel tab in phase 3, by the rule of 3.0) and the Plans button with the
// number of plans waiting for review. The transport arrives with
// m5-ui-transport. The project zone has no button: it is never hidden.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import type { EffectiveLayout, Zone } from './layout';

export interface TopBarProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  readonly zones: EffectiveLayout['zones'];
  readonly onToggle: (zone: Zone) => void;
  readonly onPlans: () => void;
}

const ZONE_ORDER: readonly Zone[] = ['left', 'lower', 'right'];

export function TopBar({ client, plans, zones, onToggle, onPlans }: TopBarProps) {
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
