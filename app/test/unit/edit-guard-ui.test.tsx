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
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import type { SessionClient } from '../../src/renderer/model/session-client';
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
      gates={{ select: true, split: true, snap: true, autoScroll: true }}
      error={null}
      onTool={() => undefined}
      onSnapToggle={() => undefined}
      onGrid={() => undefined}
      onAutoScroll={() => undefined}
    />,
  );

test('the Split tool is disabled with the reason while a branch is heard; the Object Selection tool is not', () => {
  const heard = toolbar('p1');
  const split = find(heard, byAttr('data-testid', 'tool-split'));
  assert.ok('disabled' in split.attrs);
  assert.equal(split.attrs.title, REASON);
  const select = find(heard, byAttr('data-testid', 'tool-select'));
  assert.ok(!('disabled' in select.attrs));
  for (const side of ['main', null]) {
    const free = find(toolbar(side), byAttr('data-testid', 'tool-split'));
    assert.ok(!('disabled' in free.attrs), String(side));
    assert.notEqual(free.attrs.title, REASON);
  }
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
