// The status bar's about line (m5-ui-shell; UI redesign spec 2.1, "Licence
// line"; ADR-0017 point 4): built only from engine.about and the auth reply.
// Rendered with react-dom/server for both licences the engine build can
// report: every value appears exactly as given, the commit as its first 12
// characters (with +dirty for a dirty tree), and nothing when there is no
// about yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AboutInfo } from '../../src/renderer/model/session-client';
import { SessionClient } from '../../src/renderer/model/session-client';
import { AboutLine, StatusBar } from '../../src/renderer/shell/StatusBar';

const DESKTOP: AboutInfo = {
  name: 'siann-engine',
  version: '0.4.2',
  license: 'AGPL-3.0-or-later',
  source: { url: 'https://example.invalid/siann/desktop', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: true },
};
const PLAIN: AboutInfo = {
  name: 'siann-engine-headless',
  version: '1.0.0-rc.1',
  license: 'GPL-2.0-or-later',
  source: { url: 'https://example.invalid/siann/plain', commit: '9876543210fedcba9876543210fedcba98765432', dirty: false },
};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

test('the about line shows name, version, commit, licence and source URL exactly as the engine reports them', () => {
  for (const [about, commit] of [
    [DESKTOP, 'abcdef012345+dirty'],
    [PLAIN, '9876543210fe'],
  ] as const) {
    const shown = text(renderToStaticMarkup(<AboutLine about={about} />));
    for (const part of [about.name!, about.version!, commit, about.license!, about.source!.url!]) {
      assert.ok(shown.includes(part), `${JSON.stringify(shown)} lacks ${part}`);
    }
    assert.ok(!shown.includes(about.source!.commit!), 'the full commit is not shown');
  }
  // Each licence only where the engine reported it.
  assert.ok(!text(renderToStaticMarkup(<AboutLine about={PLAIN} />)).includes('AGPL'));
  assert.ok(!text(renderToStaticMarkup(<AboutLine about={DESKTOP} />)).includes('GPL-2.0'));
});

test('no about renders no licence text', () => {
  const markup = renderToStaticMarkup(<AboutLine about={null} />);
  assert.ok(!/GPL|licen[cs]e/i.test(markup), markup);
  // The whole bar while disconnected: the status, no licence.
  const client = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
  });
  const bar = renderToStaticMarkup(<StatusBar client={client} />);
  assert.match(bar, /data-testid="status"[^>]*data-status="disconnected"/);
  assert.match(bar, /data-testid="about"/);
  assert.ok(!/GPL/.test(bar), bar);
});
