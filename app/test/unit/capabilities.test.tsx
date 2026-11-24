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
import { loopClickGates } from '../../src/renderer/model/loop-click';
import { TOKENS } from '../../src/renderer/tokens';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import { SessionClient } from '../../src/renderer/model/session-client';
import { Capable, CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { clipRects } from '../../src/renderer/timeline/geometry';
import { Timeline, editGates } from '../../src/renderer/timeline/Timeline';
import { TimelineCanvas } from '../../src/renderer/timeline/TimelineCanvas';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { TrackList } from '../../src/renderer/timeline/TrackList';
import { MediaImporter } from '../../src/renderer/model/media-import';
import { MediaTab } from '../../src/renderer/media/MediaTab';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import { translator } from '../../src/renderer/i18n/t';
import { HeardContext } from '../../src/renderer/plans/heard-context';
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
  assert.equal(full.has('transport.punch'), false, 'a method no engine lists yet');
  // m5b-protocol-parity: the full fixture lists every method the engine serves.
  for (const method of ['transport.set_cycle', 'transport.set_click']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.equal(full.feature('gestures'), true);
  assert.equal(reduced.feature('gestures'), false);
  // m5b-ui-inserts-master: the full fixture carries the core engine's real
  // features.plugins (it hosts CLAP in every build: protocol-plugins-v0.md,
  // "engine.capabilities"); a false one is absent, as a reduced fixture says.
  assert.equal(full.feature('plugins'), true);
  assert.deepEqual(FULL.features?.plugins, {
    formats: ['clap'],
    flags: ['sampleAccurateParameters', 'midiInput', 'midiOutput', 'sidechain', 'variableLatency', 'editor'],
  });
  const noPlugins = read('capabilities-no-plugins.json');
  assert.equal(capabilitySelector(noPlugins).feature('plugins'), false);
  assert.equal(capabilitySelector({ ...noPlugins, features: { ...noPlugins.features, plugins: false } }).feature('plugins'), false, 'false is absent');
  assert.deepEqual({ ...noPlugins, features: { ...noPlugins.features, plugins: FULL.features?.plugins } }, FULL, 'the no-plugins fixture is the full one less features.plugins');
  const noMaster = read('capabilities-no-master.json');
  assert.equal(capabilitySelector(noMaster).feature('masterGain'), false);
  assert.equal(capabilitySelector(noMaster).command('master.set_gain'), true, 'only the feature is left out');
  // m5-ui-loop-click: the engine reports locators (and cycle and click with a transport port).
  assert.equal(full.feature('locators'), true);
  assert.equal(reduced.feature('locators'), false);
  // m5b-engine-record: recording through the protocol, reported only with a record port.
  assert.equal(full.feature('recording'), true);
  assert.equal(reduced.feature('recording'), false, 'the reduced engine has no features.recording');
  for (const method of ['record.arm', 'transport.record', 'record.recover_take']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.equal(full.command('track.set_input'), true);
  assert.equal(reduced.command('track.set_input'), false);
  // m5b-engine-project-media: create and import, and the media name command.
  for (const method of ['session.create', 'media.import']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.equal(full.feature('mediaImport'), true);
  assert.deepEqual(FULL.features?.mediaImport, { formats: ['wav', 'flac'] });
  assert.equal(reduced.feature('mediaImport'), false);
  assert.equal(full.command('media.rename'), true);
  // m5b-engine-master: the master gain command and its feature.
  assert.equal(full.feature('masterGain'), true);
  assert.equal(reduced.feature('masterGain'), false);
  assert.equal(full.command('master.set_gain'), true);
  assert.equal(reduced.command('master.set_gain'), false);
  // m5b-engine-monitoring: the monitor command, and the feature with a record port.
  assert.equal(full.command('track.set_monitor'), true);
  assert.equal(reduced.command('track.set_monitor'), false);
  assert.equal(full.feature('monitoring'), true);
  assert.equal(reduced.feature('monitoring'), false, 'the reduced engine has no features.monitoring');
  // m5b-engine-clip-fades: the fade command and its feature (no method of its own).
  assert.equal(full.feature('clipFades'), true);
  assert.equal(reduced.feature('clipFades'), false);
  assert.equal(full.command('clip.set_fade'), true);
  assert.equal(reduced.command('clip.set_fade'), false);
  // m5b-engine-track-notes: the notes command, listed in commands (no feature flag).
  assert.equal(full.command('track.set_notes'), true);
  assert.equal(reduced.command('track.set_notes'), false);
  // m5b-engine-plan-metadata: plan titles, intents and actors, and the agents in
  // engine.status (true with a transport port); the reduced engine predates both.
  assert.equal(full.feature('planMetadata'), true);
  assert.equal(full.feature('agents'), true);
  assert.equal(reduced.feature('planMetadata'), false, 'the reduced engine has no features.planMetadata');
  assert.equal(reduced.feature('agents'), false, 'the reduced engine has no features.agents');
  // m5b-engine-agent-requests: the composer's feature, its methods and the limits.
  assert.equal(full.feature('agentRequests'), true);
  assert.equal(reduced.feature('agentRequests'), false, 'the reduced engine has no features.agentRequests');
  for (const method of ['agent.request', 'agent.cancel_request', 'agent.requests', 'agent.next_request', 'agent.answer_request']) {
    assert.equal(full.has(method), true, method);
    assert.equal(reduced.has(method), false, method);
  }
  assert.deepEqual(
    {
      perAgent: (FULL.limits as Record<string, unknown>).agentRequestsPerAgent,
      textChars: (FULL.limits as Record<string, unknown>).agentRequestTextChars,
      waitMs: (FULL.limits as Record<string, unknown>).agentRequestWaitMs,
      closed: (FULL.limits as Record<string, unknown>).agentRequestsClosedRetained,
    },
    { perAgent: 16, textChars: 4000, waitMs: 25000, closed: 16 },
  );
  // m5b-engine-buses-sends: the bus and send features and commands.
  assert.equal(full.feature('buses'), true);
  assert.equal(full.feature('sends'), true);
  assert.equal(reduced.feature('buses'), false);
  assert.equal(full.command('bus.add'), true);
  assert.equal(full.command('send.set_level'), true);
  assert.equal(full.command('track.set_output'), true);
  // m5b-engine-load-loudness: DSP load in engine.status, the loudness frame and
  // its reset (true with a transport port); the reduced engine predates them.
  assert.equal(full.has('meter.reset_loudness'), true);
  assert.equal(reduced.has('meter.reset_loudness'), false);
  assert.equal(full.feature('load'), true);
  assert.equal(full.feature('loudness'), true);
  assert.equal(reduced.feature('load'), false, 'the reduced engine has no features.load');
  assert.equal(reduced.feature('loudness'), false, 'the reduced engine has no features.loudness');
  // m5b-engine-markers: features.markers and the four marker commands.
  assert.equal(full.feature('markers'), true);
  assert.equal(reduced.feature('markers'), false, 'the reduced engine has no features.markers');
  for (const name of ['marker.add', 'marker.move', 'marker.rename', 'marker.remove']) {
    assert.equal(full.command(name), true, name);
    assert.equal(reduced.command(name), false, name);
  }
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

// m5-ui-port-toolbar (UI redesign 10.8): the media buttons left the toolbar
// and the Delete clip button is gone (Delete and Backspace stay, behind
// clip.remove); m5b-ui-media's Media tab replaced the Pool, which does not
// return on any engine (UR-5).
test('timeline: the window has no media pool and no Delete clip button, whatever the capabilities', () => {
  const timeline = (caps: Capabilities | null) =>
    within(caps, <Timeline client={fakeClient()} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} />);
  for (const caps of [FULL, REDUCED, null]) {
    const shown = timeline(caps);
    assert.ok(!shown.includes('data-testid="media-pool"'), 'no Pool at rest');
    assert.ok(!shown.includes('data-testid="pool-'), 'no place button');
    assert.ok(!shown.includes('data-testid="delete-clip"'), 'no delete button');
    assert.ok(shown.includes('data-testid="timeline-canvas"'), 'the canvas still draws the session');
  }
  assert.equal(editGates(capabilitySelector(FULL))['edit.delete'], true);
  assert.equal(editGates(capabilitySelector(REDUCED))['edit.delete'], false);
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

// m5-ui-edit-basics: the tool buttons, the snap controls, the editing keys
// and the canvas's gain, split, copy and duplicate follow the same rule.
test('timeline: the tool buttons and the snap controls need the clip commands they end in', () => {
  const timeline = (caps: Capabilities | null) =>
    within(caps, <Timeline client={fakeClient()} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} />);
  const full = timeline(FULL);
  for (const id of ['tool-select', 'tool-split', 'snap-toggle', 'grid-type']) assert.ok(full.includes(`data-testid="${id}"`), id);
  // The grid type is a field whose menu (Bar, Beat, Adapt to Zoom) opens on a click.
  assert.ok(full.includes('aria-haspopup="menu"'));
  assert.ok(!full.includes('<select'), 'no native select');
  for (const caps of [REDUCED, null]) {
    const shown = timeline(caps);
    for (const id of ['tool-select', 'tool-split', 'snap-toggle', 'grid-type']) assert.ok(!shown.includes(`data-testid="${id}"`), id);
    // The toolbar and its tool group keep their places, empty (UI redesign 3.0).
    assert.ok(shown.includes('data-part="toolbar"'));
    assert.ok(shown.includes('data-part="tools"'));
  }
  // Moves without splits: the selection tool and snap, no split tool.
  const moveOnly = timeline({ ...FULL, commands: ['clip.move'] });
  assert.ok(moveOnly.includes('data-testid="tool-select"'));
  assert.ok(moveOnly.includes('data-testid="snap-toggle"'));
  assert.ok(!moveOnly.includes('data-testid="tool-split"'), 'split needs clip.trim and clip.place');
  const trimOnly = timeline({ ...FULL, commands: ['clip.trim'] });
  assert.ok(!trimOnly.includes('data-testid="tool-split"'));
});

test('the editing keys are registered only for what engine.capabilities lists', () => {
  const full = editGates(capabilitySelector(FULL));
  for (const id of Object.keys(full)) assert.equal(full[id as keyof typeof full], true, id);
  const reduced = editGates(capabilitySelector(REDUCED));
  for (const id of ['tool.split', 'edit.splitAtCursor', 'edit.duplicate', 'edit.delete', 'edit.snapToggle', 'track.removeSelected']) {
    assert.equal(reduced[id as keyof typeof reduced], false, id);
  }
  // The reduced engine lists no transport.locate: no L, N or B.
  for (const id of ['transport.locateSelection', 'transport.locateNextClip', 'transport.locatePreviousClip']) {
    assert.equal(reduced[id as keyof typeof reduced], false, id);
  }
  // It does list track.set_mute and track.set_solo: M and S stay.
  assert.equal(reduced['track.muteSelected'], true);
  assert.equal(reduced['track.soloSelected'], true);
  // Selecting, zooming and the select tool's key send nothing.
  for (const id of ['edit.selectAll', 'view.zoomSelection', 'view.zoomEvent']) assert.equal(reduced[id as keyof typeof reduced], true, id);
  const split = editGates(capabilitySelector({ ...FULL, commands: ['clip.trim'] }));
  assert.equal(split['tool.split'], false, 'split needs clip.place too');
  assert.equal(split['edit.splitAtCursor'], false);
  const none = editGates(capabilitySelector(null));
  assert.equal(none['track.muteSelected'], false);
});

test('timeline canvas: split, Alt-drag copy, duplicate, the volume control and delete send only what engine.capabilities lists', async () => {
  for (const [caps, expected] of [
    [FULL, ['clip.trim+clip.place', 'clip.place', 'clip.place', 'clip.set_gain', 'clip.remove']],
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
    timeline.setSnap({ on: false, grid: 'bar' });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const rect = clipRects(snapshot, timeline.testHooks().view()).find((r) => r.clipId === 'clp_1')!;
    const midY = rect.y + rect.height / 2;
    const midX = rect.x + rect.width / 2;
    // The split tool: a click splits the clip there.
    timeline.setTool('split');
    fire('pointerdown', midX, midY);
    fire('pointerup', midX, midY);
    await settle();
    timeline.setTool('select');
    // Alt-drag copies.
    surface.fire('pointerdown', { clientX: midX, clientY: midY, altKey: true });
    surface.fire('pointermove', { clientX: midX + 40, clientY: midY, altKey: true });
    surface.fire('pointerup', { clientX: midX + 40, clientY: midY, altKey: true });
    await settle();
    // Ctrl+D duplicates the selection.
    await timeline.duplicate();
    // The volume control: drag up 10 px.
    // draw()'s volume box in the clip's inset box (m5-ui-port-arrange-canvas).
    const gainAt = { x: rect.x + 20, y: rect.y + rect.height - 10 };
    fire('pointerdown', gainAt.x, gainAt.y);
    fire('pointermove', gainAt.x, gainAt.y - 10);
    fire('pointerup', gainAt.x, gainAt.y - 10);
    await settle();
    await timeline.deleteSelected();
    assert.deepEqual(sent, expected, JSON.stringify(sent));
    timeline.destroy();
  }
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

// m5-ui-loop-click (test-matrix rule 2): the full fixture lists E-1's methods,
// features and command as the engine does; the reduced one lists none.
test('locators, cycle and click: the full fixture lists them, the gates follow the capabilities', () => {
  for (const method of ['transport.set_cycle', 'transport.set_click']) assert.ok(FULL.methods!.includes(method), method);
  assert.ok(FULL.commands!.includes('session.set_locators'));
  for (const feature of ['locators', 'cycle', 'click']) assert.equal(FULL.features![feature], true, feature);
  assert.deepEqual(loopClickGates(capabilitySelector(FULL)), { locators: true, cycle: true, click: true });
  assert.deepEqual(loopClickGates(capabilitySelector(REDUCED)), { locators: false, cycle: false, click: false });
  assert.deepEqual(loopClickGates(capabilitySelector(null)), { locators: false, cycle: false, click: false });
  // Each needs its method (or command) and its feature.
  const without = (method: string): Capabilities => ({ ...FULL, methods: FULL.methods!.filter((m) => m !== method) });
  assert.equal(loopClickGates(capabilitySelector(without('transport.set_cycle'))).cycle, false);
  assert.equal(loopClickGates(capabilitySelector(without('transport.set_click'))).click, false);
  assert.equal(loopClickGates(capabilitySelector({ ...FULL, commands: FULL.commands!.filter((c) => c !== 'session.set_locators') })).locators, false);
  assert.equal(loopClickGates(capabilitySelector({ ...FULL, features: { ...FULL.features, cycle: false } })).cycle, false);
});

// The empty-width token of the locator display (UI redesign 3.0; 10.7, 5) is
// permanent: not a --hold-* token, which the part's landing would delete.
test('--display-locators-empty-w is a permanent token, not a hold token', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'tokens.css'), 'utf8');
  assert.match(css, /--display-locators-empty-w:\s*calc\([\d.]+px \* var\(--scale\)\);/);
  assert.ok(!/--hold-display-locators/.test(css));
  assert.ok(!'display-locators-empty-w'.startsWith('hold-'));
  assert.equal(typeof TOKENS['display-locators-empty-w'], 'string');
  assert.match(TOKENS['display-locators-empty-w'], /^[\d.]+px$/);
});

// m5b-ui-media (UI redesign UR-5, 3.0): the event display is a drop target
// only with the preload bridge and an engine that lists media.import; the
// Media tab's Import needs the bridge too. In a plain browser tab neither is
// in the DOM.
function mediaHost(bridge: boolean) {
  const client = fakeClient();
  const importer = new MediaImporter({
    client: client as unknown as ConstructorParameters<typeof MediaImporter>[0]['client'],
    schedule: () => () => undefined,
    toasts: { push: () => 0 },
    locale: () => 'en',
  });
  return {
    client,
    host: {
      bridge: bridge ? { choose: async () => [], pathForFile: () => '' } : null,
      importer,
      toasts: { push: () => 0 },
    },
  };
}

test('timeline: the event display is a drop target only with the bridge and media.import', () => {
  const render = (caps: Capabilities | null, bridge: boolean) => {
    const { client, host } = mediaHost(bridge);
    return within(caps, <Timeline client={client} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} media={host} />);
  };
  assert.match(render(FULL, true), /data-testid="event-display"[^>]*data-drop-target="media"|data-drop-target="media"[^>]*data-testid="event-display"/);
  for (const [caps, bridge] of [[FULL, false], [REDUCED, true], [null, true]] as const) {
    assert.ok(!render(caps, bridge).includes('data-drop-target'), `${caps === FULL ? 'full' : 'reduced'} bridge=${bridge}`);
  }
  // Without a media host (a plain browser tab) there is no drop target either.
  assert.ok(!within(FULL, <Timeline client={fakeClient()} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} />).includes('data-drop-target'));
});

// The edit guard (UI redesign 4.5 C5): while a branch is heard the event
// display takes no drop (data-drop-target="guarded") and the tab's Import is
// disabled with the reason; with main heard both are as they were.
test('timeline and media tab: while a branch is heard the drop target is guarded and Import is disabled with the reason', () => {
  const reason = translator('en')(GUARD_REASON);
  const heard = (side: string | null, node: ReactNode) => within(FULL, <HeardContext.Provider value={side}>{node}</HeardContext.Provider>);
  const timeline = (side: string | null) => {
    const { client, host } = mediaHost(true);
    return heard(side, <Timeline client={client} peaks={{} as unknown as PeaksCache} commands={new CommandRegistry()} media={host} />);
  };
  assert.match(timeline('p1'), /data-drop-target="guarded"/);
  assert.match(timeline('main'), /data-drop-target="media"/);
  assert.match(timeline(null), /data-drop-target="media"/);
  const tab = (side: string | null) => {
    const { client, host } = mediaHost(true);
    return heard(side, <MediaTab client={client} media={host} />);
  };
  const button = (markup: string) => /<button[^>]*data-testid="media-import"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.match(button(tab('p1')), /disabled=""/);
  assert.ok(button(tab('p1')).includes(`title="${reason}"`), button(tab('p1')));
  assert.doesNotMatch(button(tab('main')), /disabled=""/);
});

test('media tab: Import only with the bridge; nothing of the tab without media.import', () => {
  const tab = (caps: Capabilities | null, bridge: boolean) => {
    const { client, host } = mediaHost(bridge);
    return within(caps, <MediaTab client={client} media={host} />);
  };
  assert.ok(tab(FULL, true).includes('data-testid="media-import"'));
  assert.ok(tab(FULL, true).includes('data-testid="media-row-med_sq"'));
  assert.ok(!tab(FULL, false).includes('data-testid="media-import"'), 'no Import in a plain browser tab');
  assert.ok(tab(FULL, false).includes('data-testid="media-tab"'), 'the list without the bridge');
  assert.equal(tab(REDUCED, true), '', 'nothing without media.import');
  assert.equal(tab(null, true), '', 'nothing while the capabilities are unknown');
});
