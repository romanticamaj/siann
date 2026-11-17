// A clip's title (m5-ui-port-arrange-canvas; UI redesign 3.0 and 10.7): the
// media's name (media.name, m5b-engine-project-media), and the media id when
// the media has none or its entity is missing. One function, which the event
// display draws in the clip's title strip and m5-ui-port-toolbar's info line
// reuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clipTitle } from '../../src/renderer/timeline/clip-title';
import { clip, media, snapshotOf, track } from './support/timeline';

test('the title is the media name, else the media id', () => {
  const named = { ...media('med_vox', '48000'), name: 'Chorus A · take 3' };
  const unnamed = media('med_kick', '48000');
  const clips = [clip('clp_1', 'trk_a', 'med_vox', '0', '0', '100'), clip('clp_2', 'trk_a', 'med_kick', '0', '0', '100'), clip('clp_3', 'trk_a', 'med_gone', '0', '0', '100')];
  const snapshot = snapshotOf(['trk_a'], [track('trk_a')], [named, unnamed], clips);
  assert.equal(clipTitle(snapshot, clips[0]!), 'Chorus A · take 3');
  assert.equal(clipTitle(snapshot, clips[1]!), 'med_kick', 'no name: the id');
  assert.equal(clipTitle(snapshot, clips[2]!), 'med_gone', 'no media entity: the id');
  // An empty name is no name.
  const empty = snapshotOf(['trk_a'], [track('trk_a')], [{ ...unnamed, name: '' }], [clips[1]!]);
  assert.equal(clipTitle(empty, clips[1]!), 'med_kick');
  // A rename shows in the next snapshot.
  const renamed = snapshotOf(['trk_a'], [track('trk_a')], [{ ...named, name: 'Hook' }, unnamed], clips);
  assert.equal(clipTitle(renamed, clips[0]!), 'Hook');
});
