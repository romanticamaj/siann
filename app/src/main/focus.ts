// A second launch brings the first window forward (architecture spec, "Process
// model", Single instance). Kept apart from main.ts so a unit test can hand it a
// fake app and window.

// The parts of Electron's app and BrowserWindow the second-instance handler uses.
export interface FocusApp {
  focus(options?: { steal: boolean }): void;
}

export interface FocusWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

// On macOS 14+ activation is cooperative: BrowserWindow.focus() alone does not
// activate a background app, so the window would stay behind the app the user
// launched SIANN from. There the app takes activation (app.focus({steal: true}))
// and shows the window before focusing it. Windows and Linux restore and focus,
// as before.
export function focusFirstWindow(app: FocusApp, win: FocusWindow | null, platform: NodeJS.Platform): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (platform === 'darwin') {
    app.focus({ steal: true });
    win.show();
  }
  win.focus();
}
