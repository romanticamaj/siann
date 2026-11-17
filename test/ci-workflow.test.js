'use strict';

// The RealtimeSanitizer CI job (architecture spec, "Build, test and CI" and
// "Realtime rules and enforcement"; milestone feature m2-rtsan-ci). The
// workflow is read as text: the project has no YAML dependency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml');

// Top-level jobs as { id, text }: a job starts at a two-space-indented key
// under `jobs:` and runs to the next one.
function jobs(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.ok(start >= 0, 'ci.yml has a jobs: section');
  const found = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) found.push({ id: key[1], lines: [] });
    else if (/^\S/.test(line)) break;
    else if (found.length) found[found.length - 1].lines.push(line);
  }
  return found.map((job) => ({ id: job.id, text: job.lines.join('\n') }));
}

function rtsanJob() {
  const all = jobs(fs.readFileSync(WORKFLOW, 'utf8'));
  const job = all.find((j) => /-DSIANN_RTSAN=ON/.test(j.text));
  assert.ok(job, `a job configures the native core with -DSIANN_RTSAN=ON (jobs: ${all.map((j) => j.id).join(', ')})`);
  return job;
}

test('the desktop job runs the editor-ownership test against its JUCE engine, not skipping it', () => {
  const job = jobs(fs.readFileSync(WORKFLOW, 'utf8')).find((j) => /-DSIANN_WITH_JUCE=ON/.test(j.text));
  assert.ok(job, 'a job builds with JUCE');
  assert.match(job.text, /SIANN_DESKTOP_ENGINE_EXE=/);
  assert.match(job.text, /SIANN_TEST_PLUGIN=/);
  // m5-clap-editor-window: the CLAP case of editor.spec.ts runs too.
  assert.match(job.text, /SIANN_TEST_PLUGIN_CLAP=/);
  assert.match(job.text, /playwright test editor\.spec\.ts/);
});

test('a Linux CI job installs Clang 20 or later from apt.llvm.org', () => {
  const { text } = rtsanJob();
  assert.match(text, /runs-on:\s*ubuntu-/);
  assert.match(text, /https:\/\/apt\.llvm\.org\/llvm\.sh/);
  const version = /llvm\.sh\s+(\d+)/.exec(text);
  assert.ok(version, 'llvm.sh is given a major version');
  assert.ok(Number(version[1]) >= 20, `RTSan needs Clang 20 or later, got ${version[1]}`);
});

test('the RTSan job builds the native core with that Clang and the sanitizer on', () => {
  const { text } = rtsanJob();
  const configure = text.split('\n').find((line) => /cmake\s+-S\s+native/.test(line));
  assert.ok(configure, 'the job configures native/');
  assert.match(configure, /-DSIANN_RTSAN=ON/);
  assert.match(configure, /-DSIANN_WERROR=ON/);
  const compiler = /-DCMAKE_CXX_COMPILER=clang\+\+-(\d+)/.exec(configure);
  assert.ok(compiler, 'the configure line names clang++-NN');
  assert.ok(Number(compiler[1]) >= 20);
  assert.match(text, /cmake\s+--build\s+native\/build\/rtsan/);
});

test('the RTSan job halts on the first report and runs every native test', () => {
  const { text } = rtsanJob();
  assert.match(text, /RTSAN_OPTIONS:.*halt_on_error=1/);
  // The whole suite: realtime, playback, host_fake, cli and the canaries.
  assert.match(text, /ctest\s+--test-dir\s+native\/build\/rtsan[^\n]*--no-tests=error/);
  assert.doesNotMatch(text, /ctest[^\n]*\s-R\s/, 'the job runs the whole suite, not a filter');
});

test('the RTSan job runs the [src] tests through r8brain explicitly', () => {
  const { text } = rtsanJob();
  assert.match(text, /native\/build\/rtsan\/libs\/realtime\/siann_realtime_tests\s+"\[src\]"/);
});

// Acceptance 3 of m2-rtsan-ci: the spec records the outcome of an observed
// RTSan run, never a permanent "pending". An observed run is either a GitHub
// Actions run (cited by link) or a local run of the job's exact commands,
// recorded with the Clang version it used and the counts it printed.
const SPEC = path.join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-14-siann-native-daw-architecture.md');
const RUN_LINK = /github\.com\/romanticamaj\/siann\/actions\/runs\/\d+/;
const LOCAL_RUN = /Clang 20\.\d+\.\d+/;
const PENDING = /pending the first green run|has not (been )?run|no machine used for M2 has Clang/i;

function specText() {
  return fs.readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n');
}

