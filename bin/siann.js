#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  runCommandFile,
  summarizeJournal,
  validateJournal,
} = require('../src/bridge/runner');
const {
  writeDawprojectExport,
} = require('../src/exporters/dawproject');
const {
  writeImportPackCommand,
} = require('../src/workflows/import-pack');
const {
  writeIntakePlan,
} = require('../src/workflows/intake-plan');
const {
  runLiveImportPack,
} = require('../src/workflows/live-import-pack');
const {
  applyImportPackPlan,
  approveImportPackPlan,
  rejectImportPackPlan,
  validateImportPackPlan,
  writeImportPackPlan,
} = require('../src/workflows/import-pack-plan');
const {
  writeRollbackCommand,
} = require('../src/workflows/rollback');

// The option table (m5b-bridge-cli-coverage): one row per subcommand, named by
// the command and, for plan, workflow, live and export, the word after it; the
// options it takes; its usage lines. usage() prints the lines, and an option the
// invoked row does not list is a usage error, so --run is accepted only where a
// row lists it. test/bridge-cli-run-flags.test.js reads the --run rows from here.
const ENGINE = ['--device', '--runner'];
const COMMANDS = [
  { name: 'run', options: [...ENGINE, '--json'],
    usage: ['siann run <command-file.json> [--device <id>] [--runner <path>] [--json]'] },
  { name: 'validate-journal', options: ['--json'],
    usage: ['siann validate-journal <journal-file.json> [--json]'] },
  { name: 'plan intake', options: ['--out', '--context', '--json'],
    usage: ['siann plan intake <source-dir> --out <intake-plan.json> [--context <file>] [--json]'] },
  { name: 'workflow import-pack', options: ['--out', '--plan', '--run', ...ENGINE, '--json'],
    usage: [
      'siann workflow import-pack <manifest.json> --plan <plan-file.json> [--json]',
      'siann workflow import-pack <manifest.json> --out <command-file.json> [--run] [--device <id>] [--runner <path>] [--json]',
    ] },
  { name: 'workflow validate-plan', options: ['--json'],
    usage: ['siann workflow validate-plan <plan-file.json> [--json]'] },
  { name: 'workflow approve-plan', options: ['--out', '--approved-by', '--json'],
    usage: ['siann workflow approve-plan <plan-file.json> --out <approved-plan-file.json> [--approved-by <name>] [--json]'] },
  { name: 'workflow reject-plan', options: ['--out', '--rejected-by', '--reason', '--json'],
    usage: ['siann workflow reject-plan <plan-file.json> --out <rejected-plan-file.json> [--rejected-by <name>] '
      + '[--reason <text>] [--json]'] },
  { name: 'workflow apply-plan', options: ['--out', '--run', ...ENGINE, '--json'],
    usage: ['siann workflow apply-plan <plan-file.json> --out <command-file.json> [--run] [--device <id>] '
      + '[--runner <path>] [--json]'] },
  { name: 'live import-pack', options: [...ENGINE, '--json'],
    usage: ['siann live import-pack <manifest.json> [--device <id>] [--runner <path>] [--json]'] },
  { name: 'export dawproject', options: ['--out', '--copy-media', '--json'],
    usage: ['siann export dawproject <manifest.json> --out <file.dawproject> [--copy-media] [--json]'] },
  { name: 'rollback', options: ['--out', '--run', ...ENGINE, '--json'],
    usage: ['siann rollback <journal.json> [--out <command-file.json>] [--run] [--device <id>] [--runner <path>] '
      + '[--json]'] },
];

// Every option the table names: the key it sets, and whether it takes a value.
const OPTIONS = {
  '--json': { key: 'json' },
  '--device': { key: 'device', value: true },
  '--runner': { key: 'runner', value: true },
  '--out': { key: 'out', value: true },
  '--plan': { key: 'plan', value: true },
  '--context': { key: 'context', value: true },
  '--approved-by': { key: 'approvedBy', value: true },
  '--rejected-by': { key: 'rejectedBy', value: true },
  '--reason': { key: 'reason', value: true },
  '--run': { key: 'run' },
  '--copy-media': { key: 'copyMedia' },
};

function usage(status = 0, message = null) {
  const out = status === 0 ? process.stdout : process.stderr;
  out.write([
    ...(message ? [message, ''] : []),
    'Usage:',
    ...COMMANDS.flatMap((row) => row.usage.map((line) => `  ${line}`)),
    '',
    'The engine (run, --run, live): the native siann-engine, started for each command on a',
    'scratch bundle and stopped when the command ends.',
    '  SIANN_ENGINE_EXE  the siann-engine executable; default: the core preset build,',
    '                    native/build/dev/apps/engine/siann-engine (cmake --preset dev)',
    '  --device <id>     passed to siann-engine (fake: no audio hardware)',
    '  --runner <path>   a fake engine script instead of siann-engine (tests)',
    '',
  ].join('\n'));
  process.exit(status);
}

