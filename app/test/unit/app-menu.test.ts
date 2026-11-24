// The application menu (m5b-ui-project, completed by m5b-ui-keymap;
// architecture spec, "Process model"; UI redesign 3.6): the renderer builds
// its model (command id, catalog label, chord from the preset) and the shell
// turns it into Electron's native menu, whose accelerators are shown but not
// registered, so the renderer's dispatcher stays the one key layer. Seven
// menus: File, Edit, Project, Transport, Studio, Window, Help. Every item runs
// the command its key runs, through the CommandRegistry in the scope of its
// preset binding; a command Cubase gives no key (Glue, Add Bus, Remove Bus,
// Studio Setup, Key Commands) has its item all the same. A command that needs
// the shell (New, Open, the recent list) is in the model only with the
// preload bridge, and every item only where the engine can run it (UI
// redesign 3.0); while a proposal is heard the structural items are disabled
// with the guard's reason in their label. The Edit menu's text items act on a
// focused text field through the web contents (the menu has no edit roles).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { acceleratorOf, menuTemplate, parseMenuModel, type MenuItemModel, type MenuModel } from '../../src/main/menu';
import { translator } from '../../src/renderer/i18n/t';
import type { Locale } from '../../src/renderer/i18n/locale';
import { chordsOf } from '../../src/renderer/keys/chord-label';
import { COMMAND_IDS, CommandRegistry, type CommandId } from '../../src/renderer/keys/commands';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { MENU_IDS, appMenuModel, menuScope, runMenuCommand } from '../../src/renderer/shell/app-menu';

// A catalog key this feature adds, read without the typed signature.
const say = (t: unknown, key: string): string => (t as (k: string) => string)(key);

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const RECENT = [
  { path: path.resolve('/music/Night Drive.siann'), name: 'Night Drive' },
  { path: path.resolve('/music/Demo.siann'), name: 'Demo' },
];

function commands(items: readonly MenuItemModel[]): Array<{ command: string; label: string; chord?: string }> {
  const out: Array<{ command: string; label: string; chord?: string }> = [];
  for (const item of items) {
    if (item.type === 'command') out.push({ command: item.command, label: item.label, ...(item.chord ? { chord: item.chord } : {}) });
    if (item.type === 'submenu') out.push(...commands(item.items));
  }
  return out;
}

function ids(model: MenuModel, menu: string): string[] {
  return commands(model.menus.find((m) => m.id === menu)?.items ?? []).map((c) => c.command);
}

function model(locale: Locale, shell: boolean, platform: 'mac' | 'other' = 'other'): MenuModel {
  return appMenuModel({ t: translator(locale), recent: RECENT, shell, can: capabilitySelector(FULL), platform });
}

const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  file: ['project.new', 'project.open', 'project.openRecent.1', 'project.openRecent.2', 'project.save'],
  edit: ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteAtOrigin', 'edit.delete', 'edit.duplicate', 'edit.repeat', 'edit.splitAtCursor', 'edit.glue', 'edit.selectAll', 'edit.selectNone'],
  project: ['track.add', 'track.removeSelected', 'mixer.bus.add', 'mixer.bus.remove', 'marker.insert', 'media.open'],
  transport: [
    'transport.toggle',
    'transport.start',
    'transport.stop',
    'transport.record',
    'transport.cycleToggle',
    'transport.metronomeToggle',
    'transport.toStart',
    'transport.toLeftLocator',
    'transport.toRightLocator',
    'transport.setLeftLocator',
    'transport.setRightLocator',
    'transport.locatorsToSelection',
    'transport.rewind',
    'transport.forward',
    'transport.enterPosition',
    'transport.enterTempo',
    'transport.punchIn',
    'transport.punchOut',
  ],
  studio: ['studio.setup', 'zone.lower.mixconsole'],
  window: ['zone.left.toggle', 'zone.lower.toggle', 'zone.right.toggle', 'zone.channel.toggle', 'zone.right.plans', 'plans.toggleGhosts'],
  help: ['help.keyCommands'],
};

