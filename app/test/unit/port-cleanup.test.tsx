// The component port, closed (m5-ui-port-cleanup; UI redesign 10.10, P1-17,
// and 10.9): no leftover component and no part of the mockup drawn twice.
//
// - Every module under app/src/renderer is reachable from index.tsx through
//   the import graph, so no orphan module is left from the markup before the
//   port; and every exported React component of a .tsx module is rendered by
//   the app: another module imports it, or its own module renders it.
// - The whole window, rendered with the zones' real components on the unit
//   fixtures (the read model's snapshot of support/timeline.ts and the plans
//   of support/mockup-plan.ts), carries each data-part id once and each
//   data-region once: no part of the mockup is rendered by two components.
//   Repeated components carry data-part-item, which repeats by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { CommandRegistry } from '../../src/renderer/keys/commands';
import { Mixer } from '../../src/renderer/mixer/Mixer';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { GestureController } from '../../src/renderer/model/gesture-controller';
import { LoopClickController, TransportStateStore } from '../../src/renderer/model/loop-click';
import type { PeaksCache } from '../../src/renderer/model/peaks-cache';
import { PlanStore } from '../../src/renderer/model/plan-store';
import type { ReadModel } from '../../src/renderer/model/read-model';
import type { RealtimeClient } from '../../src/renderer/model/realtime-client';
import { SessionClient } from '../../src/renderer/model/session-client';
import { TransportController } from '../../src/renderer/model/transport';
import { UndoHistory } from '../../src/renderer/model/undo-history';
import { namesFromSnapshot } from '../../src/renderer/plans/describe';
import { HearingSwitch } from '../../src/renderer/plans/HearingSwitch';
import { PlanPanelView } from '../../src/renderer/plans/PlanPanel';
import { CapabilitiesContext } from '../../src/renderer/shell/Capable';
import { Inspector } from '../../src/renderer/shell/Inspector';
import { createLayoutStore } from '../../src/renderer/shell/layout-store';
import { Shell } from '../../src/renderer/shell/Shell';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { Timeline } from '../../src/renderer/timeline/Timeline';
import { mockupPlans, mockupPreview, PENDING } from './support/mockup-plan';
import { sampleSnapshot } from './support/timeline';

// dist/test/unit -> app/src/renderer
const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');
const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;

