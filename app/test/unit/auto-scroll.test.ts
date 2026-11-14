// Auto-scroll in page mode (m5-ui-transport; UI redesign spec 3.1: Cubase's
// F, page mode, suspended while editing): the decision alone, pure. Given the
// view, the project cursor's frame and whether it is playing, auto-scroll is
// on and a drag is held, it answers the view's next scrollFrames, or null to
// leave the view where it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextScroll, type AutoScrollInput } from '../../src/renderer/timeline/auto-scroll';

// 800 px at 100 frames per px: the view shows frames [480000, 560000).
const VIEW = { scrollFrames: '480000', framesPerPixel: 100, width: 800 } as const;

function input(over: Partial<AutoScrollInput>): AutoScrollInput {
  return { view: VIEW, cursor: '500000', playing: true, enabled: true, dragging: false, ...over };
}

test('nothing moves while the cursor is in view', () => {
  assert.equal(nextScroll(input({})), null);
  assert.equal(nextScroll(input({ cursor: '480000' })), null, 'the left edge');
  assert.equal(nextScroll(input({ cursor: '559999' })), null, 'just inside the right edge');
});

test('a page forward when the cursor passes the right edge: the cursor lands at the left edge', () => {
  assert.equal(nextScroll(input({ cursor: '560000' })), '560000');
  assert.equal(nextScroll(input({ cursor: '560450' })), '560450');
  // A cursor far beyond (a locate while playing) is paged to as well.
  assert.equal(nextScroll(input({ cursor: '9600000' })), '9600000');
  // BigInt-safe: positions beyond 2^53.
  const far = (2n ** 60n).toString();
  assert.equal(nextScroll(input({ view: { ...VIEW, scrollFrames: '0' }, cursor: far })), far);
});

test('a cursor left of the view gets a page that contains it', () => {
  const next = nextScroll(input({ cursor: '100000' }));
  assert.notEqual(next, null);
  const scroll = BigInt(next!);
  const width = BigInt(VIEW.width * VIEW.framesPerPixel);
  assert.ok(scroll <= 100000n && 100000n < scroll + width, `page at ${next} holds the cursor`);
  assert.ok(scroll >= 0n);
  // Back to the start (Num . while playing): the page at 0.
  assert.equal(nextScroll(input({ cursor: '0' })), '0');
});

test('nothing moves when stopped, when auto-scroll is off, while a drag is held, or without a cursor', () => {
  for (const over of [{ playing: false }, { enabled: false }, { dragging: true }, { cursor: null }] as const) {
    assert.equal(nextScroll(input({ ...over, cursor: 'cursor' in over ? over.cursor : '600000' })), null, JSON.stringify(over));
  }
});