test('seven menus in Cubase\'s order, each labelled from the catalogs in every locale, with their commands', () => {
  assert.deepEqual([...MENU_IDS], ['file', 'edit', 'project', 'transport', 'studio', 'window', 'help']);
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const m = model(locale, true);
    assert.deepEqual(m.menus.map((menu) => menu.id), [...MENU_IDS], locale);
    for (const menu of m.menus) assert.equal(menu.label, say(t, `menu.${menu.id}`), `${locale} ${menu.id}`);
    for (const id of MENU_IDS) assert.deepEqual(ids(m, id), EXPECTED[id], `${locale} ${id}`);
    const recent = m.menus[0]!.items.find((item) => item.type === 'submenu');
    assert.ok(recent && recent.type === 'submenu' && recent.label === t('menu.openRecent'), locale);
    // File ends with Quit (Close on macOS), Window with Minimize: role items with the catalog's labels.
    const last = (menu: string) => m.menus.find((x) => x.id === menu)!.items.at(-1)!;
    assert.deepEqual(last('file'), { type: 'role', role: 'quit', label: say(t, 'menu.quit') }, locale);
    assert.deepEqual(last('window'), { type: 'role', role: 'minimize', label: say(t, 'menu.minimize') }, locale);
    assert.deepEqual(model(locale, true, 'mac').menus[0]!.items.at(-1), { type: 'role', role: 'close', label: say(t, 'menu.close') }, locale);
  }
});

test('every item is a command of COMMAND_IDS, named from the catalogs, each once', () => {
  const t = translator('en');
  const all = commands(model('en', true).menus.flatMap((m) => m.items)).filter((c) => !c.command.startsWith('project.openRecent.'));
  assert.equal(new Set(all.map((c) => c.command)).size, all.length, 'each command once');
  for (const item of all) {
    assert.ok((COMMAND_IDS as readonly string[]).includes(item.command), item.command);
    assert.ok(item.label.length > 0, item.command);
  }
  // The project and bus items keep their menu labels; the rest are the commands' names.
  const label = (id: string) => all.find((c) => c.command === id)!.label;
  assert.equal(label('project.new'), t('menu.newProject'));
  assert.equal(label('studio.setup'), t('menu.studioSetup'));
  assert.equal(label('mixer.bus.add'), t('menu.addBus'));
  assert.equal(label('edit.glue'), say(t, 'command.edit.glue'));
  assert.equal(label('help.keyCommands'), say(t, 'command.help.keyCommands'));
  // Every label differs from the English one in Chinese.
  const zh = commands(model('zh-Hant', true).menus.flatMap((m) => m.items));
  const en = commands(model('en', true).menus.flatMap((m) => m.items));
  for (const [i, item] of en.entries()) if (!item.command.startsWith('project.openRecent.')) assert.notEqual(zh[i]!.label, item.label, item.command);
});

test('every item\'s chord is the preset\'s first chord for its command; none for a command Cubase gives no key', () => {
  for (const item of commands(model('en', true).menus.flatMap((m) => m.items))) {
    assert.equal(item.chord, chordsOf(item.command as CommandId)[0], item.command);
  }
  const chord = (id: string) => commands(model('en', true).menus.flatMap((m) => m.items)).find((c) => c.command === id)?.chord;
  for (const id of ['edit.glue', 'mixer.bus.add', 'mixer.bus.remove', 'studio.setup', 'help.keyCommands']) assert.equal(chord(id), undefined, id);
  assert.equal(chord('edit.cut'), 'Mod+X');
  assert.equal(chord('transport.stop'), 'Numpad0');
  assert.equal(chord('zone.left.toggle'), 'Mod+Alt+L');
  assert.equal(chord('transport.rewind'), 'NumpadSubtract');
});

