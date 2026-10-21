const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JcsError, canonicalize, sha256Jcs } = require('../src/hash/jcs');

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'jcs', 'cases.json'), 'utf8'),
);

test('shared JCS fixtures declare their schema', () => {
  assert.equal(fixtures.schemaVersion, 'siann.jcs_fixtures.v1');
  assert.ok(fixtures.valid.length > 0);
  assert.ok(fixtures.invalid.length > 0);
});

for (const fixture of fixtures.valid) {
  test(`JCS fixture ${fixture.name} canonicalizes and hashes`, () => {
    const value = JSON.parse(fixture.input);
    assert.equal(canonicalize(value), fixture.canonical);
    assert.equal(sha256Jcs(value), fixture.sha256);
    const independent = crypto.createHash('sha256').update(fixture.canonical, 'utf8').digest('hex');
    assert.equal(fixture.sha256, `sha256:${independent}`);
  });
}

for (const fixture of fixtures.invalid) {
  test(`JCS fixture ${fixture.name} is rejected`, () => {
    assert.throws(
      () => canonicalize(JSON.parse(fixture.input)),
      (error) => error instanceof JcsError && error.code === fixture.error,
    );
  });
}

test('canonicalize rejects non-finite numbers instead of writing null', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => canonicalize({ gain: value }),
      (error) => error.code === 'non_finite_number' && error.pointer === '/gain',
    );
  }
});

test('canonicalize omits undefined object properties like a JSON round trip', () => {
  const value = { b: 1, a: undefined, c: { d: undefined } };
  assert.equal(canonicalize(value), '{"b":1,"c":{}}');
  assert.equal(canonicalize(value), canonicalize(JSON.parse(JSON.stringify(value))));
});

test('canonicalize rejects values JSON cannot represent', () => {
  const cases = [
    [[1, undefined], 'unsupported_type', '/1'],
    [{ when: new Date(0) }, 'unsupported_type', '/when'],
    [{ big: 1n }, 'unsupported_type', '/big'],
    [{ fn() {} }, 'unsupported_type', '/fn'],
  ];
  for (const [value, code, pointer] of cases) {
    assert.throws(
      () => canonicalize(value),
      (error) => error.code === code && error.pointer === pointer,
    );
  }
});

test('canonicalize escapes JSON pointer tokens in error locations', () => {
  assert.throws(
    () => canonicalize({ 'a/b': { 'c~d': Number.NaN } }),
    (error) => error.pointer === '/a~1b/c~0d',
  );
});
