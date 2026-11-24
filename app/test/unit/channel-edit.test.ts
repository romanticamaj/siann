// The e button of a track strip and of the Inspector (m5b-ui-editor-channel;
// UI redesign 3.4, 10.11): Cubase's Edit Channel Settings, which in SIANN is
// the Channel zone. e on a strip selects that track and shows the Channel
// zone on it; it is lit while the zone shows that track, and pressed again
// hides the zone. The Inspector's e does the same for the selected track.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { channelLit, editChannel } from '../../src/renderer/mixer/channel-edit';

test('e on another track\'s strip selects it and shows the zone', () => {
  assert.deepEqual(editChannel({ trackId: 'trk_2', selectedTrackId: 'trk_1', channelVisible: true }), { select: 'trk_2', zone: 'show' });
  assert.deepEqual(editChannel({ trackId: 'trk_2', selectedTrackId: null, channelVisible: false }), { select: 'trk_2', zone: 'show' });
});

test('e on the shown track hides the zone and keeps the selection', () => {
  assert.deepEqual(editChannel({ trackId: 'trk_1', selectedTrackId: 'trk_1', channelVisible: true }), { select: null, zone: 'hide' });
});

test('e on the selected track with the zone hidden selects it alone and shows the zone', () => {
  assert.deepEqual(editChannel({ trackId: 'trk_1', selectedTrackId: 'trk_1', channelVisible: false }), { select: 'trk_1', zone: 'show' });
});

test('lit: the zone is shown and its track is this one', () => {
  assert.equal(channelLit({ trackId: 'trk_1', selectedTrackId: 'trk_1', channelVisible: true }), true);
  assert.equal(channelLit({ trackId: 'trk_1', selectedTrackId: 'trk_1', channelVisible: false }), false);
  assert.equal(channelLit({ trackId: 'trk_2', selectedTrackId: 'trk_1', channelVisible: true }), false);
  assert.equal(channelLit({ trackId: 'trk_2', selectedTrackId: null, channelVisible: true }), false);
});

test('the Inspector\'s e with no track selected does nothing', () => {
  assert.equal(editChannel({ trackId: null, selectedTrackId: null, channelVisible: true }), null);
  assert.equal(channelLit({ trackId: null, selectedTrackId: null, channelVisible: true }), false);
});
