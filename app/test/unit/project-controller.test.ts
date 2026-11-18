// New, Open, the recent list and Save (m5b-ui-project; UI redesign UR-4, 3.0):
// the ProjectController over a scripted session client and a scripted shell
// port (the preload bridge's project half, which index.tsx adapts). New sends
// session.create {path} with the folder the shell's save dialog names, Open
// sends session.open {path}; a cancelled dialog sends nothing; the shell
// hears of a bundle only once the engine opened it; a refusal is shown with
// the bundle's path; Save sends session.save and hands its revision to the
// saved mark. Without a shell port (a plain browser tab) New, Open and the
// recent entries are not commands at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { CommandRegistry } from '../../src/renderer/keys/commands';
import { capabilitySelector } from '../../src/renderer/model/capabilities';
import { ProjectController, type ShellPort, type ShellProjectState } from '../../src/renderer/model/project';
import { ProtocolError } from '../../src/renderer/model/session-client';

const A = path.resolve('/music/A.siann');
const B = path.resolve('/music/B.siann');
const ALL = capabilitySelector({ methods: ['session.create', 'session.open', 'session.save', 'engine.devices', 'engine.select_device'] });

type Answer = unknown | ProtocolError;

function scriptedClient(answers: Record<string, Answer> = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    request(method: string, params: Record<string, unknown>): Promise<unknown> {
      sent.push({ method, params });
      const answer = answers[method] ?? { sessionId: 'ses_1', revision: 'r1', documentHash: 'sha256:0' };
      return answer instanceof ProtocolError ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

function scriptedShell(options: { newPath?: string | null; openPath?: string | null; state?: Partial<ShellProjectState> } = {}) {
  const opened: string[] = [];
  const listeners: Array<(state: ShellProjectState) => void> = [];
  const state: ShellProjectState = { current: null, startView: true, recent: [{ path: B, name: 'B' }], ...options.state };
  const shell: ShellPort = {
    state: async () => state,
    chooseNew: async () => (options.newPath === undefined ? A : options.newPath),
    chooseOpen: async () => (options.openPath === undefined ? B : options.openPath),
    opened: (bundle) => opened.push(bundle),
    onChange: (listener) => listeners.push(listener),
  };
  return { shell, opened, listeners };
}

function toasts() {
  const pushed: string[] = [];
  return { pushed, push: (text: string) => (pushed.push(text), pushed.length) };
}

test('New sends session.create with the dialog\'s path; the shell hears of it after the engine answered; the start view goes', async () => {
  const client = scriptedClient();
  const { shell, opened } = scriptedShell();
  const project = new ProjectController({ client, shell, locale: () => 'en', toasts: toasts() });
  await project.start();
  assert.equal(project.getSnapshot().startView, true);
  assert.deepEqual(project.getSnapshot().recent, [{ path: B, name: 'B' }]);
  assert.equal(await project.newProject(), true);
  assert.deepEqual(client.sent, [{ method: 'session.create', params: { path: A } }]);
  assert.deepEqual(opened, [A]);
  assert.equal(project.getSnapshot().startView, false);
  assert.equal(project.getSnapshot().error, null);
});

test('Open sends session.open with the folder the shell chose; a recent entry opens its path', async () => {
  const client = scriptedClient();
  const { shell, opened } = scriptedShell();
  const project = new ProjectController({ client, shell, locale: () => 'en', toasts: toasts() });
  await project.start();
  assert.equal(await project.open(), true);
  assert.equal(await project.openRecent(1), true);
  assert.equal(await project.openRecent(2), false, 'no second recent entry');
  assert.deepEqual(client.sent, [
    { method: 'session.open', params: { path: B } },
    { method: 'session.open', params: { path: B } },
  ]);
  assert.deepEqual(opened, [B, B]);
});

test('a cancelled dialog sends nothing and tells the shell nothing', async () => {
  const client = scriptedClient();
  const { shell, opened } = scriptedShell({ newPath: null, openPath: null });
  const project = new ProjectController({ client, shell, locale: () => 'en', toasts: toasts() });
  await project.start();
  assert.equal(await project.newProject(), false);
  assert.equal(await project.open(), false);
  assert.deepEqual(client.sent, []);
  assert.deepEqual(opened, []);
});

test('a bundle another engine holds shows the lock refusal with its path; the old session stays and the shell hears nothing', async () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans'] as const) {
    const t = translator(locale);
    const client = scriptedClient({ 'session.open': new ProtocolError('session_locked', 'session is locked by pid 42') });
    const { shell, opened } = scriptedShell();
    const shown = toasts();
    const project = new ProjectController({ client, shell, locale: () => locale, toasts: shown });
    await project.start();
    assert.equal(await project.open(), false);
    const line = `session_locked: ${t('project.locked', { path: B })}`;
    assert.equal(project.getSnapshot().error, line, locale);
    assert.deepEqual(shown.pushed, [line], locale);
    assert.ok(line.includes(B), locale);
    assert.deepEqual(opened, []);
    assert.equal(project.getSnapshot().startView, true, 'the start view stays where it was');
  }
});

