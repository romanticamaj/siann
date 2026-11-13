// Plan review (m5-plan-review; spec "Frontend", plan review; Protocol v0
// item 25). Lists the engine's plans from the PlanStore with a state badge
// each and the side heard; for the selected plan shows its steps (with
// checkboxes for partial approval) and its diff against the current revision
// from plan.preview, re-read whenever the head or the plan changes; an
// applied or rolled-back plan is not previewed and shows the revision it
// landed at instead. The buttons follow the plan lifecycle (plans/actions.ts;
// Audition and the Hear buttons only with an auditioner); each is one protocol
// request (Audition two), and the list follows plan.changed, never an
// optimistic state. A refusal (plan_stale with its entities) is shown on the
// error line. Every word comes from the catalogs (m5-ui-i18n); hashes, branch
// names, refs and the names in the agent's steps are shown as they are.

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { MessageKey } from '../i18n/en';
import { refusalLine } from '../i18n/errors';
import { translator, useLocale } from '../i18n/t';
import type { PlanEntry, PlanStore } from '../model/plan-store';
import { ProtocolError, type SessionClient } from '../model/session-client';
import { Capable } from '../shell/Capable';
import { availableActions, landedLabel, runAction, type ActionId, type PlanAction } from './actions';
import { selection, type PlanPreview } from './diff';
import { PlanDiff } from './PlanDiff';
import { StepList } from './StepList';

export interface PlanReviewProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
}

export function hash8(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}

type Refusal = { readonly code: string | null; readonly message: string; readonly detail: string };

type PreviewState = { readonly plan: string; readonly preview: PlanPreview } | { readonly plan: string; readonly error: Refusal };

function usePlans(plans: PlanStore) {
  return useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.getSnapshot(),
    () => plans.getSnapshot(),
  );
}

function useSnapshot(client: SessionClient) {
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
}

// plan.preview of the selected plan, read again when the head revision, the
// plan's state or its staleness changes; none for a plan that has landed.
function usePreview(client: SessionClient, plan: PlanEntry | undefined, revision: string | null): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  const hash = plan && landedLabel(plan) === null ? plan.hash : null;
  const planState = plan?.state ?? null;
  const staleKey = plan ? plan.stale.map((s) => `${s.ref}:${s.change}`).join(',') : '';
  useEffect(() => {
    if (hash === null) {
      setState(null);
      return undefined;
    }
    let current = true;
    client.request('plan.preview', { plan: hash }).then(
      (result) => {
        if (current) setState({ plan: hash, preview: result as PlanPreview });
      },
      (error: unknown) => {
        if (!current) return;
        const refusal: Refusal =
          error instanceof ProtocolError
            ? { code: error.code, message: error.message, detail: '' }
            : { code: null, message: String(error), detail: '' };
        setState({ plan: hash, error: refusal });
      },
    );
    return () => {
      current = false;
    };
  }, [client, hash, planState, staleKey, revision]);
  return state !== null && state.plan === hash ? state : null;
}

// Each action's button exists only when engine.capabilities lists the method
// it sends (UI redesign spec 3.0); audition sends plan.approve and
// plan.propose before audition.hear, and is listed under plan.propose.
const BUTTONS: ReadonlyArray<{ id: ActionId; testId: string; label: MessageKey; method: string }> = [
  { id: 'approve', testId: 'plan-approve', label: 'plans.approve', method: 'plan.approve' },
  { id: 'approveSelected', testId: 'plan-approve-selected', label: 'plans.approveSelected', method: 'plan.approve' },
  { id: 'reject', testId: 'plan-reject', label: 'plans.reject', method: 'plan.reject' },
  { id: 'apply', testId: 'plan-apply', label: 'plans.apply', method: 'plan.apply' },
  { id: 'audition', testId: 'plan-audition', label: 'plans.audition', method: 'plan.propose' },
  { id: 'hearMain', testId: 'plan-hear-main', label: 'plans.hearMain', method: 'audition.hear' },
  { id: 'hearProposal', testId: 'plan-hear-proposal', label: 'plans.hearProposal', method: 'audition.hear' },
  { id: 'merge', testId: 'plan-merge', label: 'plans.merge', method: 'proposal.merge' },
  { id: 'discard', testId: 'plan-discard', label: 'plans.discard', method: 'proposal.discard' },
];

// The note field (sent with plan.reject, so it exists only when that method
// is listed) and the action buttons.
export interface PlanActionsProps {
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly enabled: (id: ActionId) => boolean;
  readonly onRun: (id: ActionId) => void;
}

export function PlanActions({ note, onNote, enabled, onRun }: PlanActionsProps) {
  const t = translator(useLocale());
  return (
    <div className="plan-actions">
      <Capable method="plan.reject">
        <label>
          {t('plans.note')}{' '}
          <input data-testid="plan-note" value={note} onChange={(event) => onNote(event.target.value)} />
        </label>
      </Capable>
      {BUTTONS.map((button) => (
        <Capable key={button.id} method={button.method}>
          <button type="button" data-testid={button.testId} disabled={!enabled(button.id)} onClick={() => onRun(button.id)}>
            {t(button.label)}
          </button>
        </Capable>
      ))}
    </div>
  );
}

