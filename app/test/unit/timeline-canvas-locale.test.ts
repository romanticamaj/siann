// The timeline canvas words its ruler through the locale it is given and
// redraws when that locale changes (m5-ui-i18n; UI redesign spec 6.2: "the
// canvas surfaces take the same function and redraw on a locale change").
// The canvas runs on a recording 2D context and a hand-driven animation-frame
// queue: no DOM, no timers. Expected labels come from the catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLocaleStore } from '../../src/renderer/i18n/locale';
import { translator } from '../../src/renderer/i18n/t';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { ReadModel } from '../../src/renderer/model/read-model';
import { TimelineCanvas } from '../../src/renderer/timeline/TimelineCanvas';
import { sampleSnapshot } from './support/timeline';

// One queue of animation-frame callbacks, run by flush().
const frames = new Map<number, () => void>();
let nextFrame = 1;
const g = globalThis as unknown as Record<string, unknown>;
g.requestAnimationFrame = (fn: () => void) => {
  const id = nextFrame++;
  frames.set(id, fn);
  return id;
};
g.cancelAnimationFrame = (id: number) => frames.delete(id);

function flush(): number {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn();
  return pending.length;
}

// A canvas whose 2D context records the text drawn into it.
function recordingCanvas(): { canvas: HTMLCanvasElement; texts: string[] } {
  const texts: string[] = [];
  const ctx = new Proxy(
    { fillText: (text: string) => texts.push(text) },
    { get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : () => undefined), set: () => true },
  );
  const canvas = {
    clientWidth: 800,
    width: 0,
    height: 0,
    style: { height: '' },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, texts };
}

test('the ruler is worded in the given locale and redraws on a locale change', () => {
  frames.clear();
  const snapshot = sampleSnapshot();
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ReadModel;
  const peaks = { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache;
  const store = createLocaleStore({ languages: ['zh-TW'], storage: null });
  const { canvas, texts } = recordingCanvas();
  const timeline = new TimelineCanvas({
    canvas,
    model,
    peaks,
    execute: async () => undefined,
    locale: { t: () => translator(store.getSnapshot()), subscribe: (listener) => store.subscribe(listener) },
  });

  assert.equal(flush(), 1, 'the first frame');
  const zero = (locale: 'en' | 'zh-Hant' | 'zh-Hans') => translator(locale)('timeline.seconds', { value: '0' });
  assert.ok(texts.includes(zero('zh-Hant')), `zh-Hant ruler: ${texts.join(' | ')}`);
  assert.ok(!texts.includes(zero('en')), 'no English ruler label');
  // The test hook reads the labels of the last frame.
  assert.deepEqual(timeline.testHooks().rulerLabels()[0], zero('zh-Hant'));

  texts.length = 0;
  store.setLocale('en');
  assert.equal(flush(), 1, 'a locale change schedules one redraw');
  assert.ok(texts.includes(zero('en')), `en ruler: ${texts.join(' | ')}`);
  assert.ok(texts.every((text) => !/\p{Script=Han}/u.test(text)), `no Chinese after the switch: ${texts.join(' | ')}`);
  assert.equal(timeline.testHooks().rulerLabels()[0], zero('en'));

  // Track names are the user's and are the same in every locale.
  assert.ok(texts.includes('trk_a') && texts.includes('trk_b'));

  timeline.destroy();
  store.setLocale('zh-Hans');
  assert.equal(flush(), 0, 'no redraw after destroy');
});

test('without a locale the ruler is English', () => {
  frames.clear();
  const snapshot = sampleSnapshot();
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ReadModel;
  const peaks = { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache;
  const { canvas, texts } = recordingCanvas();
  const timeline = new TimelineCanvas({ canvas, model, peaks, execute: async () => undefined });
  flush();
  assert.ok(texts.includes(translator('en')('timeline.seconds', { value: '0' })), texts.join(' | '));
  timeline.destroy();
});
