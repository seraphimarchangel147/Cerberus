import { snapshotToolValue } from "./tool-outcome.js";

const MAX_SCHEMA_DEPTH = 48;
const MAX_SCHEMA_NODES = 20_000;
const MAX_VALIDATION_DEPTH = 64;
const MAX_VALIDATION_NODES = 100_000;
const MAX_VALIDATION_ISSUES = 12;
const SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
const COMBINATORS = ["allOf", "anyOf", "oneOf"];

export function normalizeToolInputSchema(value, toolName = "tool") {
  const fallback = {
    type: "object",
    properties: {},
    additionalProperties: false
  };
  const schema = normalizeSchema(value ?? fallback, `${toolName} input schema`);
  if (!isPlainRecord(schema)) {
    throw contractError(`${toolName} input schema must be a JSON Schema object.`);
  }
  const declaredTypes = schemaTypes(schema.type);
  if (
    declaredTypes
    && (declaredTypes.size !== 1 || !declaredTypes.has("object"))
  ) {
    throw contractError(`${toolName} input schema must accept only an object at its root.`);
  }
  const normalized = schema.type === undefined
    ? { ...schema, type: "object" }
    : schema;
  validateSchemaDefinition(normalized, normalized, `${toolName}.parameters`);
  return deepFreeze(normalized);
}

export function normalizeToolOutputSchema(value, toolName = "tool") {
  if (value === undefined || value === null) return null;
  const schema = normalizeSchema(value, `${toolName} output schema`);
  validateSchemaDefinition(schema, schema, `${toolName}.outputSchema`);
  return deepFreeze(schema);
}

export function validateToolContractValue(schema, value) {
  if (schema === null || schema === undefined) {
    return Object.freeze({ ok: true, issues: Object.freeze([]) });
  }
  const issues = [];
  const state = {
    nodes: 0,
    root: schema,
    refStack: new Set()
  };
  validateValue(schema, value, "$", issues, state, 0);
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues)
  });
}

export function formatToolContractIssues(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  if (issues.length === 0) return "value does not match the declared schema";
  return issues.join("; ");
}

function normalizeSchema(value, label) {
  assertJsonSchemaData(value, label, new Set(), 0);
  let cloned;
  try {
    cloned = snapshotToolValue(value);
  } catch (error) {
    throw contractError(`${label} must contain only bounded JSON-safe values: ${safeMessage(error)}`);
  }
  if (!isPlainRecord(cloned) && typeof cloned !== "boolean") {
    throw contractError(`${label} must be a JSON Schema object or boolean.`);
  }
  return cloned;
}

function assertJsonSchemaData(value, path, ancestors, depth) {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw contractError(`${path} exceeds the schema depth limit.`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== "object") {
    throw contractError(`${path} must contain only JSON-safe values.`);
  }
  if (ancestors.has(value)) {
    throw contractError(`${path} must not contain circular references.`);
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw contractError(`${path} must contain only plain objects and arrays.`);
  }
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length") continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw contractError(`${path}.${safePathPart(key)} must not use getters or setters.`);
    }
    assertJsonSchemaData(
      descriptor.value,
      `${path}.${safePathPart(key)}`,
      ancestors,
      depth + 1
    );
  }
  ancestors.delete(value);
}

