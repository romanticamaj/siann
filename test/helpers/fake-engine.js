#!/usr/bin/env node
'use strict';

// A fake siann-engine process for the bridge's CLI tests: takes
// `--session <bundle>` (created when absent, as siann-engine does), serves
// test/helpers/fake-engine-server.js on 127.0.0.1, writes the ready line
// (Protocol v0 item 17) as its only stdout line, and exits 0 when stdin ends.
//
// SIANN_FAKE_ENGINE_CALLS=<file>: the methods called, written at exit.
// SIANN_FAKE_ENGINE_RATE=<n>: the device rate engine.status reports.
// SIANN_FAKE_ENGINE_MODE: `bad-ready` writes a malformed ready line, `exit`
// exits 3 before writing one, `exit-on-import` exits 3 when media.import comes.

const fs = require('node:fs');

const { FakeSession, createFakeEngine } = require('./fake-engine-server');

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--session');
  if (at < 0 || !args[at + 1]) {
    process.stderr.write('{"ok":false,"error":{"code":"usage","message":"--session is required"}}\n');
    process.exit(1);
  }
  const bundle = args[at + 1];
  const mode = process.env.SIANN_FAKE_ENGINE_MODE || '';
  if (mode === 'exit') {
    process.stderr.write('{"ok":false,"error":{"code":"session_locked","message":"fake refusal"}}\n');
    process.exit(3);
  }
  const session = fs.existsSync(bundle) ? FakeSession.open(bundle) : FakeSession.create(bundle, 'Scratch', 48000);
  const engine = createFakeEngine({
    session,
    sampleRate: Number(process.env.SIANN_FAKE_ENGINE_RATE || 48000),
    onRequest: (request) => {
      if (mode === 'exit-on-import' && request.method === 'media.import') process.exit(3);
    },
  });
  await engine.listen();
  const finish = () => {
    if (process.env.SIANN_FAKE_ENGINE_CALLS) {
      let previous = [];
      try {
        previous = JSON.parse(fs.readFileSync(process.env.SIANN_FAKE_ENGINE_CALLS, 'utf8'));
      } catch {
        previous = [];
      }
      fs.writeFileSync(process.env.SIANN_FAKE_ENGINE_CALLS, JSON.stringify([...previous, engine.calls], null, 2));
    }
    process.exit(0);
  };
  process.stdin.on('end', finish);
  process.stdin.resume();
  process.stdout.write(`${mode === 'bad-ready' ? '{"schema":"nope"}' : engine.readyLine()}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'internal_error', message: error.message } })}\n`);
  process.exit(1);
});
