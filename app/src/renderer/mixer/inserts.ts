// The insert rack's pure logic (m5b-ui-inserts-master; UI redesign 3.4, 3.0).
//
// The rack row of a strip holds two slots, as the mockup draws it
// (--strip-inserts-h, --insert-slot-h): with fewer than two inserts the
// remaining positions are empty slots (the mockup's .slot.empty); with two or
// more the rack lists every slot in signal order followed by one empty slot,
// and scrolls inside its row. The Inspector's Inserts section lists every slot
// without a limit, then one empty slot. Every empty slot inserts at the end of
// the chain.
//
// The capability rule (3.0): the racks, the rack switch, the picker and the
// Inspector's section exist only when engine.capabilities lists
// features.plugins and the methods plugin.instantiate and plugin.registry;
// each control of a slot needs its own command or methods.

import type { CapabilitySelector } from '../model/capabilities';
import { pluginOf, type EngineStatus } from '../model/engine-status';

export type RackRow = { readonly kind: 'slot'; readonly slotId: string } | { readonly kind: 'empty' };

// The positions of a strip's rack row.
export const RACK_POSITIONS = 2;

const EMPTY: RackRow = Object.freeze({ kind: 'empty' });
const slotRow = (slotId: string): RackRow => ({ kind: 'slot', slotId });

export function rackRows(inserts: readonly string[] | undefined): RackRow[] {
  const slots = (inserts ?? []).map(slotRow);
  if (slots.length >= RACK_POSITIONS) return [...slots, EMPTY];
  return [...slots, ...Array.from({ length: RACK_POSITIONS - slots.length }, () => EMPTY)];
}

export function inspectorRows(inserts: readonly string[] | undefined): RackRow[] {
  return [...(inserts ?? []).map(slotRow), EMPTY];
}

// Where an empty slot inserts: the end of the chain.
export function insertIndex(inserts: readonly string[] | undefined): number {
  return inserts?.length ?? 0;
}

export interface SlotState {
  // running or missing as engine.status reports it; unknown without a row.
  readonly state: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export function slotState(status: EngineStatus | null, slotId: string): SlotState {
  const row = pluginOf(status, slotId);
  if (!row) return { state: 'unknown', error: null };
  return { state: row.state || 'unknown', error: row.error };
}

// The one capability gate of the insert racks.
export function pluginsListed(can: CapabilitySelector): boolean {
  return can.feature('plugins') && can.has('plugin.instantiate') && can.has('plugin.registry');
}

export interface SlotButtons {
  readonly bypass: boolean;
  readonly edit: boolean;
  readonly remove: boolean;
  // The picker's Approve.
  readonly approve: boolean;
}

export function buttonsListed(can: CapabilitySelector): SlotButtons {
  return {
    bypass: can.command('plugin.set_bypass'),
    edit: can.has('plugin.open_editor') && can.has('plugin.close_editor'),
    remove: can.command('plugin.remove'),
    approve: can.has('plugin.approve'),
  };
}