// The RealtimeSanitizer sub-bullet of "Device-side SRC (M2)", up to the next bullet.
function srcRtsanBullet(spec) {
  const start = spec.indexOf('\n  - RealtimeSanitizer:');
  assert.ok(start >= 0, 'the "Device-side SRC (M2)" section has a RealtimeSanitizer bullet');
  const rest = spec.slice(start + 1);
  const end = rest.slice(1).search(/\n {0,2}- /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function citesObservedRun(text) {
  return RUN_LINK.test(text) || (LOCAL_RUN.test(text) && /\b\d+ ctest tests passed\b/.test(text));
}

test('the spec records an observed RTSan run and the r8brain outcome, not a pending state', () => {
  const bullet = srcRtsanBullet(specText());
  assert.doesNotMatch(bullet, PENDING, 'the bullet reports a run, not that none has happened');
  assert.ok(citesObservedRun(bullet), 'the bullet cites an Actions run or a local run with its Clang version and ctest count');
  assert.match(
    bullet,
    /adoption is final|violations found/i,
    'the bullet says r8brain adoption is final or lists the violations RTSan found',
  );
  assert.doesNotMatch(bullet, /adoption is provisional/i);
  assert.match(bullet, /siann_rtsan_canary|canar/i, 'a clean run is only meaningful with the canaries reporting');
});

test('m2-exit-rt-safety is Met with a cited RTSan run', () => {
  const row = specText().split('\n').find((line) => /^\|.*\(`m2-exit-rt-safety`\)/.test(line));
  assert.ok(row, 'the M2 exit table has an m2-exit-rt-safety row');
  const [, , status, evidence] = row.split('|').map((cell) => cell.trim());
  assert.equal(status, 'Met');
  assert.doesNotMatch(evidence, PENDING);
  assert.ok(citesObservedRun(evidence), 'Met cites an Actions run or a local run with its Clang version and ctest count');
});

// The Electron shell job (m0-electron-shell; spec, "Build, test and CI"):
// the core-only siann-engine target and the Playwright Electron tests in app/
// on all three desktop OSes.
function appJob() {
  const all = jobs(fs.readFileSync(WORKFLOW, 'utf8'));
  const job = all.find((j) => j.id === 'app');
  assert.ok(job, `an app job exists (jobs: ${all.map((j) => j.id).join(', ')})`);
  return job;
}

test('an app CI job runs the Electron shell tests on Windows, macOS and Linux', () => {
  const { text } = appJob();
  const matrix = /os:\s*\[([^\]]*)\]/.exec(text);
  assert.ok(matrix, 'the app job has an os matrix');
  const oses = matrix[1].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(oses, ['macos-latest', 'ubuntu-latest', 'windows-latest']);
  assert.match(text, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(text, /xvfb-run -a (-s '[^']*' )?npm test/, 'Linux runs Electron under xvfb-run');
  assert.match(text, /SIANN_E2E_DEVICE_SCALE:\s*'1\.5'/, 'Linux runs the Electron specs at a 150 % display scale');
});

test('the app job builds only the core-only siann-engine target and points the tests at it', () => {
  const { text } = appJob();
  const configure = text.split('\n').find((line) => /cmake\s+-S\s+native/.test(line));
  assert.ok(configure, 'the app job configures native/');
  assert.doesNotMatch(configure, /SIANN_WITH_JUCE=ON/, 'core-only: no JUCE');
  assert.match(text, /cmake\s+--build\s+\S+[^\n]*--target\s+siann-engine\b/);
  assert.match(text, /SIANN_ENGINE_EXE=/);
  assert.match(text, /npm ci/);
  assert.match(text, /working-directory:\s*app/);
});

// ---- pluginval (m4-juce-formats, acceptance 1; spec, Libraries, "Build, test and CI") ----

function desktopJob() {
  const job = jobs(fs.readFileSync(WORKFLOW, 'utf8')).find((j) => /-DSIANN_WITH_JUCE=ON/.test(j.text));
  assert.ok(job, 'a job builds with JUCE');
  return job;
}

// The job's steps as text, one per six-space-indented `- ` item.
function steps(job) {
  return job.text.split(/\n(?= {6}- )/).filter((step) => /^ {6}- /.test(step));
}

const PLUGINVAL_RELEASE = 'https://github.com/Tracktion/pluginval/releases/download/v1.0.4/';

test('the desktop job downloads a pinned pluginval release for its OS and checks its hash', () => {
  const { text } = desktopJob();
  assert.doesNotMatch(text, /pluginval\/releases\/(latest|download\/latest)/);
  assert.ok(text.includes(PLUGINVAL_RELEASE), 'pluginval v1.0.4 from its GitHub release');
  for (const os of ['Windows', 'macOS', 'Linux']) {
    assert.match(text, new RegExp(`pluginval_${os}\\.zip`), os);
  }
  const hashes = text.match(/\b[0-9a-f]{64}\b/g) || [];
  assert.ok(new Set(hashes).size >= 3, 'a sha256 for each of the three archives');
  assert.match(text, /sha256sum -c|shasum -a 256 -c/);
  assert.match(text, /curl -fL --retry/);
  assert.match(text, /SIANN_PLUGINVAL=/);
});

test('the desktop job validates siann_test_plugin.vst3 at strictness 5 through scripts/pluginval.js', () => {
  const runs = steps(desktopJob()).filter((step) => /node scripts\/pluginval\.js/.test(step));
  assert.ok(runs.length > 0, 'a step runs scripts/pluginval.js');
  const vst3 = runs.filter((step) => /siann_test_plugin\.vst3/.test(step));
  assert.ok(vst3.length > 0, 'against the VST3');
  for (const step of runs) assert.match(step, /--strictness-level 5\b/);
  // Linux runs it under the virtual display and window manager the editor tests need.
  const linux = vst3.find((step) => /runner\.os == 'Linux'/.test(step));
  assert.ok(linux, 'a Linux pluginval step');
  assert.match(linux, /xvfb-run -a sh -c '?"?openbox &/);
  assert.ok(
    vst3.some((step) => /runner\.os != 'Linux'/.test(step)),
    'Windows and macOS validate the VST3 without the virtual display',
  );
});

test('on macOS the desktop job installs the AU for the runner alone and validates it', () => {
  const au = steps(desktopJob()).find(
    (step) => /siann_test_plugin\.component/.test(step) && /node scripts\/pluginval\.js/.test(step),
  );
  assert.ok(au, 'a step validates the AU');
  assert.match(au, /runner\.os == 'macOS'/);
  assert.match(au, /~\/Library\/Audio\/Plug-Ins\/Components/);
  assert.match(au, /--strictness-level 5\b/);
});

test("the desktop job keeps pluginval's logs when it fails", () => {
  const upload = steps(desktopJob()).find((step) => /actions\/upload-artifact@v4/.test(step));
  assert.ok(upload, 'an upload-artifact step');
  assert.match(upload, /if: failure\(\)/);
  assert.match(upload, /pluginval-logs/);
});

test("the app job keeps Playwright's results when its e2e fails, on every OS", () => {
  const job = jobs(fs.readFileSync(WORKFLOW, 'utf8')).find((j) => j.id === 'app');
  assert.ok(job, 'an app job exists');
  const upload = steps(job).find((step) => /name: Upload the e2e results/.test(step));
  assert.ok(upload, 'an e2e results upload step');
  assert.match(upload, /if: failure\(\)/);
  assert.doesNotMatch(upload, /if:[^\n]*runner\.os/);
  assert.match(upload, /actions\/upload-artifact@v4/);
  assert.match(upload, /name: e2e-results-\$\{\{ runner\.os \}\}/);
  assert.match(upload, /path: app\/test-results/);
});

test('the app job builds siann-cli and hands it to the timeline e2e as SIANN_CLI_EXE', () => {
  const job = jobs(fs.readFileSync(WORKFLOW, 'utf8')).find((j) => j.id === 'app');
  assert.ok(job, 'an app job exists');
  const build = job.text.split('\n').find((line) => /cmake --build native\/build\/app/.test(line));
  assert.ok(build, 'the app job builds native/build/app');
  assert.match(build, /--target[^\n]*\bsiann-cli\b/);
  assert.match(job.text, /SIANN_CLI_EXE=/);
});

test("check-all's app step passes the dev build's siann-cli to the e2e", () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-all.js'), 'utf8');
  assert.match(text, /SIANN_CLI_EXE/);
  assert.match(text, /'apps', 'cli'/);
});

// ---- Path-filtered jobs, compiler caches and the aggregate check (issue #88) ----

const ACTION = path.join(__dirname, '..', '.github', 'actions', 'compiler-cache', 'action.yml');
const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const job = (id) => {
  const all = jobs(workflowText());
  const found = all.find((j) => j.id === id);
  assert.ok(found, `a ${id} job exists (jobs: ${all.map((j) => j.id).join(', ')})`);
  return found;
};

test('CI runs on pull requests, pushes to main, nightly and by hand', () => {
  const on = workflowText().split(/\njobs:\n/)[0];
  assert.match(on, /\n {2}push:\n {4}branches: \[main\]/);
  assert.match(on, /\n {2}pull_request:/);
  assert.match(on, /\n {2}schedule:\n {4}- cron: '[^']+'/);
  assert.match(on, /\n {2}workflow_dispatch:/);
});

test('the changes job picks jobs with check-all --changed and a plain git diff', () => {
  const { text } = job('changes');
  const uses = text.match(/uses:\s*\S+/g) || [];
  assert.deepEqual(uses.map((u) => u.replace(/uses:\s*/, '')), ['actions/checkout@v4'], 'no third-party action');
  assert.match(text, /fetch-depth: 2/);
  assert.match(text, /node scripts\/check-all\.js --changed --base HEAD\^1 --plan --json/);
  // Everything outside a pull request.
  assert.match(text, /github\.event_name \}\}" = pull_request/);
  assert.match(text, /"steps":\["node","native","bridge","desktop","app","package","gcc"\]/);
  for (const output of ['native', 'bridge', 'desktop', 'app', 'package']) {
    assert.ok(text.includes(`\n      ${output}: \${{ steps.pick.outputs.${output} }}`), output);
  }
});

test('the build jobs run only when their paths change; Node always runs', () => {
  const gate = { native: 'native', rtsan: 'native', 'bridge-engine': 'bridge', desktop: 'desktop', app: 'app',
    package: 'package' };
  for (const [id, output] of Object.entries(gate)) {
    const { text } = job(id);
    assert.match(text, /\n {4}needs: changes\n/, `${id} needs changes`);
    assert.ok(text.includes(`\n    if: needs.changes.outputs.${output} == 'true'\n`), `${id} is gated on ${output}`);
  }
  const node = job('node').text;
  assert.doesNotMatch(node, /\n {4}if:/);
  assert.doesNotMatch(node, /\n {4}needs:/);
});

// docs/harness/test-matrix.md, "How to keep it complete": the bridge's tests run
// on the three desktop OSes, not on Linux alone.
test('the Node job runs npm test on Windows, macOS and Linux', () => {
  const { text } = job('node');
  const matrix = /os:\s*\[([^\]]*)\]/.exec(text);
  assert.ok(matrix, 'the node job has an os matrix');
  assert.deepEqual(matrix[1].split(',').map((s) => s.trim()).sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest']);
  assert.match(text, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(text, /fail-fast:\s*false/);
  assert.match(text, /run: npm test/);
});

// m5b-bridge-cli-coverage (acceptance item 5; spec, "Build, test and CI"): on
// ubuntu the node job enforces 70 % branch coverage of bin/siann.js. The flags
// need Node 22.8, so they are not in npm test (engines floor Node 20).
test('the Node job enforces 70 % branch coverage of bin/** on ubuntu only', () => {
  const node = job('node');
  const gate = steps(node).filter((step) => step.includes('--experimental-test-coverage'));
  assert.equal(gate.length, 1, 'one coverage step');
  const [step] = gate;
  assert.match(step, /--test-coverage-include='?bin\/\*\*'?/);
  assert.match(step, /--test-coverage-branches=70\b/);
  assert.match(step, /\n {8}if: matrix\.os == 'ubuntu-latest'\n/);
  assert.match(node.text, /node-version: 22\b/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.scripts.test, /coverage/);
});

test('the native, RTSan, desktop and app jobs build through the compiler cache', () => {
  for (const id of ['native', 'rtsan', 'desktop', 'app']) {
    const { text } = job(id);
    const cache = text.indexOf('uses: ./.github/actions/compiler-cache');
    assert.ok(cache >= 0, `${id} uses the compiler cache`);
    assert.match(text, new RegExp(`compiler-cache\n {8}with:\n {10}name: ${id}\n`), `${id} keys its own cache`);
    const configure = text.search(/cmake\s+-S\s+native/);
    assert.ok(cache < configure, `${id} sets the cache up before it configures`);
  }
});

test('the compiler cache: ccache on Linux and macOS, a pinned and checked sccache on Windows', () => {
  const text = fs.readFileSync(ACTION, 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /using: composite/);
  assert.match(text, /apt-get install -y -q ccache/);
  assert.match(text, /brew install ccache/);
  assert.match(text, /mozilla\/sccache\/releases\/download\/\$version\/\$zip/);
  assert.match(text, /version=v\d+\.\d+\.\d+\n/, 'a pinned sccache release');
  assert.match(text, /sum=[0-9a-f]{64}\n/);
  assert.match(text, /sha256sum -c -/);
  // The Visual Studio generator ignores launchers: Ninja in the MSVC environment.
  assert.ok(text.includes('call native\\tools\\msvc-env.cmd set'));
  assert.match(text, /CMAKE_GENERATOR=Ninja/);
  const cache = text.slice(text.indexOf('uses: actions/cache@v4'));
  assert.match(cache, /key: compiler-\$\{\{ inputs\.name \}\}-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('native\/CMakePresets\.json', 'native\/\*\*\/CMakeLists\.txt', 'native\/cmake\/\*\*'\) \}\}-/);
  assert.match(cache, /restore-keys:/);
});

test('every action is GitHub\'s own or this repository\'s', () => {
  for (const file of [WORKFLOW, ACTION]) {
    for (const [, ref] of fs.readFileSync(file, 'utf8').matchAll(/uses:\s*(\S+)/g)) {
      assert.match(ref, /^(actions\/[a-z-]+@v\d+|\.\/\.github\/actions\/[a-z-]+)$/, `${path.basename(file)}: ${ref}`);
    }
  }
});

test('a CI ok job passes only when every job passed or was skipped for its paths', () => {
  const { text } = job('ci-ok');
  assert.match(text, /(^|\n) {4}name: CI ok\n/);
  assert.match(text, /(^|\n) {4}if: always\(\)\n/);
  const needs = /(?:^|\n) {4}needs: \[([^\]]*)\]/.exec(text);
  assert.ok(needs, 'ci-ok lists what it needs');
  const others = jobs(workflowText()).map((j) => j.id).filter((id) => id !== 'ci-ok').sort();
  assert.deepEqual(needs[1].split(',').map((s) => s.trim()).sort(), others, 'ci-ok needs every other job');
  assert.match(text, /join\(needs\.\*\.result, ' '\)/);
  assert.match(text, /success\|skipped\) ;;/);
  assert.match(text, /exit 1/);
});

