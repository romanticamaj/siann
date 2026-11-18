// The Plans tab of the right zone (m5-ui-plan-panel; spec "Frontend", plan
// review; UI redesign section 4 and P1-5), ported from the mockup's markup by
// m5-ui-port-plans (10.10, P1-13): the agent row (m5b-ui-plan-metadata, when
// engine.capabilities lists features.agents; its empty box otherwise), then .p-scroll with
// one card for the selected plan (plans/PlanCard: its badge, time and hash,
// the count chips, the steps in the mockup's wording, the actions valid in
// its state with one primary, each only when engine.capabilities lists what
// it sends, a valid action that cannot run now disabled with its reason; the
// stale reasons, the refusal line and the reason field as rows of their own)
// and a history row for every other plan, newest first, under "Earlier";
// then the "ask the agent" box (m5b-ui-composer, plans/Composer: the request
// rows above it, when engine.capabilities lists features.agentRequests and
// agent.request; its empty box otherwise). An answered request selects the
// plan it led to. With no plan selected (first load, after a
// reconnect) the card is the newest plan that awaits a decision
// (plans/selection.ts). The hearing switch is in the zone's tab row (Shell).
// The list follows plan.changed, never an optimistic state; a chain that
// stops shows where (the engine's state stays as it reports it). Raw steps,
// refs and entity JSON are behind each step's disclosure.
//
// PlanPanelView is the pure view (static-markup tests); PlanPanel reads the
// stores and runs the actions. The selected plan, its ticked steps, its
// plan.preview (and session.fetch at its base revision, for the stale
// reasons), the hovered and the pinned step live in the review store
// (model/review-store.ts, m5b-ui-ghosts), so the ghosts exist with the zone
// closed; a step's target button locates its ghosts through it, and a click
// on a ghost brings its row into view here.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { translator, useLocale } from '../i18n/t';
import { shownAgent, type Agent, type AgentStore } from '../model/agents';
import type { PlanEntry, PlanStore } from '../model/plan-store';
import type { RequestStore } from '../model/request-store';
import type { ReviewStore } from '../model/review-store';
import type { AgentRequest, AgentRequestSelection, SessionClient } from '../model/session-client';
import { Hold } from '../shell/Hold';
import { useCapabilities } from '../shell/Capable';
import type { CommandRegistry } from '../keys/commands';
import { actionMethods, actionSet, landedLabel, primaryAction, runAction, type ActionEntry, type PlanAction } from './actions';
import { AgentRow } from './AgentRow';
import { cardOf, staleReasons as reasonsOf } from './card';
import { ComposerView, RequestRows, useComposer } from './Composer';
import type { StepNames } from './describe';
import { selection, type PlanPreview } from './diff';
import { historyOf } from './history';
import { HistoryRow } from './HistoryRow';
import { usePlanSnapshot, useModelSnapshot, useStepNames } from './hooks';
import { PlanCard } from './PlanCard';
import { refusalOf, type Refusal } from './RefusalLine';
import { cardPlan } from './selection';

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
  // The agent the row shows (model/agents.ts, shownAgent); none: "No agent connected".
  readonly agent?: Agent | null;
  // The step pinned by its target button or a click on a ghost (m5b-ui-ghosts).
  readonly pinnedStep?: number | null;
  // The "ask the agent" box (m5b-ui-composer): the requests shown above it,
  // its text and its refusal.
  readonly requests?: { readonly open: readonly AgentRequest[]; readonly closed: AgentRequest | null };
  readonly composerText?: string;
  readonly composerRefusal?: PanelRefusal | null;
  readonly onComposerText?: (text: string) => void;
  readonly onSend?: () => void;
  readonly onCancelRequest?: (request: string) => void;
  readonly onDismissRequest?: () => void;
  readonly onSelect: (hash: string) => void;
  readonly onTicked: (ticked: ReadonlySet<number>) => void;
  readonly onNote: (note: string) => void;
  readonly onRun: (entry: ActionEntry) => void;
  readonly onRejecting: (open: boolean) => void;
  readonly onHotStep: (index: number | null) => void;
  readonly onLocate?: (index: number) => void;
  // Disclosures that start open (tests).
  readonly openSteps?: ReadonlySet<number>;
  readonly openError?: boolean;
  readonly openOther?: boolean;
}

export { cardPlan };

export function PlanPanelView(props: PlanPanelViewProps) {
  const { plans, heard, firstSeen, nowMs, names, ticked } = props;
  const locale = useLocale();
  const t = translator(locale);
  const can = useCapabilities();
  const plan = cardPlan(plans, props.selected);
  const rows = historyOf(plans, plan?.hash ?? null, nowMs, firstSeen, locale, names, can);
  const chosen = selection(ticked, plan?.steps.length ?? 0);
  const set = plan ? actionSet(plan, heard, chosen) : null;
  return (
    <>
      {can.feature('agents') ? <AgentRow agent={props.agent ?? null} /> : <Hold className="agent-row-empty" />}
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
            pinnedStep={props.pinnedStep ?? null}
            onLocate={props.onLocate}
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
      {can.feature('agentRequests') && can.has('agent.request') ? (
        <>
          <RequestRows
            open={props.requests?.open ?? NONE}
            closed={props.requests?.closed ?? null}
            refusal={props.composerRefusal ?? null}
            onCancel={props.onCancelRequest ?? IGNORE}
            onDismiss={props.onDismissRequest ?? IGNORE}
          />
          <ComposerView
            agent={props.agent ?? null}
            text={props.composerText ?? ''}
            refusal={props.composerRefusal ?? null}
            onText={props.onComposerText ?? IGNORE}
            onSend={props.onSend ?? IGNORE}
          />
        </>
      ) : (
        <Hold className="composer-empty" />
      )}
    </>
  );
}

