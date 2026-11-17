// The event display ported from the mockup (m5-ui-port-arrange-canvas;
// mockup.html lines 281-287; docs/harness/agent-rules.md, "UI fidelity"): the
// DOM structure, class names and ids are the mockup's, so ui/project-zone.css
// lays it out.
//
//   div.arr-body[arrange]
//     the track list (not ported here: m5-ui-port-track-list), its divider
//     div.lanes[event-display]
//       canvas#tl                  draw()'s surface (the content layer)
//       div.hscroll[scroll-zoom]   i (the scroll thumb), u (the zoom)
//
// Extras the mockup does not have, allowed as extras only: the overlay canvas
// (the second layer of UI redesign 5.2), the drag tooltip, and the zoom's
// range input inside u. The track list gains the empty marker row (UI
// redesign 3.0): no role, not focusable, hidden, no data-part, no text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Timeline, zoomAt, zoomValue } from '../../src/renderer/timeline/Timeline';
import { MAX_FRAMES_PER_PIXEL } from '../../src/renderer/timeline/zoom';
import { sampleSnapshot } from './support/timeline';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const MOCKUP = fs.readFileSync(path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html'), 'utf8');

function fakeClient(): SessionClient {
  const snapshot = sampleSnapshot();
  const model = {
    getSnapshot: () => snapshot,
    getView: () => ({ snapshot, gesture: null, overlaid: null }),
    select: (ref: string) => snapshot.entities[ref],
    subscribe: () => () => undefined,
  };
  return {
    model,
    execute: async () => undefined,
    request: async () => undefined,
    subscribe: () => () => undefined,
    getState: () => ({ sessionId: 'ses_test' }),
  } as unknown as SessionClient;
}

function render(): string {
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <Timeline client={fakeClient()} peaks={{ get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache} commands={new CommandRegistry()} />
    </CapabilitiesContext.Provider>,
  );
}

// An opening tag as "tag#id.class1.class2[data-part]".
function tagOf(whole: string): string {
  const [, tag, attrs] = /^<([a-z0-9]+)((?:\s[^>]*)?)\/?>$/.exec(whole)!;
  const id = /\sid="([^"]*)"/.exec(attrs!)?.[1];
  const cls = /\sclass="([^"]*)"/.exec(attrs!)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const part = /\sdata-part="([^"]*)"/.exec(attrs!)?.[1];
  return `${tag}${id ? `#${id}` : ''}${cls.map((c) => `.${c}`).join('')}${part ? `[${part}]` : ''}`;
}

// The element starting at the first match of `open`, as its markup.
function element(markup: string, open: RegExp): string {
  const at = markup.search(open);
  assert.ok(at >= 0, `${open} in ${markup.slice(0, 400)}`);
  let depth = 0;
  const re = /<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>/g;
  re.lastIndex = at;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const voidTag = /^(input|br|img|meta|link)$/.test(m[2]!) || m[0].endsWith('/>');
    if (m[1]) {
      depth -= 1;
      if (depth === 0) return markup.slice(at, m.index + m[0].length);
    } else if (!voidTag) depth += 1;
  }
  throw new Error(`unclosed ${open}`);
}

// The direct children of an element's markup, as tag strings.
function children(markup: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const m of markup.matchAll(/<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>/g)) {
    const voidTag = /^(input|br|img|meta|link)$/.test(m[2]!) || m[0].endsWith('/>');
    if (m[1]) {
      depth -= 1;
      continue;
    }
    if (depth === 1) out.push(tagOf(m[0]));
    if (!voidTag) depth += 1;
  }
  return out;
}

// The mockup's event display, from the app.innerHTML template.
const MOCKUP_LANES = (() => {
  const line = MOCKUP.split('\n').find((l) => l.includes('class="lanes"'))!;
  const html = line.trim().replace(/\$\{dp\('([a-z0-9-]+)'\)\}/g, 'data-part="$1"');
  return element(html, /<div class="lanes"/);
})();

