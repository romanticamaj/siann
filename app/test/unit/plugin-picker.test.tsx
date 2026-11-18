// The plugin picker and the slot actions (m5b-ui-inserts-master; UI redesign
// 3.4; docs/schemas/protocol-plugins-v0.md). An empty slot opens a picker of
// the installs of plugin.registry by name and format with a search field;
// choosing an approved one sends plugin.instantiate at the end of the chain
// (one revision); an unapproved one shows Approve, which asks first in a
// confirmation that names the file, and an approval the engine refuses shows
// its code and message and leaves the install unapproved. A slot's bypass and
// Remove go through command.execute; its e opens and closes the editor, lit
// after the editorOpen of the last result. A fake client; the markup is
// rendered with react-dom/server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { PickerController } from '../../src/renderer/mixer/picker';
import { PluginPicker } from '../../src/renderer/mixer/PluginPicker';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { PluginSlotEntity, TrackEntity } from '../../src/renderer/model/document';
import { PluginActions, type RegistryEntry } from '../../src/renderer/model/plugin-actions';
import { ProtocolError } from '../../src/renderer/model/session-client';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { byAttr, byClass, find, findAll, parse, text, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;

const TEST_PLUGIN: RegistryEntry = { format: 'clap', path: '/plugins/siann_test_plugin.clap', uid: 'org.siann.test-plugin', name: 'SIANN Test Plugin', approved: true };
const SURGE: RegistryEntry = { format: 'clap', path: '/plugins/Surge XT.clap', uid: null, name: 'Surge XT', approved: false };
const REVERB: RegistryEntry = { format: 'vst3', path: '/plugins/Room.vst3', uid: 'com.x.room', name: 'Room Reverb', approved: true };

const slotEntity = (id: string): PluginSlotEntity => ({ schema: 'siann.entity.plugin_slot.v1', id, trackId: 'trk_a', format: 'clap', uid: 'u', name: 'Comp', path: '/p', bypass: false });

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly expectedRevision: string | undefined;
}

// A client double that answers each method from a table (a function may throw).
function fakeClient(answers: Record<string, (params: Record<string, unknown>) => unknown>, inserts: string[] = ['slt_1', 'slt_2']) {
  const a: TrackEntity = { ...track('trk_a'), name: 'Vox', inserts };
  const base = snapshotOf(['trk_a'], [a], [], [], 'r12');
  const snap = { ...base, entities: { ...base.entities, 'plugin_slot:slt_1': slotEntity('slt_1'), 'plugin_slot:slt_2': slotEntity('slt_2') } };
  const calls: Call[] = [];
  const model = { getSnapshot: () => snap, select: (ref: string) => snap.entities[ref as keyof typeof snap.entities] };
  return {
    calls,
    model,
    async request(method: string, params: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
      calls.push({ method, params, expectedRevision });
      const answer = answers[method];
      if (!answer) throw new ProtocolError('not_supported', `no ${method}`);
      return answer(params);
    },
  };
}

const registry = (...entries: RegistryEntry[]) => () => ({ plugins: entries });
const instantiated = (slotId: string) => () => ({ jobId: 'job_1', kind: 'plugin.instantiate', state: 'done', result: { revision: 'r13', slotId } });

function render(picker: PickerController, caps: Capabilities | null = FULL): Element {
  return parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <PluginPicker picker={picker} />
      </CapabilitiesContext.Provider>,
    ),
  );
}

const rows = (root: Element) => findAll(root, byAttr('data-testid', 'picker-install'));

test('the picker lists the installs of plugin.registry by name and format; Approve on an unapproved one only', async () => {
  const client = fakeClient({ 'plugin.registry': registry(TEST_PLUGIN, SURGE, REVERB) });
  const picker = new PickerController({ actions: new PluginActions({ client }) });
  assert.equal(picker.getSnapshot().open, false);
  await picker.open('trk_a');
  assert.deepEqual(client.calls.map((c) => [c.method, c.params]), [['plugin.registry', {}]]);
  const state = picker.getSnapshot();
  assert.equal(state.open, true);
  assert.equal(state.trackId, 'trk_a');
  const root = render(picker);
  const dialog = find(root, byClass('plugin-picker'));
  assert.equal(dialog.tag, 'dialog');
  assert.ok(find(dialog, byAttr('data-testid', 'picker-search')).attrs.placeholder);
  const listed = rows(root);
  assert.deepEqual(listed.map((r) => r.attrs['data-name']), ['Room Reverb', 'SIANN Test Plugin', 'Surge XT'], 'by name');
  assert.deepEqual(listed.map((r) => text(find(r, byClass('picker-format')))), ['VST3', 'CLAP', 'CLAP']);
  // An approved install is chosen with its row's button; an unapproved one has Approve and no choose button.
  assert.equal(findAll(listed[1]!, byAttr('data-testid', 'picker-choose')).length, 1);
  assert.equal(findAll(listed[1]!, byAttr('data-testid', 'picker-approve')).length, 0);
  assert.equal(findAll(listed[2]!, byAttr('data-testid', 'picker-choose')).length, 0);
  assert.equal(text(find(listed[2]!, byAttr('data-testid', 'picker-approve'))), 'Approve');
  // Without plugin.approve, no Approve button.
  const noApprove = { ...FULL, methods: FULL.methods!.filter((m) => m !== 'plugin.approve') };
  assert.equal(findAll(render(picker, noApprove), byAttr('data-testid', 'picker-approve')).length, 0);
});

