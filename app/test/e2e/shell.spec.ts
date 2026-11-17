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
  // The preload bridge exposes the engine endpoint and nothing else; the MCP
  // token stays in the main process.
  const bridge = await page.evaluate(async () => {
    const siann = (window as unknown as { siann: Record<string, Record<string, unknown>> }).siann;
    const engine = siann.engine as { current(): Promise<Record<string, unknown> | null> };
    const current = await engine.current();
    return { top: Object.keys(siann), engine: Object.keys(siann.engine), current: current ? Object.keys(current) : null };
  });
  expect(bridge.top).toEqual(['engine']);
  expect([...bridge.engine].sort()).toEqual(['current', 'onChange']);
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
// other inherits the zone's. The zone buttons are the mockup's icon buttons,
// named by their aria-label. The lower zone, the left zone and the right zone
// are ported (m5-ui-port-mixer-strip, m5-ui-port-inspector, m5-ui-port-plans;
// UI redesign 10.9 (1)): they take ui/base.css's page, as the mockup does. In
// the project zone the arrange body is ported (m5-ui-port-arrange-canvas,
// m5-ui-port-track-list): the track list takes the page's text styles, and
// only the toolbar and the info line keep the pinned ones until
// m5-ui-port-toolbar.
test('the zones not ported yet keep their text styles; the chrome, the ported lower, left and right zones and the track list take the mockup's', async () => {
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  const styles = await page.evaluate(() => {
    const pick = (el: Element) => {
      const s = getComputedStyle(el);
      return { ls: s.letterSpacing, lh: s.lineHeight, fs: parseFloat(s.fontSize), fvn: s.fontVariantNumeric, ffs: s.fontFeatureSettings };
    };
    const lineHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--line-height'));
    const zones = [
      { zone: 'toolbar', ...pick(document.querySelector('[data-zone="project"] .timeline-bar')!) },
      { zone: 'info line', ...pick(document.querySelector('[data-zone="project"] .info-line')!) },
    ];
    const right = pick(document.querySelector('[data-zone="right"]')!);
    // ui/base.css's body: the line height as a factor, the letter spacing in em.
    const body = getComputedStyle(document.body);
    const bodyLh = parseFloat(body.lineHeight) / parseFloat(body.fontSize);
    const bodyLs = parseFloat(body.letterSpacing) / parseFloat(body.fontSize);
    // Inherited values: the pinned element's own, through every element that does not set them.
    const offenders: string[] = [];
    for (const zone of document.querySelectorAll('[data-zone="project"] .timeline-bar, [data-zone="project"] .info-line')) {
      for (const el of zone.querySelectorAll('*')) {
        const s = pick(el);
        if (s.ls !== 'normal' && s.ls !== '0px') offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} letter-spacing ${s.ls}`);
        if (s.ffs !== 'normal') offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} font-feature-settings ${s.ffs}`);
      }
    }
    const ported = [
      ...['lower', 'left'].map((zone) => ({ zone, ...pick(document.querySelector(`[data-zone="${zone}"]`)!) })),
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
  // The lower zone and the left zone: the page's letter spacing, font
  // features, numerals and line height (base.css's body), none of the pinned
  // pre-port ones.
  for (const zone of styles.ported) {
    expect(zone.ls, zone.zone).toBe(styles.body.ls);
    expect(zone.ffs, zone.zone).toBe(styles.body.ffs);
    expect(zone.fvn, zone.zone).toBe(styles.body.fvn);
    expect(parseFloat(zone.lh) / zone.fs, zone.zone).toBeCloseTo(parseFloat(styles.body.lh) / styles.body.fs, 2);
  }
  // The zone buttons: icon buttons with names.
  for (const zone of ['left', 'lower', 'right']) {
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
