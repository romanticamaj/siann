// SIANN plan hash for siann.plan.v1 (architecture spec, "Plans" and
// "Canonical JSON and hashes").
//
// planHash = sha256(JCS(plan)) over the plan without its lifecycle fields
// (PLAN_HASH_EXCLUDED). The C++ engine (siann::command::planHash) implements
// the same rules; both pass fixtures/plan/plan-hash.json.
//
// Error codes:
// - plan_not_canonicalizable: JCS rejects a value (NaN, infinities, lone
//   surrogates, non-JSON types).
// - invalid_entity_set: a readSet or writeSet entry is malformed, or the set
//   is not sorted by (type, id) without duplicates.
// - invalid_plan: anything else malformed, including unknown fields.

const { JcsError, sha256Jcs } = require('./jcs');

const PLAN_SCHEMA = 'siann.plan.v1';
const PLAN_HASH_EXCLUDED = Object.freeze([
  'hash', 'state', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt', 'rejectionNote', 'appliedRevision',
]);
const HASHED_FIELDS = Object.freeze(['schema', 'baseRevision', 'steps', 'readSet', 'writeSet', 'parentPlan']);
const PLAN_STATES = Object.freeze(['draft', 'validated', 'approved', 'rejected', 'applied', 'rolled_back']);
const ENTITY_TYPES =Object.freeze(['clip', 'media', 'root', 'track']);
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

class PlanHashError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanHashError';
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkEntitySet(name, set) {
  if (!Array.isArray(set)) {
    throw new PlanHashError('invalid_entity_set', `${name} must be an array`);
  }
  let previous = null;
  set.forEach((entry, index) => {
    const where = `${name}[${index}]`;
    if (!isObject(entry) || Object.keys(entry).some((key) => !['type', 'id', 'hash'].includes(key))) {
      throw new PlanHashError('invalid_entity_set', `${where} must be {type, id, hash}`);
    }
    if (!ENTITY_TYPES.includes(entry.type)) {
      throw new PlanHashError('invalid_entity_set', `${where} has unknown type ${JSON.stringify(entry.type)}`);
    }
    if (typeof entry.id !== 'string' || !ENTITY_ID_RE.test(entry.id) || (entry.type === 'root' && entry.id !== 'root')) {
      throw new PlanHashError('invalid_entity_set', `${where} has invalid id ${JSON.stringify(entry.id)}`);
    }
    if (entry.hash !== null && (typeof entry.hash !== 'string' || !HASH_RE.test(entry.hash))) {
      throw new PlanHashError('invalid_entity_set', `${where} hash must be "sha256:<hex>" or null`);
    }
    if (previous && (entry.type < previous.type || (entry.type === previous.type && entry.id <= previous.id))) {
      throw new PlanHashError('invalid_entity_set', `${name} must be sorted by (type, id) without duplicates`);
    }
    previous = entry;
  });
}

function checkPlan(plan) {
  if (!isObject(plan)) {
    throw new PlanHashError('invalid_plan', 'a plan must be a JSON object');
  }
  for (const key of Object.keys(plan)) {
    if (!HASHED_FIELDS.includes(key) && !PLAN_HASH_EXCLUDED.includes(key)) {
      throw new PlanHashError('invalid_plan', `unknown plan field ${JSON.stringify(key)}`);
    }
  }
  if (plan.schema !== PLAN_SCHEMA) {
    throw new PlanHashError('invalid_plan', `schema must be ${PLAN_SCHEMA}`);
  }
  if (typeof plan.baseRevision !== 'string' || plan.baseRevision === '') {
    throw new PlanHashError('invalid_plan', 'baseRevision must be a non-empty string');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new PlanHashError('invalid_plan', 'steps must be a non-empty array');
  }
  plan.steps.forEach((step, index) => {
    if (!isObject(step) || typeof step.op !== 'string') {
      throw new PlanHashError('invalid_plan', `steps[${index}] must be a command object with a string op`);
    }
  });
  checkEntitySet('readSet', plan.readSet);
  checkEntitySet('writeSet', plan.writeSet);
  if (plan.parentPlan !== undefined && (typeof plan.parentPlan !== 'string' || !HASH_RE.test(plan.parentPlan))) {
    throw new PlanHashError('invalid_plan', 'parentPlan must be "sha256:<hex>"');
  }
  // Lifecycle fields are not hashed but must still be well-typed, as in the engine.
  for (const key of PLAN_HASH_EXCLUDED) {
    if (plan[key] !== undefined && typeof plan[key] !== 'string') {
      throw new PlanHashError('invalid_plan', `${key} must be a string`);
    }
  }
  if (plan.state !== undefined && !PLAN_STATES.includes(plan.state)) {
    throw new PlanHashError('invalid_plan', `unknown plan state ${JSON.stringify(plan.state)}`);
  }
}

function planHash(plan) {
  checkPlan(plan);
  const hashed = {};
  for (const key of HASHED_FIELDS) {
    if (plan[key] !== undefined) hashed[key] = plan[key];
  }
  try {
    return sha256Jcs(hashed);
  } catch (error) {
    if (error instanceof JcsError) {
      throw new PlanHashError('plan_not_canonicalizable', error.message);
    }
    throw error;
  }
}

module.exports = {
  PLAN_HASH_EXCLUDED,
  PLAN_SCHEMA,
  PlanHashError,
  planHash,
};
