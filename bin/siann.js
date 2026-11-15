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

function usage(status = 0) {
  const out = status === 0 ? process.stdout : process.stderr;
  out.write([
    'Usage:',
    '  siann run <command-file.json> [--device <id>] [--runner <path>] [--json]',
    '  siann validate-journal <journal-file.json> [--json]',
    '  siann plan intake <source-dir> --out <intake-plan.json> [--context <file>] [--json]',
    '  siann workflow import-pack <manifest.json> --plan <plan-file.json> [--json]',
    '  siann workflow import-pack <manifest.json> --out <command-file.json> [--run] [--device <id>] [--json]',
    '  siann workflow validate-plan <plan-file.json> [--json]',
    '  siann workflow approve-plan <plan-file.json> --out <approved-plan-file.json> [--approved-by <name>] [--json]',
    '  siann workflow reject-plan <plan-file.json> --out <rejected-plan-file.json> [--rejected-by <name>] [--reason <text>] [--json]',
    '  siann workflow apply-plan <plan-file.json> --out <command-file.json> [--run] [--device <id>] [--json]',
    '  siann live import-pack <manifest.json> [--device <id>] [--runner <path>] [--json]',
    '  siann export dawproject <manifest.json> --out <file.dawproject> [--copy-media] [--json]',
    '  siann rollback <journal.json> [--out <command-file.json>] [--run] [--device <id>] [--json]',
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

function parseOptions(args) {
  const options = { positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--device') {
      options.device = args[++i];
    } else if (arg === '--runner') {
      options.runner = args[++i];
    } else if (arg === '--out') {
      options.out = args[++i];
    } else if (arg === '--plan') {
      options.plan = args[++i];
    } else if (arg === '--context') {
      options.context = args[++i];
    } else if (arg === '--approved-by') {
      options.approvedBy = args[++i];
    } else if (arg === '--rejected-by') {
      options.rejectedBy = args[++i];
    } else if (arg === '--reason') {
      options.reason = args[++i];
    } else if (arg === '--run') {
      options.run = true;
    } else if (arg === '--copy-media') {
      options.copyMedia = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg} (siann --help lists the options)`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
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
    `status: ${summary.status}`,
    `commandFile: ${summary.commandFile}`,
    summary.journal ? `journal: ${summary.journal.path} (${summary.journal.status}, ${summary.journal.risk}, ${summary.journal.entryCount} entries)` : null,
    summary.error ? `error: ${summary.error.code}: ${summary.error.message}` : null,
  ].filter(Boolean).join('\n') + '\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '-h' || command === '--help') {
    usage(0);
  }
  const options = parseOptions(rest);
  if (!command || options.help) {
    usage(command ? 0 : 1);
  }

  if (command === 'run') {
    const commandFile = options.positional[0];
    if (!commandFile) {
      usage(1);
    }
    const summary = await runCommandFile(commandFile, engineOptions(options));
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  if (command === 'plan') {
    const planner = options.positional[0];
    const sourceDir = options.positional[1];
    if (planner !== 'intake' || !sourceDir || !options.out) {
      usage(1);
    }
    const summary = writeIntakePlan(sourceDir, options.out, {
      contextFile: options.context,
    });
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  if (command === 'live') {
    const workflow = options.positional[0];
    const manifestFile = options.positional[1];
    if (workflow !== 'import-pack' || !manifestFile) {
      usage(1);
    }
    const summary = await runLiveImportPack(manifestFile, engineOptions(options));
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  if (command === 'export') {
    const format = options.positional[0];
    const manifestFile = options.positional[1];
    if (format !== 'dawproject' || !manifestFile || !options.out) {
      usage(1);
    }
    const summary = writeDawprojectExport(manifestFile, options.out, {
      copyMedia: options.copyMedia,
    });
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  if (command === 'validate-journal') {
    const journalFile = options.positional[0];
    if (!journalFile) {
      usage(1);
    }
    const journal = validateJournal(JSON.parse(fs.readFileSync(journalFile, 'utf8')));
    const summary = summarizeJournal(journal, path.resolve(journalFile));
    printSummary({ ok: true, journal: summary }, options.json);
    return;
  }

  if (command === 'rollback') {
    const journalFile = options.positional[0];
    if (!journalFile) {
      usage(1);
    }
    const summary = writeRollbackCommand(journalFile, {
      outFile: options.out,
    });
    if (options.run) {
      summary.run = await runCommandFile(summary.commandFile, engineOptions(options));
      summary.ok = summary.run.ok;
    }
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  if (command === 'workflow') {
    const workflow = options.positional[0];
    if (!['import-pack', 'validate-plan', 'approve-plan', 'reject-plan', 'apply-plan'].includes(workflow)) {
      usage(1);
    }

    if (workflow === 'validate-plan') {
      const planFile = options.positional[1];
      if (!planFile) {
        usage(1);
      }
      const summary = validateImportPackPlan(planFile);
      printSummary(summary, options.json);
      process.exit(summary.ok ? 0 : 1);
    }

    if (workflow === 'approve-plan') {
      const planFile = options.positional[1];
      if (!planFile || !options.out) {
        usage(1);
      }
      const summary = approveImportPackPlan(planFile, options.out, {
        approvedBy: options.approvedBy,
      });
      printSummary(summary, options.json);
      process.exit(summary.ok ? 0 : 1);
    }

    if (workflow === 'reject-plan') {
      const planFile = options.positional[1];
      if (!planFile || !options.out) {
        usage(1);
      }
      const summary = rejectImportPackPlan(planFile, options.out, {
        rejectedBy: options.rejectedBy,
        reason: options.reason,
      });
      printSummary(summary, options.json);
      process.exit(summary.ok ? 0 : 1);
    }

    if (workflow === 'apply-plan') {
      const planFile = options.positional[1];
      if (!planFile || !options.out) {
        usage(1);
      }
      const summary = applyImportPackPlan(planFile, options.out);
      if (options.run) {
        summary.run = await runCommandFile(summary.commandFile, engineOptions(options));
        summary.ok = summary.run.ok;
      }
      printSummary(summary, options.json);
      process.exit(summary.ok ? 0 : 1);
    }

    const manifestFile = options.positional[1];
    if (!manifestFile || (!options.out && !options.plan)) {
      usage(1);
    }
    if (options.plan && options.run) {
      throw new Error('use workflow apply-plan to run a reviewed plan');
    }
    const summary = options.plan
      ? writeImportPackPlan(manifestFile, options.plan)
      : writeImportPackCommand(manifestFile, options.out);
    if (options.run) {
      summary.run = await runCommandFile(summary.commandFile, engineOptions(options));
      summary.ok = summary.run.ok;
    }
    printSummary(summary, options.json);
    process.exit(summary.ok ? 0 : 1);
  }

  usage(1);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
