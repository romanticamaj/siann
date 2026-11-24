// The bus, send and routing commands (m5b-ui-sends-buses; UI redesign 3.4,
// 10.11, 24; docs/schemas/protocol-engine-v0.md, "Buses and sends"): each
// control of a bus strip, a send slot and an output selector sends one
// command.execute, built here from the snapshot with its revision as
// expectedRevision. mixer.bus.add is one bus.add with a client-chosen bus_ id
// (16 lowercase hex digits, as track ids are chosen) and the catalog's name
// with the lowest free number; a send is added post-fader at 0 dB with a snd_
// id; the master is output null. A command that changes nothing, or names an
// entity the snapshot does not hold, is null. The removal summary names what
// a bus.remove takes with it (the engine's cascade: the bus's sends and the
// tracks and buses routed to it, rerouted to the master), which the
// confirmation shows. Framework-free.

import type { BusEntity, SendEntity, TrackEntity } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { TimelineCommand } from '../timeline/commands';

function hexId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const newBusId = (): string => hexId('bus');
export const newSendId = (): string => hexId('snd');

const busOf = (snapshot: Snapshot, busId: string) => snapshot.entities[`bus:${busId}`] as BusEntity | undefined;
const sendOf = (snapshot: Snapshot, sendId: string) => snapshot.entities[`send:${sendId}`] as SendEntity | undefined;
const trackOf = (snapshot: Snapshot, trackId: string) => snapshot.entities[`track:${trackId}`] as TrackEntity | undefined;

function command(snapshot: Snapshot, op: Record<string, unknown>): TimelineCommand {
  return { expectedRevision: snapshot.revision, commands: [op] };
}

// The default name with the lowest number no bus of the snapshot carries.
export function nextBusName(snapshot: Snapshot, name: (n: number) => string): string {
  const taken = new Set(snapshot.buses.map((bus) => bus.name));
  for (let n = 1; ; n += 1) {
    const candidate = name(n);
    if (!taken.has(candidate)) return candidate;
  }
}

export function addBusCommand(snapshot: Snapshot, name: string, busId: () => string = newBusId): TimelineCommand {
  return command(snapshot, { op: 'bus.add', busId: busId(), name });
}

export function removeBusCommand(snapshot: Snapshot, busId: string): TimelineCommand | null {
  return busOf(snapshot, busId) ? command(snapshot, { op: 'bus.remove', busId }) : null;
}

export function renameBusCommand(snapshot: Snapshot, busId: string, name: string): TimelineCommand | null {
  const bus = busOf(snapshot, busId);
  const next = name.trim();
  if (!bus || next === '' || next === bus.name) return null;
  return command(snapshot, { op: 'bus.rename', busId, name: next });
}

export function busPanCommand(snapshot: Snapshot, busId: string, pan: number): TimelineCommand | null {
  const bus = busOf(snapshot, busId);
  if (!bus || bus.pan === pan) return null;
  return command(snapshot, { op: 'bus.set_pan', busId, pan });
}

// Mute or solo, flipped from what the engine committed.
export function busToggleCommand(snapshot: Snapshot, busId: string, field: 'mute' | 'solo'): TimelineCommand | null {
  const bus = busOf(snapshot, busId);
  if (!bus) return null;
  return command(snapshot, { op: field === 'mute' ? 'bus.set_mute' : 'bus.set_solo', busId, [field]: !bus[field] });
}

const output = (busId: string | null) => (busId === null ? null : { busId });

export function trackOutputCommand(snapshot: Snapshot, trackId: string, busId: string | null): TimelineCommand | null {
  const track = trackOf(snapshot, trackId);
  if (!track || (track.output?.busId ?? null) === busId) return null;
  return command(snapshot, { op: 'track.set_output', trackId, output: output(busId) });
}

export function busOutputCommand(snapshot: Snapshot, busId: string, target: string | null): TimelineCommand | null {
  const bus = busOf(snapshot, busId);
  if (!bus || (bus.output?.busId ?? null) === target) return null;
  return command(snapshot, { op: 'bus.set_output', busId, output: output(target) });
}

export function addSendCommand(snapshot: Snapshot, trackId: string, busId: string, sendId: () => string = newSendId): TimelineCommand {
  return command(snapshot, { op: 'send.add', sendId: sendId(), trackId, busId, levelMilliDb: 0, pre: false });
}

export function sendPreCommand(snapshot: Snapshot, sendId: string, pre: boolean): TimelineCommand | null {
  const send = sendOf(snapshot, sendId);
  if (!send || send.pre === pre) return null;
  return command(snapshot, { op: 'send.set_pre', sendId, pre });
}

export function sendEnabledCommand(snapshot: Snapshot, sendId: string, enabled: boolean): TimelineCommand | null {
  const send = sendOf(snapshot, sendId);
  if (!send || send.enabled === enabled) return null;
  return command(snapshot, { op: 'send.set_enabled', sendId, enabled });
}

export function removeSendCommand(snapshot: Snapshot, sendId: string): TimelineCommand | null {
  return sendOf(snapshot, sendId) ? command(snapshot, { op: 'send.remove', sendId }) : null;
}

// What removing a bus takes with it, by name: the tracks whose sends to it
// go, the tracks and the buses that output to it (they fall back to the
// master), each once, tracks in the track order and buses in busOrder.
export interface RemovalSummary {
  readonly sends: readonly string[];
  readonly tracks: readonly string[];
  readonly buses: readonly string[];
}

export function removalSummary(busId: string, snapshot: Snapshot): RemovalSummary {
  const tracks = snapshot.trackOrder.map((id) => trackOf(snapshot, id)).filter((t): t is TrackEntity => t !== undefined);
  const sending = new Set(snapshot.sends.filter((s) => s.busId === busId).map((s) => s.trackId));
  const buses = snapshot.busOrder.map((id) => busOf(snapshot, id)).filter((b): b is BusEntity => b !== undefined);
  return {
    sends: tracks.filter((t) => sending.has(t.id)).map((t) => t.name),
    tracks: tracks.filter((t) => t.output?.busId === busId).map((t) => t.name),
    buses: buses.filter((b) => b.id !== busId && b.output?.busId === busId).map((b) => b.name),
  };
}

export function needsConfirmation(summary: RemovalSummary): boolean {
  return summary.sends.length > 0 || summary.tracks.length > 0 || summary.buses.length > 0;
}
