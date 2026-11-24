// The application menu's model (m5b-ui-project; UI redesign 3.6; architecture
// spec, "Process model"): what the renderer sends the shell, which builds
// Electron's native menu from it (app/src/main/menu.ts) and sends a click's
// command id back, run here through the CommandRegistry. Each item is a
// command id, its label from the catalogs and its chord from the key preset,
// which the shell shows as the accelerator without registering it, so the
// dispatcher stays the one key layer. This feature adds File > New, Open,
// Open Recent (the shell's last ten bundles, by path), Save and Studio >
// Studio Setup; m5b-ui-keymap completes the other menus. A command that needs
// the shell (New, Open, the recent list) is in the model only with its port,
// and every item only where the engine lists its method (spec 3.0). Rebuilt
// on every locale, capability or recent-list change. Add Bus and Remove Bus
// (mixer.bus.add, mixer.bus.remove; m5b-ui-sends-buses, UI redesign 3.6;
// 10.11, 24) follow Studio Setup in the Studio menu until m5b-ui-keymap
// completes the menus, on an engine that lists features.buses and the
// command; Remove Bus is disabled while no bus is selected (enabled: false,
// which the shell shows as a disabled item). While a proposal is heard (the
// edit guard, 4.5 C5) both are disabled with the guard's reason in their
// label, since a native menu item has no tooltip on Windows or Linux; the
// renderer rebuilds the model when the side heard changes.

import type { T } from '../i18n/t';
import type { Binding, CommandId } from '../keys/commands';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import type { CapabilitySelector } from '../model/capabilities';
import { RECENT_COMMANDS, type RecentProject } from '../model/project';
import { studioSetupAvailable } from '../model/studio-setup';
import { busesListed } from '../mixer/routing';

// The shape app/src/main/menu.ts parses.
export interface MenuCommandItem {
  readonly type: 'command';
  readonly command: CommandId;
  readonly label: string;
  readonly chord?: string;
  // Present, and false, only on a disabled item.
  readonly enabled?: false;
}

export type MenuItemModel =
  | MenuCommandItem
  | { readonly type: 'separator' }
  | { readonly type: 'submenu'; readonly label: string; readonly items: readonly MenuItemModel[] };

export interface MenuModel {
  readonly menus: ReadonlyArray<{ readonly id: 'file' | 'studio'; readonly label: string; readonly items: readonly MenuItemModel[] }>;
}

export interface AppMenuOptions {
  readonly t: T;
  readonly recent: readonly RecentProject[];
  // The shell's port exists (New, Open and the recent list need it).
  readonly shell: boolean;
  readonly can: CapabilitySelector;
  readonly preset?: readonly Binding[];
  // A bus is selected (Remove Bus acts on it).
  readonly busSelected?: boolean;
  // The edit guard's reason while a proposal is heard (useEditGuard's text), else null.
  readonly guard?: string | null;
}

export function appMenuModel({ t, recent, shell, can, preset = CUBASE_PRESET, busSelected = false, guard = null }: AppMenuOptions): MenuModel {
  const chord = (command: CommandId) => preset.find((b) => b.commandId === command && b.scope === 'window')?.chord;
  const item = (command: CommandId, label: string): MenuCommandItem => {
    const key = chord(command);
    return { type: 'command', command, label, ...(key ? { chord: key } : {}) };
  };
  const file: MenuItemModel[] = [];
  if (shell && can.has('session.create')) file.push(item('project.new', t('menu.newProject')));
  if (shell && can.has('session.open')) {
    file.push(item('project.open', t('menu.open')));
    const entries = recent.slice(0, RECENT_COMMANDS.length).map((entry, i) => item(RECENT_COMMANDS[i]!, entry.path));
    file.push({ type: 'submenu', label: t('menu.openRecent'), items: entries });
  }
  if (can.has('session.save')) {
    if (file.length > 0) file.push({ type: 'separator' });
    file.push(item('project.save', t('menu.save')));
  }
  const studio: MenuItemModel[] = studioSetupAvailable(can) ? [item('studio.setup', t('menu.studioSetup'))] : [];
  // A structural item while a proposal is heard: disabled, the reason in its label.
  const guarded = (command: CommandId, label: string, enabled: boolean): MenuCommandItem =>
    guard !== null ? { ...item(command, t('menu.guarded', { label, reason: guard })), enabled: false } : { ...item(command, label), ...(enabled ? {} : { enabled: false as const }) };
  if (busesListed(can) && can.command('bus.add')) studio.push(guarded('mixer.bus.add', t('menu.addBus'), true));
  if (busesListed(can) && can.command('bus.remove')) studio.push(guarded('mixer.bus.remove', t('menu.removeBus'), busSelected));
  return {
    menus: [
      { id: 'file', label: t('menu.file'), items: file },
      { id: 'studio', label: t('menu.studio'), items: studio },
    ],
  };
}
