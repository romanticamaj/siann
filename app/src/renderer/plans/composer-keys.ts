// The "ask the agent" box's keys and text bounds (m5b-ui-composer; UI
// redesign 4.4), pure. Enter and numpad Enter send and Shift+Enter breaks the
// line; the Enter that confirms an input-method composition (Chinese input)
// belongs to the input method: isComposing, or keyCode 229 where Chromium
// reports it that way. A text must hold a character other than white space,
// and is counted in Unicode code points against limits.agentRequestTextChars,
// as the engine counts it (protocol-engine-v0.md "Agent requests"); it is sent
// as typed.

import { composingKey } from '../keys/dispatcher';

export type ComposerKey = 'send' | 'newline' | 'none';

export interface ComposerKeyInput {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

export function composerKey(event: ComposerKeyInput): ComposerKey {
  if (composingKey(event)) return 'none';
  if (event.key !== 'Enter' && event.code !== 'Enter' && event.code !== 'NumpadEnter') return 'none';
  return event.shiftKey ? 'newline' : 'send';
}

// Code points, not UTF-16 units: a character outside the BMP counts once.
export function textLength(text: string): number {
  return [...text].length;
}

export type TextCheck = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'empty' | 'too_long' };

export function checkText(text: string, limit: number): TextCheck {
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  if (textLength(text) > limit) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}
