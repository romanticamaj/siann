// The top bar ported from the mockup (m5-ui-alignment-chrome; mockup.html
// lines 220-246; docs/harness/agent-rules.md, "UI fidelity"): the DOM
// structure and class names are the mockup's, so ui/top-bar.css draws it.
//
//   header.topbar
//     .tb-left   .brand>b>i, .session (name + chevron), the branch chip's
//                hold, .sep, .iconbtn undo, .iconbtn redo (.dim when nothing
//                is left to redo)
//     .transport .tgroup (start, cycle, stop, .play, the Record hold),
//                one .lcd (.cell position, time, locators, tempo, and the
//                signature last: m5b-ui-signature), .tgroup with the metronome
//     .tb-right  the DSP load (span.dsp; m5b-ui-meter), .zones (the Channel button's hold and
//                three .iconbtn), .aibtn with its .n
//
// An absent part's box is an element with no role, no tabindex, no data-part
// and no text, hidden from assistive technology (UI redesign 3.0). The undo
// availability comes from the causes of session.changed (UndoHistory).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { LocatorsEntity } from '../../src/renderer/model/document';
import { parseEngineStatus, type EngineLoad, type EngineStatus } from '../../src/renderer/model/engine-status';
import { bindDspLoad } from '../../src/renderer/shell/dsp-load';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import { PlanStore } from '../../src/renderer/model/plan-store';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { UndoHistory, type UndoAvailability } from '../../src/renderer/model/undo-history';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { effectiveLayout } from '../../src/renderer/shell/layout';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { TopBar } from '../../src/renderer/shell/TopBar';
import { translator } from '../../src/renderer/i18n/t';
import { formatSignature } from '../../src/renderer/timeline/musical-time';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { planName } from '../../src/renderer/plans/plan-name';
import { byAttr, elements, find, loadMockup, parse, sig, text, type Element } from './support/mockup';
import { BRANCH, hashOf, MIX_STEPS, planObject, planSnapshot } from './support/plans';
import { sampleSnapshot } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const WITH_DEVICE = parseEngineStatus({
  device: { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 240, outputLatencyFrames: 480 },
  deviceError: null,
  xruns: '0',
});

function withLocators(snapshot: Snapshot): Snapshot {
  const locators: LocatorsEntity = { schema: 'siann.entity.locators.v1', id: 'locators', left: String(8 * 96000), right: String(12 * 96000) };
  return { ...snapshot, locators };
}

// A load channel that counts what reads it (m5b-ui-meter).
interface CountingLoad {
  getLoad(): EngineLoad | null;
  subscribeLoad(listener: () => void): () => void;
  set(load: EngineLoad | null): void;
  readonly listeners: Set<() => void>;
  reads: number;
  subscriptions: number;
}

function countingLoad(): CountingLoad {
  let value: EngineLoad | null = null;
  const listeners = new Set<() => void>();
  const load: CountingLoad = {
    listeners,
    reads: 0,
    subscriptions: 0,
    getLoad: () => {
      load.reads += 1;
      return value;
    },
    subscribeLoad: (listener) => {
      load.subscriptions += 1;
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
  return load;
}

function fixedHistory(value: UndoAvailability): Pick<UndoHistory, 'getSnapshot' | 'subscribe'> {
  return { getSnapshot: () => value, subscribe: () => () => undefined };
}

function render(options: { snapshot?: Snapshot | null; history?: UndoAvailability; status?: EngineStatus | null; plans?: PlanStore; marked?: boolean; nameHidden?: boolean; capabilities?: Capabilities; load?: CountingLoad } = {}): string {
  const snapshot = options.snapshot === undefined ? withLocators(sampleSnapshot()) : options.snapshot;
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ReadModel;
  const session = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model,
  });
  const state = new TransportStateStore(session);
  state.apply({ cycle: true, click: { enabled: false, gainMilliDb: -12000 } });
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const loopClick = new LoopClickController({
    client: session,
    model,
    state,
    deviceReady: () => true,
    capabilities: () => capabilitySelector(FULL),
    toasts,
    locale: () => 'en',
  });
  const transport = new TransportController({ client: session, playing: () => false, toasts, locale: () => 'en' });
  const layout = createLayoutStore({ storage: null });
  const zones = effectiveLayout(layout.getSnapshot(), { width: 1440, height: 900 }).zones;
  const status = options.status === undefined ? WITH_DEVICE : options.status;
  const load = options.load ?? countingLoad();
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={options.capabilities ?? FULL}>
      <TopBar
        client={session}
        plans={options.plans ?? new PlanStore()}
        zones={zones}
        onToggle={() => undefined}
        onPlans={() => undefined}
        realtime={null}
        engineStatus={{ getSnapshot: () => status, subscribe: () => () => undefined, getLoad: load.getLoad, subscribeLoad: load.subscribeLoad }}
        layout={layout}
        commands={new CommandRegistry()}
        transport={transport}
        loopClick={loopClick}
        history={fixedHistory(options.history ?? { undo: 'yes', redo: 'no' })}
        saved={options.marked === undefined ? undefined : { getSnapshot: () => options.marked === true, subscribe: () => () => undefined }}
        nameHidden={options.nameHidden}
      />
    </CapabilitiesContext.Provider>,
  );
}