test('the search field filters the installs by name, ignoring case', async () => {
  const picker = new PickerController({ actions: new PluginActions({ client: fakeClient({ 'plugin.registry': registry(TEST_PLUGIN, SURGE, REVERB) }) }) });
  await picker.open('trk_a');
  picker.search('siann');
  assert.deepEqual(rows(render(picker)).map((r) => r.attrs['data-name']), ['SIANN Test Plugin']);
  picker.search('  R ');
  assert.deepEqual(rows(render(picker)).map((r) => r.attrs['data-name']), ['Room Reverb', 'Surge XT']);
  picker.search('nothing like it');
  const root = render(picker);
  assert.equal(rows(root).length, 0);
  assert.ok(text(find(root, byClass('picker-empty'))).length > 0);
});

test('Approve asks first, naming the file; a confirmed approval sends plugin.approve and the install becomes choosable', async () => {
  const approved = { ...SURGE, uid: 'org.surge', approved: true };
  let registryAnswer = registry(TEST_PLUGIN, SURGE);
  const client = fakeClient({ 'plugin.registry': () => registryAnswer(), 'plugin.approve': () => approved });
  const picker = new PickerController({ actions: new PluginActions({ client }) });
  await picker.open('trk_a');
  picker.askApprove(SURGE);
  assert.deepEqual(client.calls.map((c) => c.method), ['plugin.registry'], 'nothing is sent before the confirmation');
  const confirm = find(render(picker), byAttr('data-testid', 'confirm-dialog'));
  assert.ok(text(confirm).includes('/plugins/Surge XT.clap'), 'the confirmation names the file');
  picker.cancelApprove();
  assert.equal(picker.getSnapshot().confirm, null);
  picker.askApprove(SURGE);
  registryAnswer = registry(TEST_PLUGIN, approved);
  await picker.confirmApprove();
  const approve = client.calls.find((c) => c.method === 'plugin.approve')!;
  assert.deepEqual(approve.params, { format: 'clap', path: '/plugins/Surge XT.clap', approved: true });
  const row = rows(render(picker)).find((r) => r.attrs['data-name'] === 'Surge XT')!;
  assert.equal(findAll(row, byAttr('data-testid', 'picker-choose')).length, 1);
  assert.equal(picker.getSnapshot().error, null);
});

for (const code of ['invalid_params', 'plugin_load_failed', 'plugin_not_found']) {
  test(`an approval the engine refuses (${code}) shows its code and message and leaves the install unapproved`, async () => {
    const client = fakeClient({
      'plugin.registry': registry(SURGE),
      'plugin.approve': () => {
        throw new ProtocolError(code, `refused: ${code} for Surge XT`);
      },
    });
    const picker = new PickerController({ actions: new PluginActions({ client }) });
    await picker.open('trk_a');
    picker.askApprove(SURGE);
    await picker.confirmApprove();
    assert.deepEqual(picker.getSnapshot().error, { code, message: `refused: ${code} for Surge XT` });
    const root = render(picker);
    const error = find(root, byAttr('data-testid', 'picker-error'));
    assert.ok(text(error).includes(code));
    assert.ok(text(error).includes(`refused: ${code} for Surge XT`));
    const row = rows(root)[0]!;
    assert.equal(findAll(row, byAttr('data-testid', 'picker-approve')).length, 1, 'still unapproved');
    assert.equal(findAll(row, byAttr('data-testid', 'picker-choose')).length, 0);
  });
}

test('choosing an install sends plugin.instantiate at the end of the chain with the expected revision, then closes', async () => {
  const client = fakeClient({ 'plugin.registry': registry(TEST_PLUGIN), 'plugin.instantiate': instantiated('slt_3') });
  const picker = new PickerController({ actions: new PluginActions({ client }) });
  await picker.open('trk_a');
  const done = await picker.choose(TEST_PLUGIN);
  assert.equal(done, true);
  const call = client.calls.find((c) => c.method === 'plugin.instantiate')!;
  assert.deepEqual(call.params, { trackId: 'trk_a', index: 2, descriptor: { format: 'clap', path: '/plugins/siann_test_plugin.clap' } });
  assert.equal(call.expectedRevision, 'r12');
  assert.equal(picker.getSnapshot().open, false);
  // An empty chain inserts at 0.
  const empty = fakeClient({ 'plugin.registry': registry(TEST_PLUGIN), 'plugin.instantiate': instantiated('slt_1') }, []);
  const first = new PickerController({ actions: new PluginActions({ client: empty }) });
  await first.open('trk_a');
  await first.choose(TEST_PLUGIN);
  assert.equal(empty.calls.find((c) => c.method === 'plugin.instantiate')!.params.index, 0);
});

