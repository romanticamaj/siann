// The status bar's about line (m5-ui-shell; UI redesign spec 2.1, "Licence
// line"; ADR-0017 point 4): built only from engine.about and the auth reply.
// Rendered with react-dom/server for both licences the engine build can
// report: every value appears exactly as given, the commit as its first 12
// characters (with +dirty for a dirty tree), and nothing when there is no
// about yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AboutInfo } from '../../src/renderer/model/session-client';
import { SessionClient } from '../../src/renderer/model/session-client';
import { AboutButton, AboutLine, AboutPanel, StatusBar } from '../../src/renderer/shell/StatusBar';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import { parseEngineStatus, type EngineStatus, type EngineStatusSource } from '../../src/renderer/model/engine-status';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';

const DESKTOP: AboutInfo = {
  name: 'siann-engine',
  version: '0.4.2',
  license: 'AGPL-3.0-or-later',
  source: { url: 'https://example.invalid/siann/desktop', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: true },
};
const PLAIN: AboutInfo = {
  name: 'siann-engine-headless',
  version: '1.0.0-rc.1',
  license: 'GPL-2.0-or-later',
  source: { url: 'https://example.invalid/siann/plain', commit: '9876543210fedcba9876543210fedcba98765432', dirty: false },
};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

test('the about line shows name, version, commit, licence and source URL exactly as the engine reports them', () => {
  for (const [about, commit] of [
    [DESKTOP, 'abcdef012345+dirty'],
    [PLAIN, '9876543210fe'],
  ] as const) {
    const shown = text(renderToStaticMarkup(<AboutLine about={about} />));
    for (const part of [about.name!, about.version!, commit, about.license!, about.source!.url!]) {
      assert.ok(shown.includes(part), `${JSON.stringify(shown)} lacks ${part}`);
    }
    assert.ok(!shown.includes(about.source!.commit!), 'the full commit is not shown');
  }
  // Each licence only where the engine reported it.
  assert.ok(!text(renderToStaticMarkup(<AboutLine about={PLAIN} />)).includes('AGPL'));
  assert.ok(!text(renderToStaticMarkup(<AboutLine about={DESKTOP} />)).includes('GPL-2.0'));
});

test('no about renders no licence text', () => {
  const markup = renderToStaticMarkup(<AboutLine about={null} />);
  assert.ok(!/GPL|licen[cs]e/i.test(markup), markup);
  // The whole bar while disconnected: the status, no licence.
  const client = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
  });
  const bar = renderToStaticMarkup(<StatusBar client={client} plans={new PlanStore()} engineStatus={statusSource(null)} />);
  assert.match(bar, /data-testid="status"[^>]*data-status="disconnected"/);
  assert.match(bar, /data-testid="about"/);
  assert.ok(!/GPL/.test(bar), bar);
});

// The licence line stays visible or one click away (UI redesign spec 2.1,
// AGPL section 13): in the bar the licence sits in its own unclipped span
// after the rest of the line, the whole line is the button's title, and the
// button opens the About panel, which shows the line in full.
test('the status bar about button keeps the licence apart, titles the whole line and opens the About panel', () => {
  for (const about of [DESKTOP, PLAIN]) {
    const button = renderToStaticMarkup(<AboutButton about={about} onOpen={() => undefined} />);
    assert.match(button, /^<button[^>]*type="button"/);
    assert.match(button, /aria-haspopup="dialog"/);
    assert.match(button, /data-testid="about"/);
    const title = /title="([^"]*)"/.exec(button)?.[1]?.replace(/&amp;/g, '&') ?? '';
    for (const part of [about.name!, about.version!, about.license!, about.source!.url!]) {
      assert.ok(title.includes(part), `title ${JSON.stringify(title)} lacks ${part}`);
    }
    const license = /<span class="about-license"[^>]*>([^<]*)<\/span>/.exec(button);
    assert.equal(license?.[1], about.license);
    // The licence comes last, so what clips first is the rest of the line.
    assert.ok(button.lastIndexOf('about-license') > button.lastIndexOf('about-summary'), button);
  }
  // No about: a disabled button with no licence and no title.
  const none = renderToStaticMarkup(<AboutButton about={null} onOpen={() => undefined} />);
  assert.match(none, /disabled=""/);
  assert.ok(!/GPL|title=/.test(none), none);
});

