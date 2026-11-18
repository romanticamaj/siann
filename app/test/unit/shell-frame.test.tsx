// The window's frame (m5-ui-alignment-chrome; UI redesign 2.1-2.4, mockup.html
// and ui/layout.css): Shell renders the mockup's .app grid, whose direct
// children are the regions, in the mockup's order: .topbar, .leftzone,
// .center (the project zone over the lower zone), .plans and .statusbar. The
// zone sizes reach the grid as custom properties from the layout store
// (--left-zone-w, --right-zone-w, --lower-zone-h; 0 for a hidden zone), the
// dividers are positioned absolutely so they add no grid item, and the
// data-region ids are unchanged. No panel library sits between .app and its
// regions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector } from '../../src/renderer/model/capabilities';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import { PlanStore } from '../../src/renderer/model/plan-store';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { UndoHistory } from '../../src/renderer/model/undo-history';
import { createLayoutStore, type LayoutStore } from '../../src/renderer/shell/layout-store';
import { Shell } from '../../src/renderer/shell/Shell';
import { ToastStore } from '../../src/renderer/shell/toast-store';

function render(store: LayoutStore = createLayoutStore({ storage: null })): string {
  const client = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
  });
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const loopClick = new LoopClickController({
    client,
    model: client.model,
    state: new TransportStateStore(client),
    deviceReady: () => false,
    capabilities: () => capabilitySelector(null),
    toasts,
    locale: () => 'en',
  });
  return renderToStaticMarkup(
    <Shell
      client={client}
      plans={new PlanStore()}
      engineStatus={{ getSnapshot: () => null, subscribe: () => () => undefined }}
      store={store}
      commands={new CommandRegistry()}
      platform="other"
      phase="online"
      toasts={toasts}
      realtime={null}
      transport={new TransportController({ client, playing: () => false, toasts, locale: () => 'en' })}
      loopClick={loopClick}
      history={new UndoHistory(client)}
      left={<p>left</p>}
      project={<p>project</p>}
      lower={<p>lower</p>}
      right={<p>right</p>}
    />,
  );
}

// The direct children of the first element whose opening tag matches `open`.
function children(markup: string, open: RegExp): string[] {
  const at = markup.search(open);
  assert.ok(at >= 0, `${open} in ${markup.slice(0, 400)}`);
  const out: string[] = [];
  let depth = 0;
  const re = /<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>/g;
  re.lastIndex = at;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const [whole, close, tag, attrs] = m;
    const voidTag = /^(input|br|img|meta|link)$/.test(tag!) || whole.endsWith('/>');
    if (close) {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      const cls = /\sclass="([^"]*)"/.exec(attrs!)?.[1] ?? '';
      const region = /\sdata-region="([^"]*)"/.exec(attrs!)?.[1];
      out.push(`${tag}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}${region ? `[${region}]` : ''}`);
    }
    if (!voidTag) depth += 1;
  }
  return out;
}

test('Shell renders the mockup\'s .app grid with the six regions in its order', () => {
  const markup = render();
  const app = /<div class="app"[^>]*>/.exec(markup)?.[0];
  assert.ok(app, markup.slice(0, 300));
  assert.match(app, /data-testid="shell"/);
  // The grid's direct children in the flow: the mockup's five (and, out of the
  // flow, the dividers, the banner row and the toasts).
  const inFlow = children(markup, /<div class="app"/).filter((child) => !/\.(divider|shell-banner|toasts)\b/.test(child));
  assert.deepEqual(inFlow.map((child) => child.replace(/\.(zone-[a-z]+|zone)(?=[.[]|$)/g, '')), [
    'header.topbar[top-bar]',
    'aside.leftzone[left-zone]',
    'main.center',
    'aside.plans[right-zone]',
    'footer.statusbar[status-bar]',
  ]);
  // .center: the project zone, then the lower zone.
  const center = children(markup, /<main class="center"/);
  assert.deepEqual(
    center.filter((child) => child.includes('[')).map((child) => /\[(.*)\]/.exec(child)![1]),
    ['project-zone', 'lower-zone'],
  );
  // Nothing else takes a grid cell: every other child of .app is out of the flow.
  for (const child of children(markup, /<div class="app"/).filter((c) => !c.includes('[') && c !== 'main.center')) {
    assert.match(child, /\.(divider|shell-banner|toasts)\b/, child);
  }
  // No panel library's wrappers.
  assert.ok(!/data-panel|data-separator|data-group/.test(markup), 'no react-resizable-panels markup');
});

test('the zone sizes reach the grid as custom properties; a hidden zone is 0', () => {
  const store = createLayoutStore({ storage: null });
  const open = /<div class="app"[^>]*style="([^"]*)"/.exec(render(store))![1]!;
  assert.match(open, /--left-zone-w:216px/);
  assert.match(open, /--right-zone-w:348px/);
  assert.match(open, /--lower-zone-h:280px/);
  store.dispatch({ type: 'toggle', zone: 'left', viewport: { width: 1440, height: 900 } });
  store.dispatch({ type: 'toggle', zone: 'lower', viewport: { width: 1440, height: 900 } });
  const closed = /<div class="app"[^>]*style="([^"]*)"/.exec(render(store))![1]!;
  assert.match(closed, /--left-zone-w:0px/);
  assert.match(closed, /--lower-zone-h:0px/);
  assert.match(closed, /--right-zone-w:348px/);
});