// ---- The Windows installer (m5b-package-windows, acceptances 3 and 7) ----

test('the changes job turns the package step into the package output', () => {
  const { text } = job('changes');
  assert.match(text, /package: steps\.has\("package"\)/);
  // A docs-only change never maps to the package step (stepsForPath; check-all-changed.test.js).
  const { stepsForPaths } = require('../scripts/check-all');
  assert.ok(!stepsForPaths(['docs/x.md', 'README.md', '.claude/milestones/M5b.json']).includes('package'));
});

test('a package job builds the installer on windows-latest, signing nothing and reading no secret', () => {
  const { text } = job('package');
  assert.match(text, /\n {4}runs-on: windows-latest\n/);
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC/);
  assert.match(text, /CSC_IDENTITY_AUTO_DISCOVERY: ['"]?false['"]?/);
  // The desktop-release engine (static CRT) is what the installer ships.
  assert.match(text, /cmake --preset desktop-release/);
  assert.match(text, /cmake --build --preset desktop-release --target siann-engine/);
  // Its crash tests, in the static-CRT configuration the installer ships.
  assert.match(text, /--target siann-engine siann_engine_host_tests siann_engine_launch_tests siann_host_clap_tests/);
  assert.match(text, /ctest --preset desktop-release -R crash/);
  assert.match(text, /npm run dist/);
  assert.match(text, /node --test test\/package\//);
  assert.match(text, /SIANN_PACKAGE_DIR/);
});

test('the package job runs the smoke e2e on win-unpacked and on the silently installed app, then uninstalls', () => {
  const all = steps(job('package'));
  const index = (re) => all.findIndex((s) => re.test(s));
  const unpacked = index(/SIANN_PACKAGED_EXE[^\n]*win-unpacked/);
  const install = index(/\/S[^\n]*\/D=/);
  const installed = all.findIndex((s, i) => i > install && /SIANN_PACKAGED_EXE/.test(s) && /playwright test --project packaged/.test(s));
  const uninstall = index(/Uninstall SIANN\.exe[^\n]*\/S/);
  assert.ok(unpacked >= 0, 'the smoke run on win-unpacked');
  assert.match(all[unpacked], /playwright test --project packaged/);
  assert.match(all[unpacked], /SIANN_EXPECT_COMMIT/);
  assert.ok(install > unpacked, 'a silent install into a directory of its own');
  assert.ok(installed > install, 'the smoke run on the installed app');
  assert.match(all[installed], /SIANN_EXPECT_COMMIT/);
  assert.ok(uninstall > installed, 'a silent uninstall');
  // The uninstaller removes what it installed.
  assert.match(all.slice(uninstall).join('\n'), /Test-Path/);
});

test('the package job uploads the installer with its SHA-256', () => {
  const all = steps(job('package'));
  const hash = all.find((s) => /Get-FileHash|certutil/.test(s));
  assert.ok(hash, 'a step hashes the installer');
  assert.match(hash, /\.sha256/);
  const upload = all.find((s) => /actions\/upload-artifact@v4/.test(s) && /SIANN-Setup/.test(s));
  assert.ok(upload, 'an upload of the installer');
  assert.match(upload, /\.sha256/);
});

test('ci-ok waits for the package job', () => {
  const { text } = job('ci-ok');
  assert.match(text, /needs: \[[^\]]*\bpackage\b[^\]]*\]/);
});

