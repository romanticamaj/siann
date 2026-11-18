// The Plans tab of the right zone (m5-ui-plan-panel; spec "Frontend", plan
// review; UI redesign section 4 and P1-5), ported from the mockup's markup by
// m5-ui-port-plans (10.10, P1-13): the agent row's hold, then .p-scroll with
// one card for the selected plan (plans/PlanCard: its badge, time and hash,
// the count chips, the steps in the mockup's wording, the actions valid in
// its state with one primary, each only when engine.capabilities lists what
// it sends, a valid action that cannot run now disabled with its reason; the
// stale reasons, the refusal line and the reason field as rows of their own)
// and a history row for every other plan, newest first, under "Earlier";
// then the composer's hold. With no plan selected (first load, after a
// reconnect) the card is the newest plan that awaits a decision
// (plans/selection.ts). The hearing switch is in the zone's tab row (Shell).
// The list follows plan.changed, never an optimistic state; a chain that
// stops shows where (the engine's state stays as it reports it). Raw steps,
// refs and entity JSON are behind each step's disclosure.
//
// PlanPanelView is the pure view (static-markup tests); PlanPanel reads the
// stores, plan.preview and session.fetch at the plan's base revision (for
// the stale reasons), and runs the actions.

import { useEffect, useMemo, useRef, useState } from 'react';

import { translator, useLocale } from '../i18n/t';
import type { PlanEntry, PlanStore } from '../model/plan-store';
import type { SessionClient } from '../model/session-client';
import { Hold } from '../shell/Hold';
import { useCapabilities } from '../shell/Capable';
import { actionMethods, actionSet, landedLabel, runAction, type ActionEntry, type PlanAction } from './actions';
import { cardOf, staleReasons as reasonsOf } from './card';
import type { StepNames } from './describe';
import { selection, type PlanPreview } from './diff';
import { historyOf } from './history';
import { HistoryRow } from './HistoryRow';
import { usePlanSnapshot, useModelSnapshot, useStepNames } from './hooks';
import { PlanCard } from './PlanCard';
import { refusalOf, type Refusal } from './RefusalLine';
import { defaultSelection } from './selection';

export type PanelRefusal = Refusal;

export interface PlanPanelViewProps {
  readonly plans: readonly PlanEntry[];
  readonly heard: string | null;
  readonly firstSeen: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly names: StepNames;
  // The plan the user selected; null (or a plan the store no longer holds):
  // the default selection.
  readonly selected: string | null;
  // null: every step ticked (the default).
  readonly ticked: ReadonlySet<number> | null;
  readonly note: string;
  readonly busy: boolean;
  readonly error: PanelRefusal | null;
  readonly preview: PlanPreview | null;
  readonly previewError: PanelRefusal | null;
  readonly staleReasons: readonly string[];
  // The reason field is open (the first press of Reject).
  readonly rejecting: boolean;
  // The step under the pointer.
  readonly hotStep: number | null;
  // The step pinned by its target button or a click on a ghost (m5b-ui-ghosts).
  readonly pinnedStep?: number | null;
  readonly onSelect: (hash: string) => void;
  readonly onTicked: (ticked: ReadonlySet<number>) => void;
  readonly onNote: (note: string) => void;
  readonly onRun: (entry: ActionEntry) => void;
  readonly onRejecting: (open: boolean) => void;
  readonly onHotStep: (index: number | null) => void;
  // Disclosures that start open (tests).
  readonly openSteps?: ReadonlySet<number>;
  readonly openError?: boolean;
  readonly openOther?: boolean;
}

// The plan on the card: the selected one while the store holds it, else the default.
export function cardPlan(plans: readonly PlanEntry[], selected: string | null): PlanEntry | undefined {
  const chosen = selected !== null ? plans.find((p) => p.hash === selected) : undefined;
  if (chosen) return chosen;
  const hash = defaultSelection(plans);
  return hash !== null ? plans.find((p) => p.hash === hash) : undefined;
}

