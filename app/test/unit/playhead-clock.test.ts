// The project cursor's clock (m5-ui-transport; UI redesign spec 5.3,
// protocol-events-v1.md "the UI interpolates"): the realtime channel ticks
// slower than the display, so while playing the cursor and the position
// display extrapolate from the newest frame by the time since it arrived, at
// the session's sample rate, never more than a bounded lead past it (a stop
// or a locate then never shows far beyond what the engine reached). Stopped,
// the position is the frame's. Pure; the clock is injected, no sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_LEAD_MS, PlayheadClock } from '../../src/renderer/transport/playhead-clock';

const RATE = 48000;

function frame(playheadSamples: string, playing: boolean) {
  return { playheadSamples, playing };
}

function clockAt(start: number) {
  let now = start;
  const clock = new PlayheadClock({ now: () => now });
  return { clock, set: (ms: number) => void (now = ms) };
}

test('no frame yet, or none after a disconnect: no position', () => {
  const { clock } = clockAt(1000);
  assert.equal(clock.position(RATE), null);
  assert.equal(clock.playing(), false);
  clock.observe(frame('480', false));
  assert.equal(clock.position(RATE), '480');
  clock.observe(null);
  assert.equal(clock.position(RATE), null);
  assert.equal(clock.playing(), false);
});

test("stopped: the frame's position, however long ago it came", () => {
  const { clock, set } = clockAt(1000);
  clock.observe(frame('192000', false));
  assert.equal(clock.position(RATE), '192000');
  set(6000);
  assert.equal(clock.position(RATE), '192000');
  assert.equal(clock.playing(), false);
});

test('playing: extrapolates by the time since the frame arrived, at the sample rate', () => {
  const { clock, set } = clockAt(1000);
  clock.observe(frame('96000', true));
  assert.equal(clock.playing(), true);
  assert.equal(clock.position(RATE), '96000');
  // 10 ms at 48 kHz: 480 frames; 16.5 ms: 792 frames.
  set(1010);
  assert.equal(clock.position(RATE), '96480');
  set(1016.5);
  assert.equal(clock.position(RATE), '96792');
  // 44.1 kHz: 10 ms is 441 frames.
  set(1010);
  assert.equal(clock.position(44100), '96441');
  // An explicit now wins over the injected clock: 20 ms, 960 frames.
  assert.equal(clock.position(RATE, 1020), '96960');
});

test('the lead is bounded: a late frame never runs the cursor far ahead', () => {
  const { clock, set } = clockAt(1000);
  clock.observe(frame('0', true));
  set(1000 + MAX_LEAD_MS);
  const bound = String((MAX_LEAD_MS * RATE) / 1000);
  assert.equal(clock.position(RATE), bound);
  set(1000 + 10 * MAX_LEAD_MS);
  assert.equal(clock.position(RATE), bound, 'held at the bound');
  // A clock that went backwards adds nothing.
  set(900);
  assert.equal(clock.position(RATE), '0');
  assert.ok(MAX_LEAD_MS > 0 && MAX_LEAD_MS <= 250, 'about one or two realtime ticks');
});

test('a new frame resets the extrapolation; the same frame again does not', () => {
  const { clock, set } = clockAt(1000);
  const first = frame('48000', true);
  clock.observe(first);
  set(1020);
  clock.observe(first);
  assert.equal(clock.position(RATE), '48960', 'still counted from 1000');
  clock.observe(frame('48900', true));
  assert.equal(clock.position(RATE), '48900', 'counted from the new frame');
  set(1030);
  assert.equal(clock.position(RATE), '49380');
});

test("a stop or a locate shows the engine's position at once", () => {
  const { clock, set } = clockAt(1000);
  clock.observe(frame('48000', true));
  set(1050);
  assert.equal(clock.position(RATE), '50400');
  // The stop frame: behind the extrapolation, shown as it is.
  clock.observe(frame('49000', false));
  assert.equal(clock.position(RATE), '49000');
  set(1100);
  assert.equal(clock.position(RATE), '49000');
  // A locate while playing jumps back to the frame's position.
  clock.observe(frame('0', true));
  assert.equal(clock.position(RATE), '0');
});

test('positions beyond 2^53 frames stay exact', () => {
  const { clock, set } = clockAt(0);
  clock.observe(frame('9007199254740993', true));
  set(10);
  assert.equal(clock.position(RATE), '9007199254741473');
});
