// The Plans tab's actions (m5-ui-plan-panel; spec "Frontend", plan review;
// UI redesign 4.5 C4 and 3.0). actionSet() gives the actions valid in a
// plan's state, one of them primary, and nothing else: a validated plan
// offers Approve and apply (labelled "Approve N of M" with a proper subset
// ticked), Audition and Reject; an approved plan Apply, Audition and Reject;
// a proposed plan Merge, Hear main or Hear proposal, and Discard. A valid
// action that cannot run now is in the set but disabled with its reason (a
// stale plan, nothing ticked). Audition and the Hear actions need an
// auditioner: while the side heard is unknown (null) they are not offered.
//
// runAction() sends them. "Approve and apply" and "Audition" are chains of
// today's methods (plan.approve, then plan.apply of the plan or of the
// sub-plan the approval names; plan.approve, plan.propose, audition.hear):
// a chain stops at the first refusal and reports which request failed
// (failedAt) and the state the engine reached before it (reached). Nothing is
// retried and no plan state is assumed: the store follows plan.changed.

import { translator, type T } from '../i18n/t';
import type { PlanEntry } from '../model/plan-store';
import { ProtocolError } from '../model/session-client';
import type { Selection } from './diff';

export interface ActionClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export type PlanAction =
  | { readonly kind: 'approveApply'; readonly plan: string; readonly steps?: readonly number[] }
  // `approved`: the plan is approved already (no plan.approve).
  | { readonly kind: 'audition'; readonly plan: string; readonly steps?: readonly number[]; readonly approved: boolean }
  | { readonly kind: 'reject'; readonly plan: string; readonly note: string }
  | { readonly kind: 'apply'; readonly plan: string }
  | { readonly kind: 'merge'; readonly branch: string }
  | { readonly kind: 'discard'; readonly branch: string }
  | { readonly kind: 'hear'; readonly side: string };

// What the engine holds after the requests that succeeded.
export type Reached = 'approved' | 'proposed' | 'applied' | 'rejected' | 'discarded' | 'heard';

export type ActionOutcome =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly failedAt: null;
      readonly reached: Reached;
      // The plan the chain ended on: the sub-plan of a partial approval.
      readonly plan?: string;
    }
  | {
      readonly ok: false;
      // The method that was refused.
      readonly failedAt: string;
      // What the requests before it reached, null when nothing changed.
      readonly reached: Reached | null;
      readonly plan?: string;
      // null for an error without a protocol code.
      readonly code: string | null;
      // "<code>: <engine message> (<changed refs>)", in the engine's English,
      // for logs and tests. It names entity ids: the UI shows a refusal through
      // plans/RefusalLine (user wording, the raw text behind a disclosure).
      readonly message: string;
      // The engine's message alone, and plan_stale's changed refs.
      readonly engineMessage: string;
      readonly changedEntities: readonly string[];
    };

export type ActionId = 'approveApply' | 'apply' | 'audition' | 'reject' | 'merge' | 'hearMain' | 'hearProposal' | 'discard';

export interface ActionEntry {
  readonly id: ActionId;
  // The ticked steps when they are a proper subset (partial approval).
  readonly steps?: readonly number[];
}

export type DisabledReason = 'stale' | 'noneTicked';

export interface ActionSet {
  readonly primary: ActionEntry | null;
  readonly secondary: readonly ActionEntry[];
  readonly disabled: ReadonlyMap<ActionId, DisabledReason>;
}

const EMPTY: ActionSet = Object.freeze({ primary: null, secondary: Object.freeze([]), disabled: new Map() });

export function actionSet(plan: PlanEntry, heard: string | null, chosen: Selection): ActionSet {
  const stale = plan.stale.length > 0;
  const auditioner = heard !== null;
  const disabled = new Map<ActionId, DisabledReason>();
  if (plan.state === 'validated') {
    const steps = chosen.canApproveSelected ? { steps: chosen.steps } : {};
    const secondary: ActionEntry[] = [...(auditioner ? [{ id: 'audition' as const, ...steps }] : []), { id: 'reject' }];
    const reason: DisabledReason | null = stale ? 'stale' : chosen.steps.length === 0 ? 'noneTicked' : null;
    if (reason) {
      disabled.set('approveApply', reason);
      if (auditioner) disabled.set('audition', reason);
    }
    return { primary: { id: 'approveApply', ...steps }, secondary, disabled };
  }
  if (plan.state !== 'approved') return EMPTY;
  const branch = plan.proposalBranch;
  if (branch === undefined) {
    if (stale) {
      disabled.set('apply', 'stale');
      if (auditioner) disabled.set('audition', 'stale');
    }
    return { primary: { id: 'apply' }, secondary: [...(auditioner ? [{ id: 'audition' as const }] : []), { id: 'reject' }], disabled };
  }
  const hear: ActionEntry[] = heard === null ? [] : [{ id: heard === branch ? 'hearMain' : 'hearProposal' }];
  return { primary: { id: 'merge' }, secondary: [...hear, { id: 'discard' }], disabled };
}

