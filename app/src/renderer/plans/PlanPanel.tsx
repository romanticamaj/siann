// The Plans tab of the right zone (m5-ui-plan-panel; spec "Frontend", plan
// review; UI redesign section 4 and P1-5). The hearing switch at the top,
// then a card per plan (newest first: first step, step count, time, badge,
// short hash; split label, rejection reason), and for the selected plan its
// steps (numbered from 1, all ticked, Select all / none), why it is stale in
// user units, the actions valid in its state with one primary
// (plans/actions.ts; each only when engine.capabilities lists what it sends;
// a valid action that cannot run now disabled with its reason), the refusal
// line (plans/RefusalLine: no ids, the engine's text behind a disclosure),
// and its diff against the current revision (plan.preview, re-read when
// the head or the plan changes). Raw steps, refs and entity JSON are behind
// per-row disclosures. The list follows plan.changed, never an optimistic
// state; a chain that stops shows where (the engine's state stays as it
// reports it).
//
// PlanPanelView is the pure view (static-markup tests); PlanPanel reads the
// stores, plan.preview and session.fetch at the plan's base revision (for
// the stale reasons), and runs the actions.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { PlanEntry, PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { useCapabilities } from '../shell/Capable';
import { actionLabel, actionMethods, actionSet, landedLabel, runAction, type ActionEntry, type ActionId, type PlanAction } from './actions';
import { cardOf, staleReasons as reasonsOf } from './card';
import type { StepNames } from './describe';
import { selection, type PlanPreview } from './diff';
import { HearingSwitch } from './HearingSwitch';
import { usePlanSnapshot, useModelSnapshot, useStepNames } from './hooks';
import { PlanCard } from './PlanCard';
import { PlanDiff } from './PlanDiff';
import { RefusalLine, refusalOf, type Refusal } from './RefusalLine';
import { StepList } from './StepList';

export type PanelRefusal = Refusal;

export interface PlanPanelViewProps {
  readonly plans: readonly PlanEntry[];
  readonly heard: string | null;
  readonly firstSeen: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly names: StepNames;
  readonly selected: string | null;
  // null: every step ticked (the default).
  readonly ticked: ReadonlySet<number> | null;
  readonly note: string;
  readonly busy: boolean;
  readonly error: PanelRefusal | null;
  readonly preview: PlanPreview | null;
  readonly previewError: PanelRefusal | null;
  readonly staleReasons: readonly string[];
  readonly onSelect: (hash: string) => void;
  readonly onTicked: (ticked: ReadonlySet<number>) => void;
  readonly onNote: (note: string) => void;
  readonly onRun: (entry: ActionEntry) => void;
  // Above the cards (the hearing switch).
  readonly header?: ReactNode;
  // Disclosures that start open (tests).
  readonly openSteps?: ReadonlySet<number>;
  readonly openRows?: ReadonlySet<number>;
  readonly openError?: boolean;
}

const TEST_IDS: Record<ActionId, string> = {
  approveApply: 'plan-approve-apply',
  apply: 'plan-apply',
  audition: 'plan-audition',
  reject: 'plan-reject',
  merge: 'plan-merge',
  hearMain: 'plan-hear-main',
  hearProposal: 'plan-hear-proposal',
  discard: 'plan-discard',
};

