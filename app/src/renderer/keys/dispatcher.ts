// The key dispatcher. Placeholder: arrives with the feature commit.

import type { Binding, Scope } from './commands';

export interface KeyModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface KeyInput {
  readonly code: string;
  readonly key: string;
  readonly modifiers: KeyModifiers;
  readonly targetIsTextField: boolean;
  readonly focusedZone: Exclude<Scope, 'window'>;
  readonly platform: 'mac' | 'other';
}

export function chordOf(_input: KeyInput): string {
  throw new Error('not implemented');
}

export function resolveKey(_input: KeyInput, _preset: readonly Binding[]): Binding | null {
  throw new Error('not implemented');
}

export function isTextField(_target: EventTarget | null): boolean {
  throw new Error('not implemented');
}
