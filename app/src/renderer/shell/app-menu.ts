// The application menu's model (m5b-ui-project, completed by m5b-ui-keymap;
// UI redesign 3.6; architecture spec, "Process model"): what the renderer
// sends the shell, which builds Electron's native menu from it
// (app/src/main/menu.ts) and sends a click's command id back, run here
// through the CommandRegistry (runMenuCommand) in the scope of the command's
// key, so a menu item runs the handler its key runs. Seven menus, in Cubase's
// order: File, Edit, Project, Transport, Studio, Window, Help (3.6 lists
// their items). Each item is a command id, its label from the catalogs (the
// command's name, or the menu label File and the bus items had already) and
// its chord from the key preset, which the shell shows as the accelerator
// without registering it, so the dispatcher stays the one key layer. A
// command Cubase gives no key has its item all the same (Glue, Add Bus,
// Remove Bus, Studio Setup, Key Commands). File ends with Quit (Close on
// macOS) and Window with Minimize, role items the shell lets Electron run,
// labelled from the catalogs.
//
// An item is in the model only where its command can run on this engine
// (3.0): the edits on editGates, the transport on its methods, the locators,
// cycle, click, record and punch on their features, the buses on
// features.buses and their commands, markers on features.markers, Media on
// media.import, the tempo on session.set_tempo; New, Open and the recent list
// only with the shell's port. Remove Bus is disabled while no bus is
// selected. While a proposal is heard (the edit guard, 4.5 C5) the
// structural items are disabled with the guard's reason in their label,
// since a native menu item has no tooltip on Windows or Linux; the renderer
// rebuilds the model when the side heard, the locale, the capabilities, the
// recent list or the bus selection change. Undo, Redo, Cut, Copy, Paste and
// Select All name their text-field action: while a text field has the focus
// the shell runs that on the web contents instead of sending the command.

import type { T } from '../i18n/t';
import { chordsOf } from '../keys/chord-label';
import { commandName } from '../keys/command-names';
import type { Binding, CommandId, CommandRegistry, Scope } from '../keys/commands';
import { CUBASE_PRESET } from '../keys/preset-cubase';
import type { CapabilitySelector } from '../model/capabilities';
import { loopClickGates, recordOptionGates } from '../model/loop-click';
import { RECENT_COMMANDS, type RecentProject } from '../model/project';
import { recordGates } from '../model/record';
import { studioSetupAvailable } from '../model/studio-setup';
import { busesListed } from '../mixer/routing';
import { markersEnabled } from '../timeline/markers';
import { tempoEntryAllowed } from '../timeline/tempo-edit';
import { editGates } from '../timeline/Timeline';

export type TextAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

// The shape app/src/main/menu.ts parses.
export interface MenuCommandItem {
  readonly type: 'command';
  readonly command: CommandId;
  readonly label: string;
  readonly chord?: string;
  // Present, and false, only on a disabled item.
  readonly enabled?: false;
  // The text-field action the shell runs instead while a text field has the focus.
  readonly text?: TextAction;
}

export const MENU_IDS = ['file', 'edit', 'project', 'transport', 'studio', 'window', 'help'] as const;
export type MenuId = (typeof MENU_IDS)[number];

export type MenuItemModel =
  | MenuCommandItem
  | { readonly type: 'separator' }
  | { readonly type: 'role'; readonly role: 'quit' | 'close' | 'minimize'; readonly label: string }
  | { readonly type: 'submenu'; readonly label: string; readonly items: readonly MenuItemModel[] };

export interface MenuModel {
  readonly menus: ReadonlyArray<{ readonly id: MenuId; readonly label: string; readonly items: readonly MenuItemModel[] }>;
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
  // macOS closes the window where Windows and Linux quit.
  readonly platform?: 'mac' | 'other';
}

// Where a command without a key is registered (its handler's scope).
const UNBOUND_SCOPES: Readonly<Partial<Record<CommandId, Scope>>> = {
  'edit.glue': 'project',
};

// The scope a menu item runs its command in: the scope of its key (the
// window's first), else where the shell registers the unbound command.
export function menuScope(command: CommandId, preset: readonly Binding[] = CUBASE_PRESET): Scope {
  const bound = preset.filter((b) => b.commandId === command);
  return (bound.find((b) => b.scope === 'window') ?? bound[0])?.scope ?? UNBOUND_SCOPES[command] ?? 'window';
}