// The opening tags in document order, as "tag.class1.class2[data-part]".
function outline(markup: string): string[] {
  return [...markup.matchAll(/<([a-z0-9]+)((?:\s[^>]*)?)>/g)].map(([, tag, attrs]) => {
    const cls = /\sclass="([^"]*)"/.exec(attrs!)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    const part = /\sdata-part="([^"]*)"/.exec(attrs!)?.[1];
    return `${tag}${cls.map((c) => `.${c}`).join('')}${part ? `[${part}]` : ''}`;
  });
}

// The direct children of the first element matching `open` (its tag string), by tag.
function children(markup: string, open: RegExp): string[] {
  const at = markup.search(open);
  assert.ok(at >= 0, `${open} in ${markup}`);
  const out: string[] = [];
  let depth = 0;
  const re = /<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>/g;
  re.lastIndex = at;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const [whole, close, tag] = m;
    const voidTag = /^(input|br|img|meta|link)$/.test(tag!) || whole.endsWith('/>');
    if (close) {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) out.push(outline(whole)[0]!);
    if (!voidTag) depth += 1;
  }
  return out;
}

const HOLD = /^<span class="hold-[a-z-]+"( aria-hidden="true")?><\/span>$/;

test('the top bar has the mockup\'s structure: header.topbar > .tb-left + .transport + .tb-right', () => {
  const markup = render();
  assert.match(markup, /^<header class="topbar" data-region="top-bar" data-testid="top-bar">/);
  assert.deepEqual(children(markup, /<header /), ['div.tb-left', 'div.transport[transport]', 'div.tb-right']);
  // The heading is there for assistive technology, outside the boxes the mockup draws.
  assert.match(markup, /<h1 class="visually-hidden">SIANN<\/h1>/);
  assert.deepEqual(children(markup, /<div class="tb-left">/), [
    'h1.visually-hidden',
    'div.brand[brand]',
    'div.session[session-name]',
    'span.chip[branch-chip]',
    'span.sep',
    'button.iconbtn[undo]',
    'button.iconbtn.dim[redo]',
  ]);
  assert.match(markup, /<div class="brand" data-part="brand"><b><i><\/i><\/b><\/div>/);
  assert.match(markup, /<div class="session" data-part="session-name" data-testid="session-name"[^>]*><span[^>]*>Song<\/span> <svg class="i s" viewBox="0 0 16 16"/);
  assert.deepEqual(children(markup, /<div class="transport" /), ['div.tgroup[transport-buttons]', 'div.lcd[display]', 'div.tgroup[transport-click]']);
  assert.deepEqual(children(markup, /<div class="tgroup" data-part="transport-buttons"/), [
    'button.tbtn[transport-start]',
    'button.tbtn.lit[transport-cycle]',
    'button.tbtn[transport-stop]',
    'button.tbtn.play[transport-play]',
    // Record (m5b-ui-recording) without a record host: the box a .tbtn holds (UI redesign 3.0; 10.11, 19).
    'span.transport-hold.transport-hold-tbtn',
  ]);
  assert.deepEqual(children(markup, /<div class="lcd" /), [
    'div.cell[display-position]',
    'div.cell[display-time]',
    'div.cell[display-locators]',
    'div.cell[display-tempo]',
    'div.cell[display-signature]',
  ]);
  for (const part of ['display-position', 'display-time', 'display-tempo', 'display-signature']) {
    assert.deepEqual(children(markup, new RegExp(`<div class="cell" data-part="${part}"`)).map((c) => c.split('[')[0]), ['span.lbl', part === 'display-position' ? 'span.val' : 'span.val.sm'], part);
  }
  assert.deepEqual(children(markup, /<div class="tgroup" data-testid="transport-click" data-part="transport-click"/), ['button.tbtn[transport-metronome]']);
  assert.deepEqual(children(markup, /<div class="tb-right">/), ['span.dsp[dsp-load]', 'span.zones[zone-buttons]', 'button.aibtn[plans-button]']);
  assert.deepEqual(children(markup, /<span class="zones" /), [
    'span.hold-zone-button-channel',
    'button.iconbtn.on[zone-button-left]',
    'button.iconbtn.on[zone-button-lower]',
    'button.iconbtn.on[zone-button-right]',
  ]);
  // The icons are the mockup's: svg.i in the buttons, svg.i.s by the session name and in the Plans button.
  // undo, redo, start, cycle, stop, play, the metronome, three zone buttons and the Plans button's spark
  assert.equal((markup.match(/<svg class="i" viewBox="0 0 16 16"/g) ?? []).length, 11);
  // the session's chevron and the branch chip's icon (m5b-ui-audition)
  assert.equal((markup.match(/<svg class="i s" viewBox="0 0 16 16"/g) ?? []).length, 2);
  assert.match(markup, /<button[^>]*class="aibtn"[^>]*data-part="plans-button"[^>]*><svg class="i" viewBox="0 0 16 16"/);
  // The old wrappers are gone.
  for (const gone of ['transport-locators', 'position-display"', 'top-bar"', 'zone-buttons"', 'transport-buttons"']) {
    assert.ok(!new RegExp(`class="[^"]*\\b${gone}`).test(markup), gone);
  }
});

