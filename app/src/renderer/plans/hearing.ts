// The two sides of an audition (m5b-ui-audition; UI redesign 4.3): which
// side the hearing switch marks, the proposal its Proposal button hears (the
// heard branch, else the newest proposed plan's), and the side Shift+A flips
// to: main from a heard branch, the open proposal from main, nothing while
// the side heard is unknown or no proposal is open. From the PlanStore only,
// which follows audition.changed, never a guess.

import type { PlanSnapshot } from '../model/plan-store';

export type HeardSide = 'unknown' | 'main' | 'proposal';

export function heardSide(heard: string | null): HeardSide {
  return heard === null ? 'unknown' : heard === 'main' ? 'main' : 'proposal';
}

// The branch the Proposal side hears: the heard one, else the newest open proposal.
export function proposalBranch(snapshot: Pick<PlanSnapshot, 'heard' | 'plans'>): string | undefined {
  const heard = snapshot.heard;
  if (heard !== null && heard !== 'main') return heard;
  const proposals = snapshot.plans.filter((p) => p.proposalBranch !== undefined).map((p) => p.proposalBranch!);
  return proposals[proposals.length - 1];
}

// The side Shift+A hears next, or null when it does nothing.
export function flipTarget(snapshot: Pick<PlanSnapshot, 'heard' | 'plans'>): string | null {
  const heard = snapshot.heard;
  if (heard === null) return null;
  if (heard !== 'main') return 'main';
  return proposalBranch(snapshot) ?? null;
}