export function PlanReview({ client, plans }: PlanReviewProps) {
  const snapshot = usePlans(plans);
  const model = useSnapshot(client);
  const [selected, setSelected] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const locale = useLocale();
  const t = translator(locale);
  const plan = selected !== null ? snapshot.byHash.get(selected) : undefined;
  const preview = usePreview(client, plan, model?.revision ?? null);

  useEffect(() => {
    setTicked(new Set());
    setError(null);
  }, [selected]);

  const trackName = (id: string): string | undefined => {
    const track = client.model.select(`track:${id}`) as { name?: unknown } | undefined;
    return typeof track?.name === 'string' ? track.name : undefined;
  };

  // availableActions leaves out Audition and the Hear buttons while the side
  // heard is unknown (no auditioner), so enabled() disables them there.
  const available = plan ? availableActions(plan, snapshot.heard) : [];
  const landed = plan ? landedLabel(plan, t) : null;
  const chosen = selection(ticked, plan?.steps.length ?? 0);

  const actionFor = (id: ActionId, entry: PlanEntry): PlanAction | null => {
    const branch = entry.proposalBranch;
    switch (id) {
      case 'approve':
        return { kind: 'approve', plan: entry.hash };
      case 'approveSelected':
        return { kind: 'approveSelected', plan: entry.hash, steps: chosen.steps };
      case 'reject':
        return { kind: 'reject', plan: entry.hash, note };
      case 'apply':
        return { kind: 'apply', plan: entry.hash };
      case 'audition':
        return { kind: 'audition', plan: entry.hash };
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

  const run = (id: ActionId) => {
    if (!plan || busy) return;
    const action = actionFor(id, plan);
    if (!action) return;
    setBusy(true);
    void runAction(client, action).then((outcome) => {
      setBusy(false);
      setError(outcome.ok ? null : { code: outcome.code, message: outcome.engineMessage, detail: outcome.detail });
      if (outcome.ok && (id === 'approveSelected' || id === 'reject')) setTicked(new Set());
      if (outcome.ok && id === 'reject') setNote('');
    });
  };

  const enabled = (id: ActionId): boolean =>
    !busy && available.includes(id) && (id !== 'approveSelected' || chosen.canApproveSelected);

  return (
    <section className="plan-review" data-testid="plan-review" aria-label={t('plans.label')}>
      <h2>
        {t('plans.title')} <span className="plan-heard-label">{t('plans.heard')}</span>{' '}
        <span className="plan-heard" data-testid="plan-heard">
          {snapshot.heard ?? ''}
        </span>
      </h2>
      <ul className="plan-list" data-testid="plan-list">
        {snapshot.plans.map((entry) => (
          <li key={entry.hash}>
            <button
              type="button"
              data-testid={`plan-${hash8(entry.hash)}`}
              aria-pressed={entry.hash === selected}
              onClick={() => setSelected(entry.hash)}
            >
              <code>{hash8(entry.hash)}</code> {t('plans.steps', { count: entry.steps.length })}
              {entry.parentPlan ? ` ${t('plans.partOf', { plan: hash8(entry.parentPlan) })}` : ''}{' '}
              <span
                className={`plan-state plan-state-${entry.state}`}
                data-testid={`plan-state-${hash8(entry.hash)}`}
                data-state={entry.state}
              >
                {t(`planState.${entry.state}`)}
              </span>
              {entry.proposalBranch ? (
                <span className="plan-branch" data-testid={`plan-branch-${hash8(entry.hash)}`}>
                  {' '}
                  {entry.proposalBranch}
                  {snapshot.heard === entry.proposalBranch ? ` ${t('plans.heardMark')}` : ''}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {plan ? (
        <div className="plan-detail" data-testid="plan-detail">
          <StepList
            steps={plan.steps}
            ticked={ticked}
            disabled={busy || plan.state !== 'validated'}
            trackName={trackName}
            onToggle={(index) =>
              setTicked((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
          />
          <PlanActions note={note} onNote={setNote} enabled={enabled} onRun={run} />
          <p className="plan-error" data-testid="plan-error" role="status" data-code={error?.code ?? undefined}>
            {error ? refusalLine(error.code, error.message, locale, error.detail) : ''}
          </p>
          {landed !== null ? (
            <p className="plan-landed" data-testid="plan-landed">
              {landed}
            </p>
          ) : null}
          {preview && 'preview' in preview ? <PlanDiff preview={preview.preview} stale={plan.stale} /> : null}
          {preview && 'error' in preview ? (
            <p className="plan-preview-error" data-testid="plan-preview-error" data-code={preview.error.code ?? undefined}>
              {refusalLine(preview.error.code, preview.error.message, locale)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