function modules(dir: string = RENDERER): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modules(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const source = (file: string) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

// A relative specifier of `from` as the module file it names.
function resolveModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${path.relative(RENDERER, from)}: cannot resolve ${specifier}`);
}

// Every import of a module: `import ... from`, `export ... from`, a bare
// `import '...'` and a dynamic `import('...')`, with the names it imports.
function importsOf(file: string): Array<{ target: string; names: string[] }> {
  const text = source(file);
  const out: Array<{ target: string; names: string[] }> = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?([\w*\s{},]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveModule(file, m[2]!);
    if (!target) continue;
    const clause = m[1]!;
    const names = [...clause.replace(/\{([^}]*)\}/, (_, inner: string) => inner.replace(/\btype\s+/g, '')).matchAll(/(\w+)(?:\s+as\s+\w+)?/g)].map((n) => n[1]!);
    out.push({ target, names });
  }
  for (const m of text.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)) {
    const target = resolveModule(file, m[1]!);
    if (target) out.push({ target, names: [] });
  }
  return out;
}

test('every module of the renderer is reachable from index.tsx: no orphan is left from before the port', () => {
  const all = modules();
  assert.ok(all.length > 80, `${all.length} renderer modules`);
  const entry = path.join(RENDERER, 'index.tsx');
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const { target } of importsOf(queue.shift()!)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  assert.deepEqual(
    all.filter((file) => !seen.has(file)).map((file) => path.relative(RENDERER, file).replace(/\\/g, '/')),
    [],
    'modules no import chain from index.tsx reaches: delete them',
  );
});

test('every exported React component is rendered by the app: imported by another module, or rendered by its own', () => {
  const all = modules();
  const imported = new Map<string, Set<string>>();
  for (const file of all) {
    for (const { target, names } of importsOf(file)) {
      if (target === file) continue;
      const set = imported.get(target) ?? new Set<string>();
      for (const name of names) set.add(name);
      imported.set(target, set);
    }
  }
  const unused: string[] = [];
  let components = 0;
  for (const file of all.filter((f) => f.endsWith('.tsx'))) {
    const text = source(file);
    for (const m of text.matchAll(/\bexport\s+(?:function|const)\s+([A-Z]\w*)/g)) {
      const name = m[1]!;
      // A component is a function of props returning JSX; a context or a constant table is not.
      if (/Context$/.test(name) || /^[A-Z0-9_]+$/.test(name)) continue;
      components += 1;
      const renderedHere = new RegExp(`<${name}[\\s/>]`).test(text);
      if (!renderedHere && !imported.get(file)?.has(name)) unused.push(`${path.relative(RENDERER, file).replace(/\\/g, '/')}: ${name}`);
    }
  }
  assert.ok(components > 30, `${components} exported components`);
  assert.deepEqual(unused, [], 'exported components nothing renders: delete them');
});

// ---- the whole window, every zone's real component

function fakeModel(): ReadModel {
  const snapshot = sampleSnapshot();
  return {
    getSnapshot: () => snapshot,
    getView: () => ({ snapshot, gesture: null, overlaid: null }),
    select: (ref: string) => snapshot.entities[ref],
    subscribe: () => () => undefined,
  } as unknown as ReadModel;
}

function renderWindow(): string {
  const model = fakeModel();
  const snapshot = model.getSnapshot()!;
  const client = new SessionClient({
    createSocket: () => {
      throw new Error('no socket in this test');
    },
    currentEndpoint: async () => null,
    schedule: () => () => undefined,
    model,
  });
  const plans = new PlanStore();
  plans.setHeard('main');
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const loopClick = new LoopClickController({
    client,
    model,
    state: new TransportStateStore(client),
    deviceReady: () => false,
    capabilities: () => capabilitySelector(FULL),
    toasts,
    locale: () => 'en',
  });
  const gestures = {} as unknown as GestureController;
  const realtime = { subscribe: () => () => undefined } as unknown as RealtimeClient;
  const peaks = { get: () => undefined, subscribe: () => () => undefined } as unknown as PeaksCache;
  const commands = new CommandRegistry();
  const trackId = snapshot.trackOrder[0] ?? null;
  return renderToStaticMarkup(
    <CapabilitiesContext.Provider value={FULL}>
      <Shell
        client={client}
        plans={plans}
        engineStatus={{ getSnapshot: () => null, subscribe: () => () => undefined }}
        store={createLayoutStore({ storage: null })}
        commands={commands}
        platform="other"
        phase="online"
        toasts={toasts}
        realtime={null}
        transport={new TransportController({ client, playing: () => false, toasts, locale: () => 'en' })}
        loopClick={loopClick}
        history={new UndoHistory(client)}
        left={<Inspector client={client} gestures={gestures} trackId={trackId} />}
        project={<Timeline client={client} peaks={peaks} commands={commands} selectedTrackId={trackId} />}
        lower={<Mixer client={client} gestures={gestures} realtime={realtime} selectedTrackId={trackId} />}
        right={
          <PlanPanelView
            plans={mockupPlans()}
            heard="main"
            firstSeen={new Map([[PENDING, 0]])}
            nowMs={2 * 60_000}
            names={namesFromSnapshot(snapshot)}
            selected={null}
            ticked={null}
            note=""
            busy={false}
            error={null}
            preview={mockupPreview()}
            previewError={null}
            staleReasons={[]}
            rejecting={false}
            hotStep={null}
            onSelect={() => undefined}
            onTicked={() => undefined}
            onNote={() => undefined}
            onRun={() => undefined}
            onRejecting={() => undefined}
            onHotStep={() => undefined}
          />
        }
        rightHead={<HearingSwitch client={client} plans={plans} />}
      />
    </CapabilitiesContext.Provider>,
  );
}

const valuesOf = (markup: string, attr: string) => [...markup.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1]!);
const repeated = (values: string[]) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))].sort();

test('no part of the mockup is rendered by two components: each data-part and each data-region appears once in the window', () => {
  const markup = renderWindow();
  const regions = valuesOf(markup, 'data-region');
  assert.deepEqual([...regions].sort(), ['left-zone', 'lower-zone', 'project-zone', 'right-zone', 'status-bar', 'top-bar'], 'the six regions');
  assert.deepEqual(repeated(regions), [], 'a data-region rendered twice');
  const parts = valuesOf(markup, 'data-part');
  // Every zone rendered its component: a part of each is there.
  for (const id of ['transport', 'inspector-head', 'toolbar', 'track-list', 'event-display', 'mixer', 'lower-tabs', 'right-tabs', 'plan-card', 'status-engine']) assert.ok(parts.includes(id), `the window has ${id}`);
  assert.ok(parts.length > 50, `${parts.length} data-part ids`);
  assert.deepEqual(repeated(parts), [], 'a data-part rendered by two components (a repeated component carries data-part-item)');
  // The repeated components are there, more than once.
  const items = valuesOf(markup, 'data-part-item');
  for (const item of ['track', 'strip', 'plan-step']) assert.ok(items.filter((v) => v === item).length >= 2, `${item} repeats`);
});