// ---- The bridge against siann-engine (m5b-bridge-native-client, acceptance item 5) ----

test('a bridge-engine job runs the engine-gated Node tests on ubuntu, windows and macos', () => {
  const { text } = job('bridge-engine');
  const matrix = /os:\s*\[([^\]]*)\]/.exec(text);
  assert.ok(matrix, 'the bridge-engine job has an os matrix');
  assert.deepEqual(matrix[1].split(',').map((s) => s.trim()).sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest']);
  assert.match(text, /fail-fast:\s*false/);
  assert.match(text, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(text, /SIANN_RUN_ENGINE_TESTS:\s*'1'/);
  assert.match(text, /SIANN_ENGINE_EXE=/);
  assert.match(text, /run: npm test/);
});

test('the bridge-engine job builds the core-only siann-engine target the app job builds', () => {
  const { text } = job('bridge-engine');
  const configure = text.split('\n').find((line) => /cmake\s+-S\s+native/.test(line));
  assert.ok(configure, 'the job configures native/');
  assert.doesNotMatch(configure, /SIANN_WITH_JUCE=ON/, 'core-only: no JUCE');
  assert.match(configure, /-DSIANN_WERROR=ON/);
  assert.match(text, /cmake\s+--build\s+\S+[^\n]*--target\s+siann-engine\s*\n/);
  assert.match(text, /compiler-cache\n {8}with:\n {10}name: bridge-engine\n/);
});

test('the changes job turns the bridge step into the bridge output, and ci-ok waits for bridge-engine', () => {
  assert.match(job('changes').text, /bridge: steps\.has\("bridge"\)/);
  assert.match(job('ci-ok').text, /needs: \[[^\]]*\bbridge-engine\b[^\]]*\]/);
});

