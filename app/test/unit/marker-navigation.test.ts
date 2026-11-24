// The marker keys (m5b-ui-markers; UI redesign 3.1, 3.6, UR-9): Shift+3..9
// and Num 3..9 go to position markers 3 to 9, never to a cycle marker of the
// same number (the engine numbers each kind from 1); Shift+N and Shift+B go
// to the next and the previous marker from the project cursor over both
// kinds, a cycle marker by its start, in position order (UI redesign 3.2, the
// docs commit of this feature); nothing past the ends.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextMarker, positionMarkerByNumber, previousMarker } from '../../src/renderer/timeline/markers';
import { marker, snapshotOf, withMarkers } from './support/timeline';

function session() {
  return withMarkers(snapshotOf([], [], [], []), [
    marker('mk_a', 1, '0', 'Intro'),
    marker('mk_b', 2, '384000', 'Verse'),
    marker('mk_c', 3, '768000', 'Chorus'),
    marker('mk_d', 9, '1536000', 'Outro'),
    // A cycle marker 3 elsewhere, and one starting between the position markers.
    marker('mk_y', 3, '100000', 'Loop', '50000'),
    marker('mk_z', 1, '500000', 'Fill', '96000'),
  ]);
}

test('positionMarkerByNumber: the position marker with that number, never a cycle marker; null when none', () => {
  const s = session();
  assert.equal(positionMarkerByNumber(s, 3)?.id, 'mk_c', 'the position marker 3, not the cycle marker 3');
  assert.equal(positionMarkerByNumber(s, 9)?.id, 'mk_d');
  assert.equal(positionMarkerByNumber(s, 4), null);
  assert.equal(positionMarkerByNumber(s, 7), null);
  assert.equal(positionMarkerByNumber(withMarkers(snapshotOf([], [], [], []), [marker('mk_y', 3, '100000', 'Loop', '50000')]), 3), null);
});

test('next and previous: both kinds in position order (a cycle marker by its start), strictly after or before the cursor', () => {
  const s = session();
  // Starts: 0, 100000 (cycle), 384000, 500000 (cycle), 768000, 1536000.
  assert.equal(nextMarker(s, 0n), 100000n);
  assert.equal(nextMarker(s, 100000n), 384000n);
  assert.equal(nextMarker(s, 400000n), 500000n);
  assert.equal(nextMarker(s, 768000n), 1536000n);
  assert.equal(previousMarker(s, 1536000n), 768000n);
  assert.equal(previousMarker(s, 600000n), 500000n);
  assert.equal(previousMarker(s, 384000n), 100000n);
  assert.equal(previousMarker(s, 50n), 0n);
});

test('null at the ends and in a session without markers', () => {
  const s = session();
  assert.equal(nextMarker(s, 1536000n), null);
  assert.equal(nextMarker(s, 9_999_999n), null);
  assert.equal(previousMarker(s, 0n), null);
  const empty = snapshotOf([], [], [], []);
  assert.equal(nextMarker(empty, 0n), null);
  assert.equal(previousMarker(empty, 100n), null);
  assert.equal(positionMarkerByNumber(empty, 3), null);
});
