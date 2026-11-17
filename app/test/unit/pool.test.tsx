// The Pool (m5-ui-port-toolbar; UI redesign 10.8, 1): Cubase's Pool as an
// app-only window over the project zone, opened with Ctrl+P (Cmd+P) and from
// the event display's context menu. It lists the session's media by name (the
// media id when there is none) and a click arms placing, as the toolbar's
// media buttons did; the test ids media-pool and pool-<media id> moved into
// it. The resting window does not show it; Escape closes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import type { MediaEntity } from '../../src/renderer/model/document';
import { Pool, PoolView, poolKeyHandler, type PoolViewProps } from '../../src/renderer/timeline/Pool';
import { byAttr, elements, find, findAll, parse, text } from './support/mockup';
import { media } from './support/timeline';

const rows: MediaEntity[] = [{ ...media('med_a', '48000'), name: 'kick.wav' }, media('med_b', '96000')];

function view(over: Partial<PoolViewProps> = {}): PoolViewProps {
  return { media: rows, placingMediaId: null, canPlace: true, onPlace: () => undefined, onClose: () => undefined, t: translator('en'), ...over };
}

// The React elements below `node` whose props match.
function walk(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean, out: Array<ReactElement<Record<string, unknown>>> = []) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, match, out);
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (match(node)) out.push(node);
    walk(node.props.children as ReactNode, match, out);
  }
  return out;
}
const button = (node: ReactNode, testid: string) => walk(node, (el) => el.props['data-testid'] === testid)[0]!;

test('the Pool lists the session\'s media by name, the media id when it has none', () => {
  const root = find(parse(renderToStaticMarkup(<PoolView {...view()} />)), byAttr('data-testid', 'media-pool'));
  assert.equal(root.attrs.role, 'dialog');
  assert.equal(root.attrs['aria-label'], translator('en')('pool.title'));
  assert.equal(text(find(root, byAttr('data-testid', 'pool-med_a'))), 'kick.wav');
  assert.equal(text(find(root, byAttr('data-testid', 'pool-med_b'))), 'med_b');
  assert.equal(find(root, byAttr('data-testid', 'pool-med_a')).tag, 'button');
  assert.deepEqual(findAll(root, byAttr('aria-pressed', 'true')), []);
  // No data-part: the Pool is the app's, the mockup has none.
  assert.deepEqual(findAll(root, byAttr('data-part')), []);
});

test('the armed media is pressed; a click arms placing, a second click disarms it', () => {
  const armed = find(parse(renderToStaticMarkup(<PoolView {...view({ placingMediaId: 'med_b' })} />)), byAttr('data-testid', 'media-pool'));
  assert.equal(find(armed, byAttr('data-testid', 'pool-med_b')).attrs['aria-pressed'], 'true');
  assert.equal(find(armed, byAttr('data-testid', 'pool-med_a')).attrs['aria-pressed'], 'false');
  const calls: Array<string | null> = [];
  let closed = 0;
  const props = view({ onPlace: (id) => calls.push(id), onClose: () => (closed += 1) });
  (button(PoolView(props), 'pool-med_a').props.onClick as () => void)();
  assert.deepEqual([...calls], ['med_a']);
  const again = view({ placingMediaId: 'med_a', onPlace: (id) => calls.push(id), onClose: () => (closed += 1) });
  (button(PoolView(again), 'pool-med_a').props.onClick as () => void)();
  assert.deepEqual(calls, ['med_a', null]);
  // Arming hands the click to the event display: the Pool steps aside.
  assert.equal(closed, 2);
});

test('without clip.place the names are plain text', () => {
  const root = find(parse(renderToStaticMarkup(<PoolView {...view({ canPlace: false })} />)), byAttr('data-testid', 'media-pool'));
  assert.deepEqual(findAll(root, (el) => el.tag === 'button'), []);
  assert.deepEqual(findAll(root, (el) => (el.attrs['data-testid'] ?? '').startsWith('pool-')), []);
  assert.match(text(root), /kick\.wav/);
  assert.match(text(root), /med_b/);
  const list = find(root, (el) => el.tag === 'ul');
  assert.equal(elements(list).length, 2);
});

test('closed, the Pool is not rendered; open, it is', () => {
  const base = { media: rows, placingMediaId: null, canPlace: true, onPlace: () => undefined, onClose: () => undefined };
  assert.equal(renderToStaticMarkup(<Pool open={false} {...base} />), '');
  assert.match(renderToStaticMarkup(<Pool open {...base} />), /data-testid="media-pool"/);
});

test('Escape closes the Pool; other keys do not', () => {
  let closed = 0;
  const handler = poolKeyHandler(() => (closed += 1));
  let prevented = 0;
  handler({ key: 'a', preventDefault: () => (prevented += 1) });
  assert.equal(closed, 0);
  handler({ key: 'Escape', preventDefault: () => (prevented += 1) });
  assert.equal(closed, 1);
  assert.equal(prevented, 1);
});