// A click from the shell: the handler the key runs. False when it did nothing.
export function runMenuCommand(registry: CommandRegistry, command: CommandId): boolean {
  return registry.run(menuScope(command), command);
}

// The menu labels the File menu and the bus items had before the menus were completed.
const MENU_LABELS: Readonly<Partial<Record<CommandId, 'menu.newProject' | 'menu.open' | 'menu.save' | 'menu.studioSetup' | 'menu.addBus' | 'menu.removeBus'>>> = {
  'project.new': 'menu.newProject',
  'project.open': 'menu.open',
  'project.save': 'menu.save',
  'studio.setup': 'menu.studioSetup',
  'mixer.bus.add': 'menu.addBus',
  'mixer.bus.remove': 'menu.removeBus',
};

const TEXT_ACTIONS: Readonly<Partial<Record<CommandId, TextAction>>> = {
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.selectAll': 'selectAll',
};

// The items the edit guard disables while a proposal is heard.
const STRUCTURAL: ReadonlySet<CommandId> = new Set<CommandId>([
  'edit.cut',
  'edit.paste',
  'edit.pasteAtOrigin',
  'edit.delete',
  'edit.duplicate',
  'edit.repeat',
  'edit.splitAtCursor',
  'edit.glue',
  'track.add',
  'track.removeSelected',
  'mixer.bus.add',
  'mixer.bus.remove',
  'marker.insert',
  'transport.record',
]);

const TRANSPORT_METHODS = ['transport.play', 'transport.stop', 'transport.locate'];

const MENU_TITLES: Readonly<Record<MenuId, 'menu.file' | 'menu.edit' | 'menu.project' | 'menu.transport' | 'menu.studio' | 'menu.window' | 'menu.help'>> = {
  file: 'menu.file',
  edit: 'menu.edit',
  project: 'menu.project',
  transport: 'menu.transport',
  studio: 'menu.studio',
  window: 'menu.window',
  help: 'menu.help',
};

// Menu groups: commands, with a separator between groups that have items.
type Group = ReadonlyArray<readonly [CommandId, boolean]>;

