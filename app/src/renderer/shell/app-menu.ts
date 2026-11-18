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
// on every locale, capability or recent-list change.

import type { T } from '../i18n/t';
import type { Binding, CommandId } from '../keys/commands';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import type { CapabilitySelector } from '../model/capabilities';
import { RECENT_COMMANDS, type RecentProject } from '../model/project';
import { studioSetupAvailable } from '../model/studio-setup';

// The shape app/src/main/menu.ts parses.
export interface MenuCommandItem {
  readonly type: 'command';
  readonly command: CommandId;
  readonly label: string;
  readonly chord?: string;
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
}

export function appMenuModel({ t, recent, shell, can, preset = CUBASE_PRESET }: AppMenuOptions): MenuModel {
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
  return {
    menus: [
      { id: 'file', label: t('menu.file'), items: file },
      { id: 'studio', label: t('menu.studio'), items: studio },
    ],
  };
}
