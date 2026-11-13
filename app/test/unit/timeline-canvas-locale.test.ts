// The timeline canvas and the locale (m5-ui-i18n, m5-ui-arrange; UI redesign
// spec 6.2: "the canvas surfaces take the same function and redraw on a
// locale change"; bar.beat.tick positions "are the same in all three
// locales"). The ruler is bars and beats, byte-identical in every locale; the
// one sentence the canvas words itself is the empty session's guidance, which
// follows the locale store and redraws when it changes. Runs on fake
// canvases and a hand-driven animation-frame queue (support/surface.ts).
// Expected text comes from the catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLocaleStore } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { ReadModel, Snapshot } from '../../src/renderer/model/read-model';
import { TimelineCanvas } from '../../src/renderer/timeline/TimelineCanvas';
import { clearFrames, fakeSurface, flushFrames, installSurfaceGlobals, setDevicePixelRatio } from './support/surface';
import { sampleSnapshot, snapshotOf } from './support/timeline';

installSurfaceGlobals();

const peaks = { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache;

function canvasFor(snapshot: Snapshot, locale?: ReturnType<typeof createLocaleStore>) {
  clearFrames();
  setDevicePixelRatio(1);
  const surface = fakeSurface(800, 300);
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ReadModel;
  const timeline = new TimelineCanvas({
    content: surface.content,
    overlay: surface.overlay,
    container: surface.container,
    model,
    peaks,
    execute: async () => undefined,
    locale: locale ? { t: () => translator(locale.getSnapshot()), subscribe: (listener) => locale.subscribe(listener) } : undefined,
  });
  return { surface, timeline };
}

test('the ruler is bars and beats, the same in every locale', () => {
  const labels: string[][] = [];
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const store = createLocaleStore({ languages: [language], storage: null });
    const { timeline } = canvasFor(sampleSnapshot(), store);
    flushFrames();
    labels.push(timeline.testHooks().rulerLabels());
    timeline.destroy();
  }
  assert.ok(labels[0]!.length > 0);
  assert.equal(labels[0]![0], '1', 'bar 1 at the start');
  assert.ok(labels[0]!.every((label) => /^\d+(\.\d+(\.\d+)?)?$/.test(label)), labels[0]!.join(' '));
  assert.deepEqual(labels[1], labels[0]);
  assert.deepEqual(labels[2], labels[0]);
});

test('the empty session guidance is worded in the given locale and redraws on a locale change', () => {
  const store = createLocaleStore({ languages: ['zh-TW'], storage: null });
  const { surface, timeline } = canvasFor(snapshotOf([], [], [], []), store);
  const texts = surface.contentCalls.texts;
  assert.ok(flushFrames() >= 1, 'the first frame');
  const guidance = (locale: 'en' | 'zh-Hant' | 'zh-Hans') => translator(locale)('timeline.empty');
  assert.ok(texts.includes(guidance('zh-Hant')), `zh-Hant: ${texts.join(' | ')}`);
  assert.ok(!texts.includes(guidance('en')), 'no English guidance');
  assert.equal(timeline.testHooks().guidance(), guidance('zh-Hant'));

  surface.contentCalls.clear();
  store.setLocale('en');
  assert.ok(flushFrames() >= 1, 'a locale change schedules a redraw');
  assert.ok(texts.includes(guidance('en')), `en: ${texts.join(' | ')}`);
  assert.ok(texts.every((text) => !/\p{Script=Han}/u.test(text)), `no Chinese after the switch: ${texts.join(' | ')}`);
  assert.equal(timeline.testHooks().guidance(), guidance('en'));

  timeline.destroy();
  store.setLocale('zh-Hans');
  assert.equal(flushFrames(), 0, 'no redraw after destroy');
});

test('without a locale the guidance is English; a session with tracks shows none', () => {
  const empty = canvasFor(snapshotOf([], [], [], []));
  flushFrames();
  assert.equal(empty.timeline.testHooks().guidance(), translator('en')('timeline.empty'));
  empty.timeline.destroy();
  const full = canvasFor(sampleSnapshot());
  flushFrames();
  assert.equal(full.timeline.testHooks().guidance(), null);
  // Track names are the track list's (DOM), not the canvas's.
  assert.ok(!full.surface.contentCalls.texts.includes('trk_a'));
  full.timeline.destroy();
});
