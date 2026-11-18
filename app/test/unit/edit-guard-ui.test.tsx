// The edit guard in the controls (m5b-ui-audition; UI redesign 4.5 C5): while
// a branch is heard (HeardContext), the structural controls are disabled with
// the reason as their tooltip: the Split tool, the track list's Add Track, M
// and S on the headers and the strips. The fader, the pan knob and the
// Object Selection tool stay. With main heard nothing is disabled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import { Mixer } from '../../src/renderer/mixer/Mixer';
import { PickerController } from '../../src/renderer/mixer/picker';
import { PluginPicker } from '../../src/renderer/mixer/PluginPicker';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { PluginSlotEntity } from '../../src/renderer/model/document';
import { PluginActions } from '../../src/renderer/model/plugin-actions';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { GhostContext } from '../../src/renderer/plans/ghost-context';
import type { Ghost } from '../../src/renderer/plans/ghosts';
import { HeardContext } from '../../src/renderer/plans/heard-context';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Toolbar } from '../../src/renderer/timeline/Toolbar';
import { byAttr, find, parse, type Element } from './support/mockup';
import { snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const REASON = translator('en')(GUARD_REASON);

function within(heard: string | null, node: ReactNode): Element {
  return parse(
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={FULL}>
        <HeardContext.Provider value={heard}>{node}</HeardContext.Provider>
      </CapabilitiesContext.Provider>,
    ),
  );
}

const toolbar = (heard: string | null) =>
  within(
    heard,
    <Toolbar
      tool="select"
      snap={{ on: true, grid: 'bar' }}
      autoScroll={false}
      gates={{ select: true, split: true, glue: true, erase: true, snap: true, autoScroll: true }}
      error={null}
      onTool={() => undefined}
      onSnapToggle={() => undefined}
      onGrid={() => undefined}
      onSnapType={() => undefined}
      onAutoScroll={() => undefined}
    />,
  );

test('the Split, Glue and Erase tools are disabled with the reason while a branch is heard; the Object Selection tool is not', () => {
  const heard = toolbar('p1');
  // Glue and Erase (m5b-ui-edit-more) only glue and erase, as Split only splits.
  for (const id of ['tool-split', 'tool-glue', 'tool-erase']) {
    const tool = find(heard, byAttr('data-testid', id));
    assert.ok('disabled' in tool.attrs, id);
    assert.equal(tool.attrs.title, REASON, id);
    for (const side of ['main', null]) {
      const free = find(toolbar(side), byAttr('data-testid', id));
      assert.ok(!('disabled' in free.attrs), `${id} ${String(side)}`);
      assert.notEqual(free.attrs.title, REASON, id);
    }
  }
  const select = find(heard, byAttr('data-testid', 'tool-select'));
  assert.ok(!('disabled' in select.attrs));
});

const gestures = {} as unknown as GestureController;
const realtime = { subscribe: () => () => undefined } as unknown as RealtimeClient;

