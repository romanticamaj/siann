// The lower zone's Editor tab (m5b-ui-editor-channel; UI redesign 2.1, 5.2,
// UR-18). The mockup draws the tab's label only; the body is built from the
// shared rules and existing tokens: with no clip selected a line of text
// from the catalogs says so (no placeholder control); with one, the sample
// editor's two stacked canvases (the content layer below, the overlay that
// takes the pointer on top), in a container the surface sizes them to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { EditorTab } from '../../src/renderer/editor/EditorTab';
import type { Locale, LocaleStore } from '../../src/renderer/i18n/locale';
import { installLocaleStore, localeStore, translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import type { Snapshot } from '../../src/renderer/model/read-model';
import type { SessionClient } from '../../src/renderer/model/session-client';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { sampleSnapshot } from './support/timeline';

function client(snapshot: Snapshot | null): SessionClient {
  const model = { getSnapshot: () => snapshot, subscribe: () => () => undefined, select: (ref: string) => snapshot?.entities[ref] };
  return { model, getState: () => ({ status: 'connected', capabilities: null }), subscribe: () => () => undefined, execute: async () => undefined } as unknown as SessionClient;
}

const peaks = { get: () => null, subscribe: () => () => undefined } as unknown as PeaksCache;

function render(clipId: string | null, locale?: Locale): string {
  const before = localeStore();
  if (locale) installLocaleStore({ subscribe: () => () => undefined, getSnapshot: () => locale, setLocale: () => undefined } as unknown as LocaleStore);
  try {
    return renderToStaticMarkup(
      <EditorTab client={client(sampleSnapshot())} peaks={peaks} clipId={clipId} layout={createLayoutStore({ storage: null })} commands={new CommandRegistry()} platform="other" />,
    );
  } finally {
    installLocaleStore(before);
  }
}

test('with no clip selected the tab says so in the catalog\'s words, and draws nothing', () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const markup = render(null, locale);
    assert.match(markup, /^<p class="editor-empty" data-testid="editor-empty">([^<]+)<\/p>$/, locale);
    assert.equal(/>([^<]+)</.exec(markup)![1], translator(locale)('editor.none'), locale);
    assert.ok(!markup.includes('<canvas'), locale);
  }
  // A clip that is gone reads the same.
  assert.match(render('clp_gone'), /data-testid="editor-empty"/);
});

test('with a clip the tab holds the editor\'s two canvases, the overlay on top', () => {
  const markup = render('clp_1');
  const editor = /<div class="editor"[^>]*>([\s\S]*)<\/div>$/.exec(markup);
  assert.ok(editor, markup);
  assert.match(editor[0], /data-testid="editor"/);
  assert.match(editor[0], /data-clip="clp_1"/);
  assert.match(editor[0], /role="group"/);
  assert.match(editor[0], /aria-label="[^"]+"/);
  const canvases = [...editor[1]!.matchAll(/<canvas class="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(canvases, ['editor-content', 'editor-overlay']);
});