const LABELS = {
  approveApply: 'plans.approveApply',
  apply: 'plans.apply',
  audition: 'plans.audition',
  reject: 'plans.reject',
  merge: 'plans.merge',
  hearMain: 'plans.hearMain',
  hearProposal: 'plans.hearProposal',
  discard: 'plans.discard',
} as const satisfies Record<ActionId, string>;

// The button's words: "Approve N of M" for a partial approval.
export function actionLabel(entry: ActionEntry, stepCount: number, t: T = translator('en')): string {
  if (entry.id === 'approveApply' && entry.steps) return t('plans.approveSome', { count: entry.steps.length, total: stepCount });
  return t(LABELS[entry.id]);
}

// The methods an action sends, for the capability rule (UI redesign 3.0).
export function actionMethods(id: ActionId, plan: PlanEntry): readonly string[] {
  switch (id) {
    case 'approveApply':
      return ['plan.approve', 'plan.apply'];
    case 'apply':
      return ['plan.apply'];
    case 'audition':
      return plan.state === 'validated' ? ['plan.approve', 'plan.propose', 'audition.hear'] : ['plan.propose', 'audition.hear'];
    case 'reject':
      return ['plan.reject'];
    case 'merge':
      return ['proposal.merge'];
    case 'hearMain':
    case 'hearProposal':
      return ['audition.hear'];
    case 'discard':
      return ['proposal.discard'];
  }
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

function refused(error: unknown, failedAt: string, reached: Reached | null, plan?: string): ActionOutcome {
  const at = { failedAt, reached, ...(plan !== undefined ? { plan } : {}) };
  if (error instanceof ProtocolError) {
    const changedEntities = error.code === 'plan_stale' ? changedEntitiesOf(error.data) : [];
    const detail = changedEntities.length > 0 ? ` (${changedEntities.join(', ')})` : '';
    return {
      ok: false,
      ...at,
      code: error.code,
      message: `${error.code}: ${error.message}${detail}`,
      engineMessage: error.message,
      changedEntities,
    };
  }
  return { ok: false, ...at, code: null, message: String(error), engineMessage: String(error), changedEntities: [] };
}

// One step of a chain: the request, or the refusal that stops it.
class Chain {
  reached: Reached | null = null;
  plan: string | undefined;
  constructor(private readonly client: ActionClient) {}
  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.client.request(method, params);
    } catch (error) {
      throw new Stop(refused(error, method, this.reached, this.plan));
    }
  }
  // An answer that lacks what the next request needs.
  malformed(method: string, message: string): never {
    throw new Stop(refused(new ProtocolError('internal_error', message), method, this.reached, this.plan));
  }
  // plan.approve, with the steps of a partial approval: the plan to go on with.
  async approve(plan: string, steps: readonly number[] | undefined): Promise<string> {
    const params: Record<string, unknown> = steps ? { plan, steps: [...steps] } : { plan };
    const answer = (await this.send('plan.approve', params)) as { hash?: unknown } | null;
    this.reached = 'approved';
    if (!steps) return plan;
    if (typeof answer?.hash !== 'string') this.malformed('plan.approve', 'plan.approve named no sub-plan');
    this.plan = answer.hash;
    return answer.hash;
  }
}

class Stop {
  constructor(readonly outcome: ActionOutcome) {}
}

const done = (result: unknown, reached: Reached, plan?: string): ActionOutcome => ({
  ok: true,
  result,
  failedAt: null,
  reached,
  ...(plan !== undefined ? { plan } : {}),
});

export async function runAction(client: ActionClient, action: PlanAction): Promise<ActionOutcome> {
  const chain = new Chain(client);
  try {
    switch (action.kind) {
      case 'approveApply': {
        const plan = await chain.approve(action.plan, action.steps);
        const result = await chain.send('plan.apply', { plan });
        return done(result, 'applied', chain.plan);
      }
      case 'audition': {
        const plan = action.approved ? action.plan : await chain.approve(action.plan, action.steps);
        if (action.approved) chain.reached = 'approved';
        const proposed = (await chain.send('plan.propose', { plan })) as { branch?: unknown } | null;
        chain.reached = 'proposed';
        const branch = proposed?.branch;
        if (typeof branch !== 'string') return chain.malformed('plan.propose', 'plan.propose named no branch');
        const result = await chain.send('audition.hear', { side: branch });
        return done(result, 'proposed', chain.plan);
      }
      case 'reject':
        return done(await chain.send('plan.reject', { plan: action.plan, note: action.note }), 'rejected');
      case 'apply':
        return done(await chain.send('plan.apply', { plan: action.plan }), 'applied');
      case 'merge':
        return done(await chain.send('proposal.merge', { branch: action.branch }), 'applied');
      case 'discard':
        return done(await chain.send('proposal.discard', { branch: action.branch }), 'discarded');
      case 'hear':
        return done(await chain.send('audition.hear', { side: action.side }), 'heard');
    }
  } catch (error) {
    if (error instanceof Stop) return error.outcome;
    return refused(error, action.kind, chain.reached, chain.plan);
  }
}
