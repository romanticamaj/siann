// The right zone's Media tab (m5b-ui-media; UI redesign UR-5, 3.0, 10.8, 1):
// the session's media by name (the media id when there is none) with
// length, channels, sample rate and use count (the clips of the document
// that play it), filtered by a search field; Import (the shell's file
// dialog) only with the preload bridge; a double-click on a name renames it
// (media.rename) only when the engine lists that command; Remove
// (media.remove) is absent without the command and disabled, with its
// reason, for media a clip uses; a row drags to the event display only with
// clip.place. The mockup draws the tab but not its content, so its rules are
// shell.css's, from existing tokens. Rendered with react-dom/server, and the
// view's element tree read for its handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import { MediaActions, mediaRows, MediaTabView, removeMediaCommand, renameMediaCommand, type MediaTabViewProps } from '../../src/renderer/media/MediaTab';
import type { Capabilities } from '../../src/renderer/model/capabilities';
import type { MediaEntity } from '../../src/renderer/model/document';
import { GUARD_REASON } from '../../src/renderer/model/edit-guard';
import { FakeSessionClient, until } from './support/fakes';
import { byAttr, byClass, find, findAll, parse, text } from './support/mockup';
import { clip, media, snapshotOf, track } from './support/timeline';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const en = translator('en');

const named = (id: string, name: string, frames: string, extra: Partial<MediaEntity> = {}): MediaEntity => ({ ...media(id, frames), name, ...extra });

function session() {
  return snapshotOf(
    ['trk_a'],
    [track('trk_a')],
    [named('med_1', 'Kick 909.wav', '96000'), named('med_2', 'pad_swell.wav', '72000', { channels: 2 }), media('med_3', '24000')],
    [clip('clp_1', 'trk_a', 'med_1', '0', '0', '48000'), clip('clp_2', 'trk_a', 'med_1', '96000', '0', '48000'), clip('clp_3', 'trk_a', 'med_3', '0', '0', '100')],
  );
}

const noop = () => undefined;

function props(overrides: Partial<MediaTabViewProps> = {}): MediaTabViewProps {
  return {
    rows: mediaRows(session(), ''),
    total: 3,
    query: '',
    importing: [],
    can: { rename: true, remove: true, place: true },
    canImport: true,
    renaming: null,
    guard: null,
    t: en,
    onQuery: noop,
    onImport: noop,
    onStartRename: noop,
    onRename: noop,
    onCancelRename: noop,
    onRemove: noop,
    onDragStart: noop,
    ...overrides,
  };
}

const view = (overrides: Partial<MediaTabViewProps> = {}) => parse(renderToStaticMarkup(<MediaTabView {...props(overrides)} />));

// Every element of a rendered tree (function components other than the view are left as they are).
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find((el) => el.props['data-testid'] === id);

test('the rows: the name or the id, the length, channels, sample rate and use count from the clips', () => {
  const rows = mediaRows(session(), '');
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.frames, r.channels, r.sampleRate, r.uses]),
    [
      ['med_1', 'Kick 909.wav', '96000', 1, 48000, 2],
      ['med_2', 'pad_swell.wav', '72000', 2, 48000, 0],
      ['med_3', 'med_3', '24000', 1, 48000, 1],
    ],
  );
  const markup = view();
  const row = find(markup, byAttr('data-testid', 'media-row-med_1'))!;
  assert.deepEqual(findAll(row, (el) => el.tag === 'td').slice(0, 5).map(text), ['Kick 909.wav', '2 s', 'Mono', '48 kHz', '2']);
  const stereo = find(markup, byAttr('data-testid', 'media-row-med_2'))!;
  assert.deepEqual(findAll(stereo, (el) => el.tag === 'td').slice(0, 5).map(text), ['pad_swell.wav', '1.5 s', 'Stereo', '48 kHz', '0']);
  // The column heads.
  assert.deepEqual(findAll(find(markup, (el) => el.tag === 'thead')!, (el) => el.tag === 'th').slice(0, 5).map(text), ['Name', 'Length', 'Channels', 'Rate', 'Uses']);
  // 44.1 kHz reads with its decimal.
  const odd = mediaRows(snapshotOf([], [], [named('med_9', 'x.wav', '44100', { sampleRate: 44100 })], []), '');
  const oddMarkup = view({ rows: odd, total: 1 });
  assert.equal(text(findAll(find(oddMarkup, byAttr('data-testid', 'media-row-med_9'))!, (el) => el.tag === 'td')[3]!), '44.1 kHz');
});

