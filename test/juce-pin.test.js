'use strict';

// m4-juce-formats, acceptance 2 (architecture spec, "Realtime rules and
// enforcement", "Locks inside a hosted plugin's processBlock"; ADR-0018,
// Amendment 3): LV2 through JUCE stays off, and JUCE's processBlock audit names
// the pin it was made at, so moving the pin fails here until the audit is
// repeated and recorded. The files are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const SPEC = 'docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md';
const ADR = 'docs/adr/0018-accept-juce-wrapper-locks-inside-hosted-processblock.md';

function pinnedCommit() {
  const pin = /JUCE\/archive\/([0-9a-f]{40})\.tar\.gz/.exec(read('native/cmake/SiannJuce.cmake'));
  assert.ok(pin, 'SiannJuce.cmake fetches JUCE by commit');
  return pin[1];
}

// The text from a line starting with `start` up to the next line that starts with
// one of `ends` (or the end of the file).
function section(text, start, ends) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.startsWith(start));
  assert.ok(first >= 0, `no line starts with ${start}`);
  let last = lines.length;
  for (let i = first + 1; i < lines.length; i += 1) {
    if (ends.some((end) => lines[i].startsWith(end))) {
      last = i;
      break;
    }
  }
  return lines.slice(first, last).join('\n');
}

test('the JUCE host is built with LV2 hosting off', () => {
  const cmake = read('native/libs/host_desktop/CMakeLists.txt');
  assert.match(cmake, /^\s*JUCE_PLUGINHOST_LV2=0\s*$/m);
  assert.doesNotMatch(cmake, /JUCE_PLUGINHOST_LV2=1/);
  // The compile-time guard that keeps it so even if the definition moves.
  const source = read('native/libs/host_desktop/src/juce_plugin_host.cpp');
  assert.match(source, /static_assert\(JUCE_PLUGINHOST_LV2 == 0,/);
});

test("the spec's processBlock audit names the JUCE commit the build pins", () => {
  const short = pinnedCommit().slice(0, 7);
  const audit = section(read(SPEC), "- Locks inside a hosted plugin's `processBlock`.", ['- ', '#']);
  assert.ok(
    audit.includes(`pin \`${short}\``),
    `the JUCE pin moved to ${short}: repeat the audit under "Locks inside a hosted plugin's ` +
      'processBlock" (a lock or allocation it does not list reopens ADR-0018), then record the new pin there',
  );
});

test("ADR-0018's latest amendment records the audit at the JUCE pin in use", () => {
  const short = pinnedCommit().slice(0, 7);
  const adr = read(ADR);
  const amendments = [...adr.matchAll(/^## Amendment[^\n]*$/gm)];
  assert.ok(amendments.length > 0, 'ADR-0018 has amendments');
  const latest = adr.slice(amendments[amendments.length - 1].index);
  assert.match(latest, /re-audit/i, 'the latest amendment is an audit');
  assert.ok(
    latest.includes(`\`${short}\``),
    `the JUCE pin moved to ${short}: the re-audit belongs in a new ADR-0018 amendment naming the pin`,
  );
});
