'use strict';

// native/cmake/SiannStaleBuildCache.cmake, run in CMake script mode on a fake build
// tree: a nested cache made from a dependency's old source directory (JUCE's
// juceaide under <build>/_deps/juce-build/tools, from before the shared dependency
// cache) is removed; caches made from the current sources, or from sources the
// build generated, stay. Skipped where CMake is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'native', 'cmake', 'SiannStaleBuildCache.cmake');
const MSVC_ENV = path.join(ROOT, 'native', 'tools', 'msvc-env.cmd');

// cmake on PATH, else (Windows) the one Visual Studio bundles.
function findCmake() {
  const direct = spawnSync('cmake', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (direct.status === 0) return (args) => spawnSync('cmake', args, { encoding: 'utf8', windowsHide: true });
  if (process.platform === 'win32' && fs.existsSync(MSVC_ENV)) {
    const run = (args) => spawnSync('cmd.exe', ['/d', '/c', MSVC_ENV, 'cmake', ...args], { encoding: 'utf8', windowsHide: true });
    if (run(['--version']).status === 0) return run;
  }
  return null;
}

const cmake = findCmake();
const cmakePath = (p) => p.split(path.sep).join('/');

function writeCache(dir, home) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CMakeCache.txt'),
    `# This is the CMakeCache file.\nCMAKE_CACHEFILE_DIR:INTERNAL=${cmakePath(dir)}\nCMAKE_HOME_DIRECTORY:INTERNAL=${cmakePath(home)}\n`);
}

test('stale nested caches of a moved dependency source are removed', { skip: cmake ? false : 'cmake not found' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-stale-cache-'));
  try {
    const build = path.join(tmp, 'build');
    const oldSource = path.join(build, '_deps', 'juce-src'); // the layout before the shared cache
    const newSource = path.join(tmp, 'fetchcontent', 'juce-0123456789abcdef');
    const binary = path.join(build, '_deps', 'juce-build');
    fs.mkdirSync(path.join(oldSource, 'extras'), { recursive: true });
    fs.mkdirSync(path.join(newSource, 'extras'), { recursive: true });

    writeCache(path.join(binary, 'tools'), oldSource); // juceaide, configured pre-move
    fs.writeFileSync(path.join(binary, 'tools', 'juceaide.obj'), '');
    writeCache(path.join(binary, 'current'), path.join(newSource, 'extras')); // current sources
    writeCache(path.join(binary, 'generated'), path.join(binary, 'gen-src')); // generated in the build
    fs.writeFileSync(path.join(binary, 'keep.txt'), '');

    const driver = path.join(tmp, 'driver.cmake');
    fs.writeFileSync(driver, [
      `include("${cmakePath(MODULE)}")`,
      `siann_remove_stale_nested_caches("${cmakePath(binary)}" "${cmakePath(newSource)}")`,
      // A missing binary directory is not an error.
      `siann_remove_stale_nested_caches("${cmakePath(path.join(build, 'none'))}" "${cmakePath(newSource)}")`,
      '',
    ].join('\n'));
    const result = cmake(['-P', driver]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    assert.ok(!fs.existsSync(path.join(binary, 'tools')), 'the juceaide build from the old source is removed');
    assert.ok(fs.existsSync(path.join(binary, 'current', 'CMakeCache.txt')));
    assert.ok(fs.existsSync(path.join(binary, 'generated', 'CMakeCache.txt')));
    assert.ok(fs.existsSync(path.join(binary, 'keep.txt')));
    assert.ok(fs.existsSync(oldSource), 'sources are never touched');
    assert.match(`${result.stdout}${result.stderr}`, /Removing .*tools: configured from /);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The same temporary directory under a second spelling: a symlink on POSIX (macOS's
// os.tmpdir() is already one: /var -> /private/var), the 8.3 short name on Windows
// (C:\Users\RUNNER~1 on GitHub's runners), else a junction. null when neither exists.
function aliasOf(dir) {
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
    const short = r.status === 0 ? r.stdout.trim() : '';
    if (short && short.toLowerCase() !== dir.toLowerCase() && fs.existsSync(short)) return short;
  }
  const link = `${dir}-alias`;
  try {
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  } catch {
    return null;
  }
}

test('nested caches are judged through symlinked or short-named paths, existing or not', { skip: cmake ? false : 'cmake not found' }, (t) => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'siann-stale-alias-')));
  const alias = aliasOf(tmp);
  try {
    if (!alias) {
      t.skip('no second spelling of the temporary directory');
      return;
    }
    const via = (root, ...parts) => path.join(root, ...parts);
    const source = via(tmp, 'src');
    const oldSource = via(tmp, 'old-src');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(oldSource, { recursive: true });
    const binary = via(alias, 'build'); // the module is handed the alias, as CMake hands it
    const realBinary = via(tmp, 'build');

    // Kept: sources that do not exist yet, inside the build or the source tree, under either spelling.
    writeCache(path.join(realBinary, 'gen-alias'), via(alias, 'build', 'gen-alias', 'src'));
    writeCache(path.join(realBinary, 'gen-real'), via(tmp, 'build', 'gen-real', 'src'));
    writeCache(path.join(realBinary, 'src-alias'), via(alias, 'src', 'not', 'yet'));
    // Removed: sources outside both trees, existing or not, under either spelling.
    writeCache(path.join(realBinary, 'out-missing'), via(alias, 'elsewhere', 'missing'));
    writeCache(path.join(realBinary, 'out-old'), oldSource);

    const driver = path.join(tmp, 'driver.cmake');
    fs.writeFileSync(driver, [
      `include("${cmakePath(MODULE)}")`,
      `siann_remove_stale_nested_caches("${cmakePath(binary)}" "${cmakePath(via(alias, 'src'))}")`,
      '',
    ].join('\n'));
    const result = cmake(['-P', driver]);
    const log = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, log);

    for (const kept of ['gen-alias', 'gen-real', 'src-alias']) {
      assert.ok(fs.existsSync(path.join(realBinary, kept, 'CMakeCache.txt')), `${kept} survives (alias ${alias})\n${log}`);
    }
    for (const removed of ['out-missing', 'out-old']) {
      assert.ok(!fs.existsSync(path.join(realBinary, removed)), `${removed} is removed (alias ${alias})\n${log}`);
    }
    assert.ok(fs.existsSync(oldSource), 'sources are never touched');
  } finally {
    if (alias && alias.endsWith('-alias')) fs.rmSync(alias, { recursive: false, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the shared dependency cache drops stale nested caches before FetchContent', () => {
  const text = fs.readFileSync(path.join(ROOT, 'native', 'cmake', 'SiannDependencyCache.cmake'), 'utf8');
  assert.match(text, /include\("\$\{CMAKE_CURRENT_LIST_DIR\}\/SiannStaleBuildCache\.cmake"\)/);
  // Both when the shared cache supplies the sources and when it does not (the reverse move).
  assert.equal(text.match(/siann_remove_stale_nested_caches\(/g).length, 2);
});