test('a menu item runs the handler its key runs, in the scope of its preset binding', () => {
  const registry = new CommandRegistry();
  const ran: string[] = [];
  const all = commands(model('en', true).menus.flatMap((m) => m.items)).map((c) => c.command as CommandId);
  // Each handler registered where the shell registers it: the scope of its key, the project zone for Glue.
  for (const id of all) registry.register(menuScope(id), id, () => void ran.push(id));
  for (const id of all) assert.equal(runMenuCommand(registry, id), true, id);
  assert.deepEqual(ran, all);
  // The scope is the key's: the project zone's for the edits, the window's for the transport.
  for (const id of all) {
    const bound = CUBASE_PRESET.filter((b) => b.commandId === id);
    if (bound.length > 0) assert.equal(menuScope(id), (bound.find((b) => b.scope === 'window') ?? bound[0]!).scope, id);
  }
  assert.equal(menuScope('edit.glue'), 'project');
  assert.equal(menuScope('edit.cut'), 'project');
  assert.equal(menuScope('mixer.bus.add'), 'window');
  assert.equal(menuScope('help.keyCommands'), 'window');
  // A declining handler: the click does nothing, and says so.
  const declining = new CommandRegistry();
  declining.register('project', 'edit.glue', () => false);
  assert.equal(runMenuCommand(declining, 'edit.glue'), false);
  assert.equal(runMenuCommand(new CommandRegistry(), 'edit.glue'), false);
});

test('without a shell port New, Open and the recent list are absent; with no recent bundle Open Recent is empty', () => {
  const m = model('en', false);
  assert.deepEqual(ids(m, 'file'), ['project.save']);
  assert.ok(!m.menus[0]!.items.some((item) => item.type === 'submenu'), 'no Open Recent');
  const empty = appMenuModel({ t: translator('en'), recent: [], shell: true, can: capabilitySelector(FULL) });
  assert.deepEqual(ids(empty, 'file'), ['project.new', 'project.open', 'project.save']);
});

test('an engine that cannot run a command has no item for it (UI redesign 3.0)', () => {
  const can = (caps: Capabilities) => appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector(caps) });
  // A bare engine: the zones, MixConsole and Key Commands only, which send nothing.
  const bare = can({ methods: ['session.sync'] });
  assert.deepEqual(bare.menus.map((m) => [m.id, commands(m.items).map((c) => c.command)]), [
    ['file', []],
    ['edit', ['edit.copy', 'edit.selectAll', 'edit.selectNone']],
    ['project', []],
    ['transport', []],
    ['studio', ['zone.lower.mixconsole']],
    ['window', ['zone.left.toggle', 'zone.lower.toggle', 'zone.right.toggle', 'zone.channel.toggle', 'zone.right.plans', 'plans.toggleGhosts']],
    ['help', ['help.keyCommands']],
  ]);
  const without = (filter: (c: string) => boolean) => can({ ...FULL, commands: (FULL.commands ?? []).filter(filter) });
  assert.ok(!ids(without((c) => c !== 'clip.remove'), 'edit').includes('edit.glue'), 'Glue needs clip.remove');
  assert.ok(!ids(without((c) => c !== 'clip.remove'), 'edit').includes('edit.cut'));
  assert.ok(!ids(without((c) => c !== 'session.set_tempo'), 'transport').includes('transport.enterTempo'));
  assert.ok(!ids(without((c) => c !== 'track.add'), 'project').includes('track.add'));
  assert.ok(!ids(without((c) => !c.startsWith('marker.')), 'project').includes('marker.insert'));
  // Without features.buses neither bus item; without media.import no Media.
  const noBuses = can({ ...FULL, features: { ...FULL.features, buses: false } });
  assert.deepEqual(ids(noBuses, 'project').filter((id) => id.startsWith('mixer.')), []);
  const noMedia = can({ ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'media.import') });
  assert.ok(!ids(noMedia, 'project').includes('media.open'));
  // Without the transport methods, none of the transport's items.
  const noTransport = can({ ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'transport.locate') });
  assert.deepEqual(ids(noTransport, 'transport'), []);
  // Without features.recording no Record; without features.punch no punch items.
  const noRecord = can({ ...FULL, features: { ...FULL.features, recording: false } });
  assert.ok(!ids(noRecord, 'transport').includes('transport.record'));
  const noPunch = can({ ...FULL, features: { ...FULL.features, punch: false } });
  assert.ok(!ids(noPunch, 'transport').includes('transport.punchIn'));
});