test('the search field filters by name and id, ignoring case', () => {
  assert.deepEqual(mediaRows(session(), 'KICK').map((r) => r.id), ['med_1']);
  assert.deepEqual(mediaRows(session(), 'wav').map((r) => r.id), ['med_1', 'med_2']);
  assert.deepEqual(mediaRows(session(), 'med_3').map((r) => r.id), ['med_3']);
  assert.deepEqual(mediaRows(session(), '  ').map((r) => r.id), ['med_1', 'med_2', 'med_3']);
  assert.deepEqual(mediaRows(null, ''), []);
  const markup = view({ rows: [], total: 3, query: 'zzz' });
  assert.match(text(find(markup, byClass('media-empty'))!), /No media matches/);
  const empty = view({ rows: [], total: 0 });
  assert.match(text(find(empty, byClass('media-empty'))!), /No media/);
  const search = find(view(), byAttr('data-testid', 'media-search'))!;
  assert.equal(search.tag, 'input');
  assert.equal(search.attrs.type, 'search');
  assert.equal(search.attrs['aria-label'], 'Search media');
});

test('Import is there only with the bridge, and opens the shell\'s dialog', () => {
  assert.ok(find(view(), byAttr('data-testid', 'media-import')));
  assert.equal(findAll(view({ canImport: false }), byAttr('data-testid', 'media-import')).length, 0);
  let imported = 0;
  const tree = MediaTabView(props({ onImport: () => (imported += 1) }));
  (byTestId(tree, 'media-import')!.props.onClick as () => void)();
  assert.equal(imported, 1);
});

test('a double-click on a name starts a rename only when the engine lists media.rename; Enter sends it', () => {
  const started: string[] = [];
  const tree = MediaTabView(props({ onStartRename: (id) => started.push(id) }));
  const name = elements(tree).find((el) => el.props['data-testid'] === 'media-name-med_1')!;
  (name.props.onDoubleClick as () => void)();
  assert.deepEqual(started, ['med_1']);
  const without = MediaTabView(props({ can: { rename: false, remove: true, place: true } }));
  assert.equal(elements(without).find((el) => el.props['data-testid'] === 'media-name-med_1')!.props.onDoubleClick, undefined);
  // While renaming, the name is a field; Enter commits, Escape cancels.
  const renamed: Array<[string, string]> = [];
  let cancelled = 0;
  const editing = MediaTabView(props({ renaming: 'med_1', onRename: (id, value) => renamed.push([id, value]), onCancelRename: () => (cancelled += 1) }));
  const input = byTestId(editing, 'media-rename-input')!;
  assert.equal(input.props.defaultValue, 'Kick 909.wav');
  const key = (k: string) => (input.props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault: noop, currentTarget: { value: 'Kick 808.wav' } });
  key('Enter');
  key('Escape');
  assert.deepEqual(renamed, [['med_1', 'Kick 808.wav']]);
  assert.equal(cancelled, 1);
});

test('rename and remove are media.rename and media.remove at the head; nothing for an unchanged name or used media', () => {
  const s = session();
  assert.deepEqual(renameMediaCommand(s, 'med_1', '  Kick 808.wav '), { expectedRevision: 'r7', commands: [{ op: 'media.rename', mediaId: 'med_1', name: 'Kick 808.wav' }] });
  assert.equal(renameMediaCommand(s, 'med_1', 'Kick 909.wav'), null);
  assert.equal(renameMediaCommand(s, 'med_1', '   '), null);
  assert.equal(renameMediaCommand(s, 'med_none', 'x'), null);
  assert.deepEqual(renameMediaCommand(s, 'med_3', 'Snare'), { expectedRevision: 'r7', commands: [{ op: 'media.rename', mediaId: 'med_3', name: 'Snare' }] });
  assert.deepEqual(removeMediaCommand(s, 'med_2'), { expectedRevision: 'r7', commands: [{ op: 'media.remove', mediaId: 'med_2' }] });
  assert.equal(removeMediaCommand(s, 'med_1'), null, 'in use');
  assert.equal(removeMediaCommand(s, 'med_none'), null);
});

test('MediaActions sends the commands through command.execute', async () => {
  const client = new FakeSessionClient(session());
  client.executeAnswer = () => ({ revision: 'r8' });
  const actions = new MediaActions({ client, toasts: { push: () => 0 }, locale: () => 'en' });
  await actions.rename('med_2', 'Pad');
  await actions.remove('med_2');
  await actions.remove('med_1');
  await until(() => client.requests('command.execute').length === 2, 'two commands');
  assert.deepEqual(client.requests('command.execute').map((r) => (r.params.commands as Array<{ op: string }>)[0]!.op), ['media.rename', 'media.remove']);
});