// ---- The nightly quality jobs (m5b-nightly-quality, acceptance items 1 to 4, 6 and 7) ----
// .github/workflows/nightly.yml, a file of its own: no job of it can be in ci-ok,
// and its artifact names cannot collide with the app job's in the same run.

const NIGHTLY = path.join(__dirname, '..', '.github', 'workflows', 'nightly.yml');
const LONG_TESTS = path.join(__dirname, '..', '.github', 'workflows', 'long-tests.yml');
const NIGHTLY_JOBS = ['tour', 'fidelity', 'asan-ubsan', 'fuzz', 'coverage', 'perf'];
const FUZZ_TARGETS = ['protocol_ws', 'mcp_http', 'command_json'];

const nightlyText = () => {
  assert.ok(fs.existsSync(NIGHTLY), '.github/workflows/nightly.yml exists');
  return fs.readFileSync(NIGHTLY, 'utf8').replace(/\r\n/g, '\n');
};
const nightlyJob = (id) => {
  const all = jobs(nightlyText());
  const found = all.find((j) => j.id === id);
  assert.ok(found, `nightly.yml has a ${id} job (jobs: ${all.map((j) => j.id).join(', ')})`);
  return found;
};

// The lines of a top-level YAML key's block (without the key line).
function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  assert.ok(start >= 0, `top-level "${key}:" in the workflow`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block;
}

