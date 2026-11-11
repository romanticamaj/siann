// Plan review (m5-plan-review; spec "Frontend", plan review; Protocol v0
// item 25). Lists the engine's plans from the PlanStore with a state badge
// each and the side heard; for the selected plan shows its steps (with
// checkboxes for partial approval) and its diff against the current revision
// from plan.preview, re-read whenever the head or the plan changes. The
// buttons follow the plan lifecycle (plans/actions.ts); each is one protocol
// request, and the list follows plan.changed, never an optimistic state. A
// refusal (plan_stale with its entities) is shown on the error line.

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PlanEntry, PlanStore } from '../model/plan-store';
import { ProtocolError, type SessionClient } from '../model/session-client';
import { availableActions, runAction, type ActionId, type PlanAction } from './actions';
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

type PreviewState = { readonly plan: string; readonly preview: PlanPreview } | { readonly plan: string; readonly error: string };

function usePlans(plans: PlanStore) {
  return useSyncExternalStore(
    (listener) => plans.subscribe(listener),
    () => plans.getSnapshot(),
  );
}

function useSnapshot(client: SessionClient) {
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
  );
}

// plan.preview of the selected plan, read again when the head revision, the
// plan's state or its staleness changes.
function usePreview(client: SessionClient, plan: PlanEntry | undefined, revision: string | null): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  const hash = plan?.hash ?? null;
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
        const text = error instanceof ProtocolError ? `${error.code}: ${error.message}` : String(error);
        setState({ plan: hash, error: text });
      },
    );
    return () => {
      current = false;
    };
  }, [client, hash, planState, staleKey, revision]);
  return state !== null && state.plan === hash ? state : null;
}

const BUTTONS: ReadonlyArray<{ id: ActionId; testId: string; label: string }> = [
  { id: 'approve', testId: 'plan-approve', label: 'Approve' },
  { id: 'approveSelected', testId: 'plan-approve-selected', label: 'Approve selected' },
  { id: 'reject', testId: 'plan-reject', label: 'Reject' },
  { id: 'apply', testId: 'plan-apply', label: 'Apply' },
  { id: 'audition', testId: 'plan-audition', label: 'Audition' },
  { id: 'hearMain', testId: 'plan-hear-main', label: 'Hear main' },
  { id: 'hearProposal', testId: 'plan-hear-proposal', label: 'Hear proposal' },
  { id: 'merge', testId: 'plan-merge', label: 'Merge' },
  { id: 'discard', testId: 'plan-discard', label: 'Discard' },
];

export function PlanReview({ client, plans }: PlanReviewProps) {
  const snapshot = usePlans(plans);
  const model = useSnapshot(client);
  const [selected, setSelected] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = selected !== null ? snapshot.byHash.get(selected) : undefined;
  const preview = usePreview(client, plan, model?.revision ?? null);

  useEffect(() => {
    setTicked(new Set());
    setError('');
  }, [selected]);

  const trackName = (id: string): string | undefined => {
    const track = client.model.select(`track:${id}`) as { name?: unknown } | undefined;
    return typeof track?.name === 'string' ? track.name : undefined;
  };

  const available = plan ? availableActions(plan, snapshot.heard) : [];
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
      setError(outcome.ok ? '' : outcome.message);
      if (outcome.ok && (id === 'approveSelected' || id === 'reject')) setTicked(new Set());
      if (outcome.ok && id === 'reject') setNote('');
    });
  };

  const enabled = (id: ActionId): boolean =>
    !busy && available.includes(id) && (id !== 'approveSelected' || chosen.canApproveSelected);

  return (
    <section className="plan-review" data-testid="plan-review" aria-label="Plan review">
      <h2>
        Plans <span className="plan-heard-label">heard:</span>{' '}
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
              <code>{hash8(entry.hash)}</code> {entry.steps.length} step{entry.steps.length === 1 ? '' : 's'}
              {entry.parentPlan ? ` (part of ${hash8(entry.parentPlan)})` : ''}{' '}
              <span className={`plan-state plan-state-${entry.state}`} data-testid={`plan-state-${hash8(entry.hash)}`}>
                {entry.state}
              </span>
              {entry.proposalBranch ? (
                <span className="plan-branch" data-testid={`plan-branch-${hash8(entry.hash)}`}>
                  {' '}
                  {entry.proposalBranch}
                  {snapshot.heard === entry.proposalBranch ? ' (heard)' : ''}
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
          <div className="plan-actions">
            <label>
              Note{' '}
              <input data-testid="plan-note" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            {BUTTONS.map((button) => (
              <button
                key={button.id}
                type="button"
                data-testid={button.testId}
                disabled={!enabled(button.id)}
                onClick={() => run(button.id)}
              >
                {button.label}
              </button>
            ))}
          </div>
          <p className="plan-error" data-testid="plan-error" role="status">
            {error}
          </p>
          {preview && 'preview' in preview ? <PlanDiff preview={preview.preview} stale={plan.stale} /> : null}
          {preview && 'error' in preview ? (
            <p className="plan-preview-error" data-testid="plan-preview-error">
              {preview.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
