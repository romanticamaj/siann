'use strict';

// The sanitizer, fuzz and coverage builds of the native core
// (m5b-nightly-quality, acceptance items 2 to 4; architecture spec, "Build, test
// and CI"). CMake is read as text, like the workflows in ci-workflow.test.js:
// the options sit beside SIANN_RTSAN and apply to every target, third-party code
// included, so they come before the first target.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NATIVE = path.join(__dirname, '..', 'native');
const ROOT_CMAKE = path.join(NATIVE, 'CMakeLists.txt');
const SANITIZERS = path.join(NATIVE, 'sanitizers');
const FUZZ = path.join(NATIVE, 'fuzz');
const FUZZ_TARGETS = ['protocol_ws', 'mcp_http', 'command_json'];

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
// The CMake text without comments.
const code = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

// The body of `if(<condition>)` up to its matching endif(), nested ifs included.
function ifBlock(text, condition) {
  const start = text.search(new RegExp(`\\bif\\(${condition}\\)`));
  assert.ok(start >= 0, `if(${condition}) in native/CMakeLists.txt`);
  const re = /\b(if|endif)\(/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    depth += m[1] === 'if' ? 1 : -1;
    if (depth === 0) return text.slice(start, m.index);
  }
  assert.fail(`if(${condition}) has no endif()`);
  return '';
}

// Where the first target or dependency is declared.
function firstTarget(text) {
  const index = text.search(/\b(add_subdirectory|add_library|add_executable|FetchContent_MakeAvailable|include\(SiannThirdParty\))/);
  assert.ok(index >= 0);
  return index;
}

test('SIANN_ASAN_UBSAN is an option beside SIANN_RTSAN, off by default', () => {
  const text = code(read(ROOT_CMAKE));
  assert.match(text, /option\(SIANN_RTSAN\b/);
  assert.match(text, /option\(SIANN_ASAN_UBSAN\s+"[^"]*"\s+OFF\)/);
});

test('SIANN_ASAN_UBSAN instruments every target with ASAN and UBSAN, halting on UB, before the first target', () => {
  const text = code(read(ROOT_CMAKE));
  const block = ifBlock(text, 'SIANN_ASAN_UBSAN');
  assert.match(block, /add_compile_options\([^)]*-fsanitize=address,undefined/);
  assert.match(block, /add_compile_options\([^)]*-fno-sanitize-recover=undefined/);
  assert.match(block, /add_compile_options\([^)]*-fno-omit-frame-pointer/);
  assert.match(block, /add_link_options\([^)]*-fsanitize=address,undefined/);
  assert.ok(text.indexOf(block) < firstTarget(text), 'the flags are set before any target or dependency');
});

test('SIANN_ASAN_UBSAN refuses a compiler other than Clang and the combination with SIANN_RTSAN', () => {
  const block = ifBlock(code(read(ROOT_CMAKE)), 'SIANN_ASAN_UBSAN');
  assert.match(block, /NOT CMAKE_CXX_COMPILER_ID STREQUAL "Clang"[\s\S]*?message\(FATAL_ERROR/);
  assert.match(block, /SIANN_RTSAN[\s\S]*?message\(FATAL_ERROR/);
});

test('SIANN_FUZZ (Clang only) instruments the libraries for libFuzzer and builds the fuzz directory', () => {
  const text = code(read(ROOT_CMAKE));
  assert.match(text, /option\(SIANN_FUZZ\s+"[^"]*"\s+OFF\)/);
  const block = ifBlock(text, 'SIANN_FUZZ');
  assert.match(block, /NOT CMAKE_CXX_COMPILER_ID STREQUAL "Clang"[\s\S]*?message\(FATAL_ERROR/);
  assert.match(block, /add_compile_options\([^)]*-fsanitize=fuzzer-no-link,address,undefined/);
  assert.ok(text.indexOf(block) < firstTarget(text));
  assert.match(text, /add_subdirectory\(fuzz\)/);
  const fuzz = code(read(path.join(FUZZ, 'CMakeLists.txt')));
  for (const target of FUZZ_TARGETS) {
    assert.match(fuzz, new RegExp(`siann_fuzz_${target}\\b`), `the libFuzzer target siann_fuzz_${target}`);
  }
  assert.match(fuzz, /-fsanitize=fuzzer,address,undefined/);
  // The smoke test is an ordinary ctest in the default build, on every OS.
  assert.match(fuzz, /fuzz_smoke_test\.cpp/);
  assert.match(fuzz, /catch_discover_tests\(/);
});

test('SIANN_COVERAGE (Clang only) builds with source-based coverage', () => {
  const text = code(read(ROOT_CMAKE));
  assert.match(text, /option\(SIANN_COVERAGE\s+"[^"]*"\s+OFF\)/);
  const block = ifBlock(text, 'SIANN_COVERAGE');
  assert.match(block, /NOT CMAKE_CXX_COMPILER_ID STREQUAL "Clang"[\s\S]*?message\(FATAL_ERROR/);
  assert.match(block, /add_compile_options\([^)]*-fprofile-instr-generate -fcoverage-mapping/);
  assert.match(block, /add_link_options\([^)]*-fprofile-instr-generate/);
  assert.ok(text.indexOf(block) < firstTarget(text));
});

test('every sanitizer suppression carries its reason on the line above it', () => {
  if (!fs.existsSync(SANITIZERS)) return; // no suppression needed
  for (const name of fs.readdirSync(SANITIZERS)) {
    const lines = read(path.join(SANITIZERS, name)).split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '' || line.trim().startsWith('#')) return;
      const above = lines[i - 1] ?? '';
      assert.match(above, /^#\s*\S.{9,}/, `${name}:${i + 1} "${line}" has a comment giving its reason above it`);
    });
  }
});

test('each fuzz target has a committed, non-empty seed corpus', () => {
  for (const target of FUZZ_TARGETS) {
    const dir = path.join(FUZZ, 'corpus', target);
    assert.ok(fs.existsSync(dir), `native/fuzz/corpus/${target}/ exists`);
    const files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
    assert.ok(files.length >= 3, `${target} has at least three seeds (${files.length})`);
    assert.ok(files.some((name) => fs.statSync(path.join(dir, name)).size > 0), `${target} has a non-empty seed`);
  }
});