test('Remove Bus is disabled while no bus is selected', () => {
  const remove = (busSelected: boolean) =>
    appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected }).menus
      .find((m) => m.id === 'project')!
      .items.find((i) => i.type === 'command' && i.command === 'mixer.bus.remove');
  assert.ok(remove(false)?.type === 'command' && remove(false)!.type === 'command' && (remove(false) as { enabled?: false }).enabled === false);
  assert.equal((remove(true) as { enabled?: false }).enabled, undefined);
});

// The edit guard (UI redesign 4.5 C5; 10.11, 25): while a proposal is heard
// the structural items are disabled, the reason in their label (a native
// menu item has no tooltip on Windows or Linux); the rest stay.
test('while a proposal is heard the structural items are disabled with the reason in every locale', () => {
  const structural = ['edit.cut', 'edit.paste', 'edit.pasteAtOrigin', 'edit.delete', 'edit.duplicate', 'edit.repeat', 'edit.splitAtCursor', 'edit.glue', 'track.add', 'track.removeSelected', 'mixer.bus.add', 'mixer.bus.remove', 'marker.insert', 'transport.record'];
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const reason = t('guard.structural');
    const free = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true });
    const guarded = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true, guard: reason });
    const items = (m: MenuModel) => m.menus.flatMap((menu) => menu.items).flatMap(function flat(i): Array<Extract<MenuItemModel, { type: 'command' }>> {
      return i.type === 'command' ? [i] : i.type === 'submenu' ? i.items.flatMap(flat) : [];
    });
    const before = new Map(items(free).map((i) => [i.command, i]));
    for (const item of items(guarded)) {
      if (structural.includes(item.command)) {
        assert.equal(item.enabled, false, `${locale} ${item.command}`);
        assert.equal(item.label, t('menu.guarded', { label: before.get(item.command)!.label, reason }), `${locale} ${item.command}`);
      } else {
        assert.deepEqual(item, before.get(item.command), `${locale} ${item.command} stays`);
      }
    }
    // The tempo, undo and the locators stay (4.5 C5).
    for (const id of ['transport.enterTempo', 'edit.undo', 'transport.setLeftLocator']) assert.ok(items(guarded).some((i) => i.command === id && i.enabled === undefined), id);
  }
});

test('the Edit menu\'s undo, redo, cut, copy, paste and select all name their text-field action', () => {
  const edit = model('en', true).menus.find((m) => m.id === 'edit')!.items.flatMap((i) => (i.type === 'command' ? [i] : []));
  assert.deepEqual(
    edit.filter((i) => i.text !== undefined).map((i) => [i.command, i.text]),
    [
      ['edit.undo', 'undo'],
      ['edit.redo', 'redo'],
      ['edit.cut', 'cut'],
      ['edit.copy', 'copy'],
      ['edit.paste', 'paste'],
      ['edit.selectAll', 'selectAll'],
    ],
  );
});

