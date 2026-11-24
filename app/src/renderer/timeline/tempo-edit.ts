// The tempo field (m5b-ui-keymap). Not implemented yet.

import type { CapabilitySelector } from '../model/capabilities';
import type { TempoPoint } from '../model/document';
import type { Snapshot } from '../model/read-model';
import type { TimelineCommand } from './commands';

export function parseTempo(_text: string): number | null {
  return null;
}

export function replaceTempoAt(_tempo: readonly TempoPoint[], _sampleRate: number, _cursor: bigint, _milliBpm: number): TempoPoint[] | null {
  return null;
}

export function tempoCommand(_snapshot: Snapshot, _cursor: bigint, _milliBpm: number): TimelineCommand | null {
  return null;
}

export function tempoEntryAllowed(_can: CapabilitySelector): boolean {
  return false;
}
