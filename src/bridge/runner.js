const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scriptInvocation } = require('./script-invocation');

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseResultOutput(stdout) {
  const lines = String(stdout).trim().split(/\n/).reverse();
  const resultLine = lines.find((line) => line.trim().startsWith('{"schemaVersion":"siann.result.v0"'));
  if (!resultLine) {
    throw new Error('siann result JSON not found in runner output');
  }
  const result = JSON.parse(resultLine);
  if (result.schemaVersion !== 'siann.result.v0' || !Array.isArray(result.results)) {
    throw new Error('runner output is not a siann.result.v0 result');
  }
  return result;
}

function validateJournal(journal) {
  if (!journal || journal.schemaVersion !== 'siann.command_journal.v0') {
    throw new Error('journal schemaVersion must be siann.command_journal.v0');
  }
  if (!journal.journalId || typeof journal.journalId !== 'string') {
    throw new Error('journalId must be a non-empty string');
  }
  if (!Array.isArray(journal.batches) || journal.batches.length === 0) {
    throw new Error('journal batches must be a non-empty array');
  }
  for (const batch of journal.batches) {
    if (!['applied', 'failed', 'rolled_back'].includes(batch.status)) {
      throw new Error(`invalid batch status: ${batch.status}`);
    }
    if (!['low', 'normal', 'high'].includes(batch.risk)) {
      throw new Error(`invalid batch risk: ${batch.risk}`);
    }
    if (!Array.isArray(batch.entries)) {
      throw new Error('batch entries must be an array');
    }
    const hash = batch.postState && batch.postState.observationHash;
    if (hash && !HASH_RE.test(hash)) {
      throw new Error(`invalid observationHash: ${hash}`);
    }
  }
  return journal;
}

function summarizeJournal(journal, journalPath) {
  validateJournal(journal);
  const batch = journal.batches[0];
  const snapshot = batch.preState && batch.preState.snapshot;
  return {
    path: journalPath,
    journalId: journal.journalId,
    status: batch.status,
    risk: batch.risk,
    entryCount: batch.entries.length,
    snapshotPath: snapshot ? snapshot.path : null,
  };
}

function defaultEngineDir() {
  return process.env.SIANN_ENGINE_DIR || path.resolve(process.cwd(), '..', 'siann-engine');
}

function engineCommand(commandFile, options = {}) {
  if (options.runner) {
    return scriptInvocation(options.runner, [commandFile], options.cwd || process.cwd());
  }

  const engineDir = options.engineDir || defaultEngineDir();
  const quotedEngineDir = JSON.stringify(engineDir);
  const quotedCommandFile = JSON.stringify(commandFile);
  return {
    command: '/bin/bash',
    args: ['-lc', [
      `TOP=${quotedEngineDir}`,
      `. ${quotedEngineDir}/build/gtk2_ardour/ardev_common_waf.sh`,
      `${quotedEngineDir}/build/session_utils/ardour9-siann_command ${quotedCommandFile}`,
    ].join('; ')],
    cwd: engineDir,
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function runCommandFile(commandFile, options = {}) {
  const absoluteCommandFile = path.resolve(commandFile);
  const commandPayload = parseJsonFile(absoluteCommandFile);
  const invocation = engineCommand(absoluteCommandFile, options);
  const processResult = await runProcess(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: options.env,
  });
  const ok = processResult.status === 0;
  let result = null;
  try {
    result = parseResultOutput(processResult.stdout);
  } catch (error) {
    if (ok) {
      throw error;
    }
  }
  const summary = {
    ok,
    status: processResult.status,
    commandFile: absoluteCommandFile,
    result,
  };

  if (commandPayload.journalPath) {
    const journalPath = path.resolve(path.dirname(absoluteCommandFile), commandPayload.journalPath);
    const journal = parseJsonFile(journalPath);
    summary.journal = summarizeJournal(journal, journalPath);
  }
  if (!ok) {
    summary.stderr = processResult.stderr.trim();
  }
  return summary;
}

module.exports = {
  engineCommand,
  parseResultOutput,
  runCommandFile,
  summarizeJournal,
  validateJournal,
};