test('the shell maps chords to accelerators', () => {
  assert.equal(acceleratorOf('Mod+N'), 'CmdOrCtrl+N');
  assert.equal(acceleratorOf('Mod+Shift+Z'), 'CmdOrCtrl+Shift+Z');
  assert.equal(acceleratorOf('Mod+Alt+P'), 'CmdOrCtrl+Alt+P');
  assert.equal(acceleratorOf('Alt+X'), 'Alt+X');
  assert.equal(acceleratorOf('F3'), 'F3');
  assert.equal(acceleratorOf('Space'), 'Space');
  assert.equal(acceleratorOf('Comma'), ',');
  assert.equal(acceleratorOf('Numpad1'), 'num1');
  assert.equal(acceleratorOf('Mod+1'), 'CmdOrCtrl+1');
  assert.equal(acceleratorOf('NumpadSubtract'), 'numsub');
  assert.equal(acceleratorOf('Mod+Minus'), 'CmdOrCtrl+-');
  assert.equal(acceleratorOf('Equal'), '=');
  assert.equal(acceleratorOf('Shift+Enter'), 'Shift+Enter');
  assert.equal(acceleratorOf('Mod+ArrowLeft'), 'CmdOrCtrl+Left');
  assert.equal(acceleratorOf('Alt+Shift+ArrowRight'), 'Alt+Shift+Right');
  assert.equal(acceleratorOf('Insert'), 'Insert');
  // Every chord a menu item shows has an accelerator.
  for (const item of commands(model('en', true).menus.flatMap((m) => m.items))) if (item.chord) assert.ok(acceleratorOf(item.chord), item.chord);
});

interface Item {
  label?: string;
  role?: string;
  id?: string;
  accelerator?: string;
  registerAccelerator?: boolean;
  enabled?: boolean;
  type?: string;
  submenu?: Item[];
  click?: (item: unknown, window: unknown, event: { triggeredByAccelerator?: boolean } | undefined) => void;
}

function walk(list: Item[]): Item[] {
  return list.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu) : [])]);
}

test('the template is built from the model: seven menus, accelerators shown and none registered, a click sends the command', () => {
  const sent: string[] = [];
  const t = translator('en');
  const template = menuTemplate(model('en', true), { platform: 'win32', devtools: false, send: (command) => sent.push(command) }) as Item[];
  assert.deepEqual(template.map((m) => m.label), MENU_IDS.map((id) => say(t, `menu.${id}`)));
  assert.ok(!template.some((item) => item.role === 'editMenu' || item.role === 'windowMenu' || item.role === 'fileMenu' || item.role === 'viewMenu'), 'no menu built from a role');
  const all = walk(template);
  const byId = (id: string) => all.find((i) => i.id === id)!;
  for (const item of all.filter((i) => i.id)) assert.equal(item.registerAccelerator, false, item.id);
  assert.equal(byId('project.new').accelerator, 'CmdOrCtrl+N');
  assert.equal(byId('edit.cut').accelerator, 'CmdOrCtrl+X');
  assert.equal(byId('transport.rewind').accelerator, 'numsub');
  assert.equal(byId('edit.glue').accelerator, undefined);
  assert.equal(byId('help.keyCommands').label, say(t, 'command.help.keyCommands'));
  assert.equal(byId('project.openRecent.1').label, RECENT[0]!.path);
  // Quit and Minimize, labelled from the catalogs.
  const file = template[0]!.submenu!;
  assert.deepEqual([file.at(-1)!.role, file.at(-1)!.label], ['quit', say(t, 'menu.quit')]);
  const windowMenu = template[5]!.submenu!;
  assert.deepEqual([windowMenu.at(-1)!.role, windowMenu.at(-1)!.label], ['minimize', say(t, 'menu.minimize')]);
  // Clicks: the command id goes back; the accelerator (macOS fires it) is ignored, the dispatcher ran the key.
  byId('edit.glue').click!(null, null, { triggeredByAccelerator: false });
  byId('mixer.bus.add').click!(null, null, undefined);
  byId('project.save').click!(null, null, { triggeredByAccelerator: true });
  assert.deepEqual(sent, ['edit.glue', 'mixer.bus.add']);
  // Remove Bus without a selected bus: disabled.
  assert.equal(byId('mixer.bus.remove').enabled, false);
  // macOS: the app menu first; devtools adds the View menu; before any model the menus are roles.
  const mac = menuTemplate(model('en', true, 'mac'), { platform: 'darwin', devtools: true, send: () => undefined }) as Item[];
  assert.equal(mac[0]!.role, 'appMenu');
  assert.ok(mac.some((item) => item.role === 'viewMenu'));
  assert.equal(mac[1]!.submenu!.at(-1)!.role, 'close');
  const none = menuTemplate(null, { platform: 'win32', devtools: false, send: () => undefined }) as Item[];
  assert.ok(none.some((item) => item.role === 'fileMenu') && none.some((item) => item.role === 'editMenu'));
});

