// Dimmed lanes and headers (m5-ui-arrange; UI redesign spec 1.2, "An
// implicitly muted track (another track is soloed) dims its lane and header to
// 45 %"): a muted track is dimmed; while any track is soloed every track that
// is not soloed is dimmed; otherwise none. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TrackEntity } from '../../src/renderer/model/document';
import { DIMMED_ALPHA, dimmedTracks } from '../../src/renderer/timeline/dimming';
import { track } from './support/timeline';

const t = (id: string, patch: Partial<TrackEntity> = {}): TrackEntity => ({ ...track(id), ...patch });

test('nothing muted or soloed: nothing dimmed', () => {
  assert.deepEqual([...dimmedTracks([t('a'), t('b')])], []);
  assert.equal(DIMMED_ALPHA, 0.45);
});

test('a muted track is dimmed', () => {
  assert.deepEqual([...dimmedTracks([t('a', { mute: true }), t('b')])].sort(), ['a']);
});

test('with a solo on, every track that is not soloed is dimmed', () => {
  assert.deepEqual([...dimmedTracks([t('a', { solo: true }), t('b'), t('c')])].sort(), ['b', 'c']);
  assert.deepEqual([...dimmedTracks([t('a', { solo: true }), t('b', { solo: true }), t('c')])].sort(), ['c']);
  // A soloed track that is also muted stays muted.
  assert.deepEqual([...dimmedTracks([t('a', { solo: true, mute: true }), t('b')])].sort(), ['a', 'b']);
});
