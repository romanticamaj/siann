// The application menu (m5b-ui-project; architecture spec, "Process model";
// UI redesign 3.6). Electron's native menu, built from the model the renderer
// sends through the preload bridge (each item a command id, its label from
// the renderer's catalogs and its chord from the key preset). The chords are
// shown as accelerators and never registered (registerAccelerator: false),
// so the renderer's key dispatcher stays the one key layer; on macOS, where
// the menu fires a shown accelerator anyway, a click marked
// triggeredByAccelerator is ignored, since the dispatcher ran the key
// already. A click sends the command id back to the renderer. Pure: the
// caller builds the menu (Menu.buildFromTemplate) and owns the window.

import type { MenuItemConstructorOptions } from 'electron';

export interface MenuCommandItem {
  readonly type: 'command';
  readonly command: string;
  readonly label: string;
  readonly chord?: string;
  // false: shown disabled (Remove Bus with no bus selected; m5b-ui-sends-buses).
  readonly enabled?: false;
}

export interface MenuSeparator {
  readonly type: 'separator';
}

export interface MenuSubmenu {
  readonly type: 'submenu';
  readonly label: string;
  readonly items: readonly MenuItemModel[];
}

export type MenuItemModel = MenuCommandItem | MenuSeparator | MenuSubmenu;

export interface MenuModel {
  readonly menus: ReadonlyArray<{ readonly id: 'file' | 'studio'; readonly label: string; readonly items: readonly MenuItemModel[] }>;
}

// Bounds on what the renderer may send.
const MAX_ITEMS = 64;
const MAX_LABEL = 1024;
const COMMAND = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const CHORD = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?[A-Za-z0-9]+$/;

function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL;
}

function parseItems(value: unknown, depth: number): MenuItemModel[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: MenuItemModel[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (item.type === 'separator') {
      out.push({ type: 'separator' });
    } else if (item.type === 'command') {
      if (typeof item.command !== 'string' || !COMMAND.test(item.command) || !label(item.label)) return null;
      if (item.chord !== undefined && (typeof item.chord !== 'string' || !CHORD.test(item.chord))) return null;
      if (item.enabled !== undefined && item.enabled !== false) return null;
      out.push({
        type: 'command',
        command: item.command,
        label: item.label,
        ...(item.chord !== undefined ? { chord: item.chord as string } : {}),
        ...(item.enabled === false ? { enabled: false as const } : {}),
      });
    } else if (item.type === 'submenu' && depth === 0) {
      const items = parseItems(item.items, depth + 1);
      if (!items || !label(item.label)) return null;
      out.push({ type: 'submenu', label: item.label, items });
    } else {
      return null;
    }
  }
  return out;
}

// The model the renderer sent, or null when it is not one.
export function parseMenuModel(value: unknown): MenuModel | null {
  if (value === null || typeof value !== 'object') return null;
  const menus = (value as { menus?: unknown }).menus;
  if (!Array.isArray(menus) || menus.length > 2) return null;
  const out: Array<MenuModel['menus'][number]> = [];
  for (const raw of menus) {
    if (raw === null || typeof raw !== 'object') return null;
    const menu = raw as Record<string, unknown>;
    if ((menu.id !== 'file' && menu.id !== 'studio') || !label(menu.label)) return null;
    const items = parseItems(menu.items, 0);
    if (!items) return null;
    out.push({ id: menu.id, label: menu.label, items });
  }
  return { menus: out };
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Delete: 'Delete',
  Backspace: 'Backspace',
  NumpadEnter: 'Enter',
  NumpadDecimal: 'numdec',
  NumpadDivide: 'numdiv',
  NumpadMultiply: 'nummult',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
};

// A preset chord (keys/preset-cubase.ts: Mod, Ctrl, Alt, Shift, then the key
// as event.code names it without its Key or Digit prefix) as an Electron
// accelerator, or undefined for a key it has no name for.
export function acceleratorOf(chord: string): string | undefined {
  const parts = chord.split('+');
  const key = parts.pop();
  if (!key) return undefined;
  const modifiers = parts.map((part) => (part === 'Mod' ? 'CmdOrCtrl' : part === 'Ctrl' ? 'Control' : part));
  let name: string | undefined;
  if (/^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) name = key;
  else if (/^Numpad[0-9]$/.test(key)) name = `num${key.slice(6)}`;
  else name = KEY_NAMES[key];
  return name === undefined ? undefined : [...modifiers, name].join('+');
}

export interface MenuOptions {
  readonly platform: NodeJS.Platform;
  // The View menu (reload, devtools) under SIANN_SHELL_DEVTOOLS=1 only.
  readonly devtools: boolean;
  // A click's command id, for the renderer.
  readonly send: (command: string) => void;
}

interface ClickEvent {
  readonly triggeredByAccelerator?: boolean;
}

function items(list: readonly MenuItemModel[], send: (command: string) => void): MenuItemConstructorOptions[] {
  return list.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' };
    if (item.type === 'submenu') return { label: item.label, submenu: items(item.items, send), enabled: item.items.length > 0 };
    const accelerator = item.chord ? acceleratorOf(item.chord) : undefined;
    return {
      id: item.command,
      label: item.label,
      ...(accelerator ? { accelerator } : {}),
      registerAccelerator: false,
      ...(item.enabled === false ? { enabled: false } : {}),
      click: (_menuItem, _window, event: ClickEvent | undefined) => {
        if (event?.triggeredByAccelerator) return;
        send(item.command);
      },
    };
  });
}

// The menu bar: the app menu on macOS, File (the model's items, then Close
// on macOS or Quit), Edit, View with devtools only, Studio, Window. Role items
// only besides the model's, and none that reloads or opens devtools.
export function menuTemplate(model: MenuModel | null, options: MenuOptions): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const file = model?.menus.find((menu) => menu.id === 'file');
  const studio = model?.menus.find((menu) => menu.id === 'studio');
  const template: MenuItemConstructorOptions[] = [];
  if (mac) template.push({ role: 'appMenu' });
  if (file) {
    const own = items(file.items, options.send);
    template.push({ label: file.label, submenu: [...own, ...(own.length > 0 ? [{ type: 'separator' } as const] : []), { role: mac ? 'close' : 'quit' }] });
  } else {
    template.push({ role: 'fileMenu' });
  }
  template.push({ role: 'editMenu' });
  if (options.devtools) template.push({ role: 'viewMenu' });
  if (studio && studio.items.length > 0) template.push({ label: studio.label, submenu: items(studio.items, options.send) });
  template.push({ role: 'windowMenu' });
  return template;
}
