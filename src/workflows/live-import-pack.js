const {
  RuntimeClient,
  engineRuntimeCommand,
} = require('../runtime/client');
const {
  loadImportPackManifest,
} = require('./import-pack');
const { scriptInvocation } = require('../bridge/script-invocation');

function buildLiveImportCommands(manifest) {
  const commands = [];
  for (const track of manifest.tracks) {
    commands.push({
      op: 'create_audio_track',
      name: track.name,
      inputChannels: track.inputChannels || 1,
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
      createTrack: false,
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
  return commands;
}

function runtimeInvocation(options = {}) {
  if (options.runtime) {
    return options.runtime;
  }
  if (options.runner) {
    return scriptInvocation(options.runner);
  }
  return engineRuntimeCommand({ engineDir: options.engineDir });
}

async function runLiveImportPack(manifestFile, options = {}) {
  const manifest = loadImportPackManifest(manifestFile);
  const invocation = runtimeInvocation(options);
  const client = new RuntimeClient(invocation);
  let stopped = false;

  await client.start();
  try {
    const started = await client.request('runtime.start', { protocolVersion: 0 });
    const created = await client.request('session.create', {
      sessionDir: manifest.session.dir,
      sessionName: manifest.session.name,
      sampleRate: manifest.session.sampleRate || 48000,
    });
    const { sessionId } = created.body;
    const observed = await client.request('session.observe', { sessionId });
    const commands = buildLiveImportCommands(manifest);
    const applied = await client.request('commands.apply', {
      sessionId,
      expectedObservationHash: observed.body.observationHash,
      commands,
    });

    let preview = null;
    if (manifest.preview) {
      preview = await client.request('render.preview', {
        sessionId,
        outputPath: manifest.preview.outputPath,
        sampleRate: manifest.preview.sampleRate || manifest.session.sampleRate || 48000,
        bitDepth: manifest.preview.bitDepth || '16',
        normalize: Boolean(manifest.preview.normalize),
      });
    }

    const saved = await client.request('session.save', { sessionId });
    const closed = await client.request('session.close', { sessionId });
    await client.request('runtime.stop', {});
    stopped = true;

    return {
      ok: true,
      workflow: 'live-import-pack',
      manifestFile,
      runtime: {
        protocolVersion: started.body.protocolVersion,
        capabilities: started.body.capabilities || [],
      },
      session: {
        id: sessionId,
        dir: manifest.session.dir,
        name: manifest.session.name,
        sampleRate: manifest.session.sampleRate || 48000,
      },
      apply: {
        commandCount: commands.length,
        resultCount: applied.body.results.length,
        observationHash: applied.body.observationHash,
        rollback: applied.body.rollback || null,
      },
      preview: preview ? preview.body : null,
      journal: applied.body.journal || null,
      saved: Boolean(saved.body.saved),
      closed: Boolean(closed.body.closed),
    };
  } finally {
    if (!stopped) {
      try {
        await client.request('runtime.stop', {});
      } catch (error) {
        // The process may already be gone after a runtime-level failure.
      }
    }
    client.close();
  }
}

module.exports = {
  buildLiveImportCommands,
  runLiveImportPack,
};