test('every hold element is empty, hidden, has no role, no tabindex and no data-part', () => {
  const markup = render();
  const holds = [...markup.matchAll(/<span class="hold-[^"]*"[^>]*>[^<]*<\/span>/g)].map((m) => m[0]);
  assert.deepEqual(holds.map((h) => /class="([^"]+)"/.exec(h)![1]), [
    'hold-zone-button-channel',
  ]);
  for (const hold of holds) {
    assert.match(hold, /aria-hidden="true"/, hold);
    assert.match(hold, HOLD, hold);
    assert.ok(!/\b(role|tabindex|data-part|data-testid|title|aria-label)=/.test(hold), hold);
  }
});

// m5b-ui-signature (UI redesign UR-15, 3.1; mockup.html line 237): the Sig
// cell is the mockup's `.cell` with a `.lbl` over a `.val.sm`, its "/" in an
// <em>, reading the metre the bar maths reads; a readout, not a control.
test('the Sig cell is the mockup\'s markup, reads formatSignature() and is no control', () => {
  const markup = render();
  const open = /<div class="cell" data-part="display-signature"[^>]*>/.exec(markup);
  assert.ok(open, 'the Sig cell is there');
  const tagText = open[0];
  assert.deepEqual(children(markup, /<div class="cell" data-part="display-signature"/), ['span.lbl', 'span.val.sm']);
  const cell = markup.slice(open.index, markup.indexOf('</div>', open.index) + '</div>'.length);
  assert.match(cell, /<span class="lbl" aria-hidden="true">Sig<\/span>/);
  assert.match(cell, /<span class="val sm"[^>]*>4<em>\/<\/em>4<\/span>/);
  // Its text is the module's, so it cannot disagree with the ruler.
  assert.equal(cell.replace(/<[^>]+>/g, '').replace(/^Sig/, ''), formatSignature());
  // Its tooltip is the sentence the position display gave up; its name is the readout's.
  const en = translator('en');
  assert.ok(tagText.includes(`title="${en('transport.fourFour')}"`), tagText);
  assert.ok(tagText.includes(`aria-label="${en('transport.signature')} ${formatSignature()}"`), tagText);
  // Not a control: no role, no focus, no button, no handler.
  assert.ok(!/\b(role|tabindex|onclick|aria-pressed|disabled)=/i.test(cell), cell);
  assert.ok(!cell.includes('<button'), cell);
  // The position display no longer carries the sentence.
  const display = /<div class="lcd"[^>]*>/.exec(markup)![0];
  assert.ok(!display.includes('title='), display);
});

