// The capability rule of UI redesign spec 3.0 (m5-ui-shell): a control whose
// method or feature engine.capabilities does not list is not rendered. The
// selector answers has(method) and feature(name) over the engine's reply
// (fixtures copied from the protocol server's capabilitiesJson: the full one,
// and a reduced one without the plan actions, proposals and gestures);
// Capable renders its children only when the method is listed, and nothing
// while the capabilities are unknown. The session client asks for
// engine.capabilities once per connection after auth and keeps the last
// known value across a reconnect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { Strip } from '../../src/renderer/mixer/Strip';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import { SessionClient } from '../../src/renderer/model/session-client';
import { Capable, CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { clipRects } from '../../src/renderer/timeline/geometry';
import { Timeline } from '../../src/renderer/timeline/Timeline';
import { TimelineCanvas } from '../../src/renderer/timeline/TimelineCanvas';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { TrackList } from '../../src/renderer/timeline/TrackList';
import { FakeScheduler, FakeSocket, until } from './support/fakes';
import { fakeSurface, installSurfaceGlobals } from './support/surface';
import { sampleSnapshot } from './support/timeline';

// dist/test/unit -> app/test/unit/fixtures
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Capabilities;
const FULL = read('capabilities-full.json');
const REDUCED = read('capabilities-reduced.json');

test('has(method) and feature(name) over the full and the reduced capabilities', () => {
  const full = capabilitySelector(FULL);
  const reduced = capabilitySelector(REDUCED);
  for (const method of ['plan.approve', 'plan.apply', 'plan.propose', 'audition.hear', 'proposal.merge', 'gesture.begin']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.equal(reduced.has('plan.reject'), true);
  assert.equal(full.has('transport.set_cycle'), false, 'a method no engine lists yet');
  assert.equal(full.feature('gestures'), true);
  assert.equal(reduced.feature('gestures'), false);
  assert.equal(full.feature('plugins'), false, 'false is absent');
  assert.equal(capabilitySelector({ ...FULL, features: { plugins: { formats: ['clap'], flags: [] } } }).feature('plugins'), true);
  assert.equal(full.feature('locators'), false);
  const none = capabilitySelector(null);
  assert.equal(none.has('engine.about'), false);
  assert.equal(none.feature('plans'), false);
});

test('Capable renders nothing for an absent method and while the capabilities are unknown', () => {
  const render = (caps: Capabilities | null, method: string) =>
    renderToStaticMarkup(
      <CapabilitiesContext.Provider value={caps}>
        <Capable method={method}>
          <button type="button" data-testid="control" />
        </Capable>
      </CapabilitiesContext.Provider>,
    );
  assert.equal(render(FULL, 'plan.approve'), '<button type="button" data-testid="control"></button>');
  assert.equal(render(REDUCED, 'plan.approve'), '');
  assert.equal(render(null, 'plan.approve'), '');
  assert.equal(render(REDUCED, 'plan.reject'), '<button type="button" data-testid="control"></button>');
});

// command(name): command.execute is listed and the name is in `commands`.
test('command(name) reads the capabilities\' commands list, under command.execute', () => {
  const full = capabilitySelector(FULL);
  const reduced = capabilitySelector(REDUCED);
  for (const name of ['track.set_gain', 'track.set_mute', 'track.set_solo']) {
    assert.equal(full.command(name), true, name);
    assert.equal(reduced.command(name), true, name);
  }
  for (const name of ['clip.place', 'clip.move', 'clip.trim', 'clip.remove', 'track.set_pan']) {
    assert.equal(full.command(name), true, name);
    assert.equal(reduced.command(name), false, name);
  }
  const noExecute = { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'command.execute') };
  assert.equal(capabilitySelector(noExecute).command('track.set_mute'), false, 'no command.execute, no command');
  assert.equal(capabilitySelector(null).command('track.set_mute'), false);
});

// Real controls (not a stand-in inside Capable): each is absent from the
// markup when the command or method it sends is not listed.
const g = globalThis as unknown as Record<string, unknown>;
const frames = new Map<number, () => void>();
let nextFrame = 1;
g.requestAnimationFrame = (fn: () => void) => {
  const id = nextFrame++;
  frames.set(id, fn);
  return id;
};
g.cancelAnimationFrame = (id: number) => frames.delete(id);

function fakeClient(snapshot = sampleSnapshot(), execute: (commands: readonly unknown[]) => Promise<unknown> = async () => undefined) {
  const model = {
    getSnapshot: () => snapshot,
    getView: () => ({ snapshot, gesture: null, overlaid: null }),
    select: (ref: string) => snapshot.entities[ref],
    subscribe: () => () => undefined,
  };
  return {
    model,
    execute: (commands: readonly unknown[]) => execute(commands),
    subscribe: () => () => undefined,
    getState: () => ({ sessionId: 'ses_test' }),
  } as unknown as SessionClient;
}

function within(caps: Capabilities | null, node: ReactNode): string {
  return renderToStaticMarkup(<CapabilitiesContext.Provider value={caps}>{node}</CapabilitiesContext.Provider>);
}

const ONLY_GAIN: Capabilities = { ...FULL, commands: ['track.set_gain'] };

test('mixer strip: fader, pan, mute and solo each need their command; the reduced fixture keeps only mute and solo', () => {
  const strip = (caps: Capabilities | null) =>
    within(
      caps,
      <Strip
        trackId="trk_a"
        client={fakeClient()}
        gestures={{} as unknown as GestureController}
      />,
    );
  const full = strip(FULL);
  for (const id of ['fader-trk_a', 'pan-trk_a', 'mute-trk_a', 'solo-trk_a']) assert.ok(full.includes(`data-testid="${id}"`), id);
  const reduced = strip(REDUCED);
  for (const id of ['mute-trk_a', 'solo-trk_a']) assert.ok(reduced.includes(`data-testid="${id}"`), id);
  for (const id of ['fader-trk_a', 'pan-trk_a']) assert.ok(!reduced.includes(`data-testid="${id}"`), id);
  const gainOnly = strip(ONLY_GAIN);
  assert.ok(gainOnly.includes('data-testid="fader-trk_a"'));
  for (const id of ['pan-trk_a', 'mute-trk_a', 'solo-trk_a']) assert.ok(!gainOnly.includes(`data-testid="${id}"`), id);
  const unknown = strip(null);
  for (const id of ['fader-trk_a', 'pan-trk_a', 'mute-trk_a', 'solo-trk_a']) assert.ok(!unknown.includes(`data-testid="${id}"`), id);
});

test('timeline: the media pool place buttons need clip.place and the delete button clip.remove', () => {
  const timeline = (caps: Capabilities | null) =>
    within(caps, <Timeline client={fakeClient()} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} />);
  const full = timeline(FULL);
  assert.ok(full.includes('data-testid="pool-med_sq"'));
  assert.ok(full.includes('data-testid="delete-clip"'));
  for (const caps of [REDUCED, null]) {
    const shown = timeline(caps);
    assert.ok(!shown.includes('data-testid="pool-'), 'no place button');
    assert.ok(!shown.includes('data-testid="delete-clip"'), 'no delete button');
    assert.ok(shown.includes('data-testid="timeline-canvas"'), 'the canvas still draws the session');
  }
});

