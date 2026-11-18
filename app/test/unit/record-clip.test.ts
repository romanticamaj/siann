// The red clip of a recording (m5b-ui-recording; UI redesign 3.5, 5.2;
// docs/schemas/protocol-engine-v0.md, "Recording": startFrame is the timeline
// frame the take lands on, null until its first captured frame; a committed
// take's clip is clp_<takeId>):
//
// - one growing clip per take while recording, from its startFrame to the
//   playhead (never shorter than nothing), none for a take whose startFrame
//   is still null (the count-in) and none once its committed clip is in the
//   document;
// - the live waveform: the peaks of the track's input meter (input:<trackId>)
//   gathered into columns of WAVE_FRAMES frames from the take's start, the
//   loudest per column, ignored before the start or without the meter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MeterFrame, MeterLegend } from '../../src/renderer/model/meter-frames';
import { LiveWaveform, WAVE_FRAMES, recordingClips } from '../../src/renderer/model/record-clip';
import type { RecordState } from '../../src/renderer/model/record';

const take = (takeId: string, trackId: string, startFrame: string | null) => ({ takeId, trackId, startFrame, durableFrames: '0', endedBy: null, overflows: null });

const state = (recording: boolean, takes: RecordState['takes']): RecordState => ({ recording, armed: takes.map((t) => t.trackId), takes });

test('one clip per take from its startFrame to the playhead while recording', () => {
  const s = state(true, [take('take_1', 'trk_1', '96000'), take('take_2', 'trk_2', '96000')]);
  assert.deepEqual(recordingClips(s, 144000n, () => false), [
    { takeId: 'take_1', trackId: 'trk_1', start: 96000n, end: 144000n },
    { takeId: 'take_2', trackId: 'trk_2', start: 96000n, end: 144000n },
  ]);
  // A playhead before the start (pre-roll) draws nothing yet, not a negative clip.
  assert.deepEqual(recordingClips(s, 90000n, () => false).map((c) => c.end - c.start), [0n, 0n]);
});

test('no clip during the count-in (startFrame null), without a playhead, or when not recording', () => {
  assert.deepEqual(recordingClips(state(true, [take('take_1', 'trk_1', null)]), 1000n, () => false), []);
  assert.deepEqual(recordingClips(state(true, [take('take_1', 'trk_1', '0')]), null, () => false), []);
  assert.deepEqual(recordingClips(state(false, [take('take_1', 'trk_1', '0')]), 1000n, () => false), []);
  assert.deepEqual(recordingClips(null, 1000n, () => false), []);
});

test('replaced by the committed clip clp_<takeId> once the document has it', () => {
  const s = state(true, [take('take_1', 'trk_1', '0'), take('take_2', 'trk_2', '0')]);
  const committed = new Set(['clp_take_1']);
  assert.deepEqual(recordingClips(s, 4800n, (id) => committed.has(id)).map((c) => c.takeId), ['take_2']);
});

const LEGEND: MeterLegend = { epoch: '3', entities: ['master', 'track:trk_1', 'input:trk_1'] };
const frame = (at: number, peak: number, epoch = '3'): MeterFrame => ({
  epoch,
  engineTimestampMicros: '0',
  playheadSamples: String(at),
  playing: true,
  entries: [
    { entityIndex: 0, channels: 2, peak: [0.9, 0.9], rms: [0.5, 0.5] },
    { entityIndex: 2, channels: 1, peak: [peak], rms: [peak / 2] },
  ],
});

test('the waveform gathers the input meter\'s peaks into columns from the take\'s start', () => {
  const wave = new LiveWaveform();
  const start = 96000n;
  wave.add('take_1', 'trk_1', start, frame(96000 + 10, 0.2), LEGEND);
  wave.add('take_1', 'trk_1', start, frame(96000 + 20, 0.6), LEGEND);
  wave.add('take_1', 'trk_1', start, frame(96000 + WAVE_FRAMES + 5, 0.3), LEGEND);
  // Three columns later, a gap is silence.
  wave.add('take_1', 'trk_1', start, frame(96000 + 3 * WAVE_FRAMES + 5, 0.4), LEGEND);
  const columns = wave.columns('take_1');
  assert.equal(columns.length, 4);
  assert.ok(Math.abs(columns[0]! - 0.6) < 1e-6, 'the loudest of the column');
  assert.ok(Math.abs(columns[1]! - 0.3) < 1e-6);
  assert.equal(columns[2], 0);
  assert.ok(Math.abs(columns[3]! - 0.4) < 1e-6);
  // The master's peak is not the track's input.
  assert.ok(columns.every((v) => v < 0.9));
});

test('frames before the start, of another epoch, or without the track\'s input meter add nothing', () => {
  const wave = new LiveWaveform();
  wave.add('take_1', 'trk_1', 96000n, frame(95000, 0.8), LEGEND);
  wave.add('take_1', 'trk_1', 96000n, frame(97000, 0.8, '4'), LEGEND);
  wave.add('take_1', 'trk_2', 96000n, frame(97000, 0.8), LEGEND);
  assert.deepEqual([...wave.columns('take_1')], []);
  wave.add('take_1', 'trk_1', 96000n, frame(97000, 0.5), LEGEND);
  assert.equal(wave.columns('take_1').length, 1);
  // A finished take is forgotten.
  wave.retain(new Set());
  assert.deepEqual([...wave.columns('take_1')], []);
});