test('the locator cell without locators keeps --display-locators-empty-w and no id; the old wrapper is gone', () => {
  const markup = render({ snapshot: sampleSnapshot() });
  assert.ok(!markup.includes('data-part="display-locators"'));
  assert.deepEqual(children(markup, /<div class="lcd" /), [
    'div.cell[display-position]',
    'div.cell[display-time]',
    'span.cell.display-locators-empty',
    'div.cell[display-tempo]',
    'div.cell[display-signature]',
  ]);
  assert.match(markup, /<span class="cell display-locators-empty" aria-hidden="true"><\/span>/);
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.display-locators-empty\s*\{[^}]*width:\s*var\(--display-locators-empty-w\)/);
  assert.doesNotMatch(css, /\.transport-locators/);
});

// m5b-ui-meter (UR-14; mockup.html line 242): the DSP load is the mockup's
// span.dsp, "DSP", .bar > i and .num, its values written through refs from
// the load channel (no React state: the poll causes no commit, spec 5.6).
const MOCKUP_HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html'), 'utf8');
const WITHOUT_LOAD: Capabilities = { ...FULL, features: { ...FULL.features, load: false } };

test('the DSP load is the mockup\'s markup: span.dsp[dsp-load] > DSP, span.bar > i, span.num', () => {
  // The mockup's own markup, read from mockup.html.
  const mock = /<span class="dsp" \$\{dp\('dsp-load'\)\}>(DSP )<span class="bar"><i><\/i><\/span><span class="num" style="color:var\(--tx-2\)">12%<\/span><\/span>/.exec(MOCKUP_HTML);
  assert.ok(mock, 'mockup.html still draws the DSP load as this port reads it');
  const load = countingLoad();
  const markup = render({ load });
  const open = /<span class="dsp" data-part="dsp-load"[^>]*>/.exec(markup);
  assert.ok(open, markup);
  assert.deepEqual(children(markup, /<span class="dsp" data-part="dsp-load"/), ['span.bar', 'span.num']);
  const span = markup.slice(open.index, markup.indexOf('</span></span>', open.index) + '</span></span>'.length);
  assert.match(span, /^<span class="dsp" data-part="dsp-load"[^>]*>DSP <span class="bar"><i><\/i><\/span><span class="num" style="color:var\(--tx-2\)"><\/span><\/span>$/, span);
  assert.match(open[0], /data-testid="dsp-load"/);
  assert.match(open[0], /role="meter"/);
  assert.match(open[0], /aria-label="DSP load"/);
  // Nothing of the load is read while rendering: the values are written by the binding.
  assert.equal(load.reads, 0);
  assert.equal(load.subscriptions, 0);
});

