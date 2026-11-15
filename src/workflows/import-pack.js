const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertString(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function validateManifest(manifest) {
  assertObject(manifest, 'manifest');
  if (manifest.schemaVersion !== 'siann.import_pack.v0') {
    throw new Error('schemaVersion must be siann.import_pack.v0');
  }
  assertObject(manifest.session, 'session');
  assertString(manifest.session.dir, 'session.dir');
  assertString(manifest.session.name, 'session.name');
  if (!Array.isArray(manifest.tracks) || manifest.tracks.length === 0) {
    throw new Error('tracks must be a non-empty array');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('assets must be a non-empty array');
  }

  const trackNames = new Set();
  for (const track of manifest.tracks) {
    assertString(track.name, 'track.name');
    trackNames.add(track.name);
  }
  for (const asset of manifest.assets) {
    assertString(asset.id, 'asset.id');
    assertString(asset.path, `asset ${asset.id}.path`);
    assertString(asset.trackName, `asset ${asset.id}.trackName`);
    assertString(asset.regionName, `asset ${asset.id}.regionName`);
    assertString(asset.start, `asset ${asset.id}.start`);
    if (asset.sourceStart !== undefined) {
      assertString(asset.sourceStart, `asset ${asset.id}.sourceStart`);
    }
    if (asset.duration !== undefined) {
      assertString(asset.duration, `asset ${asset.id}.duration`);
    }
    if (!trackNames.has(asset.trackName)) {
      throw new Error(`unknown trackName: ${asset.trackName}`);
    }
  }
  if (manifest.preview) {
    assertObject(manifest.preview, 'preview');
    assertString(manifest.preview.outputPath, 'preview.outputPath');
  }
  return manifest;
}

function loadImportPackManifest(manifestFile) {
  const absoluteManifestFile = path.resolve(manifestFile);
  const manifestDir = path.dirname(absoluteManifestFile);
  return normalizeManifestPaths(validateManifest(readJson(absoluteManifestFile)), manifestDir);
}

function resolveManifestPath(manifestDir, value) {
  return path.isAbsolute(value) ? value : path.resolve(manifestDir, value);
}

function normalizeManifestPaths(manifest, manifestDir) {
  const normalized = {
    ...manifest,
    session: {
      ...manifest.session,
      dir: resolveManifestPath(manifestDir, manifest.session.dir),
    },
    assets: manifest.assets.map((asset) => ({
      ...asset,
      path: resolveManifestPath(manifestDir, asset.path),
    })),
  };
  if (manifest.journalPath) {
    normalized.journalPath = resolveManifestPath(manifestDir, manifest.journalPath);
  }
  if (manifest.preview) {
    normalized.preview = {
      ...manifest.preview,
      outputPath: resolveManifestPath(manifestDir, manifest.preview.outputPath),
    };
  }
  return normalized;
}

function renderFormatError(message) {
  const error = new Error(message);
  error.code = 'render_format_unsupported';
  return error;
}

// siann-engine's render.start takes {name, start?, frames?} (architecture spec,
// Jobs v0) and writes 32-bit float WAV at the session rate, unnormalised. A
// preview that asks for another format is refused here rather than narrowed
// when the command file runs; bitDepth "float32" and normalize false state
// what the engine writes and are accepted.
function previewSampleRate(manifest) {
  const sessionRate = manifest.session.sampleRate || 48000;
  const { preview } = manifest;
  if (preview.bitDepth !== undefined && preview.bitDepth !== 'float32') {
    throw renderFormatError(`preview.bitDepth ${JSON.stringify(preview.bitDepth)} is not a format siann-engine `
      + 'renders: it writes 32-bit float WAV (omit bitDepth, or set "float32")');
  }
  if (preview.normalize !== undefined && preview.normalize !== false) {
    throw renderFormatError('preview.normalize is not supported: siann-engine renders unnormalised (omit it)');
  }
  const rate = preview.sampleRate || sessionRate;
  if (rate !== sessionRate) {
    throw renderFormatError(`preview.sampleRate ${rate} differs from the session's ${sessionRate}: siann-engine `
      + 'renders at the session rate (omit preview.sampleRate)');
  }
  return rate;
}

// The command file holds only what siann-engine honours: no track
// inputChannels (track.add takes channels, from outputChannels), no
// snapshotRetention (a v1 journal holds no snapshots) and no render bit depth
// or normalisation (docs/schemas/command-journal-v1.md, "How a command file
// runs"). A manifest may still carry inputChannels and snapshotRetention, so
// existing manifests load, but nothing reads them.
function buildImportPackCommand(manifest) {
  validateManifest(manifest);
  const previewRate = manifest.preview ? previewSampleRate(manifest) : null;
  const commands = [{
    op: 'create_session',
    sessionDir: manifest.session.dir,
    sessionName: manifest.session.name,
    sampleRate: manifest.session.sampleRate || 48000,
  }];

  for (const track of manifest.tracks) {
    commands.push({
      op: 'create_audio_track',
      name: track.name,
      outputChannels: track.outputChannels || 2,
      count: track.count || 1,
    });
  }

  for (const asset of manifest.assets) {
    const command = {
      op: 'import_audio',
      path: asset.path,
      trackName: asset.trackName,
      regionName: asset.regionName,
      start: asset.start,
    };
    if (asset.sourceStart !== undefined) {
      command.sourceStart = asset.sourceStart;
    }
    if (asset.duration !== undefined) {
      command.duration = asset.duration;
    }
    commands.push(command);
  }

  commands.push({ op: 'save_session' });
  if (manifest.preview) {
    commands.push({
      op: 'render',
      outputPath: manifest.preview.outputPath,
      sampleRate: previewRate,
    });
  }
  commands.push({ op: 'observe_session' });

  return {
    schemaVersion: 'siann.command.v0',
    journalPath: manifest.journalPath || path.join(manifest.session.dir, '..', 'journal.json'),
    batchRisk: manifest.batchRisk || 'normal',
    commands,
  };
}

function writeImportPackCommand(manifestFile, outFile) {
  const absoluteManifestFile = path.resolve(manifestFile);
  const absoluteOutFile = path.resolve(outFile);
  const command = buildImportPackCommand(loadImportPackManifest(absoluteManifestFile));
  fs.mkdirSync(path.dirname(absoluteOutFile), { recursive: true });
  fs.writeFileSync(absoluteOutFile, `${JSON.stringify(command, null, 2)}\n`);
  return {
    ok: true,
    workflow: 'import-pack',
    manifestFile: absoluteManifestFile,
    commandFile: absoluteOutFile,
    commandCount: command.commands.length,
  };
}

module.exports = {
  buildImportPackCommand,
  loadImportPackManifest,
  validateManifest,
  writeImportPackCommand,
};