// The canvas's gestures (place, move, trim) send nothing the capabilities do not list.
function pointerCanvas() {
  installSurfaceGlobals();
  const surface = fakeSurface(800, 300);
  const fire = (type: string, x: number, y: number) => surface.fire(type, { clientX: x, clientY: y });
  return { surface, fire };
}

test('timeline canvas: a drag, a trim and a placement execute only the commands engine.capabilities lists', async () => {
  for (const [caps, expected] of [
    [FULL, ['clip.move', 'clip.trim+clip.move', 'clip.place']],
    [REDUCED, []],
  ] as const) {
    const sent: string[] = [];
    const snapshot = sampleSnapshot();
    const { surface, fire } = pointerCanvas();
    const allows = capabilitySelector(caps);
    const timeline = new TimelineCanvas({
      content: surface.content,
      overlay: surface.overlay,
      container: surface.container,
      model: fakeClient(snapshot).model,
      peaks: { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache,
      execute: async (commands) => {
        sent.push(commands.map((c) => (c as { op: string }).op).join('+'));
      },
      allows: (op) => allows.command(op),
    });
    const rect = clipRects(snapshot, timeline.testHooks().view()).find((r) => r.clipId === 'clp_1')!;
    const midY = rect.y + rect.height / 2;
    // Move: drag the body 40 px right.
    fire('pointerdown', rect.x + rect.width / 2, midY);
    fire('pointermove', rect.x + rect.width / 2 + 40, midY);
    fire('pointerup', rect.x + rect.width / 2 + 40, midY);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Trim: drag the start edge 20 px right.
    fire('pointerdown', rect.x + 1, midY);
    fire('pointermove', rect.x + 21, midY);
    fire('pointerup', rect.x + 21, midY);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Place: arm a media and click a lane.
    timeline.setPlacing('med_si');
    fire('pointerdown', 700, midY);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timeline.deleteSelected();
    assert.deepEqual(sent.slice(0, 3), expected, JSON.stringify(sent));
    if (caps === REDUCED) assert.deepEqual(sent, [], 'no clip.remove either');
    timeline.destroy();
  }
});

test('track list: + needs track.add, renaming track.rename, M and S track.set_mute and track.set_solo', () => {
  const list = (caps: Capabilities | null) =>
    within(
      caps,
      <TrackList
        client={fakeClient()}
        realtime={null}
        timeline={null}
        layout={createLayoutStore({ storage: null })}
        selectedTrackId={null}
        onSelectTrack={() => undefined}
      />,
    );
  const full = list(FULL);
  assert.ok(full.includes('data-testid="track-add"'), 'the + button');
  assert.match(full, /data-testid="track-list-body"[^>]*data-addable="true"/, 'double-click on empty space adds');
  for (const id of ['trk_a', 'trk_b']) {
    assert.match(full, new RegExp(`data-testid="track-name-${id}"[^>]*data-renamable="true"`), id);
    assert.ok(full.includes(`data-testid="track-mute-${id}"`), id);
    assert.ok(full.includes(`data-testid="track-solo-${id}"`), id);
  }
  const reduced = list(REDUCED);
  assert.ok(!reduced.includes('data-testid="track-add"'), 'no + without track.add');
  assert.ok(!reduced.includes('data-addable'), 'no double-click add without track.add');
  assert.ok(reduced.includes('data-testid="track-name-trk_a"'), 'the name is shown');
  assert.ok(!reduced.includes('data-renamable'), 'no rename without track.rename');
  assert.ok(reduced.includes('data-testid="track-mute-trk_a"'), 'the reduced fixture keeps mute');
  const addOnly = list({ ...FULL, commands: ['track.add'] });
  assert.ok(addOnly.includes('data-testid="track-add"'));
  assert.ok(!addOnly.includes('data-testid="track-mute-'), 'no M without track.set_mute');
  assert.ok(!addOnly.includes('data-testid="track-solo-'), 'no S without track.set_solo');
  const unknown = list(null);
  for (const id of ['track-add', 'track-mute-trk_a', 'track-solo-trk_a']) assert.ok(!unknown.includes(`data-testid="${id}"`), id);
});

// The Plans tab's controls (note field, step checkboxes, action buttons)
// follow the same rule: plan-panel.test.tsx and audition-banner.test.tsx.

// The engine's side: auth, then engine.capabilities from `answer`; nothing else is answered.
function engine(socket: FakeSocket, answer: () => Record<string, unknown>) {
  socket.handler = (message) => {
    if (message.type === 'auth') {
      queueMicrotask(() =>
        socket.deliver({ type: 'auth', ok: true, sessionId: 'ses_0000000000000001', revision: 'r1', seq: '1', meters: null, about: FULL.about }),
      );
      return;
    }
    if (message.method === 'engine.capabilities') {
      queueMicrotask(() => socket.deliver({ requestId: message.requestId, ...answer() }));
    }
  };
}

test('the session client asks for engine.capabilities once per connection and keeps the last value across a reconnect', async () => {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  let reply: Record<string, unknown> = { ok: true, result: FULL };
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      engine(socket, () => reply);
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: scheduler.schedule,
  });
  assert.equal(client.getState().capabilities, null);
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => client.getState().capabilities !== null, 'the capabilities');
  assert.deepEqual(client.getState().capabilities, FULL);
  assert.equal(sockets[0]!.requests('engine.capabilities').length, 1);

  // The engine goes away and comes back: the last value stays until the new one.
  sockets[0]!.serverClose();
  assert.equal(client.getState().status, 'disconnected');
  assert.deepEqual(client.getState().capabilities, FULL, 'kept while disconnected');
  reply = { ok: true, result: REDUCED };
  scheduler.fire(250);
  await until(() => sockets.length === 2, 'the reconnect');
  const second = sockets[1]!;
  second.onopen?.();
  await until(() => client.getState().status === 'connected', 'connected again');
  await until(() => client.getState().capabilities?.methods?.length === REDUCED.methods?.length, 'the new value');
  assert.deepEqual(client.getState().capabilities, REDUCED);
  assert.equal(second.requests('engine.capabilities').length, 1, 'once per connection');

  // A refused request keeps the last known value.
  reply = { ok: false, error: { code: 'internal_error', message: 'no' } };
  second.serverClose();
  scheduler.fire(250);
  await until(() => sockets.length === 3, 'the second reconnect');
  sockets[2]!.onopen?.();
  await until(() => sockets[2]!.requests('engine.capabilities').length === 1, 'asked on the third connection');
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(client.getState().capabilities, REDUCED);
});