const NONE: readonly AgentRequest[] = Object.freeze([]);
const IGNORE = () => undefined;

type Entity = Readonly<Record<string, unknown>>;

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
  // The plan review's state (model/review-store.ts): a reconnect clears its
  // selection there (UI redesign spec 4.5 C8).
  readonly review: ReviewStore;
  // The reconnects so far (model/connection-phase.ts); each one clears the
  // refusal and the reason field.
  readonly reconnects?: number;
  // The key commands: Ctrl+Return in the right zone runs the card's primary
  // (plans.primary, m5b-ui-audition); none when absent.
  readonly commands?: CommandRegistry;
  // The agents the engine lists (m5b-ui-plan-metadata).
  readonly agents?: AgentStore;
  // The requests to the agent (m5b-ui-composer).
  readonly requests?: RequestStore;
  // The selected tracks and clips, sent with a request.
  readonly selection?: AgentRequestSelection;
}

const NO_AGENTS = { subscribe: () => () => undefined, getSnapshot: () => null };
const NO_REQUESTS = { subscribe: () => () => undefined, getSnapshot: () => null };

export function PlanPanel({ client, plans, review, reconnects = 0, agents, commands, requests, selection }: PlanPanelProps) {
  const snapshot = usePlanSnapshot(plans);
  const source = agents ?? NO_AGENTS;
  const subscribe = useMemo(() => (listener: () => void) => source.subscribe(listener), [source]);
  const listed = useSyncExternalStore(subscribe, () => source.getSnapshot());
  const agent = listed ? shownAgent(listed.agents) : null;
  const requestSource = requests ?? NO_REQUESTS;
  const subscribeRequests = useMemo(() => (listener: () => void) => requestSource.subscribe(listener), [requestSource]);
  const shownRequests = useSyncExternalStore(subscribeRequests, () => requestSource.getSnapshot());
  const composer = useComposer(client, requests, agent, selection);
  const model = useModelSnapshot(client);
  const names = useStepNames(client);
  const locale = useLocale();
  const now = useNow();
  const can = useCapabilities();
  const reviewState = useSyncExternalStore((listener) => review.subscribe(listener), () => review.getSnapshot(), () => review.getSnapshot());
  const { selected, ticked, hotStep, pinnedStep } = reviewState;
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
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
    setRejecting(false);
    setError(null);
  }, [shown]);
  // A reconnect clears the refusal and the reason field (the store clears the selection).
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    setRejecting(false);
    setError(null);
  }, [reconnects]);
  const preview = reviewState.preview !== null && reviewState.preview.plan === plan?.hash ? reviewState.preview : null;
  void model;
  // A click on a ghost brings its row into view.
  useEffect(
    () =>
      review.onReveal(({ step, plans: toPlans }) => {
        if (!toPlans) return;
        requestAnimationFrame(() => document.querySelector(`[data-testid="step-${step - 1}"]`)?.scrollIntoView({ block: 'nearest' }));
      }),
    [review],
  );

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
    review.select(hash);
    setRejecting(false);
    setError(null);
  };
  // An answered request selects the plan it led to. agent.request_changed
  // follows the plan's plan.changed, so the store holds it; a plan it does not
  // hold yet is still the selection, and the card shows it once it arrives.
  const latestSelect = useRef(select);
  latestSelect.current = select;
  useEffect(() => requests?.onSelectPlan((hash) => latestSelect.current(hash)), [requests]);

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
    review.select(plan.hash);
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      // A partial approval goes on with its sub-plan: follow it.
      if (outcome.plan !== undefined) {
        // Followed, not chosen: the refusal of the chain stays shown.
        lastShown.current = outcome.plan;
        review.select(outcome.plan);
      }
      setError(outcome.ok ? null : { code: outcome.code, message: outcome.engineMessage, changedEntities: outcome.changedEntities });
      if (outcome.ok && entry.id === 'reject') {
        setNote('');
        setRejecting(false);
      }
    });
  };

  // Ctrl+Return (Cmd+Return) with the right zone focused: the card's primary,
  // Approve N of M, Apply or Merge, when it can run now; otherwise the key
  // keeps its default (UI redesign 3.6, 4.5 C4).
  const primary = useRef<() => boolean>(() => false);
  primary.current = () => {
    if (!plan || busy) return false;
    const set = actionSet(plan, snapshot.heard, selection(ticked, plan.steps.length));
    const entry = primaryAction(set, (e) => actionMethods(e.id, plan).every((m) => can.has(m)));
    if (!entry) return false;
    run(entry);
    return true;
  };
  useEffect(() => (commands ? commands.register('right', 'plans.primary', () => primary.current()) : undefined), [commands]);

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
      previewError={preview?.error !== undefined ? refusalOf(preview.error) : null}
      staleReasons={reasons}
      rejecting={rejecting}
      hotStep={hotStep}
      agent={agent}
      pinnedStep={pinnedStep}
      requests={shownRequests ?? undefined}
      composerText={composer.text}
      composerRefusal={composer.refusal}
      onComposerText={composer.setText}
      onSend={composer.send}
      onCancelRequest={composer.cancel}
      onDismissRequest={composer.dismiss}
      onLocate={(index) => review.locate(index)}
      onSelect={select}
      onTicked={(next) => review.setTicked(next)}
      onNote={setNote}
      onRun={run}
      onRejecting={setRejecting}
      onHotStep={(index) => review.setHot(index)}
    />
  );
}
