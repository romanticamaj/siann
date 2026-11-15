// The top bar ported from the mockup (m5-ui-alignment-chrome; mockup.html
// lines 220-246; docs/harness/agent-rules.md, "UI fidelity"): the DOM
// structure and class names are the mockup's, so ui/top-bar.css draws it.
//
//   header.topbar
//     .tb-left   .brand>b>i, .session (name + chevron), the branch chip's
//                hold, .sep, .iconbtn undo, .iconbtn redo (.dim when nothing
//                is left to redo)
//     .transport .tgroup (start, cycle, stop, .play, the Record hold),
//                one .lcd (.cell position, time, locators, tempo, the
//                signature's hold last), .tgroup with the metronome
//     .tb-right  the DSP load's hold, .zones (the Channel button's hold and
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
import { parseEngineStatus, type EngineStatus } from '../../src/renderer/model/engine-status';
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

function fixedHistory(value: UndoAvailability): Pick<UndoHistory, 'getSnapshot' | 'subscribe'> {
  return { getSnapshot: () => value, subscribe: () => () => undefined };
}

function render(options: { snapshot?: Snapshot | null; history?: UndoAvailability; status?: EngineStatus | null } = {}): string {
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
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <TopBar
        client={session}
        plans={new PlanStore()}
        zones={zones}
        onToggle={() => undefined}
        onPlans={() => undefined}
        realtime={null}
        engineStatus={{ getSnapshot: () => status, subscribe: () => () => undefined }}
        layout={layout}
        commands={new CommandRegistry()}
        transport={transport}
        loopClick={loopClick}
        history={fixedHistory(options.history ?? { undo: 'yes', redo: 'no' })}
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
    const voidTag = /^(input|br|img|path|rect|circle)$/.test(tag!) || whole.endsWith('/>');
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
    'span.hold-branch-chip',
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
    'span.hold-transport-record',
  ]);
  assert.deepEqual(children(markup, /<div class="lcd" /), [
    'div.cell[display-position]',
    'div.cell[display-time]',
    'div.cell[display-locators]',
    'div.cell[display-tempo]',
    'span.hold-display-signature',
  ]);
  for (const part of ['display-position', 'display-time', 'display-tempo']) {
    assert.deepEqual(children(markup, new RegExp(`<div class="cell" data-part="${part}"`)).map((c) => c.split('[')[0]), ['span.lbl', part === 'display-position' ? 'span.val' : 'span.val.sm'], part);
  }
  assert.deepEqual(children(markup, /<div class="tgroup" data-part="transport-click"/), ['button.tbtn[transport-metronome]']);
  assert.deepEqual(children(markup, /<div class="tb-right">/), ['span.hold-dsp-load', 'span.zones[zone-buttons]', 'button.aibtn[plans-button]']);
  assert.deepEqual(children(markup, /<span class="zones" /), [
    'span.hold-zone-button-channel',
    'button.iconbtn.on[zone-button-left]',
    'button.iconbtn.on[zone-button-lower]',
    'button.iconbtn.on[zone-button-right]',
  ]);
  // The icons are the mockup's: svg.i in the buttons, svg.i.s by the session name and in the Plans button.
  // undo, redo, start, cycle, stop, play, the metronome and three zone buttons
  assert.equal((markup.match(/<svg class="i" viewBox="0 0 16 16"/g) ?? []).length, 10);
  // the session's chevron and the Plans button's spark
  assert.equal((markup.match(/<svg class="i s" viewBox="0 0 16 16"/g) ?? []).length, 2);
  assert.match(markup, /<button[^>]*class="aibtn"[^>]*data-part="plans-button"[^>]*><svg class="i s" viewBox="0 0 16 16"/);
  // The old wrappers are gone.
  for (const gone of ['transport-locators', 'position-display"', 'top-bar"', 'zone-buttons"', 'transport-buttons"']) {
    assert.ok(!new RegExp(`class="[^"]*\\b${gone}`).test(markup), gone);
  }
});

test('every hold element is empty, hidden, has no role, no tabindex and no data-part', () => {
  const markup = render();
  const holds = [...markup.matchAll(/<span class="hold-[^"]*"[^>]*>[^<]*<\/span>/g)].map((m) => m[0]);
  assert.deepEqual(holds.map((h) => /class="([^"]+)"/.exec(h)![1]), [
    'hold-branch-chip',
    'hold-transport-record',
    'hold-display-signature',
    'hold-dsp-load',
    'hold-zone-button-channel',
  ]);
  for (const hold of holds) {
    assert.match(hold, /aria-hidden="true"/, hold);
    assert.match(hold, HOLD, hold);
    assert.ok(!/\b(role|tabindex|data-part|data-testid|title|aria-label)=/.test(hold), hold);
  }
});

test('the locator cell without locators keeps --display-locators-empty-w and no id; the old wrapper is gone', () => {
  const markup = render({ snapshot: sampleSnapshot() });
  assert.ok(!markup.includes('data-part="display-locators"'));
  assert.deepEqual(children(markup, /<div class="lcd" /), [
    'div.cell[display-position]',
    'div.cell[display-time]',
    'span.cell.display-locators-empty',
    'div.cell[display-tempo]',
    'span.hold-display-signature',
  ]);
  assert.match(markup, /<span class="cell display-locators-empty" aria-hidden="true"><\/span>/);
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.display-locators-empty\s*\{[^}]*width:\s*var\(--display-locators-empty-w\)/);
  assert.doesNotMatch(css, /\.transport-locators/);
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
