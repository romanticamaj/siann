// SIANN document hash: an RFC 6962 Merkle Tree Hash over entity hashes.
//
// Contract (architecture spec, "Canonical JSON and hashes"):
// - One leaf per entity, sorted by the ASCII bytes of "<type>:<id>".
// - Leaf input: 0x00 || "<type>:<id>" || 0x00 || entityHash (32 bytes).
// - Internal node: 0x01 || left || right. Split and empty tree per RFC 6962 2.1.
// - Types match ^[a-z][a-z0-9_]{0,31}$, IDs match ^[A-Za-z0-9_-]{1,64}$,
//   hashes are "sha256:" followed by 64 lowercase hex digits.
// The C++ engine implements the same contract and passes fixtures/hash/.

const crypto = require('node:crypto');

const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

class MerkleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MerkleError';
    this.code = code;
  }
}

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function leafHash(leafInput) {
  return sha256(LEAF_PREFIX, leafInput);
}

function nodeHash(left, right) {
  return sha256(NODE_PREFIX, left, right);
}

function largestPowerOfTwoBelow(n) {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

// RFC 6962 MTH over already leaf-hashed entries.
function treeHash(leafHashes) {
  if (leafHashes.length === 0) {
    return sha256(Buffer.alloc(0));
  }
  if (leafHashes.length === 1) {
    return leafHashes[0];
  }
  const k = largestPowerOfTwoBelow(leafHashes.length);
  return nodeHash(treeHash(leafHashes.slice(0, k)), treeHash(leafHashes.slice(k)));
}

function parseHash(value) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    return null;
  }
  return Buffer.from(value.slice('sha256:'.length), 'hex');
}

function documentHash(entities) {
  if (!Array.isArray(entities)) {
    throw new MerkleError('invalid_entities', 'entities must be an array');
  }
  const keyed = entities.map((entity) => {
    if (typeof entity.type !== 'string' || !ENTITY_TYPE_RE.test(entity.type)) {
      throw new MerkleError('invalid_entity_type', `invalid entity type ${JSON.stringify(entity.type)}`);
    }
    if (typeof entity.id !== 'string' || !ENTITY_ID_RE.test(entity.id)) {
      throw new MerkleError('invalid_entity_id', `invalid entity id ${JSON.stringify(entity.id)}`);
    }
    const digest = parseHash(entity.entityHash);
    if (!digest) {
      throw new MerkleError('invalid_entity_hash', `invalid hash for ${entity.type}:${entity.id}`);
    }
    return { key: Buffer.from(`${entity.type}:${entity.id}`, 'ascii'), digest };
  });
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  for (let i = 1; i < keyed.length; i += 1) {
    if (Buffer.compare(keyed[i - 1].key, keyed[i].key) === 0) {
      throw new MerkleError('duplicate_entity', `duplicate entity ${keyed[i].key.toString('ascii')}`);
    }
  }
  const leaves = keyed.map(({ key, digest }) => leafHash(Buffer.concat([key, LEAF_PREFIX, digest])));
  return `sha256:${treeHash(leaves).toString('hex')}`;
}

module.exports = {
  MerkleError,
  documentHash,
  leafHash,
  nodeHash,
  treeHash,
};