test('the zones keep their ids, focus attributes and dividers, positioned out of the grid', () => {
  const markup = render();
  for (const zone of ['left', 'project', 'lower', 'right']) {
    assert.match(markup, new RegExp(`data-testid="zone-${zone}" data-region="${zone}-zone" data-zone="${zone}"`), zone);
  }
  for (const zone of ['left', 'lower', 'right']) {
    const divider = new RegExp(`<div[^>]*data-testid="separator-${zone}"[^>]*>`).exec(markup)?.[0];
    assert.ok(divider, zone);
    assert.match(divider, /role="separator"/);
    assert.match(divider, /tabindex="0"/);
    assert.match(divider, new RegExp(`class="divider divider-${zone}"`));
    assert.match(divider, /aria-valuenow="\d+"/);
  }
  const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'renderer', 'shell.css'), 'utf8');
  assert.match(css, /\.divider-left, \.divider-right, \.divider-lower \{ position: absolute; \}/);
  // The dependency is gone.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.ok(!('react-resizable-panels' in pkg.dependencies));
});

// m5-ui-port-cleanup (UI redesign 10.9, 1): the project zone is the mockup's
// section.arrange, whose rows (toolbar, info line, arrange body) and focus
// frame are the shared rules'; the zone's content is its direct child, with
// no app body between them. The other zones keep their body, the app's
// scroll wrapper (10.10).
test('the project zone is the mockup\'s section.arrange, with its content as its direct children', () => {
  const markup = render();
  const project = /<section class="([^"]*)"[^>]*data-region="project-zone"[^>]*>/.exec(markup);
  assert.ok(project, 'the project zone');
  assert.deepEqual(project[1]!.split(/\s+/), ['arrange', 'zone', 'zone-project']);
  assert.deepEqual(children(markup, /<section class="arrange[^"]*"[^>]*data-region="project-zone"/), ['p']);
  assert.ok(!markup.includes('data-testid="zone-project-body"'), 'no app body in the project zone');
  for (const zone of ['left', 'lower', 'right']) assert.ok(markup.includes(`data-testid="zone-${zone}-body"`), zone);
});

// m5-ui-port-mixer-strip (UI redesign 10.10, P1-12): the lower zone is the
// mockup's section.lower, and its tab row is the mockup's .tabs with the
// MixConsole tab (icon, label, the key); the Editor tab and the rack
// switches are pending (m5b-ui-editor-channel, m5b-ui-inserts-master) and
// absent. The right zone's row waits for m5-ui-port-plans.
test('the lower zone takes the mockup\'s .lower and .tabs with the MixConsole tab; the right zone\'s row is unchanged', () => {
  const markup = render();
  const lower = /<section class="([^"]*)"[^>]*data-region="lower-zone"[^>]*>/.exec(markup);
  assert.ok(lower, 'the lower zone');
  assert.ok(lower[1]!.split(/\s+/).includes('lower'), lower[1]);
  const row = children(markup, /<section class="[^"]*"[^>]*data-region="lower-zone"/)[0]!;
  assert.equal(row, 'div.tabs');
  const tabs = /<div class="tabs"[^>]*>([\s\S]*?)<\/div>/.exec(markup)!;
  assert.match(tabs[0], /data-part="lower-tabs"/);
  assert.match(tabs[0], /role="tablist"/);
  const tab = /<button[^>]*data-part="tab-mixconsole"[^>]*>([\s\S]*?)<\/button>/.exec(tabs[1]!)!;
  assert.ok(tab, 'the MixConsole tab');
  assert.match(tab[0], /class="tab on"/);
  assert.match(tab[0], /role="tab"/);
  assert.match(tab[0], /aria-selected="true"/);
  assert.match(tab[0], /data-testid="tab-lower-mixconsole"/);
  // The mockup's ic('sliders','s'), the label, then the key in a kbd.
  assert.match(tab[1]!, /^<svg class="i s" viewBox="0 0 16 16"[^>]*>[\s\S]*<\/svg>MixConsole <kbd>Alt\+F3<\/kbd>$/);
  assert.ok(!markup.includes('data-part="tab-editor"'), 'tab-editor is pending');
  // m5b-ui-inserts-master: the spacer, then the rack switches; with no capabilities known
  // (this render) the switches are not in the DOM and the row ends at its spacer.
  assert.ok(!markup.includes('data-part="mixer-racks"'), 'no rack switch without features.plugins');
  assert.match(tabs[1]!, /<\/button><span class="spacer"><\/span>$/);
  // The right zone's row is the mockup's .p-head since m5-ui-port-plans.
  assert.match(markup, /<div class="p-head" role="tablist" data-part="right-tabs">/);
  assert.ok(!markup.includes('class="zone-tabs"'), 'no .zone-tabs row is left');
});
