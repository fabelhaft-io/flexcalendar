// --- E05-R10 test support: problem documents and captured log lines ----------
//
// Two small helpers the error-model tests share: an assertion that a body is
// the problem for one kind, and a checker that validates a body against the
// `Problem` schema `spec/openapi.yaml` declares. The checker understands only
// the keywords that schema uses (`type`, `required`, `properties`,
// `additionalProperties`, `enum`), which is all it has to.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PROBLEM_TYPES, PROBLEM_TYPE_BASE } from '../../src/problem.mjs';

/** Every member a problem document may carry. */
export const PROBLEM_MEMBERS = [
  'type',
  'title',
  'status',
  'instance',
  'property',
];

/** The `Problem` schema as the contract declares it, straight from the spec. */
export const specProblemSchema = parse(
  readFileSync(
    new URL('../../../../spec/openapi.yaml', import.meta.url),
    'utf8',
  ),
).components.schemas.Problem;

/** @param {unknown} value @param {string} type */
function isType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

/**
 * The structural subset of JSON Schema the `Problem` schema uses. Returns the
 * first violation, or undefined.
 * @param {any} schema
 * @param {any} value
 * @param {string} [at]
 * @returns {string | undefined}
 */
export function firstSchemaViolation(schema, value, at = '$') {
  if (schema.type !== undefined && !isType(value, schema.type)) {
    return `${at} is not ${schema.type}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${at} is not one of ${schema.enum.join(', ')}`;
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${at} is missing ${key}`;
    }
    for (const [key, member] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false)
          return `${at} has an undeclared member ${key}`;
        continue;
      }
      const violation = firstSchemaViolation(sub, member, `${at}.${key}`);
      if (violation !== undefined) return violation;
    }
  }
  return undefined;
}

/** @param {any} schema @param {any} value */
export function assertMatchesSchema(schema, value) {
  assert.equal(firstSchemaViolation(schema, value), undefined);
}

/**
 * Asserts a body is exactly the problem for one kind and returns it.
 * @param {unknown} body
 * @param {string} slug
 * @returns {any}
 */
export function assertProblem(body, slug) {
  const entry = PROBLEM_TYPES[slug];
  assert.ok(entry !== undefined, `unknown problem type: ${slug}`);
  const problem = /** @type {any} */ (body);
  assert.equal(problem.type, `${PROBLEM_TYPE_BASE}${slug}`);
  assert.equal(problem.title, entry.title);
  assert.equal(problem.status, entry.status);
  assert.match(problem.instance, /^urn:uuid:[0-9a-f-]{36}$/);
  for (const key of Object.keys(problem)) {
    assert.ok(PROBLEM_MEMBERS.includes(key), `unexpected member ${key}`);
  }
  assertMatchesSchema(specProblemSchema, problem);
  return problem;
}