export function PlanPanelView(props: PlanPanelViewProps) {
  const { plans, heard, firstSeen, nowMs, names, selected, ticked, note, busy, error } = props;
  const locale = useLocale();
  const t = translator(locale);
  const can = useCapabilities();
  const plan = selected !== null ? plans.find((p) => p.hash === selected) : undefined;
  const newestFirst = [...plans].reverse();
  const chosen = selection(ticked, plan?.steps.length ?? 0);
  const set = plan ? actionSet(plan, heard, chosen) : null;
  const entries = set && plan ? [...(set.primary ? [set.primary] : []), ...set.secondary].filter((e) => actionMethods(e.id, plan).every((m) => can.has(m))) : [];
  const landed = plan ? landedLabel(plan, t) : null;
  // The selected plan's detail, directly under its card.
  const detail =
    plan && set ? (
        <div className="plan-detail" data-testid="plan-detail">
          <StepList
            key={plan.hash}
            steps={plan.steps}
            names={names}
            ticked={ticked}
            selectable={plan.state === 'validated' && can.has('plan.approve')}
            disabled={busy}
            onTicked={props.onTicked}
            openSteps={props.openSteps}
          />
          {props.staleReasons.length > 0 ? (
            <div className="plan-stale-reasons" data-testid="plan-stale-reasons">
              <h3>{t('plans.staleTitle')}</h3>
              <ul>
                {props.staleReasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {entries.length > 0 ? (
            <div className="plan-actions">
              {entries.some((e) => e.id === 'reject') ? (
                <label className="plan-note">
                  {t('plans.reason')}{' '}
                  <input data-testid="plan-note" value={note} onChange={(event) => props.onNote(event.target.value)} />
                </label>
              ) : null}
              {entries.map((entry) => {
                const reason = set.disabled.get(entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={entry === set.primary ? 'plan-action primary' : 'plan-action'}
                    data-testid={TEST_IDS[entry.id]}
                    disabled={busy || reason !== undefined}
                    title={reason !== undefined ? t(`actionReason.${reason}`) : undefined}
                    onClick={() => props.onRun(entry)}
                  >
                    {actionLabel(entry, plan.steps.length, t)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <RefusalLine
            key={error ? `${error.code ?? ''}:${error.message}` : ''}
            refusal={error}
            locale={locale}
            names={names}
            testId="plan-error"
            className="plan-error"
            role="status"
            open={props.openError}
          />
          {landed !== null ? (
            <p className="plan-landed" data-testid="plan-landed">
              {landed}
            </p>
          ) : null}
          {landed === null && props.preview ? (
            <PlanDiff key={plan.hash} preview={props.preview} stale={plan.stale} names={names} openRows={props.openRows} />
          ) : null}
          {landed === null && props.previewError ? (
            <RefusalLine refusal={props.previewError} locale={locale} names={names} testId="plan-preview-error" className="plan-preview-error" />
          ) : null}
        </div>
      ) : null;
  return (
    <section className="plan-review" data-testid="plan-review" aria-label={t('plans.label')}>
      {props.header}
      {plans.length === 0 ? <p className="plan-none">{t('plans.none')}</p> : null}
      <ul className="plan-list" data-testid="plan-list" aria-label={t('plans.list')}>
        {newestFirst.map((entry) => (
          <li key={entry.hash}>
            <PlanCard
              plan={entry}
              card={cardOf(entry, plans, heard, nowMs, firstSeen.get(entry.hash), locale, names)}
              selected={entry.hash === selected}
              onSelect={() => props.onSelect(entry.hash)}
            />
            {entry.hash === selected ? detail : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Entity = Readonly<Record<string, unknown>>;

interface PreviewState {
  readonly plan: string;
  readonly preview?: PlanPreview;
  readonly error?: PanelRefusal;
  // The stale refs at the plan's base revision; null when that read was refused.
  readonly base?: ReadonlyMap<string, Entity | null> | null;
}

// plan.preview of the selected plan (and, for a stale one, its stale entities
// at the base revision), read again when the head revision, the plan's state
// or its staleness changes; none for a plan that has landed.
function usePreview(client: SessionClient, plan: PlanEntry | undefined, revision: string | null): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  const hash = plan && landedLabel(plan) === null ? plan.hash : null;
  const planState = plan?.state ?? null;
  const staleRefs = plan ? plan.stale.map((s) => s.ref) : [];
  const staleKey = plan ? plan.stale.map((s) => `${s.ref}:${s.change}`).join(',') : '';
  const baseRevision = typeof plan?.raw.baseRevision === 'string' ? plan.raw.baseRevision : null;
  useEffect(() => {
    if (hash === null) {
      setState(null);
      return undefined;
    }
    let current = true;
    const base = async (): Promise<ReadonlyMap<string, Entity | null> | null> => {
      if (staleRefs.length === 0 || baseRevision === null) return new Map();
      try {
        const fetched = (await client.request('session.fetch', { refs: staleRefs, revision: baseRevision })) as {
          entities?: Array<{ ref?: unknown; entity?: unknown }>;
        };
        const map = new Map<string, Entity | null>();
        for (const item of fetched.entities ?? []) {
          if (typeof item.ref === 'string') map.set(item.ref, (item.entity as Entity | undefined) ?? null);
        }
        return map;
      } catch {
        return null;
      }
    };
    void client.request('plan.preview', { plan: hash }).then(
      async (result) => {
        const atBase = await base();
        if (current) setState({ plan: hash, preview: result as PlanPreview, base: atBase });
      },
      (error: unknown) => {
        if (current) setState({ plan: hash, error: refusalOf(error) });
      },
    );
    return () => {
      current = false;
    };
    // staleRefs is staleKey's content.
  }, [client, hash, planState, staleKey, revision, baseRevision]);
  return state !== null && state.plan === hash ? state : null;
}

// The clock at this render; the relative times are re-rendered every 30 s.
function useNow(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return Date.now();
}

export interface PlanPanelProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  // The reconnects so far (model/connection-phase.ts); each one clears the
  // selected plan and its ticked steps (UI redesign spec 4.5 C8).
  readonly reconnects?: number;
}

export function PlanPanel({ client, plans, reconnects = 0 }: PlanPanelProps) {
  const snapshot = usePlanSnapshot(plans);
  const model = useModelSnapshot(client);
  const names = useStepNames(client);
  const locale = useLocale();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number> | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelRefusal | null>(null);
  const plan = selected !== null ? snapshot.byHash.get(selected) : undefined;
  // A reconnect clears the selection and its ticked steps.
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    setSelected(null);
    setTicked(null);
    setError(null);
  }, [reconnects]);
  const preview = usePreview(client, plan, model?.revision ?? null);

  const reasons = useMemo(() => {
    if (!plan || plan.stale.length === 0 || !preview?.preview) return [];
    const head = new Map<string, Entity | null>();
    for (const entity of preview.preview.entities) head.set(entity.ref, entity.before);
    for (const { ref } of plan.stale) {
      if (!head.has(ref)) head.set(ref, (client.model.select(ref) as Entity | undefined) ?? null);
    }
    return reasonsOf(plan, head, preview.base ?? null, locale, names);
  }, [plan, preview, client, locale, names]);

  const select = (hash: string) => {
    setSelected(hash);
    setTicked(null);
    setError(null);
  };

  const actionFor = (entry: ActionEntry, current: PlanEntry): PlanAction | null => {
    const branch = current.proposalBranch;
    switch (entry.id) {
      case 'approveApply':
        return { kind: 'approveApply', plan: current.hash, ...(entry.steps ? { steps: entry.steps } : {}) };
      case 'audition':
        return { kind: 'audition', plan: current.hash, approved: current.state === 'approved', ...(entry.steps ? { steps: entry.steps } : {}) };
      case 'reject':
        return { kind: 'reject', plan: current.hash, note };
      case 'apply':
        return { kind: 'apply', plan: current.hash };
      case 'hearMain':
        return { kind: 'hear', side: 'main' };
      case 'hearProposal':
        return branch ? { kind: 'hear', side: branch } : null;
      case 'merge':
        return branch ? { kind: 'merge', branch } : null;
      case 'discard':
        return branch ? { kind: 'discard', branch } : null;
    }
  };

  const run = (entry: ActionEntry) => {
    if (!plan || busy) return;
    const action = actionFor(entry, plan);
    if (!action) return;
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      // A partial approval goes on with its sub-plan: follow it.
      if (outcome.plan !== undefined) {
        setSelected(outcome.plan);
        setTicked(null);
      }
      setError(outcome.ok ? null : { code: outcome.code, message: outcome.engineMessage, changedEntities: outcome.changedEntities });
      if (outcome.ok && entry.id === 'reject') setNote('');
    });
  };

  return (
    <PlanPanelView
      plans={snapshot.plans}
      heard={snapshot.heard}
      firstSeen={snapshot.firstSeen}
      nowMs={now}
      names={names}
      selected={plan ? selected : null}
      ticked={ticked}
      note={note}
      busy={busy}
      error={error}
      preview={preview?.preview ?? null}
      previewError={preview?.error ?? null}
      staleReasons={reasons}
      onSelect={select}
      onTicked={setTicked}
      onNote={setNote}
      onRun={run}
      header={<HearingSwitch client={client} plans={plans} />}
    />
  );
}
