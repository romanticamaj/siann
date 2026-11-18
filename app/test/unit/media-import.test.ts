// The import of dropped and chosen files (m5b-ui-media; UI redesign UR-5;
// architecture spec, "Frontend", and Jobs v0, import): model/media-import.ts
// over a fake session client. One media.import {path, clientImportId} per
// file, polled with job.status on the injected scheduler; a placeholder per
// file with the job's progress; the placements of one drop are sent only
// after every import of the drop is done or failed, in drop order, each one
// command.execute whose expectedRevision is the head once the read model
// reached the job's revision. Content the session already holds (existing:
// true) commits nothing and its clip is placed with the mediaId the job
// returns. A failed job removes its placeholder and raises a toast with the
// engine's code and the file name; the other files keep the lanes the drop
// gave them. N files are N command.execute calls, so N undos remove N clips.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MediaEntity } from '../../src/renderer/model/document';
import { translator } from '../../src/renderer/i18n/t';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import { MediaImporter, POLL_MS } from '../../src/renderer/model/media-import';
import type { DropPlan } from '../../src/renderer/timeline/media-drop';
import { addMedia, FakeScheduler, FakeSessionClient, settle, until } from './support/fakes';
import { media, snapshotOf, track } from './support/timeline';

const FILES = [
  { name: 'a.wav', path: '/x/a.wav' },
  { name: 'b.wav', path: '/x/b.wav' },
];

function setup(trackOrder = ['trk_a', 'trk_b'], blocked: () => boolean = () => false) {
  const client = new FakeSessionClient(snapshotOf(trackOrder, trackOrder.map(track), [media('med_1', '48000')], []));
  const scheduler = new FakeScheduler();
  const toasts: string[] = [];
  let n = 0;
  const importer = new MediaImporter({
    client,
    schedule: scheduler.schedule,
    toasts: { push: (text: string) => (toasts.push(text), toasts.length) },
    locale: () => 'en',
    blocked,
    ids: { importId: () => `imp_${(n += 1)}`, trackId: () => `trk_new${n}`, clipId: () => `clp_${(n += 1)}` },
  });
  return { client, scheduler, toasts, importer };
}

const done = (mediaId: string, revision: string, name: string, extra: Record<string, unknown> = {}) => ({
  state: 'done',
  result: { mediaId, revision, contentHash: 'sha256:1', name, frames: '24000', sampleRate: 48000, channels: 1, converted: false, ...extra },
});
const entity = (id: string, name: string): MediaEntity => ({ ...media(id, '24000'), name });

const PLAN: DropPlan = { position: 96000n, lanes: [{ trackId: 'trk_a' }, { trackId: 'trk_b' }] };

test('one media.import per file with its path and a client import id, each with a placeholder', async () => {
  const { client, scheduler, importer } = setup();
  void importer.drop(FILES, PLAN);
  await until(() => client.requests('media.import').length === 2, 'two imports');
  assert.deepEqual(
    client.requests('media.import').map((r) => r.params),
    [
      { path: '/x/a.wav', clientImportId: 'imp_1' },
      { path: '/x/b.wav', clientImportId: 'imp_2' },
    ],
  );
  const shown = importer.getSnapshot();
  assert.deepEqual(shown.map((p) => [p.name, p.progress, p.lane?.trackId ?? null]), [
    ['a.wav', null, 'trk_a'],
    ['b.wav', null, 'trk_b'],
  ]);
  assert.ok(shown.every((p) => p.position === 96000n));
  // The jobs are polled on the scheduler, never at once.
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  assert.equal(client.requests('job.status').length, 0);
  assert.equal(scheduler.pending()[0]!.ms, POLL_MS);
});

test("job.status's progress shows in each placeholder", async () => {
  const { client, scheduler, importer } = setup();
  void importer.drop(FILES, PLAN);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  client.jobs[0]!.status = { state: 'running', progress: { framesDone: '12000', framesTotal: '48000' } };
  client.jobs[1]!.status = { state: 'running', progress: { framesDone: '0', framesTotal: '0' } };
  scheduler.fire(POLL_MS);
  await until(() => client.requests('job.status').length === 2, 'both polled');
  await until(() => importer.getSnapshot()[0]?.progress === 0.25, 'the first file at 25 %');
  assert.equal(importer.getSnapshot()[1]!.progress, 0);
  assert.deepEqual(client.requests('job.status').map((r) => r.params.jobId), ['job_1', 'job_2']);
});