test('the DSP load binding writes the bar\'s width, the percentage and the peak tooltip on each load notification', () => {
  const load = countingLoad();
  const bar = { style: { width: '' } };
  const num = { textContent: null as string | null };
  const attrs = new Map<string, string>();
  const root = { title: '', setAttribute: (name: string, value: string) => void attrs.set(name, value) };
  const t = translator('en');
  const off = bindDspLoad(load, { root, bar, num }, (percent) => t('topbar.dspPeak', { percent }));
  assert.equal(load.subscriptions, 1);
  // No load yet: an empty bar at 0 %.
  assert.deepEqual([bar.style.width, num.textContent, root.title], ['0%', '0%', '']);
  load.set({ average: 0.123, peak: 0.31 });
  assert.deepEqual([bar.style.width, num.textContent], ['12.3%', '12%']);
  assert.equal(root.title, t('topbar.dspPeak', { percent: '31%' }));
  assert.equal(attrs.get('aria-valuenow'), '12');
  // Past the deadline: the text says so, the bar stops at its end.
  load.set({ average: 1.4, peak: 2.5 });
  assert.deepEqual([bar.style.width, num.textContent], ['100%', '140%']);
  assert.equal(root.title, t('topbar.dspPeak', { percent: '250%' }));
  off();
  assert.equal(load.listeners.size, 0);
  load.set({ average: 0.5, peak: 0.5 });
  assert.equal(num.textContent, '140%', 'nothing is written after unbinding');
  // The tooltip names the peak in every catalog.
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) assert.ok(translator(locale)('topbar.dspPeak', { percent: '31%' }).includes('31%'), locale);
});

test('without features.load the DSP load is absent and its box is an empty span.dsp-load-empty', () => {
  const markup = render({ capabilities: WITHOUT_LOAD });
  assert.ok(!markup.includes('data-part="dsp-load"'), 'no dsp-load id');
  assert.ok(!markup.includes('class="dsp"'), 'no .dsp');
  assert.deepEqual(children(markup, /<div class="tb-right">/), ['span.dsp-load-empty', 'span.zones[zone-buttons]', 'button.aibtn[plans-button]']);
  assert.match(markup, /<span class="dsp-load-empty" aria-hidden="true"><\/span>/);
  const box = /<span class="dsp-load-empty"[^>]*>/.exec(markup)![0];
  assert.ok(!/\b(role|tabindex|data-part|data-testid|title|aria-label)=/.test(box), box);
  // Without engine.status there is no load either.
  const noStatus = render({ capabilities: { ...FULL, methods: (FULL.methods ?? []).filter((m) => m !== 'engine.status') } });
  assert.ok(!noStatus.includes('data-part="dsp-load"'));
  assert.match(noStatus, /<span class="dsp-load-empty" aria-hidden="true"><\/span>/);
});

test('undo is lit and redo dim from the undo history; both lit while it is unknown', () => {
  const tagOf = (markup: string, part: string) => new RegExp(`<button[^>]*data-part="${part}"[^>]*>`).exec(markup)![0];
  const after = render({ history: { undo: 'yes', redo: 'no' } });
  assert.match(tagOf(after, 'undo'), /class="iconbtn"/);
  assert.match(tagOf(after, 'redo'), /class="iconbtn dim"/);
  const unknown = render({ history: { undo: 'unknown', redo: 'unknown' } });
  assert.match(tagOf(unknown, 'undo'), /class="iconbtn"/);
  assert.match(tagOf(unknown, 'redo'), /class="iconbtn"/);
  const undone = render({ history: { undo: 'no', redo: 'yes' } });
  assert.match(tagOf(undone, 'undo'), /class="iconbtn dim"/);
  assert.match(tagOf(undone, 'redo'), /class="iconbtn"/);
});

test('the display digits keep the mockup\'s separators in <em>: the time has none around its colons', async () => {
  const { lcdPieces } = await import('../../src/renderer/shell/Transport');
  assert.deepEqual(lcdPieces('10.3.000'), ['10', '.', '3', '.', '000']);
  assert.deepEqual(lcdPieces('00:00:19.000'), ['00:00:19', '.', '000']);
  assert.deepEqual(lcdPieces('120.00'), ['120', '.', '00']);
  assert.deepEqual(lcdPieces('9.1 – 13.1'), ['9', '.', '1 ', '–', ' 13', '.', '1']);
});