// Keys directly under a block, at its first indentation level.
function childKeys(block) {
  const indents = block.filter((l) => /^\s+\S/.test(l) && !/^\s*#/.test(l)).map((l) => l.match(/^\s*/)[0].length);
  if (indents.length === 0) return [];
  const level = Math.min(...indents);
  return block
    .filter((l) => l.match(/^\s*/)[0].length === level && /^\s*[A-Za-z_][\w-]*:/.test(l))
    .map((l) => l.trim().split(':')[0]);
}

const matrixOf = (text, key) => {
  const found = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
  assert.ok(found, `a ${key} matrix`);
  return found[1].split(',').map((s) => s.trim()).sort();
};
const configureLine = (text) => {
  const line = text.split('\n').find((l) => /cmake\s+-S\s+native/.test(l));
  assert.ok(line, 'the job configures native/');
  return line;
};
const cronOf = (text) => /-\s*cron:\s*'([^']+)'/.exec(text)?.[1];

test('the nightly workflow runs on a schedule and by hand only, at a time of its own', () => {
  const text = nightlyText();
  assert.deepEqual(childKeys(topLevelBlock(text, 'on')).sort(), ['schedule', 'workflow_dispatch']);
  const cron = cronOf(text);
  assert.ok(cron, 'a cron schedule');
  assert.notEqual(cron, cronOf(workflowText()), 'not at the time of ci.yml');
  assert.notEqual(cron, cronOf(fs.readFileSync(LONG_TESTS, 'utf8')), 'not at the time of long-tests.yml');
  assert.deepEqual(jobs(text).map((j) => j.id).sort(), [...NIGHTLY_JOBS].sort());
});