test('an existing folder and a missing one are shown with their paths', async () => {
  const t = translator('en');
  const exists = scriptedClient({ 'session.create': new ProtocolError('already_exists', 'exists') });
  const a = new ProjectController({ client: exists, shell: scriptedShell().shell, locale: () => 'en', toasts: toasts() });
  await a.start();
  assert.equal(await a.newProject(), false);
  assert.equal(a.getSnapshot().error, `already_exists: ${t('project.exists', { path: A })}`);
  const missing = scriptedClient({ 'session.open': new ProtocolError('not_found', 'no directory') });
  const b = new ProjectController({ client: missing, shell: scriptedShell().shell, locale: () => 'en', toasts: toasts() });
  await b.start();
  assert.equal(await b.open(), false);
  assert.equal(b.getSnapshot().error, `not_found: ${t('project.notFound', { path: B })}`);
  // The next success clears it.
  missing.request = scriptedClient().request;
  assert.equal(await b.open(), true);
  assert.equal(b.getSnapshot().error, null);
});

test('Save sends session.save and hands its revision to the saved mark; a refusal is a toast', async () => {
  const client = scriptedClient({ 'session.save': { revision: 'r7', path: '/x/session.json' } });
  const marks: string[] = [];
  const project = new ProjectController({ client, shell: null, locale: () => 'en', toasts: toasts(), saved: { saved: (revision) => marks.push(revision) } });
  await project.start();
  assert.equal(await project.save(), true);
  assert.deepEqual(client.sent, [{ method: 'session.save', params: {} }]);
  assert.deepEqual(marks, ['r7']);
  const failing = scriptedClient({ 'session.save': new ProtocolError('io_error', 'disk full') });
  const shown = toasts();
  const other = new ProjectController({ client: failing, shell: null, locale: () => 'en', toasts: shown });
  assert.equal(await other.save(), false);
  assert.deepEqual(shown.pushed, ['io_error: disk full']);
});

test('the commands: New, Open and Open Recent only with a shell port, Save always (with session.save)', async () => {
  const withShell = new CommandRegistry();
  const client = scriptedClient();
  const { shell } = scriptedShell();
  const project = new ProjectController({ client, shell, locale: () => 'en', toasts: toasts() });
  await project.start();
  const off = project.bind(withShell, () => ALL);
  assert.equal(withShell.run('window', 'project.new'), true);
  assert.equal(withShell.run('window', 'project.open'), true);
  assert.equal(withShell.run('window', 'project.openRecent.1'), true);
  assert.equal(withShell.run('window', 'project.openRecent.2'), false, 'no second entry: the command declines');
  assert.equal(withShell.run('window', 'project.save'), true);
  off();
  assert.equal(withShell.run('window', 'project.save'), false, 'unbound');

  const plain = new CommandRegistry();
  const tab = new ProjectController({ client: scriptedClient(), shell: null, locale: () => 'en', toasts: toasts() });
  await tab.start();
  tab.bind(plain, () => ALL);
  assert.equal(tab.getSnapshot().startView, false, 'a plain tab has no start view');
  for (const id of ['project.new', 'project.open', 'project.openRecent.1'] as const) assert.equal(plain.run('window', id), false, id);
  assert.equal(plain.run('window', 'project.save'), true);
  // An engine without session.save: Save declines.
  const bare = new CommandRegistry();
  tab.bind(bare, () => capabilitySelector({ methods: [] }));
  assert.equal(bare.run('window', 'project.save'), false);
});

test('the shell\'s record changes reach the view', async () => {
  const { shell, listeners } = scriptedShell();
  const project = new ProjectController({ client: scriptedClient(), shell, locale: () => 'en', toasts: toasts() });
  await project.start();
  let told = 0;
  project.subscribe(() => (told += 1));
  listeners[0]!({ current: A, startView: false, recent: [{ path: A, name: 'A' }, { path: B, name: 'B' }] });
  assert.ok(told > 0);
  assert.deepEqual(project.getSnapshot().recent.map((r) => r.name), ['A', 'B']);
  assert.equal(project.getSnapshot().current, A);
});