test('a failed instantiate job shows its code and keeps the picker open; so does a refused request', async () => {
  const client = fakeClient({
    'plugin.registry': registry(TEST_PLUGIN),
    'plugin.instantiate': () => ({ jobId: 'job_2', kind: 'plugin.instantiate', state: 'failed', error: { code: 'plugin_load_failed', message: 'the library did not load' } }),
  });
  const picker = new PickerController({ actions: new PluginActions({ client }) });
  await picker.open('trk_a');
  assert.equal(await picker.choose(TEST_PLUGIN), false);
  assert.equal(picker.getSnapshot().open, true);
  assert.deepEqual(picker.getSnapshot().error, { code: 'plugin_load_failed', message: 'the library did not load' });
  assert.ok(text(find(render(picker), byAttr('data-testid', 'picker-error'))).includes('plugin_load_failed'));
  const refused = fakeClient({
    'plugin.registry': registry(TEST_PLUGIN),
    'plugin.instantiate': () => {
      throw new ProtocolError('revision_mismatch', 'the session moved on');
    },
  });
  const again = new PickerController({ actions: new PluginActions({ client: refused }) });
  await again.open('trk_a');
  assert.equal(await again.choose(TEST_PLUGIN), false);
  assert.equal(again.getSnapshot().error?.code, 'revision_mismatch');
  // A registry the engine refuses shows its code too.
  const broken = new PickerController({ actions: new PluginActions({ client: fakeClient({}) }) });
  await broken.open('trk_a');
  assert.equal(broken.getSnapshot().error?.code, 'not_supported');
  broken.close();
  assert.equal(broken.getSnapshot().open, false);
  assert.equal(broken.getSnapshot().error, null);
});

test('bypass and Remove commit through command.execute; e opens and closes the editor, lit from editorOpen', async () => {
  let editorOpen = true;
  const client = fakeClient({
    'command.execute': () => ({ revision: 'r13' }),
    'plugin.open_editor': (p) => ({ slotId: p.slotId, editorOpen, nativeHandle: editorOpen ? '42' : '0' }),
    'plugin.close_editor': (p) => ({ slotId: p.slotId, editorOpen: false, nativeHandle: '0' }),
  });
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const actions = new PluginActions({ client, toasts, locale: () => 'en' });
  await actions.setBypass('slt_1', true);
  await actions.remove('slt_2');
  assert.deepEqual(
    client.calls.map((c) => [c.method, c.params, c.expectedRevision]),
    [
      ['command.execute', { commands: [{ op: 'plugin.set_bypass', slotId: 'slt_1', bypass: true }] }, 'r12'],
      ['command.execute', { commands: [{ op: 'plugin.remove', slotId: 'slt_2' }] }, 'r12'],
    ],
  );
  let heard = 0;
  actions.subscribe(() => (heard += 1));
  assert.equal(actions.editorOpen('slt_1'), false);
  await actions.toggleEditor('slt_1');
  assert.equal(actions.editorOpen('slt_1'), true);
  await actions.toggleEditor('slt_1');
  assert.equal(actions.editorOpen('slt_1'), false);
  assert.deepEqual(client.calls.slice(2).map((c) => [c.method, c.params]), [
    ['plugin.open_editor', { slotId: 'slt_1' }],
    ['plugin.close_editor', { slotId: 'slt_1' }],
  ]);
  assert.ok(heard >= 2);
  // The engine may answer an open with editorOpen false (a window that did not open): e stays unlit.
  editorOpen = false;
  await actions.toggleEditor('slt_1');
  assert.equal(actions.editorOpen('slt_1'), false);
  assert.deepEqual(toasts.getSnapshot(), [], 'no refusal so far');
});

test('a refused slot action raises a toast with the engine\'s code (editor_failed on the headless engine)', async () => {
  const client = fakeClient({
    'plugin.open_editor': () => {
      throw new ProtocolError('editor_failed', 'a CLAP plugin in the headless engine has no window');
    },
  });
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const actions = new PluginActions({ client, toasts, locale: () => 'en' });
  await actions.toggleEditor('slt_1');
  assert.equal(actions.editorOpen('slt_1'), false);
  const shown = toasts.getSnapshot();
  assert.equal(shown.length, 1);
  assert.ok(shown[0]!.text.startsWith('editor_failed: '), shown[0]!.text);
});
