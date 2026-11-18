'use strict';

// Rollback of what a bridge run applied (m5b-bridge-native-client; architecture
// spec, siann-protocol item 14 and "Plans"). The run's siann.command_journal.v1
// names the bundle and, per plan, the revision it applied. The rollback runs in
// a later engine process, where the plan store is empty, so it opens the
// bundle and rolls each applied plan revision back by its id
// (plan.rollback {revision}), newest first. Only the document changes: the
// imported media and the renders stay in the bundle.

const fs = require('node:fs');
const path = require('node:path');

const { validateJournal } = require('../bridge/runner');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appliedBatches(journal) {
  validateJournal(journal);
  const applied = journal.batches.filter((batch) => batch.status === 'applied' && batch.appliedRevision);
  if (applied.length === 0) {
    throw new Error(`the journal ${journal.journalId} has no applied plan to roll back`);
  }
  return applied.reverse();
}

function buildRollbackCommand(journal) {
  const batches = appliedBatches(journal);
  return {
    schemaVersion: 'siann.command.v0',
    commands: [
      { op: 'open_session', sessionDir: journal.bundle },
      ...batches.map((batch) => ({ op: 'rollback_plan', revision: batch.appliedRevision, planHash: batch.planHash })),
      { op: 'observe_session' },
    ],
  };
}

function writeRollbackCommand(journalFile, options = {}) {
  const absoluteJournalFile = path.resolve(journalFile);
  const outFile = options.outFile
    ? path.resolve(options.outFile)
    : path.join(path.dirname(absoluteJournalFile), 'rollback.command.json');
  const journal = readJson(absoluteJournalFile);
  const command = buildRollbackCommand(journal);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(command, null, 2)}\n`);
  return {
    ok: true,
    workflow: 'rollback',
    journalFile: absoluteJournalFile,
    commandFile: outFile,
    commandCount: command.commands.length,
    bundle: journal.bundle,
    revisions: command.commands.filter((c) => c.op === 'rollback_plan').map((c) => c.revision),
  };
}

module.exports = {
  buildRollbackCommand,
  writeRollbackCommand,
};