export function appMenuModel({ t, recent, shell, can, preset = CUBASE_PRESET, busSelected = false, guard = null, platform = 'other' }: AppMenuOptions): MenuModel {
  const item = (command: CommandId, label?: string, enabled = true): MenuCommandItem => {
    const key = chordsOf(command, preset)[0];
    const name = label ?? (MENU_LABELS[command] ? t(MENU_LABELS[command]!) : commandName(t, command));
    const text = TEXT_ACTIONS[command];
    const base = { type: 'command' as const, command, label: name, ...(key ? { chord: key } : {}), ...(text ? { text } : {}) };
    if (guard !== null && STRUCTURAL.has(command)) return { ...base, label: t('menu.guarded', { label: name, reason: guard }), enabled: false };
    return enabled ? base : { ...base, enabled: false };
  };
  const groups = (list: readonly Group[]): MenuItemModel[] => {
    const out: MenuItemModel[] = [];
    for (const group of list) {
      const shown = group.filter(([, available]) => available).map(([command]) => item(command));
      if (shown.length === 0) continue;
      if (out.length > 0) out.push({ type: 'separator' });
      out.push(...shown);
    }
    return out;
  };

  // File: New, Open, Open Recent, Save; then Quit or Close.
  const file: MenuItemModel[] = [];
  if (shell && can.has('session.create')) file.push(item('project.new'));
  if (shell && can.has('session.open')) {
    file.push(item('project.open'));
    const entries = recent.slice(0, RECENT_COMMANDS.length).map((entry, i) => item(RECENT_COMMANDS[i]!, entry.path));
    file.push({ type: 'submenu', label: t('menu.openRecent'), items: entries });
  }
  if (can.has('session.save')) {
    if (file.length > 0) file.push({ type: 'separator' });
    file.push(item('project.save'));
  }
  if (file.length > 0) file.push({ type: 'separator' });
  file.push(platform === 'mac' ? { type: 'role', role: 'close', label: t('menu.close') } : { type: 'role', role: 'quit', label: t('menu.quit') });

  // Edit.
  const edits = editGates(can);
  const undo = can.has('session.undo') && can.has('session.redo');
  const edit = groups([
    [
      ['edit.undo', undo],
      ['edit.redo', undo],
    ],
    [
      ['edit.cut', edits['edit.cut']],
      ['edit.copy', edits['edit.copy']],
      ['edit.paste', edits['edit.paste']],
      ['edit.pasteAtOrigin', edits['edit.pasteAtOrigin']],
      ['edit.delete', edits['edit.delete']],
    ],
    [
      ['edit.duplicate', edits['edit.duplicate']],
      ['edit.repeat', edits['edit.repeat']],
      ['edit.splitAtCursor', edits['edit.splitAtCursor']],
      ['edit.glue', edits['edit.glue']],
    ],
    [
      ['edit.selectAll', edits['edit.selectAll']],
      ['edit.selectNone', edits['edit.selectNone']],
    ],
  ]);

  // Project: tracks, buses, markers, media. Remove Bus waits for a selected bus.
  const buses = busesListed(can);
  const project: MenuItemModel[] = [];
  const tracks = groups([
    [
      ['track.add', can.command('track.add')],
      ['track.removeSelected', edits['track.removeSelected']],
    ],
  ]);
  project.push(...tracks);
  const busItems: MenuItemModel[] = [];
  if (buses && can.command('bus.add')) busItems.push(item('mixer.bus.add'));
  if (buses && can.command('bus.remove')) busItems.push(item('mixer.bus.remove', undefined, busSelected));
  for (const block of [busItems, groups([[['marker.insert', markersEnabled(can) && can.command('marker.add')]]]), groups([[['media.open', can.has('media.import')]]])]) {
    if (block.length === 0) continue;
    if (project.length > 0) project.push({ type: 'separator' });
    project.push(...block);
  }

  // Transport: only on an engine with the transport (Capable's rule).
  const transport = TRANSPORT_METHODS.every((method) => can.has(method));
  const loop = loopClickGates(can);
  const punch = recordOptionGates(can).punch;
  const transportMenu = transport
    ? groups([
        [
          ['transport.toggle', true],
          ['transport.start', true],
          ['transport.stop', true],
          ['transport.record', recordGates(can).record],
        ],
        [
          ['transport.cycleToggle', loop.cycle],
          ['transport.metronomeToggle', loop.click],
        ],
        [
          ['transport.toStart', true],
          ['transport.toLeftLocator', loop.locators],
          ['transport.toRightLocator', loop.locators],
          ['transport.setLeftLocator', loop.locators],
          ['transport.setRightLocator', loop.locators],
          ['transport.locatorsToSelection', loop.locators],
        ],
        [
          ['transport.rewind', true],
          ['transport.forward', true],
        ],
        [
          ['transport.enterPosition', true],
          ['transport.enterTempo', tempoEntryAllowed(can)],
        ],
        [
          ['transport.punchIn', punch],
          ['transport.punchOut', punch],
        ],
      ])
    : [];

  // Studio: Studio Setup, MixConsole.
  const studio = groups([[['studio.setup', studioSetupAvailable(can)]], [['zone.lower.mixconsole', true]]]);

  // Window: the zones, Plans and the ghosts; then Minimize.
  const windowMenu: MenuItemModel[] = [
    ...groups([
      [
        ['zone.left.toggle', true],
        ['zone.lower.toggle', true],
        ['zone.right.toggle', true],
        ['zone.channel.toggle', true],
      ],
      [
        ['zone.right.plans', true],
        ['plans.toggleGhosts', true],
      ],
    ]),
    { type: 'separator' },
    { type: 'role', role: 'minimize', label: t('menu.minimize') },
  ];

  const help = groups([[['help.keyCommands', true]]]);

  const items: Readonly<Record<MenuId, MenuItemModel[]>> = { file, edit, project, transport: transportMenu, studio, window: windowMenu, help };
  return { menus: MENU_IDS.map((id) => ({ id, label: t(MENU_TITLES[id]), items: items[id] })) };
}
