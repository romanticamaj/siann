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

// The spec may only report the job's outcome (green, clean, r8brain adoption
// final, m2-exit-rt-safety Met) once a run has been observed, and then it
// cites that run. Until then it says the result is pending the first green run.
const SPEC = path.join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-14-siann-native-daw-architecture.md');
const RUN_LINK = /github\.com\/romanticamaj\/siann\/actions\/runs\/\d+/;

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

test('the spec claims a clean RTSan run and final r8brain adoption only with a cited run', () => {
  const bullet = srcRtsanBullet(specText());
  const claims = /runs clean|adoption is final|libsamplerate is not needed|bringing the job up fixed/i;
  if (claims.test(bullet)) {
    assert.match(bullet, RUN_LINK, 'a clean-run claim cites the CI run that showed it');
  } else {
    assert.match(bullet, /pending the first green run/i, 'without a cited run the bullet says the result is pending');
    assert.match(bullet, /provisional/i, 'without a cited run r8brain adoption stays provisional');
  }
});

test('m2-exit-rt-safety is marked Met only with a cited green RTSan run', () => {
  const row = specText().split('\n').find((line) => /^\|.*\(`m2-exit-rt-safety`\)/.test(line));
  assert.ok(row, 'the M2 exit table has an m2-exit-rt-safety row');
  const [, , status, evidence] = row.split('|').map((cell) => cell.trim());
  if (status === 'Met') {
    assert.match(evidence, RUN_LINK, 'Met cites the green RTSan CI run');
  } else {
    assert.match(evidence, /pending the first green run/i);
  }
  assert.doesNotMatch(evidence, /runs all \d+ ctest tests/, 'the test count is reported from a run, not derived');
});
