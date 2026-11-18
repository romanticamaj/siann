#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeDemoAudio } = require('./create-demo-audio');

function parseArgs(argv) {
  const options = {
    outRoot: path.join(os.tmpdir(), 'siann-import-pack-demo'),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.outRoot = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/create-demo-import-pack.js [--out <dir>] [--json]',
    '',
  ].join('\n'));
}

function buildDemoManifest(outRoot) {
  const absoluteOutRoot = path.resolve(outRoot);
  const audioDir = writeDemoAudio(path.join(absoluteOutRoot, 'audio'));
  return {
    schemaVersion: 'siann.import_pack.v0',
    session: {
      dir: path.join(absoluteOutRoot, 'Session'),
      name: 'ImportPackDemo',
      sampleRate: 48000,
    },
    journalPath: path.join(absoluteOutRoot, 'journal.json'),
    batchRisk: 'normal',
    snapshotRetention: {
      maxCount: 3,
    },
    tracks: [
      {
        name: 'FX Risers',
        inputChannels: 1,
        outputChannels: 2,
      },
      {
        name: 'Impacts',
        inputChannels: 1,
        outputChannels: 2,
      },
    ],
    assets: [
      {
        id: 'riser_01',
        path: path.join(audioDir, 'riser.wav'),
        trackName: 'FX Risers',
        regionName: 'Riser 01',
        start: '8',
      },
      {
        id: 'impact_01',
        path: path.join(audioDir, 'impact.wav'),
        trackName: 'Impacts',
        regionName: 'Impact 01',
        start: '12',
      },
    ],
    preview: {
      outputPath: path.join(absoluteOutRoot, 'preview.wav'),
      sampleRate: 48000,
    },
  };
}

function writeDemoImportPack(outRoot) {
  const absoluteOutRoot = path.resolve(outRoot);
  const manifest = buildDemoManifest(absoluteOutRoot);
  const manifestFile = path.join(absoluteOutRoot, 'manifest.json');
  fs.mkdirSync(absoluteOutRoot, { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    ok: true,
    workflow: 'create-demo-import-pack',
    outRoot: absoluteOutRoot,
    manifestFile,
    audioDir: path.join(absoluteOutRoot, 'audio'),
    trackCount: manifest.tracks.length,
    assetCount: manifest.assets.length,
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    const summary = writeDemoImportPack(options.outRoot);
    process.stdout.write(options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `Wrote demo import pack to ${summary.outRoot}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildDemoManifest,
  writeDemoImportPack,
};

