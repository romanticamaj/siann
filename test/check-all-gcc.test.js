'use strict';

// `check-all --gcc` on the JUCE sources: juce_TargetPlatform.h #warns, which -Werror
// makes an error, unless DEBUG or NDEBUG is defined, so the step defines the ones the
// desktop preset's build type gets from CMake.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTypeDefines, presetBuildType } = require('../scripts/check-all');

test('Debug defines DEBUG and _DEBUG; the other build types NDEBUG', () => {
  assert.deepEqual(buildTypeDefines('Debug'), ['-DDEBUG=1', '-D_DEBUG=1']);
  for (const type of ['Release', 'RelWithDebInfo', 'MinSizeRel']) {
    assert.deepEqual(buildTypeDefines(type), ['-DNDEBUG'], type);
  }
});

test('the desktop preset is Debug, inherited from dev', () => {
  assert.equal(presetBuildType('desktop'), 'Debug');
  assert.equal(presetBuildType('release'), 'Release');
});

test('the build type follows inherits, nearest first, and accepts a typed cache variable', () => {
  const presets = { configurePresets: [
    { name: 'base', cacheVariables: { CMAKE_BUILD_TYPE: 'Debug' } },
    { name: 'rel', inherits: 'base', cacheVariables: { CMAKE_BUILD_TYPE: { type: 'STRING', value: 'RelWithDebInfo' } } },
    { name: 'child', inherits: ['rel', 'base'] },
    { name: 'none' },
  ] };
  assert.equal(presetBuildType('child', presets), 'RelWithDebInfo');
  assert.equal(presetBuildType('base', presets), 'Debug');
  assert.equal(presetBuildType('none', presets), null);
  assert.equal(presetBuildType('missing', presets), null);
});
