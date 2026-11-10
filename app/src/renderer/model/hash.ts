// SIANN integrity hashes for the renderer (spec, "Canonical JSON and hashes"),
// ported from the bridge's src/hash/jcs.js and src/hash/merkle.js and held to
// the same shared fixtures. Framework-free and DOM-free: SHA-256 comes from
// WebCrypto (crypto.subtle), present in the renderer and in Node 22.
//
// - canonicalize: RFC 8785 (JCS). Keys sorted by UTF-16 code units, ECMAScript
//   number serialization (-0 becomes 0), NaN and infinities rejected, lone
//   surrogates rejected, undefined properties omitted, anything that is not
//   JSON rejected.
// - entityHash: "sha256:" + hex SHA-256 of the entity's canonical text.
// - documentHash: RFC 6962 Merkle Tree Hash over one leaf per entity, sorted by
//   the ASCII bytes of "<type>:<id>"; leaf input 0x00 || ref || 0x00 || hash,
//   node 0x01 || left || right.

export class HashError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HashError';
  }
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function serializeString(value: string, pointer: string): string {
  if (LONE_SURROGATE_RE.test(value)) throw new HashError('lone_surrogate', `string contains a lone surrogate at ${pointer}`);
  return JSON.stringify(value);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, pointer: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new HashError('non_finite_number', `number must be finite at ${pointer}`);
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, pointer);
    case 'object':
      break;
    default:
      throw new HashError('unsupported_type', `unsupported value type ${typeof value} at ${pointer}`);
  }
  const object = value as object;
  if (Array.isArray(object)) {
    const parts: string[] = [];
    object.forEach((entry: unknown, i) => {
      if (entry === undefined) throw new HashError('unsupported_type', `array entry is undefined at ${pointer}/${i}`);
      parts.push(serialize(entry, `${pointer}/${i}`));
    });
    return `[${parts.join(',')}]`;
  }
  if (!isPlainObject(object)) throw new HashError('unsupported_type', `only plain objects can be canonicalized at ${pointer}`);
  const record = object as Record<string, unknown>;
  // Array.prototype.sort compares UTF-16 code units, as RFC 8785 requires.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const parts = keys.map((key) => `${serializeString(key, pointer)}:${serialize(record[key], `${pointer}/${key}`)}`);
  return `{${parts.join(',')}}`;
}

export function canonicalize(value: unknown): string {
  return serialize(value, '');
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

export async function sha256Jcs(value: unknown): Promise<string> {
  return `sha256:${toHex(await sha256(encoder.encode(canonicalize(value))))}`;
}

// The entity hash: sha256 over the entity's JCS text (the hashed form the
// protocol carries).
export function entityHash(entity: unknown): Promise<string> {
  return sha256Jcs(entity);
}

export function entityRef(type: string, id: string): string {
  return `${type}:${id}`;
}

const LEAF = new Uint8Array([0x00]);
const NODE = new Uint8Array([0x01]);

export function leafHash(leafInput: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(LEAF, leafInput));
}

// RFC 6962 MTH over already leaf-hashed entries.
export async function treeHash(leaves: readonly Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  const left = await treeHash(leaves.slice(0, k));
  const right = await treeHash(leaves.slice(k));
  return sha256(concat(NODE, left, right));
}

export interface HashedEntity {
  readonly type: string;
  readonly id: string;
  readonly entityHash: string;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function documentHash(entities: readonly HashedEntity[]): Promise<string> {
  const keyed = entities.map((entity) => {
    if (typeof entity.type !== 'string' || !ENTITY_TYPE_RE.test(entity.type)) {
      throw new HashError('invalid_entity_type', `invalid entity type ${JSON.stringify(entity.type)}`);
    }
    if (typeof entity.id !== 'string' || !ENTITY_ID_RE.test(entity.id)) {
      throw new HashError('invalid_entity_id', `invalid entity id ${JSON.stringify(entity.id)}`);
    }
    if (typeof entity.entityHash !== 'string' || !HASH_RE.test(entity.entityHash)) {
      throw new HashError('invalid_entity_hash', `invalid hash for ${entity.type}:${entity.id}`);
    }
    return { key: entityRef(entity.type, entity.id), digest: fromHex(entity.entityHash.slice('sha256:'.length)) };
  });
  // Types and ids are ASCII, so UTF-16 order is byte order.
  keyed.sort((a, b) => compareAscii(a.key, b.key));
  for (let i = 1; i < keyed.length; i += 1) {
    if (keyed[i - 1]!.key === keyed[i]!.key) throw new HashError('duplicate_entity', `duplicate entity ${keyed[i]!.key}`);
  }
  const leaves = await Promise.all(keyed.map(({ key, digest }) => leafHash(concat(encoder.encode(key), LEAF, digest))));
  return `sha256:${toHex(await treeHash(leaves))}`;
}