test('the event display is the mockup\'s: .lanes holding canvas#tl first and .hscroll with i and u', () => {
  const markup = render();
  const lanes = element(markup, /<div class="lanes"/);
  assert.match(lanes, /^<div class="lanes" data-testid="event-display" data-part="event-display"[^>]*>/);
  const mockup = children(MOCKUP_LANES);
  // The mockup draws: <canvas id="tl"> and <div class="hscroll" data-part="scroll-zoom"><i></i><u></u></div>.
  assert.deepEqual(mockup, ['canvas#tl', 'div.hscroll[scroll-zoom]']);
  const app = children(lanes);
  const extras = ['canvas.timeline-layer.timeline-overlay', 'div.drag-tooltip'];
  assert.deepEqual(app.filter((tag) => !extras.includes(tag)), mockup, 'the mockup\'s children in its order');
  assert.deepEqual(app.filter((tag) => extras.includes(tag)), extras, 'the two extras');
  assert.equal(app[0], 'canvas#tl', 'the content canvas first');
  assert.match(lanes, /<canvas id="tl" data-testid="timeline-content"><\/canvas>/);
  assert.match(lanes, /<canvas class="timeline-layer timeline-overlay" data-testid="timeline-canvas"><\/canvas>/);
  // .hscroll: i then u, as the mockup's (the range input, when the surface is up, sits inside u).
  const hscroll = element(lanes, /<div class="hscroll"/);
  assert.deepEqual(children(hscroll).map((tag) => tag.split('[')[0]), children(element(MOCKUP_LANES, /<div class="hscroll"/)));
  assert.deepEqual(children(hscroll), ['i', 'u']);
  // The old classes are gone.
  assert.doesNotMatch(markup, /class="[^"]*\b(event-display|arrange|zoom-slider)\b/);
});

test('the arrange body is .arr-body[arrange] with the track list, its divider and the event display', () => {
  const markup = render();
  const body = element(markup, /<div class="arr-body"/);
  assert.match(body, /^<div class="arr-body" data-part="arrange" style="grid-template-columns:[^"]*var\(--divider-w\) minmax\(0, 1fr\)"/);
  const kids = children(body);
  assert.equal(kids.length, 3);
  assert.equal(kids[0], 'div.track-list[track-list]');
  assert.equal(kids[2], 'div.lanes[event-display]');
});

test('the track list has one empty, hidden element in the marker row, between its head and its body', () => {
  const list = element(render(), /<div class="track-list"/);
  const kids = children(list);
  assert.deepEqual(kids, ['div.track-list-head[track-list-head]', 'div', 'div.track-list-body']);
  // The marker row: no role, not focusable, hidden from assistive technology, no part id, no text, no class.
  const row = [...list.matchAll(/<div aria-hidden="true"><\/div>/g)];
  assert.equal(row.length, 1, 'one empty element');
  const at = list.indexOf(row[0]![0]);
  assert.ok(at > list.indexOf('track-list-head') && at < list.indexOf('track-list-body'));
  assert.doesNotMatch(row[0]![0], /role=|tabindex=|data-part|class=/);
});

// The zoom's visible handle is the mockup's u::after; the range input's thumb
// is transparent, so the handle has to follow the value (shell.css places it
// from --zoom-at on u). Review finding: it sat at the mockup's 40 % whatever
// the zoom.
test('the zoom handle follows the zoom: --zoom-at on u is the slider value as a fraction', () => {
  assert.equal(zoomAt(MAX_FRAMES_PER_PIXEL), 0, 'all the way out: the left end');
  assert.equal(zoomAt(1), 1, 'one frame per pixel: the right end');
  assert.equal(zoomAt(2 ** 10), 0.5, 'half the octaves');
  assert.ok(zoomAt(256) > zoomAt(512), 'zooming in moves the handle right');
  assert.equal(zoomValue(2 ** 10), 10);
  assert.equal(zoomAt(0), 1, 'clamped');
  assert.equal(zoomAt(2 ** 30), 0, 'clamped');
  const u = element(element(render(), /<div class="hscroll"/), /<u/);
  assert.match(u, /^<u style="--zoom-at:[0-9.]+">/);
  const css = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.hscroll u::after \{ left: calc\(100% \* var\(--zoom-at\) - var\(--zoom-handle\) \/ 2\);[^}]*\}/, 'shell.css places the handle from --zoom-at');
  // The handle is drawn over the input: a press on it must reach the input.
  assert.match(css, /\.hscroll u::after \{[^}]*pointer-events: none;[^}]*\}/, 'the handle lets the press through to the input');
});