// The options and positionals of args. `given` lists the options that came, for
// the row check in main.
function parseOptions(args) {
  const options = { positional: [], given: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (Object.hasOwn(OPTIONS, arg)) {
      const spec = OPTIONS[arg];
      options.given.push(arg);
      if (spec.value) {
        i += 1;
        if (i >= args.length) usage(1, `option ${arg} needs a value`);
        options[spec.key] = args[i];
      } else {
        options[spec.key] = true;
      }
    } else if (arg.startsWith('--')) {
      usage(1, `unknown option ${arg} (siann --help lists the options)`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

// The row of the command line, its positionals after the name, or a usage error.
function commandRow(command, options) {
  const single = COMMANDS.find((row) => row.name === command);
  if (single) return { row: single, args: options.positional };
  const double = COMMANDS.find((row) => row.name === `${command} ${options.positional[0]}`);
  if (double) return { row: double, args: options.positional.slice(1) };
  return usage(1, `unknown command: siann ${[command, ...options.positional.slice(0, 1)].join(' ')}`);
}

// How run, --run and live start the engine: SIANN_ENGINE_EXE or the core preset
// build (src/runtime/client.js), --device for siann-engine, --runner for tests.
function engineOptions(options) {
  return { device: options.device, runner: options.runner };
}

function printSummary(summary, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `ok: ${summary.ok}`,
    summary.status !== undefined ? `status: ${summary.status}` : null,
    summary.commandFile !== undefined ? `commandFile: ${summary.commandFile}` : null,
    summary.journal ? `journal: ${summary.journal.path} (${summary.journal.status}, ${summary.journal.risk}, ${summary.journal.entryCount} entries)` : null,
    summary.error ? `error: ${summary.error.code}: ${summary.error.message}` : null,
  ].filter(Boolean).join('\n') + '\n');
}

// validate-journal: {ok, journal}, or {ok: false, status: 'failed', error: {code,
// message}} (docs/schemas/command-journal-v1.md, "Validation").
function checkJournalFile(journalFile) {
  const failed = (code, message) => ({ ok: false, status: 'failed', error: { code, message } });
  let text;
  try {
    text = fs.readFileSync(journalFile, 'utf8');
  } catch (error) {
    return failed('journal_unreadable', `cannot read ${journalFile}: ${error.message}`);
  }
  let journal;
  try {
    journal = JSON.parse(text);
  } catch (error) {
    return failed('journal_not_json', `${journalFile} is not JSON: ${error.message}`);
  }
  try {
    return { ok: true, journal: summarizeJournal(validateJournal(journal), path.resolve(journalFile)) };
  } catch (error) {
    if (!error.code) throw error;
    return failed(error.code, error.message);
  }
}

// --run: the command file the subcommand wrote, through the engine.
async function runIfAsked(summary, options) {
  if (options.run) {
    summary.run = await runCommandFile(summary.commandFile, engineOptions(options));
    summary.ok = summary.run.ok;
  }
  return summary;
}

function finish(summary, options) {
  printSummary(summary, options.json);
  process.exit(summary.ok ? 0 : 1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '-h' || command === '--help') {
    usage(0);
  }
  const options = parseOptions(rest);
  if (!command) {
    usage(1);
  }
  if (options.help) {
    usage(0);
  }
  const { row, args } = commandRow(command, options);
  for (const option of options.given) {
    if (!row.options.includes(option)) usage(1, `siann ${row.name} does not take ${option}`);
  }
  const [file] = args;
  const needs = (...present) => {
    if (!present.every(Boolean)) usage(1, `siann ${row.name}: missing arguments`);
  };

  switch (row.name) {
    case 'run':
      needs(file);
      return finish(await runCommandFile(file, engineOptions(options)), options);
    case 'validate-journal':
      needs(file);
      return finish(checkJournalFile(file), options);
    case 'plan intake':
      needs(file, options.out);
      return finish(writeIntakePlan(file, options.out, { contextFile: options.context }), options);
    case 'live import-pack':
      needs(file);
      return finish(await runLiveImportPack(file, engineOptions(options)), options);
    case 'export dawproject':
      needs(file, options.out);
      return finish(writeDawprojectExport(file, options.out, { copyMedia: options.copyMedia }), options);
    case 'rollback':
      needs(file);
      return finish(await runIfAsked(writeRollbackCommand(file, { outFile: options.out }), options), options);
    case 'workflow validate-plan':
      needs(file);
      return finish(validateImportPackPlan(file), options);
    case 'workflow approve-plan':
      needs(file, options.out);
      return finish(approveImportPackPlan(file, options.out, { approvedBy: options.approvedBy }), options);
    case 'workflow reject-plan':
      needs(file, options.out);
      return finish(rejectImportPackPlan(file, options.out, {
        rejectedBy: options.rejectedBy,
        reason: options.reason,
      }), options);
    case 'workflow apply-plan':
      needs(file, options.out);
      return finish(await runIfAsked(applyImportPackPlan(file, options.out), options), options);
    default: // workflow import-pack
      needs(file, options.out || options.plan);
      if (options.plan && options.run) {
        throw new Error('use workflow apply-plan to run a reviewed plan');
      }
      return finish(await runIfAsked(options.plan
        ? writeImportPackPlan(file, options.plan)
        : writeImportPackCommand(file, options.out), options), options);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { COMMANDS };
