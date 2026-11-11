// The plan review's actions (m5-plan-review; spec "Frontend", plan review).
// Each button is one protocol request; Audition is plan.propose followed by
// audition.hear of the branch it opened. The answer is reported, never
// retried, and the plan's state is left to plan.changed: a plan_stale answer
// names the changed entities and leaves the plan where it was.

import type { PlanEntry } from '../model/plan-store';
import { ProtocolError } from '../model/session-client';

export interface ActionClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export type PlanAction =
  | { readonly kind: 'approve'; readonly plan: string }
  | { readonly kind: 'approveSelected'; readonly plan: string; readonly steps: readonly number[] }
  | { readonly kind: 'reject'; readonly plan: string; readonly note: string }
  | { readonly kind: 'apply'; readonly plan: string }
  | { readonly kind: 'audition'; readonly plan: string }
  | { readonly kind: 'merge'; readonly branch: string }
  | { readonly kind: 'discard'; readonly branch: string }
  | { readonly kind: 'hear'; readonly side: string };

export type ActionOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly changedEntities: readonly string[] };

// The buttons a plan offers, in display order, given the side heard.
export type ActionId =
  | 'approve'
  | 'approveSelected'
  | 'reject'
  | 'apply'
  | 'audition'
  | 'hearMain'
  | 'hearProposal'
  | 'merge'
  | 'discard';

export function availableActions(plan: PlanEntry, heard: string | null): ActionId[] {
  if (plan.state === 'validated') return ['approve', 'approveSelected', 'reject'];
  if (plan.state !== 'approved') return [];
  const branch = plan.proposalBranch;
  if (branch === undefined) return ['apply', 'audition', 'reject'];
  return [heard === branch ? 'hearMain' : 'hearProposal', 'merge', 'discard'];
}

function changedEntitiesOf(data: unknown): string[] {
  const changed = (data as { changedEntities?: unknown } | null | undefined)?.changedEntities;
  if (!Array.isArray(changed)) return [];
  return changed
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { ref?: unknown } | null)?.ref))
    .filter((ref): ref is string => typeof ref === 'string');
}

function refused(error: unknown): ActionOutcome {
  if (error instanceof ProtocolError) {
    const changedEntities = error.code === 'plan_stale' ? changedEntitiesOf(error.data) : [];
    const detail = changedEntities.length > 0 ? ` (${changedEntities.join(', ')})` : '';
    return { ok: false, code: error.code, message: `${error.code}: ${error.message}${detail}`, changedEntities };
  }
  return { ok: false, code: 'error', message: String(error), changedEntities: [] };
}

export async function runAction(client: ActionClient, action: PlanAction): Promise<ActionOutcome> {
  try {
    switch (action.kind) {
      case 'approve':
        return { ok: true, result: await client.request('plan.approve', { plan: action.plan }) };
      case 'approveSelected':
        return { ok: true, result: await client.request('plan.approve', { plan: action.plan, steps: [...action.steps] }) };
      case 'reject':
        return { ok: true, result: await client.request('plan.reject', { plan: action.plan, note: action.note }) };
      case 'apply':
        return { ok: true, result: await client.request('plan.apply', { plan: action.plan }) };
      case 'audition': {
        const proposed = (await client.request('plan.propose', { plan: action.plan })) as { branch?: unknown };
        if (typeof proposed?.branch !== 'string') throw new ProtocolError('internal_error', 'plan.propose named no branch');
        return { ok: true, result: await client.request('audition.hear', { side: proposed.branch }) };
      }
      case 'merge':
        return { ok: true, result: await client.request('proposal.merge', { branch: action.branch }) };
      case 'discard':
        return { ok: true, result: await client.request('proposal.discard', { branch: action.branch }) };
      case 'hear':
        return { ok: true, result: await client.request('audition.hear', { side: action.side }) };
    }
  } catch (error) {
    return refused(error);
  }
}