test('the placements wait for every import of the drop, then go in drop order at the head the model reached', async () => {
  const { client, scheduler, importer } = setup();
  const finished = importer.drop(FILES, PLAN);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  // The first file is done (its media.add is r8), the second still running.
  client.jobs[0]!.status = done('med_a', 'r8', 'a.wav');
  client.jobs[1]!.status = { state: 'running', progress: { framesDone: '1', framesTotal: '2' } };
  scheduler.fire(POLL_MS);
  await until(() => scheduler.pending().length === 1, 'polled again');
  client.commit((s) => addMedia(s, entity('med_a', 'a.wav'), 'r8'));
  await settle();
  assert.equal(client.requests('command.execute').length, 0, 'nothing is placed while an import of the drop runs');
  // The second ends r9; the read model has not reached it yet.
  client.jobs[1]!.status = done('med_b', 'r9', 'b.wav');
  scheduler.fire(POLL_MS);
  await until(() => client.requests('job.status').length === 3, 'the running job polled again');
  await settle();
  assert.equal(client.requests('command.execute').length, 0, 'not before the read model reached r9');
  client.commit((s) => addMedia(s, entity('med_b', 'b.wav'), 'r9'));
  await finished;
  const executes = client.requests('command.execute');
  assert.equal(executes.length, 2, 'one command.execute per file');
  assert.deepEqual(
    executes.map((e) => [e.expectedRevision, (e.params.commands as Array<Record<string, unknown>>).map((c) => [c.op, c.trackId, c.mediaId, (c.position as { value: string }).value, c.length])]),
    [
      ['r9', [['clip.place', 'trk_a', 'med_a', '96000', '24000']]],
      ['r10', [['clip.place', 'trk_b', 'med_b', '96000', '24000']]],
    ],
  );
  assert.deepEqual(importer.getSnapshot(), [], 'the placeholders are gone');
  assert.equal(client.model.getSnapshot().clips.length, 2);
  assert.equal(scheduler.pending().length, 0, 'no poll left');
});

test('content the session already holds is placed with the mediaId the job returns, and commits no media', async () => {
  const { client, scheduler, importer } = setup();
  const finished = importer.drop([FILES[0]!], { position: 0n, lanes: [{ trackId: 'trk_b' }] });
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  client.jobs[0]!.status = done('med_1', 'r7', 'a.wav', { existing: true });
  scheduler.fire(POLL_MS);
  await finished;
  const [execute] = client.requests('command.execute');
  assert.ok(execute);
  assert.equal(execute.expectedRevision, 'r7');
  const [place] = execute.params.commands as Array<Record<string, unknown>>;
  assert.equal(place!.op, 'clip.place');
  assert.equal(place!.mediaId, 'med_1');
  assert.equal(place!.length, '48000', "the existing media's frames");
  assert.equal(client.model.getSnapshot().media.length, 1, 'no new media');
});

test("a failed import removes its placeholder and raises a toast with the engine's code and the file; the others keep their lanes", async () => {
  const { client, scheduler, toasts, importer } = setup();
  const finished = importer.drop([{ name: 'bad.wav', path: '/x/bad.wav' }, FILES[1]!], PLAN);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  client.jobs[0]!.status = { state: 'failed', error: { code: 'decode_failed', message: 'truncated' } };
  scheduler.fire(POLL_MS);
  await until(() => importer.getSnapshot().length === 1, 'the failed placeholder gone');
  assert.equal(importer.getSnapshot()[0]!.name, 'b.wav');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /bad\.wav/);
  assert.match(toasts[0]!, /decode_failed/);
  client.jobs[1]!.status = done('med_b', 'r8', 'b.wav');
  client.commit((s) => addMedia(s, entity('med_b', 'b.wav'), 'r8'));
  scheduler.fire(POLL_MS);
  await finished;
  const executes = client.requests('command.execute');
  assert.equal(executes.length, 1);
  const [place] = executes[0]!.params.commands as Array<Record<string, unknown>>;
  assert.equal(place!.trackId, 'trk_b', 'the lane the drop gave it, not shifted to the first track');
});