test('every nightly action is GitHub\'s own or this repository\'s', () => {
  for (const [, ref] of nightlyText().matchAll(/uses:\s*(\S+)/g)) {
    assert.match(ref, /^(actions\/[a-z-]+@v\d+|\.\/\.github\/actions\/[a-z-]+)$/, `nightly.yml: ${ref}`);
  }
});

test('no nightly job blocks a pull request: ci.yml names none and ci-ok needs what it did', () => {
  const ids = jobs(workflowText()).map((j) => j.id);
  for (const id of NIGHTLY_JOBS) assert.ok(!ids.includes(id), `ci.yml has no ${id} job`);
  const needs = /(?:^|\n) {4}needs: \[([^\]]*)\]/.exec(job('ci-ok').text);
  assert.deepEqual(needs[1].split(',').map((s) => s.trim()),
    ['changes', 'node', 'native', 'rtsan', 'bridge-engine', 'desktop', 'app', 'package']);
  for (const { text } of jobs(nightlyText())) assert.doesNotMatch(text, /continue-on-error/);
});

test('nightly tour: ux-tour.spec.ts in en, zh-Hant and zh-Hans against the core-only engine, one artifact per locale', () => {
  const { text } = nightlyJob('tour');
  assert.deepEqual(matrixOf(text, 'locale'), ['en', 'zh-Hans', 'zh-Hant']);
  assert.match(text, /fail-fast:\s*false/);
  assert.match(text, /SIANN_UX_TOUR:\s*'1'/);
  assert.match(text, /SIANN_UX_LOCALE:\s*\$\{\{\s*matrix\.locale\s*\}\}/);
  assert.match(text, /SIANN_UX_OUT:/);
  assert.doesNotMatch(configureLine(text), /SIANN_WITH_JUCE/, 'core-only: no JUCE');
  assert.match(text, /cmake\s+--build\s+\S+[^\n]*--target\s+siann-engine\b/);
  assert.match(text, /SIANN_ENGINE_EXE=/);
  assert.match(text, /playwright test ux-tour/);
  const upload = steps({ text }).find((s) => /actions\/upload-artifact@v4/.test(s));
  assert.ok(upload, 'an upload of the tour');
  assert.match(upload, /name: ux-tour-\$\{\{ matrix\.locale \}\}/);
  assert.match(upload, /if-no-files-found: error/);
});

test('nightly fidelity: the gate on ubuntu and windows, its report as fidelity-<os>, no threshold of its own', () => {
  const { text } = nightlyJob('fidelity');
  assert.deepEqual(matrixOf(text, 'os'), ['ubuntu-latest', 'windows-latest']);
  assert.match(text, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(text, /SIANN_FIDELITY:\s*'1'/);
  assert.match(text, /SIANN_FIDELITY_OUT:/);
  assert.match(text, /playwright test --project fidelity/);
  assert.doesNotMatch(text, /threshold|max-?diff|--update-snapshots/i);
  assert.doesNotMatch(configureLine(text), /SIANN_WITH_JUCE/);
  const upload = steps({ text }).find((s) => /actions\/upload-artifact@v4/.test(s));
  assert.ok(upload, 'an upload of the report');
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /name: fidelity-\$\{\{ runner\.os \}\}/);
});

test('nightly asan-ubsan: Clang 20, -DSIANN_ASAN_UBSAN=ON, the whole ctest suite halting on the first report', () => {
  const { text } = nightlyJob('asan-ubsan');
  assert.match(text, /\n {4}runs-on: ubuntu-24\.04\n/);
  assert.match(text, /https:\/\/apt\.llvm\.org\/llvm\.sh/);
  const configure = configureLine(text);
  assert.match(configure, /-DCMAKE_CXX_COMPILER=clang\+\+-20/);
  assert.match(configure, /-DSIANN_ASAN_UBSAN=ON/);
  assert.match(configure, /-DSIANN_WERROR=ON/);
  assert.doesNotMatch(configure, /SIANN_WITH_JUCE|SIANN_RTSAN/);
  assert.match(text, /ASAN_OPTIONS:[^\n]*halt_on_error=1/);
  assert.match(text, /UBSAN_OPTIONS:[^\n]*halt_on_error=1/);
  assert.match(text, /ctest\s+--test-dir\s+native\/build\/asan[^\n]*--no-tests=error/);
  assert.doesNotMatch(text, /ctest[^\n]*\s-R\s/, 'the whole suite, not a filter');
});

