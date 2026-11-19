// The keys the main process takes before the page unless SIANN_SHELL_DEVTOOLS=1
// (shell hardening): F12 and Ctrl/Cmd+Shift+I (devtools), F5 and plain
// Ctrl/Cmd+R (reload). Ctrl/Cmd+Shift+R goes on to the renderer, where it is
// Record's laptop fallback (m5b-ui-recording, the Cubase preset's
// Mod+Shift+R); with no reload role in the menu it reloads nothing.

export interface KeyInput {
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export function isDevtoolsOrReloadKey(input: KeyInput): boolean {
  const key = input.key.toLowerCase();
  const command = input.control || input.meta;
  return key === 'f12' || key === 'f5' || (command && input.shift && key === 'i') || (command && !input.shift && key === 'r');
}
