// The start view (m5b-ui-project; UI redesign UR-4): shown over the zones
// when the shell has no bundle to start on, with New, Open and the recent
// list (each row the bundle's name over its path). It needs the shell (its
// folder dialogs and its record), so without the shell port, as in a plain
// browser tab, it is absent (UI redesign 3.0). The mockup has no start view:
// its markup is the app's own, styled in shell.css from existing tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { translator } from '../../src/renderer/i18n/t';
import { ProjectController, type ShellPort, type ShellProjectState } from '../../src/renderer/model/project';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { StartView } from '../../src/renderer/shell/StartView';

const CAPS = { methods: ['session.create', 'session.open', 'session.save'] };
const RECENT = [
  { path: path.resolve('/music/Night Drive.siann'), name: 'Night Drive' },
  { path: path.resolve('/music/Demo.siann'), name: 'Demo' },
];

function shellWith(state: Partial<ShellProjectState>): ShellPort {
  const full: ShellProjectState = { current: null, startView: true, recent: RECENT, ...state };
  return { state: async () => full, chooseNew: async () => null, chooseOpen: async () => null, opened: () => undefined, onChange: () => undefined };
}

const client = { request: async () => ({}) };

async function render(shell: ShellPort | null, caps: unknown = CAPS): Promise<string> {
  const project = new ProjectController({ client, shell, locale: () => 'en' });
  await project.start();
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={caps as never}>
      <StartView project={project} />
    </CapabilitiesContext.Provider>,
  );
}

test('the start view has New, Open and the recent rows', async () => {
  const t = translator('en');
  const markup = await render(shellWith({}));
  assert.match(markup, /^<div class="start-view" data-region="start-view" data-testid="start-view"/);
  assert.ok(markup.includes(`>${t('start.title')}</h2>`));
  assert.match(markup, new RegExp(`<button type="button"[^>]*data-testid="start-new"[^>]*>${t('menu.newProject')}</button>`));
  assert.match(markup, new RegExp(`<button type="button"[^>]*data-testid="start-open"[^>]*>${t('menu.open')}</button>`));
  assert.ok(markup.includes(`>${t('start.recent')}</h3>`));
  for (const [i, entry] of RECENT.entries()) {
    const at = markup.indexOf(`data-testid="start-recent-${i + 1}"`);
    assert.ok(at >= 0, entry.name);
    const row = markup.slice(at, markup.indexOf('</button>', at));
    assert.ok(row.includes(`>${entry.name}<`) && row.includes(`>${entry.path}<`), row);
  }
});

test('no recent bundle: the list says so', async () => {
  const markup = await render(shellWith({ recent: [] }));
  assert.ok(markup.includes(translator('en')('start.noRecent')));
  assert.ok(!markup.includes('data-testid="start-recent-1"'));
});

test('absent without the shell port, when the shell has a bundle, and without session.create and session.open', async () => {
  assert.equal(await render(null), '');
  assert.equal(await render(shellWith({ startView: false, current: RECENT[0]!.path })), '');
  // An engine without session.create: no New button; without session.open: no Open and no rows.
  const noCreate = await render(shellWith({}), { methods: ['session.open'] });
  assert.ok(!noCreate.includes('start-new') && noCreate.includes('start-open'));
  const noOpen = await render(shellWith({}), { methods: ['session.create'] });
  assert.ok(noOpen.includes('start-new') && !noOpen.includes('start-open') && !noOpen.includes('start-recent-1'));
});
