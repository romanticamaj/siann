'use strict';

// `siann live import-pack`: a manifest straight into a native session, in one
// engine process (m5b-bridge-native-client). The manifest becomes the same
// command list `workflow import-pack` writes (session.create, media.import
// per file, one plan for the tracks and clips, session.save, the preview
// render, session.inspect), run by src/bridge/runner.js without a file in
// between. The journal goes to the manifest's journalPath.

const path = require('node:path');

const { runCommands, summarizeJournal } = require('../bridge/runner');
const { buildImportPackCommand, loadImportPackManifest } = require('./import-pack');

async function runLiveImportPack(manifestFile, options = {}) {
  const absoluteManifestFile = path.resolve(manifestFile);
  const manifest = loadImportPackManifest(absoluteManifestFile);
  const payload = buildImportPackCommand(manifest);
  const outcome = await runCommands(payload, { ...options, baseDir: path.dirname(absoluteManifestFile) });

  const byOp = (op) => outcome.results.filter((r) => r.op === op);
  const applied = outcome.journal ? outcome.journal.batches.filter((b) => b.status === 'applied') : [];
  const last = applied.at(-1);
  const render = byOp('render')[0];
  const summary = {
    ok: outcome.ok,
    workflow: 'live-import-pack',
    manifestFile: absoluteManifestFile,
    session: {
      name: manifest.session.name,
      bundle: manifest.session.dir,
      sampleRate: manifest.session.sampleRate || 48000,
    },
    apply: {
      trackCount: byOp('create_audio_track').reduce((n, r) => n + r.trackIds.length, 0),
      clipCount: byOp('import_audio').length,
      planHash: last ? last.planHash : null,
      appliedRevision: last ? last.appliedRevision : null,
    },
    preview: render ? { outputPath: render.outputPath, renderPath: render.renderPath } : null,
    journal: outcome.journal ? summarizeJournal(outcome.journal, outcome.journalPath) : null,
    saved: byOp('save_session').length > 0,
  };
  if (outcome.error) summary.error = outcome.error;
  return summary;
}

module.exports = {
  runLiveImportPack,
};
