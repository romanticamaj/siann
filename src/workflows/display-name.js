// Names the bridge hands to the engine as stored names (a session's, a
// track's, a region's): the engine's rule (spec "siann-model", names;
// docs/schemas/protocol-engine-v0.md, "Names"; follow-up to #123). A name is
// well-formed text (no lone UTF-16 surrogate, which would be malformed UTF-8
// on the wire) without a control character (C0, DEL, C1) and without a
// display-unsafe character: the bidi formatting characters U+061C, U+200E,
// U+200F, U+202A to U+202E and U+2066 to U+2069, and the line and paragraph
// separators U+2028 and U+2029. A name an agent or a user wrote is refused
// (nameFault); a name derived from a file name is stripped of them instead
// (withoutUnsafeCharacters).

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u;
const UNSAFE_GLOBAL = new RegExp(UNSAFE.source, 'gu');
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// A lone surrogate: a high one not followed by a low one, or a low one alone.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_SURROGATE_GLOBAL = new RegExp(LONE_SURROGATE.source, 'g');

// The first fault of `name`, or null: 'invalid_text' (a lone surrogate),
// 'control' or 'display_unsafe'.
function nameFault(name) {
  if (LONE_SURROGATE.test(name)) {
    return 'invalid_text';
  }
  const unsafe = name.match(UNSAFE);
  if (!unsafe) {
    return null;
  }
  return CONTROL.test(unsafe[0]) ? 'control' : 'display_unsafe';
}

// Throws when `value` (a non-empty string; the caller checks that) is not a
// display-safe name.
function assertDisplaySafeName(value, label) {
  const fault = nameFault(value);
  if (fault !== null) {
    throw new Error(`${label} must not contain control characters, bidi formatting characters or line separators (${fault})`);
  }
}

// `name` without its control and display-unsafe characters and lone surrogates.
function withoutUnsafeCharacters(name) {
  return name.replace(LONE_SURROGATE_GLOBAL, '').replace(UNSAFE_GLOBAL, '');
}

module.exports = {
  assertDisplaySafeName,
  nameFault,
  withoutUnsafeCharacters,
};
