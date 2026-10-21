// RFC 8785 JSON Canonicalization Scheme (JCS) and the SIANN sha256 helper.
//
// This is the only canonicalization used for SIANN integrity hashes. The C++
// engine implements the same rules and must pass the shared fixtures in
// fixtures/jcs/.
//
// Rules (RFC 8785 plus I-JSON, RFC 7493):
// - Object keys are sorted by UTF-16 code units (JavaScript's default string
//   ordering), with no insignificant whitespace.
// - Numbers use ECMAScript Number serialization; -0 becomes 0. NaN and
//   infinities are rejected.
// - Strings use ECMAScript JSON escaping; lone surrogates are rejected.
// - Object properties whose value is undefined are omitted, matching what a
//   JSON file round trip produces. Any other non-JSON value is rejected.

const crypto = require('node:crypto');

class JcsError extends Error {
  constructor(code, message, pointer) {
    super(`${message} at ${pointer || '/'}`);
    this.name = 'JcsError';
    this.code = code;
    this.pointer = pointer || '/';
  }
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function pointerJoin(pointer, token) {
  const escaped = String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${pointer === '/' ? '' : pointer}/${escaped}`;
}

function serializeString(value, pointer) {
  if (LONE_SURROGATE_RE.test(value)) {
    throw new JcsError('lone_surrogate', 'string contains a lone surrogate', pointer);
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value, pointer) {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JcsError('non_finite_number', 'number must be finite', pointer);
      }
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, pointer);
    case 'object':
      break;
    default:
      throw new JcsError('unsupported_type', `unsupported value type ${typeof value}`, pointer);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i += 1) {
      const entryPointer = pointerJoin(pointer, i);
      if (value[i] === undefined) {
        throw new JcsError('unsupported_type', 'array entry is undefined', entryPointer);
      }
      parts.push(serialize(value[i], entryPointer));
    }
    return `[${parts.join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new JcsError('unsupported_type', 'only plain objects can be canonicalized', pointer);
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const parts = keys.map((key) => {
    const keyPointer = pointerJoin(pointer, key);
    return `${serializeString(key, keyPointer)}:${serialize(value[key], keyPointer)}`;
  });
  return `{${parts.join(',')}}`;
}

function canonicalize(value) {
  return serialize(value, '/');
}

function sha256Jcs(value) {
  const digest = crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

module.exports = {
  CANONICALIZATION: 'jcs-rfc8785',
  JcsError,
  canonicalize,
  sha256Jcs,
};
