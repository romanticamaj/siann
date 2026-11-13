// The plan review's actions (m5-plan-review; spec "Frontend", plan review).
// Each button is one protocol request except Audition, which is two:
// plan.propose, then audition.hear of the branch it opened. A refused hear
// leaves the plan proposed (Discard or Hear proposal follow). The answer is
// reported, never retried, and the plan's state is left to plan.changed: a
// plan_stale answer names the changed entities and leaves the plan where it
// was. Audition and the Hear buttons need an auditioner: while the side heard
// is unknown (null) they are not offered.

import { translator, type T } from '../i18n/t';
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
  | {
      readonly ok: false;
      // null for an error without a protocol code.
      readonly code: string | null;
      // "<code>: <engine message> (<changed entities>)", in the engine's English.
      readonly message: string;
      // The engine's message alone, and the " (<changed entities>)" suffix,
      // for a line built through the catalogs (i18n/errors.ts refusalLine).
      readonly engineMessage: string;
      readonly detail: string;
      readonly changedEntities: readonly string[];
    };

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
  if (branch === undefined) return heard === null ? ['apply', 'reject'] : ['apply', 'audition', 'reject'];
  if (heard === null) return ['merge', 'discard'];
  return [heard === branch ? 'hearMain' : 'hearProposal', 'merge', 'discard'];
}

// What the review shows instead of a diff for a plan that has landed: an
// applied plan previews against a head that already holds its effects (one
// that added an entity answers already_exists), so it is not previewed.
// Null for a plan that previews. Worded through `t` (English by default).
export function landedLabel(plan: PlanEntry, t: T = translator('en')): string | null {
  const revision = plan.appliedRevision;
  if (plan.state === 'applied') return revision !== undefined ? t('plans.appliedAt', { revision }) : t('plans.applied');
  if (plan.state === 'rolled_back') return revision !== undefined ? t('plans.rolledBackAt', { revision }) : t('plans.rolledBack');
  return null;
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
    return {
      ok: false,
      code: error.code,
      message: `${error.code}: ${error.message}${detail}`,
      engineMessage: error.message,
      detail,
      changedEntities,
    };
  }
  return { ok: false, code: null, message: String(error), engineMessage: String(error), detail: '', changedEntities: [] };
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