test('with a text field focused the Edit menu\'s text items act on it through the web contents, by click and by accelerator', () => {
  const sent: string[] = [];
  const edited: string[] = [];
  let focused = false;
  const options = { platform: 'darwin' as const, devtools: false, send: (c: string) => sent.push(c), textFocused: () => focused, textEdit: (action: string) => edited.push(action) };
  const all = walk(menuTemplate(model('en', true, 'mac'), options) as Item[]);
  const byId = (id: string) => all.find((i) => i.id === id)!;
  focused = true;
  for (const id of ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll']) byId(id).click!(null, null, { triggeredByAccelerator: true });
  byId('edit.copy').click!(null, null, { triggeredByAccelerator: false });
  // An item without a text action still runs its command (clicked), not in the field.
  byId('edit.duplicate').click!(null, null, undefined);
  assert.deepEqual(edited, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'copy']);
  assert.deepEqual(sent, ['edit.duplicate']);
  // No text field: the command, and nothing for the accelerator.
  focused = false;
  byId('edit.copy').click!(null, null, undefined);
  byId('edit.copy').click!(null, null, { triggeredByAccelerator: true });
  assert.deepEqual(sent, ['edit.duplicate', 'edit.copy']);
  assert.equal(edited.length, 7);
});

test('the shell accepts only a well-formed model from the renderer', () => {
  const good = model('en', true);
  assert.deepEqual(parseMenuModel(JSON.parse(JSON.stringify(good))), good);
  const mac = model('en', true, 'mac');
  assert.deepEqual(parseMenuModel(JSON.parse(JSON.stringify(mac))), mac);
  assert.equal(parseMenuModel(null), null);
  assert.equal(parseMenuModel({ menus: 'x' }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'File', items: [{ type: 'command', command: 7, label: 'x' }] }] }), null);
  // A role item needs its label, and only quit, close and minimize are taken.
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'File', items: [{ type: 'role', role: 'quit' }] }] }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'File', items: [{ type: 'role', role: 'reload', label: 'Reload' }] }] }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'window', label: 'Window', items: [{ type: 'role', role: 'toggleDevTools', label: 'x' }] }] }), null);
  // The seven ids, each once; no other.
  for (const id of MENU_IDS) assert.ok(parseMenuModel({ menus: [{ id, label: 'x', items: [] }] }), id);
  assert.equal(parseMenuModel({ menus: [{ id: 'view', label: 'View', items: [] }] }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'A', items: [] }, { id: 'file', label: 'B', items: [] }] }), null);
  // A text action is one of the six.
  assert.equal(parseMenuModel({ menus: [{ id: 'edit', label: 'Edit', items: [{ type: 'command', command: 'edit.copy', label: 'Copy', text: 'print' }] }] }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'studio', label: 'Studio', items: [{ type: 'command', command: 'mixer.bus.remove', label: 'x', enabled: 'no' }] }] }), null);
});

test('no menu item carries the Pool\'s command (m5b-ui-media: the Media tab replaced it)', () => {
  for (const shell of [true, false]) {
    for (const menu of model('en', shell).menus) assert.ok(!commands(menu.items).some((item) => item.command === 'pool.open'), menu.id);
  }
});