function validateSchemaDefinition(schema, root, path, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) {
    throw contractError(`${path} exceeds the schema node limit.`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw contractError(`${path} exceeds the schema depth limit.`);
  }
  if (typeof schema === "boolean") return;
  if (!isPlainRecord(schema)) {
    throw contractError(`${path} must be a JSON Schema object or boolean.`);
  }

  if (schema.type !== undefined) {
    const types = schemaTypes(schema.type);
    if (!types || types.size === 0) {
      throw contractError(`${path}.type must be a supported type or non-empty type array.`);
    }
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#")) {
      throw contractError(`${path}.$ref must be a local JSON pointer.`);
    }
    if (resolveLocalRef(root, schema.$ref) === undefined) {
      throw contractError(`${path}.$ref does not resolve inside the schema.`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainRecord(schema.properties)) {
      throw contractError(`${path}.properties must be an object.`);
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      validateSchemaDefinition(child, root, `${path}.properties.${safePathPart(name)}`, state, depth + 1);
    }
  }
  if (schema.$defs !== undefined) {
    if (!isPlainRecord(schema.$defs)) {
      throw contractError(`${path}.$defs must be an object.`);
    }
    for (const [name, child] of Object.entries(schema.$defs)) {
      validateSchemaDefinition(child, root, `${path}.$defs.${safePathPart(name)}`, state, depth + 1);
    }
  }
  if (schema.required !== undefined) {
    stringArray(schema.required, `${path}.required`, { unique: true });
  }
  if (schema.additionalProperties !== undefined) {
    const additional = schema.additionalProperties;
    if (typeof additional !== "boolean") {
      validateSchemaDefinition(additional, root, `${path}.additionalProperties`, state, depth + 1);
    }
  }
  if (schema.items !== undefined) {
    validateSchemaDefinition(schema.items, root, `${path}.items`, state, depth + 1);
  }
  for (const key of COMBINATORS) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0) {
      throw contractError(`${path}.${key} must be a non-empty schema array.`);
    }
    schema[key].forEach((child, index) => {
      validateSchemaDefinition(child, root, `${path}.${key}[${index}]`, state, depth + 1);
    });
  }
  if (schema.not !== undefined) {
    validateSchemaDefinition(schema.not, root, `${path}.not`, state, depth + 1);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw contractError(`${path}.enum must be a non-empty array.`);
  }
  integerKeyword(schema, "minLength", path, 0);
  integerKeyword(schema, "maxLength", path, 0);
  integerKeyword(schema, "minItems", path, 0);
  integerKeyword(schema, "maxItems", path, 0);
  integerKeyword(schema, "minProperties", path, 0);
  integerKeyword(schema, "maxProperties", path, 0);
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
      throw contractError(`${path}.${key} must be a finite number.`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      throw contractError(`${path}.pattern must be a string.`);
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      throw contractError(`${path}.pattern must be a valid ECMAScript regular expression.`);
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    throw contractError(`${path}.uniqueItems must be a boolean.`);
  }
}

function validateValue(schema, value, path, issues, state, depth) {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  state.nodes += 1;
  if (state.nodes > MAX_VALIDATION_NODES) {
    addIssue(issues, `${path} exceeds the validation node limit`);
    return;
  }
  if (depth > MAX_VALIDATION_DEPTH) {
    addIssue(issues, `${path} exceeds the validation depth limit`);
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    addIssue(issues, `${path} is rejected by the declared schema`);
    return;
  }

  if (schema.$ref !== undefined) {
    const refIdentity = `${schema.$ref}\u0000${path}`;
    if (state.refStack.has(refIdentity)) {
      addIssue(issues, `${path} contains a recursive schema reference`);
      return;
    }
    const target = resolveLocalRef(state.root, schema.$ref);
    if (target === undefined) {
      addIssue(issues, `${path} references an unavailable schema`);
      return;
    }
    state.refStack.add(refIdentity);
    validateValue(target, value, path, issues, state, depth + 1);
    state.refStack.delete(refIdentity);
    if (issues.length >= MAX_VALIDATION_ISSUES) return;
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) {
      validateValue(branch, value, path, issues, state, depth + 1);
      if (issues.length >= MAX_VALIDATION_ISSUES) return;
    }
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((branch) => branchMatches(branch, value, state, depth));
    if (!matches) addIssue(issues, `${path} must match at least one allowed schema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => branchMatches(branch, value, state, depth)).length;
    if (matches !== 1) addIssue(issues, `${path} must match exactly one allowed schema`);
  }
  if (schema.not && branchMatches(schema.not, value, state, depth)) {
    addIssue(issues, `${path} matches a forbidden schema`);
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    addIssue(issues, `${path} must equal the declared constant`);
  }
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    addIssue(issues, `${path} must be one of the declared enum values`);
  }

  const types = schemaTypes(schema.type);
  if (types && ![...types].some((type) => valueMatchesType(value, type))) {
    addIssue(issues, `${path} must be ${joinTypes(types)}`);
    return;
  }

  if (Array.isArray(value)) {
    validateArray(schema, value, path, issues, state, depth);
  } else if (isPlainRecord(value)) {
    validateObject(schema, value, path, issues, state, depth);
  } else if (typeof value === "string") {
    validateString(schema, value, path, issues);
  } else if (typeof value === "number") {
    validateNumber(schema, value, path, issues);
  }
}

function validateObject(schema, value, path, issues, state, depth) {
  const keys = Object.keys(value);
  if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) {
    addIssue(issues, `${path} must contain at least ${schema.minProperties} properties`);
  }
  if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) {
    addIssue(issues, `${path} must contain at most ${schema.maxProperties} properties`);
  }
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) {
      addIssue(issues, `${childPath(path, name)} is required`);
    }
  }
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  for (const key of keys) {
    if (Object.hasOwn(properties, key)) {
      validateValue(properties[key], value[key], childPath(path, key), issues, state, depth + 1);
    } else if (schema.additionalProperties === false) {
      addIssue(issues, `${childPath(path, key)} is not an allowed property`);
    } else if (isPlainRecord(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
      validateValue(
        schema.additionalProperties,
        value[key],
        childPath(path, key),
        issues,
        state,
        depth + 1
      );
    }
    if (issues.length >= MAX_VALIDATION_ISSUES) return;
  }
}

function validateArray(schema, value, path, issues, state, depth) {
  if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
    addIssue(issues, `${path} must contain at least ${schema.minItems} items`);
  }
  if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
    addIssue(issues, `${path} must contain at most ${schema.maxItems} items`);
  }
  if (schema.uniqueItems === true) {
    for (let left = 0; left < value.length; left += 1) {
      for (let right = left + 1; right < value.length; right += 1) {
        if (jsonEqual(value[left], value[right])) {
          addIssue(issues, `${path} must not contain duplicate items`);
          left = value.length;
          break;
        }
      }
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateValue(schema.items, item, `${path}[${index}]`, issues, state, depth + 1);
    });
  }
}

function validateString(schema, value, path, issues) {
  const length = [...value].length;
  if (Number.isInteger(schema.minLength) && length < schema.minLength) {
    addIssue(issues, `${path} must contain at least ${schema.minLength} characters`);
  }
  if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
    addIssue(issues, `${path} must contain at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    addIssue(issues, `${path} does not match the declared pattern`);
  }
  if (typeof schema.format === "string" && !matchesKnownFormat(value, schema.format)) {
    addIssue(issues, `${path} must match format ${safePathPart(schema.format)}`);
  }
}