// The undo history: what session.changed says of the head (its cause).
test('UndoHistory follows the causes of session.changed and forgets on a new connection', () => {
  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  const stateListeners: Array<() => void> = [];
  let connections = 1;
  const client = {
    onEvent: (type: string, listener: (event: Record<string, unknown>) => void) => {
      assert.equal(type, 'session.changed');
      listeners.push(listener);
      return () => undefined;
    },
    subscribe: (listener: () => void) => {
      stateListeners.push(listener);
      return () => undefined;
    },
    getState: () => ({ connections, sessionId: 'ses_1' }),
  };
  const history = new UndoHistory(client as never);
  const emit = (cause: string) => listeners.forEach((l) => l({ type: 'session.changed', cause }));
  assert.deepEqual(history.getSnapshot(), { undo: 'unknown', redo: 'unknown' });
  emit('command');
  assert.deepEqual(history.getSnapshot(), { undo: 'yes', redo: 'no' });
  emit('undo');
  assert.deepEqual(history.getSnapshot(), { undo: 'unknown', redo: 'yes' });
  emit('redo');
  assert.deepEqual(history.getSnapshot(), { undo: 'yes', redo: 'unknown' });
  emit('plan');
  assert.deepEqual(history.getSnapshot(), { undo: 'yes', redo: 'no' });
  history.refused('session.undo');
  assert.deepEqual(history.getSnapshot(), { undo: 'no', redo: 'no' });
  connections = 2;
  stateListeners.forEach((l) => l());
  assert.deepEqual(history.getSnapshot(), { undo: 'unknown', redo: 'unknown' });
});

// ---- m5b-ui-audition (UI redesign 4.3, 2.4; mockup.html line 224): the branch
// chip, span.chip[branch-chip] > the branch icon, a span and span.num, reads
// `main r<head>` while main is heard and the plan's name (plans/plan-name.ts,
// as the banner names it) while its branch is heard, ellipsised with the
// whole name in its title. The Hold that kept its box is gone.

function chipOf(markup: string): Element {
  const at = markup.indexOf('<span class="chip"');
  assert.ok(at >= 0, 'the chip is there');
  return find(parse(markup.slice(at, markup.indexOf('<span class="sep"', at))), byAttr('data-part', 'branch-chip'));
}

function storeHearing(heard: string | null): PlanStore {
  const store = new PlanStore({ now: () => 0 });
  store.fromList({ plans: [planObject(hashOf('1'), 'validated', MIX_STEPS), planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH })] });
  store.setHeard(heard);
  return store;
}

test('the branch chip has the mockup\'s markup and reads main r<head> while main is heard', () => {
  const mock = find(parse(loadMockup('en').branchChip), byAttr('data-part', 'branch-chip'));
  for (const heard of ['main', null]) {
    const app = chipOf(render({ snapshot: planSnapshot(), plans: storeHearing(heard) }));
    assert.equal(sig(app), sig(mock));
    assert.equal(app.attrs['data-part'], 'branch-chip');
    assert.deepEqual(elements(app).map(sig), elements(mock).map(sig));
    assert.equal(elements(app)[0]!.attrs.class, elements(mock)[0]!.attrs.class, 'the small branch icon');
    assert.equal(elements(app)[2]!.attrs.style?.replace(/\s/g, ''), elements(mock)[2]!.attrs.style?.replace(/\s/g, ''));
    assert.equal(text(elements(app)[1]!), 'main');
    assert.equal(text(elements(app)[2]!), planSnapshot().revision);
  }
  assert.ok(!render().includes('hold-branch-chip'), 'no hold');
});