test('Remove is enabled only for unused media, gives its reason when it is not, and is absent without media.remove', () => {
  const markup = view();
  const used = find(markup, byAttr('data-testid', 'media-remove-med_1'))!;
  assert.equal(used.tag, 'button');
  assert.ok('disabled' in used.attrs, 'disabled for used media');
  assert.equal(used.attrs.title, 'Used by 2 clips: remove the clips first');
  const unused = find(markup, byAttr('data-testid', 'media-remove-med_2'))!;
  assert.ok(!('disabled' in unused.attrs));
  assert.equal(unused.attrs.title, undefined);
  assert.equal(text(unused), 'Remove');
  const removed: string[] = [];
  const tree = MediaTabView(props({ onRemove: (id) => removed.push(id) }));
  (byTestId(tree, 'media-remove-med_2')!.props.onClick as () => void)();
  assert.deepEqual(removed, ['med_2']);
  const without = view({ can: { rename: true, remove: false, place: true } });
  assert.equal(findAll(without, (el) => (el.attrs['data-testid'] ?? '').startsWith('media-remove-')).length, 0);
});

test('a row drags to the event display only with clip.place', () => {
  const rows = (markup: ReturnType<typeof view>) => findAll(markup, (el) => (el.attrs['data-testid'] ?? '').startsWith('media-row-'));
  assert.ok(rows(view()).every((row) => row.attrs.draggable === 'true'));
  assert.ok(rows(view({ can: { rename: true, remove: true, place: false } })).every((row) => row.attrs.draggable !== 'true'));
  const dragged: string[] = [];
  const tree = MediaTabView(props({ onDragStart: (id) => dragged.push(id) }));
  (byTestId(tree, 'media-row-med_2')!.props.onDragStart as (e: unknown) => void)({});
  assert.deepEqual(dragged, ['med_2']);
});

test('a file being imported shows its name and progress at the top of the list', () => {
  const markup = view({ importing: [{ key: 'imp_1', name: 'b.wav', progress: 0.4, lane: null, position: null }] });
  const row = find(markup, byAttr('data-testid', 'media-importing-imp_1'))!;
  assert.match(text(row), /b\.wav/);
  assert.match(text(row), /40 %/);
  assert.ok(FULL.commands?.includes('media.rename'));
});

// The edit guard (UI redesign 4.5 C5): while a branch is heard, Import, a
// row's drag, the rename and Remove are disabled with the guard's reason;
// the search and the list stay.
test('while a branch is heard Import, the drag, the rename and Remove are disabled with the reason; the search stays', () => {
  const reason = en(GUARD_REASON);
  const markup = view({ guard: reason });
  const importButton = find(markup, byAttr('data-testid', 'media-import'))!;
  assert.ok('disabled' in importButton.attrs, 'Import disabled');
  assert.equal(importButton.attrs.title, reason);
  for (const id of ['med_1', 'med_2']) {
    const remove = find(markup, byAttr('data-testid', `media-remove-${id}`))!;
    assert.ok('disabled' in remove.attrs, id);
    assert.equal(remove.attrs.title, reason, id);
  }
  const rows = findAll(markup, (el) => (el.attrs['data-testid'] ?? '').startsWith('media-row-'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.attrs.draggable !== 'true'), 'no row drags');
  const search = find(markup, byAttr('data-testid', 'media-search'))!;
  assert.ok(!('disabled' in search.attrs), 'the search stays');
  // No handler starts a rename, a drag, an import or a removal.
  let calls = 0;
  const count = () => {
    calls += 1;
  };
  const tree = MediaTabView(props({ guard: reason, onImport: count, onStartRename: count, onRemove: count, onDragStart: count }));
  assert.equal(byTestId(tree, 'media-name-med_1')!.props.onDoubleClick, undefined);
  assert.equal(byTestId(tree, 'media-row-med_2')!.props.onDragStart, undefined);
  (byTestId(tree, 'media-import')!.props.onClick as () => void)();
  (byTestId(tree, 'media-remove-med_2')!.props.onClick as () => void)();
  assert.equal(calls, 0);
  // A rename under way is not shown as a field while heard.
  assert.equal(findAll(view({ guard: reason, renaming: 'med_1' }), byAttr('data-testid', 'media-rename-input')).length, 0);
  // With main heard nothing is disabled.
  const free = view();
  assert.ok(!('disabled' in find(free, byAttr('data-testid', 'media-import'))!.attrs));
  assert.ok(!('disabled' in find(free, byAttr('data-testid', 'media-remove-med_2'))!.attrs));
});
