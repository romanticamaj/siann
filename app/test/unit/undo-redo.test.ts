// Undo, redo and the transport commands (m5-ui-transport; UI redesign spec
// 3.1, 3.2): Ctrl+Z and Ctrl+Shift+Z run edit.undo and edit.redo, which send
// session.undo and session.redo; the transport keys send transport.play,
// transport.stop and transport.locate. A refusal is shown as one toast worded
// by i18n/errors.ts (the code in front); a success shows none. Over a
// SessionClient on the fake socket of support/fakes.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refusalLine } from '../../src/renderer/i18n/errors';
import { CommandRegistry, type CommandId } from '../../src/renderer/keys/commands';
import { SessionClient } from '../../src/renderer/model/session-client';
import { bindTransportCommands, TransportController } from '../../src/renderer/model/transport';
import { ToastStore } from '../../src/renderer/shell/toast-store';
import { FakeScheduler, FakeSocket, settle, until, type Message } from './support/fakes';

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

async function setup(answers: Partial<Record<string, Answer>> = {}, options: { playing?: boolean; ready?: boolean; canUndo?: boolean } = {}) {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  const client = new SessionClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      socket.handler = (message: Message) => {
        if (message.type === 'auth') {
          queueMicrotask(() => socket.deliver({ type: 'auth', ok: true, sessionId: 'ses_0000000000000001', revision: 'r1', seq: '1', meters: null }));
          return;
        }
        if (!message.requestId || !message.method) return;
        const answer = answers[message.method] ?? { ok: true, result: {} };
        queueMicrotask(() =>
          socket.deliver(
            answer.ok
              ? { requestId: message.requestId, ok: true, result: answer.result }
              : { requestId: message.requestId, ok: false, error: { code: answer.code, message: answer.message } },
          ),
        );
      };
      sockets.push(socket);
      return socket;
    },
    currentEndpoint: async () => ({ port: 1, token: 'tok' }),
    schedule: scheduler.schedule,
  });
  client.connect({ port: 1, token: 'tok' });
  sockets[0]!.onopen?.();
  await until(() => client.getState().status === 'connected', 'connected');
  const toasts = new ToastStore({ schedule: scheduler.schedule });
  const transport = new TransportController({ client, playing: () => options.playing ?? false, toasts, locale: () => 'en' });
  const commands = new CommandRegistry();
  bindTransportCommands(commands, transport, { transportReady: () => options.ready ?? true, canUndo: () => options.canUndo ?? true });
  const sent = (method: string) => sockets[0]!.requests(method);
  return { client, toasts, transport, commands, sent };
}

async function run(commands: CommandRegistry, id: CommandId): Promise<boolean> {
  const ran = commands.run('window', id);
  await settle();
  return ran;
}

test('edit.undo sends session.undo and edit.redo sends session.redo; a success shows no toast', async () => {
  const { commands, sent, toasts } = await setup();
  assert.equal(await run(commands, 'edit.undo'), true);
  assert.equal(sent('session.undo').length, 1);
  assert.deepEqual(sent('session.undo')[0]!.params, {});
  assert.equal(await run(commands, 'edit.redo'), true);
  assert.equal(sent('session.redo').length, 1);
  assert.equal(toasts.getSnapshot().length, 0);
});

test('a refusal shows one toast worded by i18n/errors.ts', async () => {
  const refusals: Array<[CommandId, string, string, string]> = [
    ['edit.undo', 'session.undo', 'nothing_to_undo', 'nothing to undo'],
    ['edit.redo', 'session.redo', 'nothing_to_redo', 'nothing to redo'],
    // A code the catalogs do not know: the engine's message after it.
    ['edit.undo', 'session.undo', 'revision_conflict', 'the session moved on'],
  ];
  for (const [id, method, code, message] of refusals) {
    const { commands, sent, toasts } = await setup({ [method]: { ok: false, code, message } });
    await run(commands, id);
    assert.equal(sent(method).length, 1);
    await until(() => toasts.getSnapshot().length > 0, `the ${code} toast`);
    await settle();
    const shown = toasts.getSnapshot();
    assert.equal(shown.length, 1, code);
    assert.equal(shown[0]!.text, refusalLine(code, message, 'en'));
    // A language switch re-words it.
    assert.equal(shown[0]!.reword?.('zh-Hant'), refusalLine(code, message, 'zh-Hant'));
  }
});

test('the transport keys send play, stop and locate; Space toggles from the realtime playing flag', async () => {
  const stopped = await setup();
  await run(stopped.commands, 'transport.toggle');
  assert.equal(stopped.sent('transport.play').length, 1);
  assert.equal(stopped.sent('transport.stop').length, 0);
  await run(stopped.commands, 'transport.start');
  assert.equal(stopped.sent('transport.play').length, 2);
  await run(stopped.commands, 'transport.stop');
  assert.equal(stopped.sent('transport.stop').length, 1);
  await run(stopped.commands, 'transport.toStart');
  assert.deepEqual(stopped.sent('transport.locate').map((m) => m.params), [{ frames: '0' }]);

  const playing = await setup({}, { playing: true });
  await run(playing.commands, 'transport.toggle');
  assert.equal(playing.sent('transport.stop').length, 1);
  assert.equal(playing.sent('transport.play').length, 0);

  // locate(frames) sends the decimal string as given.
  await playing.transport.locate('192000');
  assert.deepEqual(playing.sent('transport.locate').map((m) => m.params), [{ frames: '192000' }]);
});

test('no device: the transport keys decline and send nothing; no_device from the engine is a toast', async () => {
  const idle = await setup({}, { ready: false });
  for (const id of ['transport.toggle', 'transport.start', 'transport.stop', 'transport.toStart'] as const) {
    assert.equal(await run(idle.commands, id), false, id);
  }
  for (const method of ['transport.play', 'transport.stop', 'transport.locate']) assert.equal(idle.sent(method).length, 0, method);

  const refused = await setup({ 'transport.play': { ok: false, code: 'no_device', message: 'no audio device is running' } });
  await run(refused.commands, 'transport.start');
  await until(() => refused.toasts.getSnapshot().length === 1, 'the no_device toast');
  assert.equal(refused.toasts.getSnapshot()[0]!.text, refusalLine('no_device', 'no audio device is running', 'en'));
});

test('an engine without session.undo gets neither undo nor redo, and the key keeps its default', async () => {
  const { commands, sent } = await setup({}, { canUndo: false });
  assert.equal(await run(commands, 'edit.undo'), false);
  assert.equal(await run(commands, 'edit.redo'), false);
  assert.equal(sent('session.undo').length + sent('session.redo').length, 0);
});