test('while a branch is heard the chip names its plan as the banner does, the whole name in its title', () => {
  const t = translator('en');
  const store = storeHearing(BRANCH);
  const names = namesFromSnapshot(planSnapshot());
  const name = planName(store.getSnapshot().byHash.get(hashOf('2'))!, t, names, capabilitySelector(FULL));
  assert.equal(name.kind, 'steps', 'an untitled plan');
  const whole = name.kind === 'steps' ? t('chip.proposal', { lead: name.lead, steps: name.steps }) : '';
  const app = chipOf(render({ snapshot: planSnapshot(), plans: store }));
  assert.equal(app.attrs['data-part'], 'branch-chip');
  assert.deepEqual(elements(app).map(sig), ['svg.i.s', 'span']);
  assert.equal(text(elements(app)[1]!), whole);
  assert.equal(app.attrs.title, whole);
  // A branch no held plan owns: the generic word.
  const generic = chipOf(render({ snapshot: planSnapshot(), plans: storeHearing('p9') }));
  assert.equal(text(elements(generic)[1]!), t('chip.generic'));
  assert.ok(!new RegExp(`\\b(${BRANCH}|p9)\\b`).test(text(generic) + text(app)), 'no branch id');
  // A titled plan (m5b-ui-plan-metadata, features.planMetadata): its title.
  const titled = new PlanStore({ now: () => 0 });
  titled.fromList({ plans: [planObject(hashOf('2'), 'approved', MIX_STEPS, { proposalBranch: BRANCH, title: 'Lift the chorus' })] });
  titled.setHeard(BRANCH);
  const chip = chipOf(render({ snapshot: planSnapshot(), plans: titled }));
  assert.equal(text(elements(chip)[1]!), 'Lift the chorus');
  assert.equal(chip.attrs.title, 'Lift the chorus');
});

// Before the first snapshot nothing is held (UI redesign 3.0; 10.11, 15): the
// window has no document yet, so the session name is empty and the chip is
// not rendered, with no box in its place. Every snapshot has a revision, so
// from the first one on the chip is always there.
test('before the first snapshot the session name is empty and the chip is absent with no box; any snapshot brings the chip', () => {
  const markup = render({ snapshot: null });
  assert.ok(!markup.includes('data-part="branch-chip"'));
  assert.ok(!markup.includes('hold-branch-chip'));
  assert.ok(!markup.includes('branch-chip-empty'), 'no empty box');
  // The left group is the mockup's without the chip: nothing stands in for it.
  assert.deepEqual(children(markup, /<div class="tb-left">/).slice(1), ['div.brand[brand]', 'div.session[session-name]', 'span.sep', 'button.iconbtn[undo]', 'button.iconbtn.dim[redo]']);
  // The session name is empty in the same state, and was never held.
  const session = find(parse(markup), byAttr('data-part', 'session-name'));
  assert.equal(text(session), '');
  assert.equal(session.attrs.title, '');
  // With a snapshot both are there: the name and main's head.
  for (const snapshot of [planSnapshot(), sampleSnapshot()]) {
    const withDocument = render({ snapshot });
    assert.equal(text(elements(chipOf(withDocument))[2]!), snapshot.revision);
    assert.equal(text(find(parse(withDocument), byAttr('data-part', 'session-name'))), snapshot.root?.name);
  }
});

// m5b-ui-project (UI redesign UR-4): the session's name with the saved mark,
// a bullet after the name inside the same .session part (no new element), and
// no name over the start view's scratch bundle.
test('the session name carries the saved mark while the head is newer than the last save, and none over the start view', () => {
  const t = translator('en');
  const clean = render({ marked: false });
  assert.match(clean, /<div class="session" data-part="session-name" data-testid="session-name" title="Song"><span[^>]*>Song<\/span> <svg/);
  const marked = render({ marked: true });
  const session = /<div class="session"[^>]*>[\s\S]*?<\/div>/.exec(marked)![0];
  assert.match(session, /data-unsaved="true"/);
  assert.ok(session.includes(`title="${t('session.unsavedTitle', { name: 'Song' })}"`), session);
  assert.match(session, /<span[^>]*>Song<\/span>(<!-- -->)? •(<!-- -->)? <svg/, session);
  // The structure stays the mockup's: the name's span and the chevron, nothing more.
  assert.deepEqual(children(marked, /<div class="session"/), ['span', 'svg.i.s']);
  assert.equal(t('session.unsavedMark'), '•');
  const hidden = render({ nameHidden: true, marked: true });
  assert.match(hidden, /<div class="session" data-part="session-name" data-testid="session-name" title=""><span[^>]*><\/span> <svg/);
});
