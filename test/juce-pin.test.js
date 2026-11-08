'use strict';

// m4-juce-formats (architecture spec, "Realtime rules and enforcement", "Locks
// inside a hosted plugin's processBlock"; ADR-0018): LV2 through JUCE stays off,
// and JUCE's processBlock audit names the pin it was made at, so moving the pin
// fails here until the audit is repeated. The files are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the JUCE host is built with LV2 hosting off', () => {
  const cmake = read('native/libs/host_desktop/CMakeLists.txt');
  assert.match(cmake, /^\s*JUCE_PLUGINHOST_LV2=0\s*$/m);
  assert.doesNotMatch(cmake, /JUCE_PLUGINHOST_LV2=1/);
  // The compile-time guard that keeps it so even if the definition moves.
  const source = read('native/libs/host_desktop/src/juce_plugin_host.cpp');
  assert.match(source, /static_assert\(JUCE_PLUGINHOST_LV2 == 0,/);
});

test('the processBlock audit names the JUCE commit the build pins', () => {
  const pin = /JUCE\/archive\/([0-9a-f]{40})\.tar\.gz/.exec(read('native/cmake/SiannJuce.cmake'));
  assert.ok(pin, 'SiannJuce.cmake fetches JUCE by commit');
  const spec = read('docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md');
  const audited = [...spec.matchAll(/Audited at JUCE pin ([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.ok(audited.length > 0, 'the spec records the JUCE pin its processBlock audit was made at');
  assert.equal(
    audited[audited.length - 1],
    pin[1],
    'the JUCE pin moved: repeat the audit under "Locks inside a hosted plugin\'s processBlock" ' +
      '(a lock or allocation it does not list reopens ADR-0018), then record the new pin there',
  );
});
