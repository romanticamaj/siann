// The application menu (m5b-ui-project; architecture spec, "Process model";
// UI redesign 3.6): the renderer builds its model (command id, catalog label,
// chord from the preset) and the shell turns it into Electron's native menu,
// whose accelerators are shown but not registered, so the renderer's
// dispatcher stays the one key layer. A command that needs the shell (New,
// Open, the recent list) is in the model only with the preload bridge (UI
// redesign 3.0); Save and Studio Setup need only the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { acceleratorOf, menuTemplate, parseMenuModel, type MenuItemModel, type MenuModel } from '../../src/main/menu';
import { translator } from '../../src/renderer/i18n/t';
import type { Locale } from '../../src/renderer/i18n/locale';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import { appMenuModel } from '../../src/renderer/shell/app-menu';

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

function model(locale: Locale, shell: boolean): MenuModel {
  return appMenuModel({ t: translator(locale), recent: RECENT, shell, can: capabilitySelector(FULL) });
}

test('the model has File > New, Open, Open Recent and Save and Studio > Studio Setup, labelled from the catalogs in every locale', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const m = model(locale, true);
    assert.deepEqual(m.menus.map((menu) => [menu.id, menu.label]), [
      ['file', t('menu.file')],
      ['studio', t('menu.studio')],
    ], locale);
    const file = m.menus[0]!;
    assert.deepEqual(commands(file.items), [
      { command: 'project.new', label: t('menu.newProject'), chord: 'Mod+N' },
      { command: 'project.open', label: t('menu.open'), chord: 'Mod+O' },
      { command: 'project.openRecent.1', label: RECENT[0]!.path },
      { command: 'project.openRecent.2', label: RECENT[1]!.path },
      { command: 'project.save', label: t('menu.save'), chord: 'Mod+S' },
    ], locale);
    const recent = file.items.find((item) => item.type === 'submenu');
    assert.ok(recent && recent.type === 'submenu' && recent.label === t('menu.openRecent'), locale);
    // Add Bus and Remove Bus follow Studio Setup (m5b-ui-sends-buses; the test below).
    assert.deepEqual(commands(m.menus[1]!.items), [
      { command: 'studio.setup', label: t('menu.studioSetup') },
      { command: 'mixer.bus.add', label: t('menu.addBus') },
      { command: 'mixer.bus.remove', label: t('menu.removeBus') },
    ], locale);
  }
});

test('the chords are the preset\'s, and every label differs from the English one in Chinese', () => {
  const chord = (id: string) => CUBASE_PRESET.find((b) => b.commandId === id && b.scope === 'window')?.chord;
  for (const item of commands(model('en', true).menus[0]!.items)) if (item.chord) assert.equal(item.chord, chord(item.command));
  const en = commands(model('en', true).menus.flatMap((m) => m.items));
  const zh = commands(model('zh-Hant', true).menus.flatMap((m) => m.items));
  for (const [i, item] of en.entries()) if (!item.command.startsWith('project.openRecent.')) assert.notEqual(zh[i]!.label, item.label, item.command);
});

test('without a shell port New, Open and the recent list are absent while Save and Studio Setup stay', () => {
  const m = model('en', false);
  assert.deepEqual(commands(m.menus.flatMap((menu) => menu.items)).map((c) => c.command), ['project.save', 'studio.setup', 'mixer.bus.add', 'mixer.bus.remove']);
  assert.ok(!m.menus[0]!.items.some((item) => item.type === 'submenu'), 'no Open Recent');
  // No recent bundle: Open Recent is there, empty of commands.
  const empty = appMenuModel({ t: translator('en'), recent: [], shell: true, can: capabilitySelector(FULL) });
  assert.deepEqual(commands(empty.menus[0]!.items).map((c) => c.command), ['project.new', 'project.open', 'project.save']);
  // An engine without the methods: nothing of theirs.
  const bare = appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector({ methods: ['session.sync'] }) });
  assert.deepEqual(commands(bare.menus.flatMap((menu) => menu.items)), []);
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
});

