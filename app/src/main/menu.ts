// The application menu (m5b-ui-project, completed by m5b-ui-keymap;
// architecture spec, "Process model"; UI redesign 3.6). Electron's native
// menu, built wholly from the model the renderer sends through the preload
// bridge: seven menus (File, Edit, Project, Transport, Studio, Window, Help),
// each item a command id, its label from the renderer's catalogs and its
// chord from the key preset; File's Quit (Close on macOS) and Window's
// Minimize are role items with the catalogs' labels. The chords are shown as
// accelerators and never registered (registerAccelerator: false), so the
// renderer's key dispatcher stays the one key layer; on macOS, where the
// menu fires a shown accelerator anyway, a click marked
// triggeredByAccelerator is ignored, since the dispatcher ran the key
// already. A click sends the command id back to the renderer.
//
// The Edit menu carries no Electron roles, so its Undo, Redo, Cut, Copy,
// Paste and Select All name their text-field action: while the renderer
// reports a text field focused, a click (or, on macOS, the accelerator)
// runs that action on the window's web contents (webContents.cut() and the
// rest) instead of the command, so the platform's editing keys and the
// menu keep working in a text field. Before the renderer's first model the
// menus are Electron's roles. Pure: the caller builds the menu
// (Menu.buildFromTemplate) and owns the window.

import type { MenuItemConstructorOptions } from 'electron';

export type TextAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
const TEXT_ACTIONS: ReadonlySet<string> = new Set<TextAction>(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);

export interface MenuCommandItem {
  readonly type: 'command';
  readonly command: string;
  readonly label: string;
  readonly chord?: string;
  // false: shown disabled (Remove Bus with no bus selected; m5b-ui-sends-buses).
  readonly enabled?: false;
  readonly text?: TextAction;
}

export interface MenuRole {
  readonly type: 'role';
  readonly role: 'quit' | 'close' | 'minimize';
  readonly label: string;
}

export interface MenuSeparator {
  readonly type: 'separator';
}

export interface MenuSubmenu {
  readonly type: 'submenu';
  readonly label: string;
  readonly items: readonly MenuItemModel[];
}

export type MenuItemModel = MenuCommandItem | MenuSeparator | MenuRole | MenuSubmenu;

export const MENU_IDS = ['file', 'edit', 'project', 'transport', 'studio', 'window', 'help'] as const;
export type MenuId = (typeof MENU_IDS)[number];

export interface MenuModel {
  readonly menus: ReadonlyArray<{ readonly id: MenuId; readonly label: string; readonly items: readonly MenuItemModel[] }>;
}

// Bounds on what the renderer may send.
const MAX_ITEMS = 64;
const MAX_LABEL = 1024;
const COMMAND = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const CHORD = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?[A-Za-z0-9]+$/;
const ROLES: ReadonlySet<string> = new Set(['quit', 'close', 'minimize']);

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
      if (item.text !== undefined && (typeof item.text !== 'string' || !TEXT_ACTIONS.has(item.text))) return null;
      out.push({
        type: 'command',
        command: item.command,
        label: item.label,
        ...(item.chord !== undefined ? { chord: item.chord as string } : {}),
        ...(item.enabled === false ? { enabled: false as const } : {}),
        ...(item.text !== undefined ? { text: item.text as TextAction } : {}),
      });
    } else if (item.type === 'role' && depth === 0) {
      if (typeof item.role !== 'string' || !ROLES.has(item.role) || !label(item.label)) return null;
      out.push({ type: 'role', role: item.role as MenuRole['role'], label: item.label });
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

// The model the renderer sent, or null when it is not one: menus of the
// seven ids, each at most once.
export function parseMenuModel(value: unknown): MenuModel | null {
  if (value === null || typeof value !== 'object') return null;
  const menus = (value as { menus?: unknown }).menus;
  if (!Array.isArray(menus) || menus.length > MENU_IDS.length) return null;
  const out: Array<MenuModel['menus'][number]> = [];
  const seen = new Set<string>();
  for (const raw of menus) {
    if (raw === null || typeof raw !== 'object') return null;
    const menu = raw as Record<string, unknown>;
    if (typeof menu.id !== 'string' || !(MENU_IDS as readonly string[]).includes(menu.id) || seen.has(menu.id) || !label(menu.label)) return null;
    seen.add(menu.id);
    const items = parseItems(menu.items, 0);
    if (!items) return null;
    out.push({ id: menu.id as MenuId, label: menu.label, items });
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
  Insert: 'Insert',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  NumpadEnter: 'Enter',
  NumpadDecimal: 'numdec',
  NumpadComma: 'numdec',
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
  // A text field has the focus in the window (the renderer says so).
  readonly textFocused?: () => boolean;
  // Runs a text-field action on the window's web contents.
  readonly textEdit?: (action: TextAction) => void;
}

interface ClickEvent {
  readonly triggeredByAccelerator?: boolean;
}

function items(list: readonly MenuItemModel[], options: MenuOptions): MenuItemConstructorOptions[] {
  return list.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' };
    if (item.type === 'submenu') return { label: item.label, submenu: items(item.items, options), enabled: item.items.length > 0 };
    if (item.type === 'role') return { role: item.role, label: item.label };
    const accelerator = item.chord ? acceleratorOf(item.chord) : undefined;
    return {
      id: item.command,
      label: item.label,
      ...(accelerator ? { accelerator } : {}),
      registerAccelerator: false,
      ...(item.enabled === false ? { enabled: false } : {}),
      click: (_menuItem, _window, event: ClickEvent | undefined) => {
        // In a text field the field's own action, by click or by the accelerator macOS fires.
        if (item.text && options.textFocused?.() && options.textEdit) {
          options.textEdit(item.text);
          return;
        }
        if (event?.triggeredByAccelerator) return;
        options.send(item.command);
      },
    };
  });
}

// The menu bar: the app menu on macOS, then the model's menus in its order
// (an empty one is left out), the View menu after Edit with devtools only.
// Role items only besides the model's (Quit, Close, Minimize), and none that
// reloads or opens devtools. Before any model, Electron's own menus.
export function menuTemplate(model: MenuModel | null, options: MenuOptions): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];
  if (mac) template.push({ role: 'appMenu' });
  if (!model) {
    template.push({ role: 'fileMenu' }, { role: 'editMenu' });
    if (options.devtools) template.push({ role: 'viewMenu' });
    template.push({ role: 'windowMenu' });
    return template;
  }
  for (const menu of model.menus) {
    if (menu.items.length === 0) continue;
    template.push({ label: menu.label, submenu: items(menu.items, options) });
    if (menu.id === 'edit' && options.devtools) template.push({ role: 'viewMenu' });
  }
  return template;
}
