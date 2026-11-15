const fs = require('node:fs');
const path = require('node:path');

function assertDirectory(dir, name) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${name} must be an existing directory`);
  }
}

function secondsFromName(name) {
  const match = name.match(/(\d{2})m(\d{2})s/);
  if (!match) {
    throw new Error(`missing mmss placement in file name: ${name}`);
  }
  return String((Number(match[1]) * 60) + Number(match[2]));
}

function secondsFromClock(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    return String((Number(match[1]) * 60) + Number(match[2]));
  }
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) {
    throw new Error(`invalid time value: ${value}`);
  }
  return String(seconds);
}

function parsePlacementSheet(file) {
  if (!fs.existsSync(file)) {
    return new Map();
  }
  const placements = new Map();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('`') || !line.includes('長')) {
      continue;
    }
    const fileMatch = line.match(/`([^`]+\.wav)`/i);
    const sourceStartMatch = line.match(/起\s*([0-9:]+)/);
    const durationMatch = line.match(/長\s*([0-9:]+)/);
    if (!fileMatch || !sourceStartMatch || !durationMatch) {
      continue;
    }
    placements.set(fileMatch[1], {
      sourceStart: secondsFromClock(sourceStartMatch[1]),
      duration: secondsFromClock(durationMatch[1]),
    });
  }
  return placements;
}

function stripVariant(value) {
  return value.replace(/_([a-z])$/i, '');
}

function bgmNames(fileName) {
  const base = path.basename(fileName, '.wav').replace(/^\d{2}m\d{2}s_/, '');
  const parts = base.split('_');
  const cue = parts[0] || 'BGM';
  const title = stripVariant(parts.slice(1).join('_') || cue).replace(/_/g, ' ');
  const variant = parts.slice(1).join('_').replace(/_/g, ' ');
  return {
    trackName: `${cue} ${title}`.trim(),
    regionName: `${cue} ${variant}`.trim(),
  };
}

function sfxNames(fileName) {
  const base = path.basename(fileName, '.wav').replace(/^SFX_/, '');
  const withoutTime = base.replace(/_\d{2}m\d{2}s_/, '_');
  const parts = withoutTime.split('_');
  const cue = parts[0] ? `SFX ${parts[0]}` : 'SFX';
  const title = parts.slice(1).join(' ').trim();
  return {
    trackName: title ? `${cue} ${title}` : cue,
    regionName: title ? `${cue} ${title}` : cue,
  };
}

function listWavs(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .sort();
}

function assetId(fileName) {
  return path.basename(fileName, '.wav')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function addTrack(tracks, seen, name) {
  if (!seen.has(name)) {
    seen.add(name);
    tracks.push({ name, inputChannels: 2, outputChannels: 2 });
  }
}

function buildDawZipManifest(sourceRoot, options = {}) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  assertDirectory(absoluteSourceRoot, 'sourceRoot');
  const outRoot = path.resolve(options.outRoot || '/tmp/siann-user-daw-demo');
  const sessionDir = path.resolve(options.sessionDir || path.join(outRoot, 'Session'));
  const previewPath = path.resolve(options.previewPath || path.join(outRoot, 'preview.wav'));
  const journalPath = path.resolve(options.journalPath || path.join(outRoot, 'journal.json'));
  const bgmDir = path.join(absoluteSourceRoot, '_DAW');
  const sfxDir = path.join(absoluteSourceRoot, '_SpliceSFX');
  const placementByFile = parsePlacementSheet(path.join(bgmDir, 'placement.md'));

  const tracks = [];
  const seenTracks = new Set();
  const assets = [];

  for (const fileName of listWavs(bgmDir)) {
    const names = bgmNames(fileName);
    const placement = placementByFile.get(fileName);
    addTrack(tracks, seenTracks, names.trackName);
    const asset = {
      id: assetId(fileName),
      path: path.join(bgmDir, fileName),
      trackName: names.trackName,
      regionName: names.regionName,
      start: secondsFromName(fileName),
    };
    if (placement) {
      asset.sourceStart = placement.sourceStart;
      asset.duration = placement.duration;
    }
    assets.push(asset);
  }

  for (const fileName of listWavs(sfxDir)) {
    const names = sfxNames(fileName);
    addTrack(tracks, seenTracks, names.trackName);
    assets.push({
      id: assetId(fileName),
      path: path.join(sfxDir, fileName),
      trackName: names.trackName,
      regionName: names.regionName,
      start: secondsFromName(fileName),
    });
  }

  if (assets.length === 0) {
    throw new Error('no WAV assets found under _DAW or _SpliceSFX');
  }

  return {
    schemaVersion: 'siann.import_pack.v0',
    session: {
      dir: sessionDir,
      name: options.sessionName || 'UserDawPlacementDemo',
      sampleRate: options.sampleRate || 48000,
    },
    journalPath,
    batchRisk: 'normal',
    snapshotRetention: { maxCount: 3 },
    tracks,
    assets,
    preview: {
      outputPath: previewPath,
      sampleRate: options.sampleRate || 48000,
    },
  };
}

function writeDawZipManifest(sourceRoot, manifestFile, options = {}) {
  const absoluteManifestFile = path.resolve(manifestFile);
  const manifest = buildDawZipManifest(sourceRoot, options);
  fs.mkdirSync(path.dirname(absoluteManifestFile), { recursive: true });
  fs.writeFileSync(absoluteManifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    ok: true,
    workflow: 'create-daw-manifest',
    sourceRoot: path.resolve(sourceRoot),
    manifestFile: absoluteManifestFile,
    trackCount: manifest.tracks.length,
    assetCount: manifest.assets.length,
  };
}

module.exports = {
  buildDawZipManifest,
  writeDawZipManifest,
};