export function PlanPanelView(props: PlanPanelViewProps) {
  const { plans, heard, firstSeen, nowMs, names, ticked } = props;
  const locale = useLocale();
  const t = translator(locale);
  const can = useCapabilities();
  const plan = cardPlan(plans, props.selected);
  const rows = historyOf(plans, plan?.hash ?? null, nowMs, firstSeen, locale, names);
  const chosen = selection(ticked, plan?.steps.length ?? 0);
  const set = plan ? actionSet(plan, heard, chosen) : null;
  return (
    <>
      <Hold className="hold-agent-row" />
      <div className="p-scroll" data-testid="plan-review" aria-label={t('plans.label')}>
        {plans.length === 0 ? <p className="plan-none">{t('plans.none')}</p> : null}
        {plan && set ? (
          <PlanCard
            key={plan.hash}
            plan={plan}
            card={cardOf(plan, plans, heard, nowMs, firstSeen.get(plan.hash), locale, names)}
            names={names}
            set={set}
            allowed={(entry) => actionMethods(entry.id, plan).every((m) => can.has(m))}
            selectable={plan.state === 'validated' && can.has('plan.approve')}
            ticked={ticked}
            busy={props.busy}
            note={props.note}
            rejecting={props.rejecting}
            hotStep={props.hotStep}
            error={props.error}
            preview={landedLabel(plan) === null ? props.preview : null}
            previewError={landedLabel(plan) === null ? props.previewError : null}
            staleReasons={props.staleReasons}
            openSteps={props.openSteps}
            openError={props.openError}
            openOther={props.openOther}
            onTicked={props.onTicked}
            onNote={props.onNote}
            onRun={props.onRun}
            onRejecting={props.onRejecting}
            onHotStep={props.onHotStep}
          />
        ) : null}
        {rows.length > 0 ? (
          <>
            <div className="hist-h up" data-part="plan-history-head">
              {t('plans.earlier')}
              <span>{t('plans.count', { count: rows.length })}</span>
            </div>
            {rows.map((row) => (
              <HistoryRow key={row.hash} row={row} onSelect={() => props.onSelect(row.hash)} />
            ))}
          </>
        ) : null}
      </div>
      <Hold className="hold-composer" />
    </>
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
  const [rejecting, setRejecting] = useState(false);
  const [hotStep, setHotStep] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelRefusal | null>(null);
  const plan = cardPlan(snapshot.plans, selected);
  // Another plan on the card (a selection, or the default moving on): its
  // own ticks, reason and refusal.
  const shown = plan?.hash ?? null;
  const lastShown = useRef(shown);
  useEffect(() => {
    if (lastShown.current === shown) return;
    lastShown.current = shown;
    setTicked(null);
    setRejecting(false);
    setHotStep(null);
    setError(null);
  }, [shown]);
  // A reconnect clears the selection and its ticked steps.
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    setSelected(null);
    setTicked(null);
    setRejecting(false);
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
    setRejecting(false);
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
    // The card stays on the plan it acted on.
    setSelected(plan.hash);
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      // A partial approval goes on with its sub-plan: follow it.
      if (outcome.plan !== undefined) {
        // Followed, not chosen: the refusal of the chain stays shown.
        lastShown.current = outcome.plan;
        setSelected(outcome.plan);
        setTicked(null);
      }
      setError(outcome.ok ? null : { code: outcome.code, message: outcome.engineMessage, changedEntities: outcome.changedEntities });
      if (outcome.ok && entry.id === 'reject') {
        setNote('');
        setRejecting(false);
      }
    });
  };

  return (
    <PlanPanelView
      plans={snapshot.plans}
      heard={snapshot.heard}
      firstSeen={snapshot.firstSeen}
      nowMs={now}
      names={names}
      selected={shown}
      ticked={ticked}
      note={note}
      busy={busy}
      error={error}
      preview={preview?.preview ?? null}
      previewError={preview?.error ?? null}
      staleReasons={reasons}
      rejecting={rejecting}
      hotStep={hotStep}
      onSelect={select}
      onTicked={setTicked}
      onNote={setNote}
      onRun={run}
      onRejecting={setRejecting}
      onHotStep={setHotStep}
    />
  );
}