test('the About panel shows the whole about line', () => {
  const panel = renderToStaticMarkup(<AboutPanel about={DESKTOP} open onClose={() => undefined} />);
  assert.match(panel, /^<dialog[^>]*data-testid="about-panel"/);
  const shown = text(panel);
  for (const part of [DESKTOP.name!, DESKTOP.version!, 'abcdef012345+dirty', DESKTOP.license!, DESKTOP.source!.url!]) {
    assert.ok(shown.includes(part), `${JSON.stringify(shown)} lacks ${part}`);
  }
  assert.match(panel, /data-testid="about-close"/);
});

// The bar's content (UI redesign spec 2.1, "Status bar"; 3.0): engine
// connection, device and latency, xruns (engine.status), side heard,
// language, saved revision and the about line. The session id and the read
// model's counts are diagnostics: they sit in the About panel, not the bar.
// Device, latency and xruns exist only when engine.capabilities lists
// engine.status and an answer is known; the side heard only when it lists
// audition.hear and a side is known.
function statusSource(snapshot: EngineStatus | null): EngineStatusSource {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

function disconnectedClient(): SessionClient {
  return new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
  });
}

const STATUS = parseEngineStatus({
  device: { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 240, outputLatencyFrames: 480 },
  xruns: '4',
});

test('the status bar shows device, latency, xruns and the side heard, and keeps the diagnostics in the About panel', () => {
  const plans = new PlanStore();
  plans.setHeard('main');
  const caps: Capabilities = { methods: ['engine.status', 'audition.hear'], features: {} };
  const bar = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps}>
      <StatusBar client={disconnectedClient()} plans={plans} engineStatus={statusSource(STATUS)} />
    </CapabilitiesContext.Provider>,
  );
  const panelAt = bar.indexOf('data-testid="about-panel"');
  assert.ok(panelAt > 0, bar);
  const outside = bar.slice(0, panelAt);
  const inside = bar.slice(panelAt);
  assert.match(outside, /data-testid="device"[^>]*>fake</);
  assert.match(outside, /data-testid="latency"[^>]*>5\.0 \/ 10\.0 ms</);
  assert.match(outside, /data-testid="xruns"[^>]*>4</);
  // The side heard in words (m5-ui-plan-panel): Main or Proposal, never a branch id.
  assert.match(outside, /data-testid="status-heard"[^>]*>Main</);
  assert.match(outside, /data-testid="revision"/);
  assert.match(outside, /data-testid="locale-switch"/);
  for (const id of ['session-id', 'track-count', 'clip-count', 'sync-count', 'connections']) {
    assert.ok(!outside.includes(`data-testid="${id}"`), `${id} is not in the bar`);
    assert.ok(inside.includes(`data-testid="${id}"`), `${id} is in the About panel`);
  }
});

test('without engine.status or audition.hear in the capabilities, or before an answer, the bar has no device, latency, xruns or side heard', () => {
  const plans = new PlanStore();
  plans.setHeard('main');
  const caps: ReadonlyArray<Capabilities | null> = [null, { methods: ['engine.capabilities'], features: {} }];
  for (const cap of caps) {
    const bar = renderToStaticMarkup(
      <CapabilitiesContext.Provider value={cap}>
        <StatusBar client={disconnectedClient()} plans={plans} engineStatus={statusSource(STATUS)} />
      </CapabilitiesContext.Provider>,
    );
    for (const id of ['device', 'latency', 'xruns', 'status-heard']) assert.ok(!bar.includes(`data-testid="${id}"`), id);
  }
  const unknown = renderToStaticMarkup(
    <CapabilitiesContext.Provider value={{ methods: ['engine.status', 'audition.hear'], features: {} }}>
      <StatusBar client={disconnectedClient()} plans={new PlanStore()} engineStatus={statusSource(null)} />
    </CapabilitiesContext.Provider>,
  );
  for (const id of ['device', 'latency', 'xruns', 'status-heard']) assert.ok(!unknown.includes(`data-testid="${id}"`), id);
});
