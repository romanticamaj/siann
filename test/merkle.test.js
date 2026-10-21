const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MerkleError,
  documentHash,
  leafHash,
  treeHash,
} = require('../src/hash/merkle');

const fixturesDir = path.join(__dirname, '..', 'fixtures', 'hash');
const rfc6962 = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'rfc6962.json'), 'utf8'));
const documents = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'document.json'), 'utf8'));

test('RFC 6962 tree hash matches the Certificate Transparency vectors for 0 to 8 leaves', () => {
  const leaves = rfc6962.leafInputsHex.map((hex) => leafHash(Buffer.from(hex, 'hex')));
  rfc6962.roots.forEach((expected, size) => {
    assert.equal(treeHash(leaves.slice(0, size)).toString('hex'), expected, `size ${size}`);
  });
});

for (const fixture of documents.valid) {
  test(`document hash fixture ${fixture.name}`, () => {
    assert.equal(documentHash(fixture.entities), fixture.documentHash);
  });
}

for (const fixture of documents.invalid) {
  test(`document hash fixture ${fixture.name} is rejected`, () => {
    assert.throws(
      () => documentHash(fixture.entities),
      (error) => error instanceof MerkleError && error.code === fixture.error,
    );
  });
}

test('document hash does not depend on input order', () => {
  const entities = documents.valid.find((entry) => entry.entities.length >= 3).entities;
  const reversed = [...entities].reverse();
  assert.equal(documentHash(reversed), documentHash(entities));
});
