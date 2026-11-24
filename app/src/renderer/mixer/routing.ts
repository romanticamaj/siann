// Output routing and the capability gates of the buses, the sends and the
// rack switches (m5b-ui-sends-buses; UI redesign 3.0, 3.4; 10.11, 25).
//
// An output selector lists the master first, then the buses in busOrder: on
// a track every bus, on a bus every other bus. A bus whose choice would close
// a loop is offered too: the engine refuses it with routing_cycle and the UI
// shows that refusal, it does not guess the graph.
//
// The gates (3.0): bus strips, the bus menu items and every output selector
// need features.buses (an output selector also its command); the sends
// racks and the Inspector's Sends section need features.sends and send.add
// (and buses to send to). A rack switch is rendered only where its rack can
// be; a stored rack the engine cannot show reads as none lit. Framework-free.

import type { CapabilitySelector } from '../model/capabilities';
import type { BusEntity, TrackEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { Rack } from '../shell/layout';
import { pluginsListed } from './inserts';

export type OutputOwner = { readonly kind: 'track'; readonly id: string } | { readonly kind: 'bus'; readonly id: string };

// A choice of a selector: a bus, or the master (busId null, its name the catalog's).
export interface OutputChoice {
  readonly busId: string | null;
  readonly name: string | null;
}

const MASTER: OutputChoice = Object.freeze({ busId: null, name: null });

export function outputChoices(snapshot: Snapshot, owner: OutputOwner): OutputChoice[] {
  const buses = snapshot.busOrder
    .filter((id) => !(owner.kind === 'bus' && id === owner.id))
    .map((id) => snapshot.entities[`bus:${id}`] as BusEntity | undefined)
    .filter((bus): bus is BusEntity => bus !== undefined)
    .map((bus) => ({ busId: bus.id, name: bus.name }));
  return [MASTER, ...buses];
}

// The bus the owner outputs to, or null for the master.
export function outputOf(snapshot: Snapshot, owner: OutputOwner): string | null {
  const entity = snapshot.entities[`${owner.kind}:${owner.id}`] as TrackEntity | BusEntity | undefined;
  return entity?.output?.busId ?? null;
}

export function busesListed(can: CapabilitySelector): boolean {
  return can.feature('buses');
}

export function routingListed(can: CapabilitySelector): boolean {
  return busesListed(can) && can.command('track.set_output');
}

export function sendsListed(can: CapabilitySelector): boolean {
  return busesListed(can) && can.feature('sends') && can.command('send.add');
}

export type RackAvailability = Readonly<Record<Rack, boolean>>;

export function availableRacks(can: CapabilitySelector): RackAvailability {
  return { routing: routingListed(can), inserts: pluginsListed(can), sends: sendsListed(can) };
}

// The rack the strips show: the lit one, when the engine can show it.
export function shownRack(stored: Rack | null, available: RackAvailability): Rack | null {
  return stored !== null && available[stored] ? stored : null;
}