test('nightly fuzz: each libFuzzer target for a fixed time from its committed corpus, crashing inputs uploaded', () => {
  const { text } = nightlyJob('fuzz');
  assert.match(text, /\n {4}runs-on: ubuntu-24\.04\n/);
  const configure = configureLine(text);
  assert.match(configure, /-DCMAKE_CXX_COMPILER=clang\+\+-20/);
  assert.match(configure, /-DSIANN_FUZZ=ON/);
  for (const target of FUZZ_TARGETS) {
    const run = text.split('\n').find((l) => new RegExp(`siann_fuzz_${target}\\b[^\\n]*-max_total_time=\\d+`).test(l));
    assert.ok(run, `siann_fuzz_${target} runs for a fixed time`);
    assert.match(run, new RegExp(`native/fuzz/corpus/${target}\\b`), `${target} starts from its corpus`);
  }
  const upload = steps({ text }).find((s) => /actions\/upload-artifact@v4/.test(s));
  assert.ok(upload, 'an upload of what the fuzzers found');
  assert.match(upload, /if: failure\(\)/);
  for (const kind of ['crash', 'timeout', 'oom']) assert.match(upload, new RegExp(`${kind}-\\*`), kind);
});

test('nightly coverage: llvm-cov HTML uploaded and its summary in the job summary, ignoring _deps and tests', () => {
  const { text } = nightlyJob('coverage');
  assert.match(text, /\n {4}runs-on: ubuntu-24\.04\n/);
  const configure = configureLine(text);
  assert.match(configure, /-DCMAKE_CXX_COMPILER=clang\+\+-20/);
  assert.match(configure, /-DSIANN_COVERAGE=ON/);
  assert.match(text, /LLVM_PROFILE_FILE:[^\n]*%p[^\n]*\.profraw/);
  assert.match(text, /ctest\s+--test-dir\s+native\/build\/coverage/);
  assert.match(text, /llvm-profdata-20 merge/);
  assert.match(text, /llvm-cov-20 show[^\n]*-format=html/);
  assert.match(text, /llvm-cov-20 report/);
  const ignore = /--ignore-filename-regex='([^']+)'/.exec(text);
  assert.ok(ignore, 'an --ignore-filename-regex');
  assert.ok(new RegExp(ignore[1]).test('/w/native/build/coverage/_deps/catch2-src/x.cpp'), '_deps is ignored');
  assert.ok(new RegExp(ignore[1]).test('/w/native/libs/graph/tests/graph_test.cpp'), 'tests are ignored');
  assert.ok(!new RegExp(ignore[1]).test('/w/native/libs/graph/src/graph.cpp'), 'the sources are kept');
  assert.match(text, />> "\$GITHUB_STEP_SUMMARY"/);
  assert.doesNotMatch(text, /fail-under|threshold/i, 'report only');
  const upload = steps({ text }).find((s) => /actions\/upload-artifact@v4/.test(s));
  assert.ok(upload, 'an upload of the HTML');
  assert.match(upload, /name: native-coverage/);
});

test('nightly perf: the 64-track scenario under SIANN_PERF=1, its report uploaded', () => {
  const { text } = nightlyJob('perf');
  assert.match(text, /SIANN_PERF:\s*'1'/);
  assert.match(text, /SIANN_PERF_OUT:/);
  assert.match(text, /playwright test perf/);
  assert.doesNotMatch(configureLine(text), /SIANN_WITH_JUCE/);
  assert.match(text, /SIANN_CLI_EXE=/);
  const upload = steps({ text }).find((s) => /actions\/upload-artifact@v4/.test(s));
  assert.ok(upload, 'an upload of the report');
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /perf-report\.json/);
});

test('the nightly jobs build through the compiler cache', () => {
  for (const id of NIGHTLY_JOBS) {
    const { text } = nightlyJob(id);
    const cache = text.indexOf('uses: ./.github/actions/compiler-cache');
    assert.ok(cache >= 0, `${id} uses the compiler cache`);
    assert.ok(cache < text.search(/cmake\s+-S\s+native/), `${id} sets the cache up before it configures`);
  }
});

test('the app job prints the unit test coverage in its job summary, with no threshold', () => {
  const step = steps(job('app')).find((s) => /--experimental-test-coverage/.test(s));
  assert.ok(step, 'a step runs the unit tests with coverage');
  assert.match(step, /dist\/test\/unit\/\*\.test\.js/);
  assert.match(step, /--test-coverage-exclude='dist\/test\/\*\*'/);
  assert.match(step, /\$GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(step, /--test-coverage-(lines|branches|functions)=/);
  assert.doesNotMatch(step, /continue-on-error/);
});

