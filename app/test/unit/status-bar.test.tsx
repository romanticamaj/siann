// The status bar's about line (m5-ui-shell; UI redesign spec 2.1, "Licence
// line"; ADR-0017 point 4): built only from engine.about and the auth reply.
// Rendered with react-dom/server for both licences the engine build can
// report: every value appears exactly as given, the commit as its first 12
// characters (with +dirty for a dirty tree), and nothing when there is no
// about yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, translator } from '../../src/renderer/i18n/t';
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

function fixedLocale(locale: Locale): LocaleStore {
  return { subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore;
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

test('the About panel\'s line shows name, version, the whole commit with the dirty mark, licence and source URL exactly as the engine reports them', () => {
  for (const [about, commit] of [
    [DESKTOP, 'abcdef0123456789abcdef0123456789abcdef01+dirty'],
    [PLAIN, '9876543210fedcba9876543210fedcba98765432'],
  ] as const) {
    const shown = text(renderToStaticMarkup(<AboutLine about={about} />));
    for (const part of [about.name!, about.version!, commit, about.license!, about.source!.url!]) {
      assert.ok(shown.includes(part), `${JSON.stringify(shown)} lacks ${part}`);
    }
  }
  assert.ok(!text(renderToStaticMarkup(<AboutLine about={PLAIN} />)).includes('+dirty'));
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
// AGPL section 13), in the mockup's words (10.7, 1): "name version (commit7)
// · licence · source", the commit's first 7 characters in a .mono span, the
// source an <a> inside the button; the whole line is the button's title, and
// the button opens the About panel, which shows the whole commit and the
// mark of a modified tree.
test('the status bar about button reads name, version, 7-character commit, licence and source, and opens the About panel', () => {
  for (const [about, short] of [
    [DESKTOP, 'abcdef0'],
    [PLAIN, '9876543'],
  ] as const) {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
      installLocaleStore(fixedLocale(locale));
      try {
        const button = renderToStaticMarkup(<AboutButton about={about} onOpen={() => undefined} />);
        assert.match(button, /^<button[^>]*type="button"/);
        assert.match(button, /aria-haspopup="dialog"/);
        assert.match(button, /data-testid="about"/);
        assert.match(button, /data-part="status-about"/);
        const source = translator(locale)('status.source');
        assert.equal(
          text(button),
          `${about.name} ${about.version} ( ${short} ) · ${about.license} · ${source}`.replace(/\s+/g, ' '),
          locale,
        );
        // The mockup's text runs: "(", the commit in .mono, then ") · licence · " and the link.
        assert.match(button, new RegExp(`\\(<span class="mono"[^>]*>${short}</span></span><span class="about-tail">\\) · <span data-testid="about-license">`));
        assert.ok(button.endsWith(`<a>${source}</a></span></button>`), button);
        assert.ok(!button.includes(about.source!.commit!), 'the whole commit is the About panel\'s');
        assert.ok(!button.includes('+dirty'), 'the dirty mark is the About panel\'s');
        const title = /title="([^"]*)"/.exec(button)?.[1]?.replace(/&amp;/g, '&') ?? '';
        for (const part of [about.name!, about.version!, about.license!, about.source!.url!]) {
          assert.ok(title.includes(part), `title ${JSON.stringify(title)} lacks ${part}`);
        }
      } finally {
        installLocaleStore(fixedLocale('en'));
      }
    }
  }
  // No source URL: no "source" link.
  const bare = renderToStaticMarkup(<AboutButton about={{ ...PLAIN, source: { commit: PLAIN.source!.commit! } }} onOpen={() => undefined} />);
  assert.ok(!bare.includes('<a>'), bare);
  // No about: a disabled button with no licence and no title.
  const none = renderToStaticMarkup(<AboutButton about={null} onOpen={() => undefined} />);
  assert.match(none, /disabled=""/);
  assert.ok(!/GPL|title=/.test(none), none);
});

test('the About panel shows the whole about line', () => {
  const panel = renderToStaticMarkup(<AboutPanel about={DESKTOP} open onClose={() => undefined} />);
  assert.match(panel, /^<dialog[^>]*data-testid="about-panel"/);
  const shown = text(panel);
  for (const part of [DESKTOP.name!, DESKTOP.version!, `${DESKTOP.source!.commit!}+dirty`, DESKTOP.license!, DESKTOP.source!.url!]) {
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
  // The device segment as the mockup draws it: an id without a slash is shown once.
  assert.match(outside, /<span data-part="status-device" data-testid="device"[^>]*>fake · <b class="num">48 kHz<\/b> \/ <b class="num">256<\/b> · <span class="num" data-testid="latency">15\.0 ms<\/span><\/span>/);
  assert.match(outside, /<span data-part="status-xruns"><b class="num" data-testid="xruns">4<\/b> xruns<\/span>/);
  // The side heard in words (m5-ui-plan-panel): main or proposal, never a branch id; lower-case in the bar.
  assert.match(outside, /<span class="hear" data-part="status-hearing"><svg class="i s"[^>]*>.*?<\/svg>Hearing <b data-testid="status-heard" data-heard="main">main<\/b><\/span>/);
  assert.match(outside, /data-testid="saved-revision"/);
  assert.match(outside, /data-testid="locale-switch"/);
  // The diagnostics row's test id is about-track-count (UI redesign 10.8, 4): track-count is the track list head's count.
  assert.ok(!bar.includes('data-testid="track-count"'), 'no track-count in the status bar or its About panel');
  for (const id of ['session-id', 'about-track-count', 'clip-count', 'sync-count', 'connections']) {
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

// The mockup's markup (lines 338-344; docs/harness/agent-rules.md, "UI
// fidelity"): footer.statusbar holding the engine (i.ok, b), the device, the
// xruns, .hear, and .right with .loc, the saved revision and the about line,
// in the mockup's words in every locale (UI redesign 10.7, 1).
test('the status bar has the mockup\'s structure and words in en, zh-Hant and zh-Hans', () => {
  const words = {
    en: { xruns: 'xruns', hearing: 'Hearing', main: 'main', saved: 'Saved', locale: 'English' },
    'zh-Hant': { xruns: '次中斷', hearing: '監聽', main: '主線', saved: '已儲存', locale: '繁體中文' },
    'zh-Hans': { xruns: '次中断', hearing: '监听', main: '主线', saved: '已保存', locale: '简体中文' },
  } as const;
  const plans = new PlanStore();
  plans.setHeard('main');
  const caps: Capabilities = { methods: ['engine.status', 'audition.hear'], features: {} };
  for (const [locale, w] of Object.entries(words) as Array<[keyof typeof words, (typeof words)[keyof typeof words]]>) {
    installLocaleStore(fixedLocale(locale));
    try {
      const engine = translator(locale)('status.engineDisconnected');
      const bar = renderToStaticMarkup(
        <CapabilitiesContext.Provider value={caps}>
          <StatusBar client={disconnectedClient()} plans={plans} engineStatus={statusSource(STATUS)} />
        </CapabilitiesContext.Provider>,
      );
      const outside = bar.slice(0, bar.indexOf('<dialog'));
      assert.match(outside, /^<footer class="statusbar" data-region="status-bar" data-testid="status-bar"/);
      assert.ok(outside.includes(`<span data-part="status-engine" data-testid="status" data-status="disconnected"><i class="ok"></i><b>${engine}</b></span>`), `${locale}: ${outside}`);
      assert.ok(outside.includes(`<b class="num" data-testid="xruns">4</b> ${w.xruns}</span>`), locale);
      assert.ok(outside.includes(`</svg>${w.hearing} <b data-testid="status-heard" data-heard="main">${w.main}</b></span>`), locale);
      assert.match(outside, /<span class="right"><span class="loc" data-part="status-locale"><svg class="i s" viewBox="0 0 16 16"[^>]*>/);
      assert.match(outside, new RegExp(`</svg>${w.locale}<select[^>]*data-testid="locale-switch"`), locale);
      assert.ok(outside.includes(`<span data-part="status-saved">${w.saved} · <b class="num" data-testid="saved-revision"></b></span>`), locale);
      // The order: engine, device, xruns, hearing, then the right-hand group.
      const order = ['status-engine', 'status-device', 'status-xruns', 'status-hearing', 'status-locale', 'status-saved'].map((id) => outside.indexOf(`data-part="${id}"`));
      assert.deepEqual([...order].sort((a, b) => a - b), order, locale);
      assert.ok(order.every((at) => at > 0), locale);
    } finally {
      installLocaleStore(fixedLocale('en'));
    }
  }
  // The mockup's zh-TW words, exactly.
  const zh = translator('zh-Hant');
  assert.equal(zh('status.engineConnected'), '引擎已連線');
  assert.equal(zh('status.source'), '原始碼');
  assert.equal(translator('en')('status.engineConnected'), 'Engine connected');
});

test('the saved revision is the saved mark\'s baseline (UR-4); the head revision is the About panel\'s diagnostic', () => {
  const saved = (revision: string | null) => ({ getSnapshot: () => true, savedRevision: () => revision, subscribe: () => () => undefined });
  const t = translator('en');
  const bar = renderToStaticMarkup(<StatusBar client={disconnectedClient()} plans={new PlanStore()} engineStatus={statusSource(null)} saved={saved('r1')} />);
  const panelAt = bar.indexOf('data-testid="about-panel"');
  const outside = bar.slice(0, panelAt);
  const inside = bar.slice(panelAt);
  assert.ok(outside.includes(`<span data-part="status-saved">${t('status.saved')} · <b class="num" data-testid="saved-revision">r1</b></span>`), outside);
  assert.ok(!outside.includes('data-testid="revision"'), 'the head is not in the bar');
  assert.ok(inside.includes(`<dt>${t('status.head')}</dt><dd data-testid="revision">`), inside);
  // Before the first sync, or without a saved mark: nothing is called saved.
  for (const props of [{ saved: saved(null) }, {}]) {
    const empty = renderToStaticMarkup(<StatusBar client={disconnectedClient()} plans={new PlanStore()} engineStatus={statusSource(null)} {...props} />);
    assert.ok(empty.includes('data-testid="saved-revision"></b>'), empty);
  }
});
