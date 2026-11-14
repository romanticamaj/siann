// The selection of the event display and the track list (m5-ui-edit-basics;
// UI redesign spec 3.1, 3.2 and 3.3), pure: a click replaces the clip
// selection and Shift-click toggles a clip in or out, Ctrl+A takes every
// audio clip, ids the snapshot lost are pruned; L locates the selection's
// start, N and B the next and previous clip start (on the selected tracks,
// or every track when none is selected); Alt+S fits the selection in the
// view. Tracks: click selects one, Ctrl-click toggles, Shift-click selects
// the range from the primary in track order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameToX, type Viewport } from '../../src/renderer/timeline/geometry';
import {
  clickSelection,
  nextClipFrame,
  previousClipFrame,
  pruneSelection,
  pruneTracks,
  selectAllClips,
  selectTrack,
  selectionSpan,
  selectionStart,
  zoomToSelection,
  type TrackSelection,
} from '../../src/renderer/timeline/selection';
import { clip, sampleSnapshot, snapshotOf } from './support/timeline';

// clp_1 on trk_b 4800-28800; clp_2 on trk_a 0-9600; clp_3 on trk_a 48000-72000.
const snapshot = sampleSnapshot();

test('a click replaces the selection, Shift-click toggles a clip in or out, an empty click clears unless Shift is held', () => {
  assert.deepEqual(clickSelection([], 'clp_1', false), ['clp_1']);
  assert.deepEqual(clickSelection(['clp_1', 'clp_2'], 'clp_3', false), ['clp_3']);
  assert.deepEqual(clickSelection(['clp_1'], 'clp_3', true), ['clp_1', 'clp_3']);
  assert.deepEqual(clickSelection(['clp_1', 'clp_3'], 'clp_1', true), ['clp_3']);
  assert.deepEqual(clickSelection(['clp_1'], null, false), []);
  assert.deepEqual(clickSelection(['clp_1'], null, true), ['clp_1']);
});

test('select all takes every drawn audio clip; pruning drops ids the snapshot lost', () => {
  assert.deepEqual([...selectAllClips(snapshot)].sort(), ['clp_1', 'clp_2', 'clp_3']);
  const music = { ...clip('clp_m', 'trk_a', 'med_sq', '0', '0', '10'), position: { domain: 'music' as const, value: '0' } };
  const withMusic = snapshotOf(snapshot.trackOrder, snapshot.tracks, snapshot.media, [...snapshot.clips, music]);
  assert.ok(!selectAllClips(withMusic).includes('clp_m'), 'no music-domain clip');
  const kept = ['clp_1', 'clp_3'];
  assert.equal(pruneSelection(kept, snapshot), kept, 'unchanged: the same array');
  assert.deepEqual(pruneSelection(['clp_1', 'clp_gone', 'clp_3'], snapshot), ['clp_1', 'clp_3']);
});

test('the selection\'s start and span', () => {
  assert.equal(selectionStart(snapshot, ['clp_3', 'clp_1']), 4800n);
  assert.equal(selectionStart(snapshot, []), null);
  assert.deepEqual(selectionSpan(snapshot, ['clp_3', 'clp_1']), { start: 4800n, end: 72000n });
  assert.equal(selectionSpan(snapshot, ['clp_gone']), null);
});

test('N and B: the next and previous clip start, on the selected tracks or on every track', () => {
  assert.equal(nextClipFrame(snapshot, 0n, []), 4800n);
  assert.equal(nextClipFrame(snapshot, 4800n, []), 48000n);
  assert.equal(nextClipFrame(snapshot, 48000n, []), null);
  assert.equal(nextClipFrame(snapshot, 0n, ['trk_a']), 48000n);
  assert.equal(previousClipFrame(snapshot, 48000n, []), 4800n);
  assert.equal(previousClipFrame(snapshot, 4800n, []), 0n);
  assert.equal(previousClipFrame(snapshot, 0n, []), null);
  assert.equal(previousClipFrame(snapshot, 48000n, ['trk_b']), 4800n);
  assert.equal(previousClipFrame(snapshot, 100000n, ['trk_b']), 4800n);
});

test('zoom to selection fits the selection\'s span with a margin', () => {
  const view: Viewport = { framesPerPixel: 1000, scrollFrames: '500000', rulerHeight: 32, laneHeight: 53, width: 1000, height: 400 };
  const fitted = zoomToSelection(view, snapshot, ['clp_1', 'clp_3']);
  // 4800-72000 with 5 % of the span either side.
  assert.equal(fitted.framesPerPixel, 74);
  assert.equal(fitted.scrollFrames, '1440');
  assert.ok(frameToX(4800n, fitted) > 0);
  assert.ok(frameToX(72000n, fitted) < view.width);
  assert.equal(fitted.height, view.height, 'only the horizontal zoom and scroll change');
  assert.equal(zoomToSelection(view, snapshot, []), view, 'nothing selected: unchanged');
});

test('tracks: click selects one, Ctrl-click toggles, Shift-click takes the range from the primary', () => {
  const order = ['trk_1', 'trk_2', 'trk_3', 'trk_4'];
  const none: TrackSelection = { primary: null, ids: [] };
  const one = selectTrack(none, 'trk_2', 'replace', order);
  assert.deepEqual(one, { primary: 'trk_2', ids: ['trk_2'] });
  const two = selectTrack(one, 'trk_4', 'toggle', order);
  assert.deepEqual(two, { primary: 'trk_4', ids: ['trk_2', 'trk_4'] });
  assert.deepEqual(selectTrack(two, 'trk_4', 'toggle', order), { primary: 'trk_2', ids: ['trk_2'] });
  assert.deepEqual(selectTrack(one, 'trk_4', 'range', order), { primary: 'trk_2', ids: ['trk_2', 'trk_3', 'trk_4'] });
  assert.deepEqual(selectTrack(selectTrack(none, 'trk_3', 'replace', order), 'trk_1', 'range', order), {
    primary: 'trk_3',
    ids: ['trk_1', 'trk_2', 'trk_3'],
  });
  assert.deepEqual(selectTrack(none, 'trk_3', 'range', order), { primary: 'trk_3', ids: ['trk_3'] }, 'no primary: one track');
  assert.deepEqual(selectTrack(two, 'trk_1', 'replace', order), { primary: 'trk_1', ids: ['trk_1'] });
  // A removed track leaves the selection; the primary moves to what remains.
  assert.deepEqual(pruneTracks(two, ['trk_1', 'trk_2', 'trk_3']), { primary: 'trk_2', ids: ['trk_2'] });
  assert.equal(pruneTracks(two, order), two, 'unchanged: the same object');
});