interface Item {
  label?: string;
  role?: string;
  id?: string;
  accelerator?: string;
  registerAccelerator?: boolean;
  type?: string;
  submenu?: Item[];
  click?: (item: unknown, window: unknown, event: { triggeredByAccelerator?: boolean } | undefined) => void;
}

test('the template shows the accelerators, registers none, and a click sends the command unless the accelerator fired it', () => {
  const sent: string[] = [];
  const template = menuTemplate(model('en', true), { platform: 'win32', devtools: false, send: (command) => sent.push(command) }) as Item[];
  const t = translator('en');
  const file = template.find((item) => item.label === t('menu.file'))!;
  assert.ok(file, 'the File menu');
  const items = file.submenu!;
  const byId = (id: string) => {
    const walk = (list: Item[]): Item | undefined => list.flatMap((i) => [i, ...(i.submenu ? [walk(i.submenu)].filter(Boolean) as Item[] : [])]).find((i) => i.id === id);
    return walk(items);
  };
  const newItem = byId('project.new')!;
  assert.equal(newItem.label, t('menu.newProject'));
  assert.equal(newItem.accelerator, 'CmdOrCtrl+N');
  assert.equal(newItem.registerAccelerator, false);
  assert.equal(byId('project.open')!.accelerator, 'CmdOrCtrl+O');
  assert.equal(byId('project.save')!.accelerator, 'CmdOrCtrl+S');
  assert.equal(byId('project.openRecent.1')!.label, RECENT[0]!.path);
  // A click: the command id goes back to the renderer.
  newItem.click!(newItem, null, { triggeredByAccelerator: false });
  byId('project.openRecent.2')!.click!(null, null, undefined);
  // The accelerator (macOS, where the menu fires it): ignored, the dispatcher already ran it.
  byId('project.save')!.click!(null, null, { triggeredByAccelerator: true });
  assert.deepEqual(sent, ['project.new', 'project.openRecent.2']);
  // The rest of the menu bar: Edit and Window roles, the Studio menu, no View menu (devtools off), Quit at the end of File.
  const studio = template.find((item) => item.label === t('menu.studio'))!;
  assert.equal(studio.submenu![0]!.id, 'studio.setup');
  assert.ok(template.some((item) => item.role === 'editMenu') && template.some((item) => item.role === 'windowMenu'));
  assert.ok(!template.some((item) => item.role === 'viewMenu'));
  assert.equal(items[items.length - 1]!.role, 'quit');
  // On macOS the app menu comes first; before any model the File menu is the role's.
  const mac = menuTemplate(null, { platform: 'darwin', devtools: true, send: () => undefined }) as Item[];
  assert.equal(mac[0]!.role, 'appMenu');
  assert.ok(mac.some((item) => item.role === 'fileMenu') && mac.some((item) => item.role === 'viewMenu'));
});

test('the shell accepts only a well-formed model from the renderer', () => {
  const good = model('en', true);
  assert.deepEqual(parseMenuModel(JSON.parse(JSON.stringify(good))), good);
  assert.equal(parseMenuModel(null), null);
  assert.equal(parseMenuModel({ menus: 'x' }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'File', items: [{ type: 'command', command: 7, label: 'x' }] }] }), null);
  assert.equal(parseMenuModel({ menus: [{ id: 'file', label: 'File', items: [{ type: 'role', role: 'quit' }] }] }), null);
});

test('no menu item carries the Pool\'s command (m5b-ui-media: the Media tab replaced it)', () => {
  for (const shell of [true, false]) {
    for (const menu of model('en', shell).menus) assert.ok(!commands(menu.items).some((item) => item.command === 'pool.open'), menu.id);
  }
});