test('files dropped past the last track get new tracks named after the media, one command.execute each', async () => {
  const { client, scheduler, importer } = setup(['trk_a']);
  const three = [...FILES, { name: 'c.flac', path: '/x/c.flac' }];
  const finished = importer.drop(three, { position: 0n, lanes: [{ trackId: 'trk_a' }, { trackId: null }, { trackId: null }] });
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  assert.deepEqual(importer.getSnapshot().map((p) => [p.lane?.trackId ?? null, p.lane?.newIndex ?? null]), [
    ['trk_a', null],
    [null, 0],
    [null, 1],
  ]);
  client.jobs.forEach((job, i) => (job.status = done(`med_n${i}`, `r${8 + i}`, three[i]!.name)));
  client.commit((s) => addMedia(addMedia(addMedia(s, entity('med_n0', 'a.wav'), 'r8'), entity('med_n1', 'b.wav'), 'r9'), entity('med_n2', 'c.flac'), 'r10'));
  scheduler.fire(POLL_MS);
  await finished;
  const ops = client.requests('command.execute').map((e) => (e.params.commands as Array<Record<string, unknown>>).map((c) => `${String(c.op)} ${String(c.name ?? c.trackId)}`));
  assert.equal(ops.length, 3, 'three files, three command.execute');
  assert.deepEqual(ops[0], ['clip.place trk_a']);
  assert.equal(ops[1]![0], 'track.add b.wav');
  assert.match(ops[1]![1]!, /^clip\.place trk_new/);
  assert.equal(ops[2]![0], 'track.add c.flac');
  // The new tracks are appended in drop order.
  assert.equal(client.model.getSnapshot().trackOrder.length, 3);
});

test('a refused placement raises a toast and the remaining files are still placed', async () => {
  const { client, scheduler, toasts, importer } = setup();
  let calls = 0;
  client.executeAnswer = () => {
    calls += 1;
    if (calls === 1) return Object.assign(new Error('stale'), { code: 'revision_mismatch' });
    return { revision: { id: 'r9' } };
  };
  const finished = importer.drop(FILES, PLAN);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  client.jobs[0]!.status = done('med_1', 'r7', 'a.wav', { existing: true });
  client.jobs[1]!.status = done('med_1', 'r7', 'b.wav', { existing: true });
  scheduler.fire(POLL_MS);
  // The second placement waits for the model to reach r9.
  await until(() => client.requests('command.execute').length === 2, 'both sent');
  client.commit((s) => ({ ...s, revision: 'r9' }));
  await finished;
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /a\.wav/);
  assert.match(toasts[0]!, /revision_mismatch/);
});

test('Import from the tab imports each file and places nothing', async () => {
  const { client, scheduler, importer } = setup();
  const finished = importer.importFiles(['/x/a.wav', '/y/Kick 909.flac']);
  await until(() => client.requests('media.import').length === 2, 'two imports');
  assert.deepEqual(importer.getSnapshot().map((p) => [p.name, p.lane]), [
    ['a.wav', null],
    ['Kick 909.flac', null],
  ]);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  client.jobs[0]!.status = done('med_a', 'r8', 'a.wav');
  client.jobs[1]!.status = done('med_b', 'r9', 'Kick 909.flac');
  scheduler.fire(POLL_MS);
  await finished;
  assert.equal(client.requests('command.execute').length, 0);
  assert.deepEqual(importer.getSnapshot(), []);
});

// The edit guard (UI redesign 4.5 C5): while a proposal is heard the import
// commits nothing onto main. A drop or Import then sends no request and a
// toast gives the guard's reason; a drop whose imports began with main heard
// places no clip once a proposal is heard, and says so.
test('while blocked a drop and Import send no request, and a toast gives the guard reason', async () => {
  const { client, importer, toasts } = setup(['trk_a', 'trk_b'], () => true);
  await importer.drop(FILES, PLAN);
  await importer.importFiles(['/x/a.wav']);
  await settle();
  assert.equal(client.requests('media.import').length, 0);
  assert.equal(client.requests('command.execute').length, 0);
  assert.deepEqual(importer.getSnapshot(), []);
  assert.deepEqual(toasts, [translator('en')(GUARD_REASON), translator('en')(GUARD_REASON)]);
});

test('a drop whose imports end once a proposal is heard places nothing and says why', async () => {
  let heard = false;
  const { client, scheduler, importer, toasts } = setup(['trk_a', 'trk_b'], () => heard);
  const finished = importer.drop(FILES, PLAN);
  await until(() => scheduler.pending().length === 1, 'a poll scheduled');
  heard = true;
  client.jobs[0]!.status = done('med_a', 'r8', 'a.wav');
  client.jobs[1]!.status = done('med_b', 'r9', 'b.wav');
  scheduler.fire(POLL_MS);
  await until(() => client.requests('job.status').length === 2, 'polled');
  client.commit((s) => addMedia(addMedia(s, entity('med_a', 'a.wav'), 'r8'), entity('med_b', 'b.wav'), 'r9'));
  await finished;
  assert.equal(client.requests('command.execute').length, 0);
  assert.deepEqual(importer.getSnapshot(), []);
  assert.deepEqual(toasts, [translator('en')(GUARD_REASON)]);
});
