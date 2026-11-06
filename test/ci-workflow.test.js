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
  assert.match(text, /xvfb-run -a npm test/, 'Linux runs Electron under xvfb-run');
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
