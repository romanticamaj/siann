// The Key Commands list (m5b-ui-keymap). Not implemented yet.

import type { Platform } from '../keys/chord-label';

export interface KeyCommandsProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly platform?: Platform;
  readonly initialQuery?: string;
}

export function KeyCommands(_props: KeyCommandsProps) {
  return null;
}