function mixer(heard: string | null): Element {
  const snap = snapshotOf(['trk_a'], [{ ...track('trk_a'), name: 'A' }], [], []);
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => snap.entities[ref],
    subscribe: () => () => undefined,
  };
  const client = { model, getState: () => ({ status: 'connected', legend: null }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
  return within(heard, <Mixer client={client} gestures={gestures} realtime={realtime} />);
}

test('M and S of a strip are disabled with the reason while a branch is heard; the fader and the knob stay', () => {
  const heard = mixer('p1');
  for (const id of ['mute-trk_a', 'solo-trk_a']) {
    const button = find(heard, byAttr('data-testid', id));
    assert.ok('disabled' in button.attrs, id);
    assert.equal(button.attrs.title, REASON, id);
  }
  for (const id of ['fader-trk_a', 'pan-trk_a']) {
    const control = find(heard, byAttr('data-testid', id));
    assert.ok(!('aria-disabled' in control.attrs) && !('disabled' in control.attrs), id);
  }
  const free = mixer('main');
  assert.ok(!('disabled' in find(free, byAttr('data-testid', 'mute-trk_a')).attrs));
});

// ---- The inserts of m5b-ui-inserts-master under the guard: bypass, Remove,
// an empty slot and the picker's choice commit onto main, so they are held
// while a branch is heard; e (the plugin's own window) stays.

const slotEntity = (id: string, name: string): PluginSlotEntity => ({ schema: 'siann.entity.plugin_slot.v1', id, trackId: 'trk_a', format: 'clap', uid: 'u', name, path: '/p/' + id, bypass: false });

function rackMixer(heard: string | null): Element {
  const base = snapshotOf(['trk_a'], [{ ...track('trk_a'), name: 'A', inserts: ['slt_1'] }], [], []);
  const snap = { ...base, entities: { ...base.entities, 'plugin_slot:slt_1': slotEntity('slt_1', 'Comp') } };
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => (snap.entities as Record<string, unknown>)[ref],
    subscribe: () => () => undefined,
  };
  const client = { model, getState: () => ({ status: 'connected', legend: null }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
  return within(heard, <Mixer client={client} gestures={gestures} realtime={realtime} />);
}

test('bypass, Remove and the empty slot of a rack are held with the reason while a branch is heard; e stays', () => {
  const heard = rackMixer('p1');
  for (const id of ['slot-bypass-slt_1', 'slot-remove-slt_1']) {
    const button = find(heard, byAttr('data-testid', id));
    assert.ok('disabled' in button.attrs, id);
    assert.equal(button.attrs.title, REASON, id);
  }
  assert.ok(!('disabled' in find(heard, byAttr('data-testid', 'slot-edit-slt_1')).attrs), 'e stays');
  const empty = find(heard, byAttr('data-testid', 'slot-add-trk_a-1'));
  assert.equal(empty.attrs['aria-disabled'], 'true');
  assert.equal(empty.attrs.title, REASON);
  for (const side of ['main', null]) {
    const free = rackMixer(side);
    for (const id of ['slot-bypass-slt_1', 'slot-remove-slt_1']) assert.ok(!('disabled' in find(free, byAttr('data-testid', id)).attrs), id);
    const add = find(free, byAttr('data-testid', 'slot-add-trk_a-1'));
    assert.ok(!('aria-disabled' in add.attrs));
    assert.notEqual(add.attrs.title, REASON);
  }
});

test('the picker does not insert while a branch is heard: its choice is disabled with the reason', async () => {
  const entry = { format: 'clap', path: '/plugins/x.clap', uid: 'org.x', name: 'X', approved: true };
  const client = { model: { getSnapshot: () => null, select: () => undefined }, request: async () => ({ plugins: [entry] }) };
  const picker = new PickerController({ actions: new PluginActions({ client: client as never }) });
  await picker.open('trk_a');
  const choose = (heard: string | null) => find(within(heard, <PluginPicker picker={picker} />), byAttr('data-testid', 'picker-choose'));
  assert.ok('disabled' in choose('p1').attrs);
  assert.equal(choose('p1').attrs.title, REASON);
  assert.ok(!('disabled' in choose('main').attrs));
  assert.equal(choose('main').attrs.title, entry.path);
});

// While the proposal is heard the insert ghosts are solid too (UI redesign 4.3).
test('a heard proposal\'s insert ghosts and bypass ring carry the solid mode', () => {
  const base = snapshotOf(['trk_a'], [{ ...track('trk_a'), name: 'A', inserts: ['slt_1'] }], [], []);
  const snap = { ...base, entities: { ...base.entities, 'plugin_slot:slt_1': slotEntity('slt_1', 'Comp') } };
  const model = {
    getSnapshot: () => snap,
    getView: () => ({ snapshot: snap, gesture: null, overlaid: null }),
    select: (ref: string) => (snap.entities as Record<string, unknown>)[ref],
    subscribe: () => () => undefined,
  };
  const client = { model, getState: () => ({ status: 'connected', legend: { entities: ['master'] } }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
  const render = (mode: 'solid' | undefined) => {
    const ghosts: Ghost[] = [
      { kind: 'insert-bypass', step: 1, trackId: 'trk_a', slotId: 'slt_1', before: false, after: true, ...(mode ? { mode } : {}) },
      { kind: 'insert-add', step: 2, trackId: 'trk_a', slotId: null, name: 'Limiter', index: 1, ...(mode ? { mode } : {}) },
      { kind: 'master-gain', step: 3, before: 0, after: -6000, ...(mode ? { mode } : {}) },
    ];
    return within(
      'p1',
      <GhostContext.Provider value={{ ghosts, outline: null, pin: () => undefined }}>
        <Mixer client={client} gestures={gestures} realtime={realtime} />
      </GhostContext.Provider>,
    );
  };
  for (const id of ['slot-bypass-slt_1', 'slot-ghost-2', 'fader-master-ghost-3', 'fader-value-master-ghost']) {
    assert.equal(find(render('solid'), byAttr('data-testid', id)).attrs['data-ghost-mode'], 'solid', id);
    assert.ok(!('data-ghost-mode' in find(render(undefined), byAttr('data-testid', id)).attrs), id);
  }
});