// m5b-ui-sends-buses (UI redesign 3.6; 10.11, 24): Add Bus and Remove Bus are
// unbound commands in the Studio menu until m5b-ui-keymap completes the
// menus, only on an engine that lists features.buses (and the command);
// Remove Bus acts on the selected bus and is disabled while none is selected,
// which the shell's menu shows as a disabled item.
test('Add Bus and Remove Bus are in the Studio menu with features.buses, Remove disabled without a selected bus', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const none = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL) });
    const studio = none.menus.find((m) => m.id === 'studio')!;
    assert.deepEqual(
      studio.items.filter((i) => i.type === 'command').map((i) => i.type === 'command' && [i.command, i.label, i.chord ?? null, i.enabled ?? true]),
      [
        ['studio.setup', t('menu.studioSetup'), null, true],
        ['mixer.bus.add', t('menu.addBus'), null, true],
        ['mixer.bus.remove', t('menu.removeBus'), null, false],
      ],
      locale,
    );
    const selected = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true });
    const remove = selected.menus.find((m) => m.id === 'studio')!.items.find((i) => i.type === 'command' && i.command === 'mixer.bus.remove');
    assert.ok(remove && remove.type === 'command' && remove.enabled === undefined, `${locale}: enabled with a bus selected`);
  }
  // Without features.buses, or without the command, neither is there.
  const noBuses = appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector({ ...FULL, features: { ...FULL.features, buses: false } }), busSelected: true });
  assert.deepEqual(commands(noBuses.menus[1]!.items).map((c) => c.command), ['studio.setup']);
  const noRemove = appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector({ ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'bus.remove') }) });
  assert.deepEqual(commands(noRemove.menus[1]!.items).map((c) => c.command), ['studio.setup', 'mixer.bus.add']);
});

// The edit guard (UI redesign 4.5 C5; 10.11, 24): while a proposal is heard
// Add Bus and Remove Bus are disabled, the reason in their label (a native
// menu item has no tooltip on Windows or Linux); the other items stay.
test('while a proposal is heard Add Bus and Remove Bus are disabled with the reason in every locale', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const reason = t('guard.structural');
    const guarded = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true, guard: reason });
    const studioItems = (model: MenuModel) => model.menus.find((m) => m.id === 'studio')!.items.flatMap((i) => (i.type === 'command' ? [i] : []));
    const items = studioItems(guarded);
    assert.deepEqual(
      items.map((i) => [i.command, i.label, i.enabled ?? true]),
      [
        ['studio.setup', t('menu.studioSetup'), true],
        ['mixer.bus.add', t('menu.guarded', { label: t('menu.addBus'), reason }), false],
        ['mixer.bus.remove', t('menu.guarded', { label: t('menu.removeBus'), reason }), false],
      ],
      locale,
    );
    assert.ok(items[1]!.label.includes(reason), `${locale}: the reason is in the label`);
    // The File menu is not structural and stays as it is.
    assert.deepEqual(guarded.menus[0], appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true }).menus[0], locale);
    // With no proposal heard, nothing is guarded.
    const free = appMenuModel({ t, recent: RECENT, shell: true, can: capabilitySelector(FULL), busSelected: true, guard: null });
    assert.deepEqual(studioItems(free).map((i) => [i.label, i.enabled ?? true]), [[t('menu.studioSetup'), true], [t('menu.addBus'), true], [t('menu.removeBus'), true]], locale);
  }
});

test('the shell keeps a disabled item disabled and sends nothing for it', () => {
  const m = appMenuModel({ t: translator('en'), recent: RECENT, shell: true, can: capabilitySelector(FULL) });
  const parsed = parseMenuModel(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(parsed, m);
  assert.equal(parseMenuModel({ menus: [{ id: 'studio', label: 'Studio', items: [{ type: 'command', command: 'mixer.bus.remove', label: 'x', enabled: 'no' }] }] }), null);
  const template = menuTemplate(m, { platform: 'win32', devtools: false, send: () => undefined }) as Array<Item & { enabled?: boolean }>;
  const studio = template.find((item) => item.label === translator('en')('menu.studio'))!;
  const byId = (id: string) => (studio.submenu as Array<Item & { enabled?: boolean }>).find((i) => i.id === id)!;
  assert.equal(byId('mixer.bus.remove').enabled, false);
  assert.notEqual(byId('mixer.bus.add').enabled, false);
});