function validateNumber(schema, value, path, issues) {
  if (Number.isFinite(schema.minimum) && value < schema.minimum) {
    addIssue(issues, `${path} must be at least ${schema.minimum}`);
  }
  if (Number.isFinite(schema.maximum) && value > schema.maximum) {
    addIssue(issues, `${path} must be at most ${schema.maximum}`);
  }
  if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
    addIssue(issues, `${path} must be greater than ${schema.exclusiveMinimum}`);
  }
  if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {
    addIssue(issues, `${path} must be less than ${schema.exclusiveMaximum}`);
  }
}

function branchMatches(schema, value, parentState, depth) {
  const branchIssues = [];
  const state = {
    nodes: parentState.nodes,
    root: parentState.root,
    refStack: new Set(parentState.refStack)
  };
  validateValue(schema, value, "$", branchIssues, state, depth + 1);
  parentState.nodes = Math.max(parentState.nodes, state.nodes);
  return branchIssues.length === 0;
}

function schemaTypes(value) {
  if (value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return null;
  const types = new Set();
  for (const item of values) {
    if (typeof item !== "string" || !SCHEMA_TYPES.has(item)) return null;
    types.add(item);
  }
  return types;
}

function valueMatchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainRecord(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function joinTypes(types) {
  const values = [...types];
  if (values.length === 1) {
    return ["array", "object", "integer"].includes(values[0])
      ? `an ${values[0]}`
      : `a ${values[0]}`;
  }
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function resolveLocalRef(root, ref) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function stringArray(value, path, { unique = false } = {}) {
  if (!Array.isArray(value)) throw contractError(`${path} must be an array of strings.`);
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw contractError(`${path}[${index}] must be a non-empty string.`);
    }
    if (unique && seen.has(item)) {
      throw contractError(`${path} must not contain duplicate values.`);
    }
    seen.add(item);
  });
}

function integerKeyword(schema, key, path, minimum) {
  if (
    schema[key] !== undefined
    && (!Number.isInteger(schema[key]) || schema[key] < minimum)
  ) {
    throw contractError(`${path}.${key} must be an integer greater than or equal to ${minimum}.`);
  }
}

function matchesKnownFormat(value, format) {
  if (format === "date") return validDate(value);
  if (format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
  }
  if (format === "uri" || format === "uri-reference") {
    try {
      if (format === "uri-reference" && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
        new URL(value, "https://tool-contract.invalid/");
      } else {
        new URL(value);
      }
      return true;
    } catch {
      return false;
    }
  }
  if (format === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value);
  return true;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index]
        && jsonEqual(left[key], right[key])
      ));
  }
  return false;
}

function childPath(parent, name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    ? `${parent}.${name}`
    : `${parent}[${JSON.stringify(name)}]`;
}

function safePathPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/gu, "?").slice(0, 120) || "?";
}

function addIssue(issues, message) {
  if (issues.length < MAX_VALIDATION_ISSUES) issues.push(message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safeMessage(error) {
  return String(error?.message ?? error ?? "invalid schema").slice(0, 500);
}

function contractError(message) {
  const error = new TypeError(message);
  error.code = "TOOL_CONTRACT_INVALID";
  return error;
}
