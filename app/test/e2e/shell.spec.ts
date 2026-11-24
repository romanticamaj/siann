// The Electron shell end to end (m0-electron-shell acceptance; M0 exit
// m0-exit-lifecycle): the app starts the real siann-engine
// (SIANN_ENGINE_EXE), the renderer connects with the token handshake, a
// killed engine is restarted and the renderer reconnects, and quitting the
// app ends the engine. Waits are Playwright condition waits with bounded
// timeouts; SIANN_SHELL_BACKOFF_MS sets the restart delay.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { matches, ownerOf, type Manifest } from './support/fidelity-core';
import { prepareBundle, stageSession } from './support/fidelity-session';
import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

function engineExe(): string {
  const exe = process.env.SIANN_ENGINE_EXE;
  if (!exe) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_ENGINE_EXE points at a missing file: ${exe}`);
  return exe;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let sessionDir: string;
let app: ElectronApplication;
let page: Page;

async function enginePid(): Promise<number | null> {
  return app.evaluate(() => {
    const shell = (globalThis as { __siannShell?: { pid(): number | null } }).__siannShell;
    return shell ? shell.pid() : null;
  });
}

async function launch(backoffMs: number, env: Record<string, string> = {}): Promise<void> {
  app = await launchElectron({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: engineExe(),
      SIANN_SESSION_DIR: sessionDir,
      SIANN_SHELL_BACKOFF_MS: String(backoffMs),
      SIANN_SHELL_TEST: '1',
      ...env,
    },
  });
  page = await app.firstWindow();
}

test.beforeEach(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-shell-'));
  await launch(50);
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = '';
});

test('the renderer connects with the token handshake', async () => {
  expect(page.url()).toMatch(/^siann:\/\/app\//);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('session-id')).toHaveText(/^ses_[0-9a-f]+$/);
  await expect(page.getByTestId('revision')).toHaveText(/^r\d+$/);
  await expect(page.getByTestId('about')).toContainText('siann-engine');
  await expect(page.getByTestId('about')).toContainText(/(A?GPL)-\d\.\d-or-later/);
  // The new session was created where the shell was told.
  expect(fs.existsSync(path.join(sessionDir, 'Untitled.siann'))).toBe(true);

  // What the window really runs with. Probing the page cannot show this:
  // contextIsolation hides Node from the main world even with nodeIntegration on.
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const last = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences();
    return {
      contextIsolation: last?.contextIsolation,
      nodeIntegration: last?.nodeIntegration,
      sandbox: last?.sandbox,
    };
  });
  expect(preferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  // The preload bridge exposes the engine endpoint and, since m5b-ui-project,
  // the shell's project record and dialogs and the menu's two directions,
  // since m5b-ui-media the audio file dialog and a dropped file's path, since
  // m5b-ui-recording a recording's start and end for the power-save blocker,
  // and nothing else; the MCP token stays in the main process.
  const bridge = await page.evaluate(async () => {
    const siann = (window as unknown as { siann: Record<string, Record<string, unknown>> }).siann;
    const engine = siann.engine as { current(): Promise<Record<string, unknown> | null> };
    const current = await engine.current();
    return {
      top: Object.keys(siann),
      engine: Object.keys(siann.engine),
      project: Object.keys(siann.project ?? {}),
      menu: Object.keys(siann.menu ?? {}),
      media: Object.keys(siann.media ?? {}),
      power: Object.keys(siann.power ?? {}),
      current: current ? Object.keys(current) : null,
    };
  });
  expect([...bridge.top].sort()).toEqual(['engine', 'media', 'menu', 'power', 'project']);
  expect([...bridge.project].sort()).toEqual(['chooseNew', 'chooseOpen', 'onChange', 'opened', 'state']);
  expect([...bridge.menu].sort()).toEqual(['onCommand', 'set']);
  expect([...bridge.engine].sort()).toEqual(['current', 'onChange']);
  expect([...bridge.media].sort()).toEqual(['choose', 'pathForFile']);
  expect([...bridge.power]).toEqual(['recording']);
  expect([...(bridge.current ?? [])].sort()).toEqual(['port', 'token']);
});

async function killEngineAndExpectReconnect(): Promise<void> {
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const firstSession = await page.getByTestId('session-id').textContent();
  const firstPid = await enginePid();
  expect(firstPid).not.toBeNull();

  // Record every status the renderer shows from here on, so a short
  // "disconnected" between kill and reconnect is not missed.
  await page.evaluate(() => {
    const status = document.querySelector('[data-testid="status"]')!;
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    // The connection state as the status bar carries it (its words are the mockup's).
    new MutationObserver(() => seen.push(status.getAttribute('data-status') ?? '')).observe(status, {
      attributes: true,
      attributeFilter: ['data-status'],
    });
  });

  process.kill(firstPid!);

  await expect.poll(async () => isAlive(firstPid!)).toBe(false);
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses))
    .toContain('disconnected');
  await expect.poll(enginePid).not.toBe(firstPid);
  await expect.poll(enginePid).not.toBeNull();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  // A new engine with a new per-launch token was accepted: the shell handed
  // the renderer the new pair.
  await expect(page.getByTestId('session-id')).toHaveText(/^ses_[0-9a-f]+$/);
  await expect(page.getByTestId('session-id')).not.toHaveText(firstSession ?? '');
  const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  expect(statuses.indexOf('disconnected')).toBeLessThan(statuses.lastIndexOf('connected'));
}

// m5-ui-alignment-chrome: the page takes ui/base.css's text styles, and the
// zones not ported yet keep the ones they had (the old page rule: line height
// --line-height, no letter spacing, tabular numerals, no font features), so
// the regions look as they did until their alignment features port them. An
// element of a zone that sets one of these itself keeps its own value; every
// other inherits the zone's. The ported zones are out of that rule: the lower
// zone (m5-ui-port-mixer-strip), the left zone (m5-ui-port-inspector), the
// right zone (m5-ui-port-plans, the Plans tab) and the project zone (its
// canvas, track list, toolbar and info line; m5-ui-port-toolbar the last)
// take ui/base.css's page, as the mockup does (UI redesign 10.9 (1)), so no
// zone keeps the pinned styles now. The zone buttons are the mockup's icon
// buttons, named by their aria-label.
test('the chrome and the ported lower, left, right and project zones take the mockup\'s text styles', async () => {
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const styles = await page.evaluate(() => {
    const pick = (el: Element) => {
      const s = getComputedStyle(el);
      return { ls: s.letterSpacing, lh: s.lineHeight, fs: parseFloat(s.fontSize), fvn: s.fontVariantNumeric, ffs: s.fontFeatureSettings };
    };
    const lineHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--line-height'));
    // No zone is left unported (m5-ui-port-toolbar).
    const zones = ([] as string[]).map((zone) => ({ zone, ...pick(document.querySelector(`[data-zone="${zone}"]`)!) }));
    const right = pick(document.querySelector('[data-zone="right"]')!);
    // ui/base.css's body: the line height as a factor, the letter spacing in em.
    const body = getComputedStyle(document.body);
    const bodyLh = parseFloat(body.lineHeight) / parseFloat(body.fontSize);
    const bodyLs = parseFloat(body.letterSpacing) / parseFloat(body.fontSize);
    // Inherited values: the pinned element's own, through every element that does not set them.
    const offenders: string[] = [];
    for (const zone of document.querySelectorAll('[data-zone]:not([data-zone="right"]):not([data-zone="lower"]):not([data-zone="left"]):not([data-zone="project"])')) {
      for (const el of zone.querySelectorAll('*')) {
        const s = pick(el);
        if (s.ls !== 'normal' && s.ls !== '0px') offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} letter-spacing ${s.ls}`);
        if (s.ffs !== 'normal') offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} font-feature-settings ${s.ffs}`);
      }
    }
    const ported = [
      ...['lower', 'left', 'project'].map((zone) => ({ zone, ...pick(document.querySelector(`[data-zone="${zone}"]`)!) })),
      { zone: 'track list', ...pick(document.querySelector('[data-zone="project"] .headers')!) },
    ];
    return { zones, right, bodyLh, bodyLs, lineHeight, offenders, body: pick(document.body), ported };
  });
  for (const zone of styles.zones) {
    expect(zone.ls, zone.zone).toBe('normal');
    expect(zone.ffs, zone.zone).toBe('normal');
    expect(zone.fvn, zone.zone).toBe('tabular-nums');
    expect(parseFloat(zone.lh), zone.zone).toBeCloseTo(zone.fs * styles.lineHeight, 1);
  }
  expect(styles.offenders).toEqual([]);
  // The right zone: the page's text styles, not the pinned ones.
  expect(styles.right.ffs).toBe(styles.body.ffs);
  expect(styles.right.fvn).toBe(styles.body.fvn);
  expect(styles.right.ls).not.toBe('normal');
  expect(parseFloat(styles.right.ls)).toBeCloseTo(styles.right.fs * styles.bodyLs, 2);
  expect(parseFloat(styles.right.lh)).toBeCloseTo(styles.right.fs * styles.bodyLh, 1);
  // The chrome: ui/base.css's page.
  expect(styles.body.ffs).not.toBe('normal');
  expect(styles.body.ls).not.toBe('normal');
  // The lower, left and project zones: the page's letter spacing, font
  // features, numerals and line height (base.css's body), none of the pinned
  // pre-port ones.
  for (const zone of styles.ported) {
    expect(zone.ls, zone.zone).toBe(styles.body.ls);
    expect(zone.ffs, zone.zone).toBe(styles.body.ffs);
    expect(zone.fvn, zone.zone).toBe(styles.body.fvn);
    expect(parseFloat(zone.lh) / zone.fs, zone.zone).toBeCloseTo(parseFloat(styles.body.lh) / styles.body.fs, 2);
  }
  // The zone buttons: icon buttons with names, the Channel zone's first (m5b-ui-editor-channel).
  await expect(page.locator('[data-part="zone-buttons"] > button')).toHaveCount(4);
  for (const zone of ['channel', 'left', 'lower', 'right']) {
    const button = page.getByTestId(`zone-button-${zone}`);
    await expect(button).toHaveClass(/\biconbtn\b/);
    await expect(button).toHaveAttribute('aria-label', /\S/);
    await expect(button).toHaveText('');
  }
});

test('a killed engine is restarted and the renderer reconnects', async () => {
  await killEngineAndExpectReconnect();
});

// The renderer's own retry runs once, 250 ms after the socket closes, and finds
// no engine when the restart takes longer. Only onChange can reconnect it then.
test('a restart slower than the renderer retry reconnects through onChange', async () => {
  await app.close();
  await launch(1_000);
  await killEngineAndExpectReconnect();
});

let statusCalls = 0;

// What engine.status says about the device of the engine the renderer is on.
async function deviceId(): Promise<string | null> {
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  if (endpoint === null) return null;
  const sessionId = await page.getByTestId('session-id').textContent();
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
  try {
    const replies: string[] = [];
    let wake = () => {};
    socket.addEventListener('message', (event) => {
      replies.push(String(event.data));
      wake();
    });
    const reply = async (): Promise<Record<string, unknown>> => {
      while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return JSON.parse(replies.shift()!) as Record<string, unknown>;
    };
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    socket.send(JSON.stringify({ type: 'auth', token: endpoint.token }));
    await reply();
    // A new id each time: the server answers a repeated one from its idempotency cache.
    const requestId = `req_status_${++statusCalls}`;
    socket.send(JSON.stringify({ requestId, sessionId, method: 'engine.status', params: {} }));
    for (;;) {
      const message = await reply();
      if (message.requestId !== requestId) continue;
      const result = message.result as { device: { id: string } | null };
      return result.device?.id ?? null;
    }
  } finally {
    socket.close();
  }
}

// The shell restarts an engine that exits; an engine that serves without its device
// retries under the backoff the shell handed it (spec, "Process model").
test('an engine relaunched after a crash reopens a device that was still held', async () => {
  await app.close();
  await launch(50, { SIANN_ENGINE_TEST_ARGS: '--device fake --fake-open-failures 3' });
  await killEngineAndExpectReconnect();
  await expect.poll(deviceId, { timeout: 15_000 }).toBe('fake');
});

test('quitting the app ends the engine', async () => {
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const pid = await enginePid();
  expect(pid).not.toBeNull();
  expect(isAlive(pid!)).toBe(true);

  await app.close();

  await expect.poll(() => isAlive(pid!)).toBe(false);
});

// The engine's death alone cannot show that quit stopped it: children die with
// Electron on Windows, and stdin EOF ends the engine on POSIX. The order can.
test('quitting stops the engine first and only then quits', async () => {
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const orderFile = path.join(sessionDir, 'quit-order.log');
  await app.evaluate(({ app: electronApp }, file) => {
    const write = (line: string) => process.getBuiltinModule('node:fs').appendFileSync(file, `${line}\n`);
    const shell = (globalThis as unknown as { __siannShell: NodeJS.EventEmitter }).__siannShell;
    shell.on('exit', (exit: { restartInMs: number | null }) => write(`engine exit, restart in ${exit.restartInMs}`));
    electronApp.on('will-quit', () => write('will-quit'));
  }, orderFile);

  await app.close();

  expect(fs.readFileSync(orderFile, 'utf8').trim().split(/\r?\n/)).toEqual(['engine exit, restart in null', 'will-quit']);
});

// m5-ui-port-cleanup (acceptance 4; UI redesign 3.0): on the mockup's own
// session (support/fidelity-session.ts, the fidelity run's), the whole window
// carries no id of a part whose gate is pending in the manifest, and every id
// the mockup's markup names outright whose part has landed (its gate report)
// and whose content is not dynamic is in the DOM.
test('the whole window has no id of a pending part and every landed id of the mockup, derived from the manifest', async () => {
  test.setTimeout(240_000);
  await app.close();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-shell-fidelity-'));
  try {
    const bundleDir = prepareBundle(scratch);
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'test', 'fidelity', 'manifest.json'), 'utf8')) as Manifest & { environment: unknown };
    await launch(50, {
      SIANN_SESSION_DIR: bundleDir,
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      // The test plugin's directory, for the mockup's insert racks (m5b-ui-inserts-master).
      SIANN_ENGINE_TEST_ARGS: JSON.stringify(['--device', 'fake', ...(process.env.SIANN_TEST_PLUGIN_CLAP ? ['--plugin-dir', path.dirname(process.env.SIANN_TEST_PLUGIN_CLAP)] : [])]),
      SIANN_FIDELITY_ENVIRONMENT: JSON.stringify(manifest.environment),
    });
    const view = { width: manifest.viewport.width, height: manifest.viewport.height };
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), view);
    await page.setViewportSize(view);
    const notes: string[] = [];
    await stageSession(app, page, notes);
    // Every id in the DOM, as the fidelity run names them (collectDom): the
    // regions, the parts, and the repeated items with their data-part-of children.
    const shown = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll('[data-region]'))) out.push(el.getAttribute('data-region')!);
      for (const el of Array.from(document.querySelectorAll('[data-part]'))) out.push(el.getAttribute('data-part')!);
      const counts = new Map<string, number>();
      for (const item of Array.from(document.querySelectorAll('[data-part-item]'))) {
        const name = item.getAttribute('data-part-item')!;
        let key = item.getAttribute('data-part-key');
        if (!key) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          key = String(counts.get(name));
        }
        out.push(`${name}-${key}`);
        for (const child of Array.from(item.querySelectorAll('[data-part-of]'))) {
          if (child.closest('[data-part-item]') === item) out.push(`${name}-${key}-${child.getAttribute('data-part-of')}`);
        }
      }
      return out;
    });
    expect(shown.length).toBeGreaterThan(200);
    const mode = (id: string) => {
      const owner = ownerOf(manifest, id);
      expect(owner, `a manifest rule owns ${id}`).not.toBeNull();
      return owner!.mode;
    };
    expect(shown.filter((id) => mode(id) === 'pending'), 'ids of pending parts in the window').toEqual([]);
    // The ids the mockup's markup names outright (dp() and dr()), landed and not dynamic.
    const mockup = fs.readFileSync(path.join(APP_DIR, '..', manifest.mockup), 'utf8');
    const named = [...new Set([...mockup.matchAll(/\$\{d[pr]\('([a-z0-9-]+)'\)\}/g)].map((m) => m[1]!))];
    const landed = named.filter((id) => mode(id) === 'report' && !matches(manifest.pixels.dynamic, id));
    expect(landed.length).toBeGreaterThan(60);
    expect(named.filter((id) => mode(id) === 'pending').length).toBeGreaterThan(10);
    expect(landed.filter((id) => !shown.includes(id)), 'landed ids of the mockup missing from the window').toEqual([]);
    // The ids the mockup's markup computes: a plan step that names a clip
    // (step()'s sixth argument true) wraps its title in plan-step-N-title
    // (m5b-ui-media). Checked for presence whether or not pixels.dynamic masks
    // them (it masks plan-step-2-title's pixels only).
    const titled = [...mockup.matchAll(/\$\{step\((\d+),.*,(?:true|false),true\)\}/g)].map((m) => `plan-step-${m[1]!}-title`);
    expect(titled).toEqual(['plan-step-2-title', 'plan-step-6-title']);
    expect(titled.filter((id) => mode(id) === 'report')).toEqual(titled);
    expect(titled.filter((id) => !shown.includes(id)), 'computed ids of the mockup missing from the window').toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
