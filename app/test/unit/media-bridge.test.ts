// The media half of the preload bridge (m5b-ui-media; UI redesign UR-5;
// architecture spec, "Frontend"): the shell's file dialog for Import and the
// path of a dropped file (webUtils.getPathForFile), never the renderer's own.
// The pure helpers on both sides: the formats the engine accepts come from
// features.mediaImport.formats; a drop is split into the files it accepts
// and the ones it refuses before any request; the dialog opens files, several
// at once, filtered to those formats, and hands back absolute paths only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { chosenPaths, DEFAULT_MEDIA_FORMATS, mediaDialogOptions, mediaFormats } from '../../src/main/media';
import { acceptedFormats, extensionOf, MEDIA_ROW_TYPE, splitDrop } from '../../src/renderer/model/media-bridge';
import type { Capabilities } from '../../src/renderer/model/capabilities';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const REDUCED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-reduced.json'), 'utf8')) as Capabilities;

test('the accepted formats are features.mediaImport.formats, lower case, and none without media.import', () => {
  assert.deepEqual(acceptedFormats(FULL), ['wav', 'flac']);
  assert.deepEqual(acceptedFormats(REDUCED), []);
  assert.deepEqual(acceptedFormats(null), []);
  assert.deepEqual(acceptedFormats({ methods: ['media.import'], features: { mediaImport: { formats: ['WAV', 'aiff', 7, ''] } } }), ['wav', 'aiff']);
  // The method without the feature, or the feature without the method: nothing is accepted.
  assert.deepEqual(acceptedFormats({ methods: ['media.import'] }), []);
  assert.deepEqual(acceptedFormats({ methods: [], features: { mediaImport: { formats: ['wav'] } } }), []);
});

test('a file\'s extension is its name\'s last suffix, lower case', () => {
  assert.equal(extensionOf('Kick 909.WAV'), 'wav');
  assert.equal(extensionOf('take.2.flac'), 'flac');
  assert.equal(extensionOf('notes.txt'), 'txt');
  assert.equal(extensionOf('README'), '');
  assert.equal(extensionOf('.wav'), '');
  assert.equal(extensionOf('dir.wav/'), '');
});

test('a drop splits into the files the engine accepts and the ones it refuses, in drop order', () => {
  const files = [
    { name: 'a.wav', path: path.resolve('/x/a.wav') },
    { name: 'notes.txt', path: path.resolve('/x/notes.txt') },
    { name: 'b.FLAC', path: path.resolve('/x/b.FLAC') },
    { name: 'c.mp3', path: path.resolve('/x/c.mp3') },
    // A file the bridge gives no path for (a plain browser tab, a virtual item).
    { name: 'd.wav', path: '' },
    { name: 'e.wav', path: 'relative/e.wav' },
  ];
  const { accepted, refused } = splitDrop(files, ['wav', 'flac']);
  assert.deepEqual(accepted.map((f) => f.name), ['a.wav', 'b.FLAC']);
  assert.deepEqual(refused.map((f) => f.name), ['notes.txt', 'c.mp3', 'd.wav', 'e.wav']);
  assert.deepEqual(splitDrop(files, []).accepted, []);
});

test('a Media tab row drags under the app\'s own type', () => {
  assert.equal(MEDIA_ROW_TYPE, 'application/x-siann-media');
});

test('the shell\'s dialog opens several files filtered to the formats', () => {
  const options = mediaDialogOptions(['wav', 'flac'], 'Audio');
  assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(options.filters, [{ name: 'Audio', extensions: ['wav', 'flac'] }]);
});

test('the shell takes the formats from the renderer only when they are plain extensions, else the defaults', () => {
  assert.deepEqual(DEFAULT_MEDIA_FORMATS, ['wav', 'flac']);
  assert.deepEqual(mediaFormats(['wav']), ['wav']);
  assert.deepEqual(mediaFormats(['WAV', 'flac']), ['wav', 'flac']);
  for (const bad of [undefined, null, 'wav', [], [''], ['*'], ['wav;rm'], ['../x'], [1], new Array(40).fill('wav')]) {
    assert.deepEqual(mediaFormats(bad), DEFAULT_MEDIA_FORMATS, JSON.stringify(bad));
  }
});

test('a cancelled dialog gives no path, and only absolute paths come back', () => {
  assert.deepEqual(chosenPaths({ canceled: true, filePaths: [path.resolve('/x/a.wav')] }), []);
  assert.deepEqual(chosenPaths({ canceled: false, filePaths: [path.resolve('/x/a.wav'), 'b.wav', '', path.resolve('/x/c.flac')] }), [
    path.resolve('/x/a.wav'),
    path.resolve('/x/c.flac'),
  ]);
  assert.deepEqual(chosenPaths({ canceled: false, filePaths: [] }), []);
});
