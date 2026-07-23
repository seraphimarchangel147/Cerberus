import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tool-registry.js";

function register(registry, name, options = {}) {
  return registry.register({
    name,
    description: `${name} fixture`,
    handler: async () => ({ ok: true }),
    ...options
  });
}

test("tool capability manifests derive conservative defaults without changing policy", () => {
  const registry = new ToolRegistry();
  const read = register(registry, "read_fixture", { sideEffects: false });
  const externalWrite = register(registry, "remote_write", {
    source: "mcp",
    needsConfirmation: true
  });

  assert.deepEqual(read.capability, {
    domain: "internal",
    verbs: [],
    effect: "read",
    idempotent: true,
    latency: "low",
    cost: "unknown",
    resources: [],
    requirements: [],
    examples: [],
    successCriteria: [],
    availability: "available"
  });
  assert.deepEqual(externalWrite.capability, {
    domain: "mcp",
    verbs: [],
    effect: "write",
    idempotent: false,
    latency: "unknown",
    cost: "unknown",
    resources: ["mcp"],
    requirements: ["human_confirmation"],
    examples: [],
    successCriteria: [],
    availability: "conditional"
  });
  assert.equal(read.sideEffects, false);
  assert.equal(externalWrite.sideEffects, true);
  assert.equal(externalWrite.needsConfirmation, true);
});

test("explicit capability manifests normalize, redact, and freeze serializable data", () => {
  const registry = new ToolRegistry();
  const registered = register(registry, "workspace_read", {
    sideEffects: false,
    capability: {
      domain: " filesystem ",
      verbs: [" read ", "search", "read"],
      effect: "READ",
      idempotent: true,
      latency: "instant",
      cost: "none",
      resources: [" workspace ", "workspace"],
      requirements: ["path_within_workspace"],
      examples: [{
        purpose: "Read a project file",
        arguments: {
          path: "README.md",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456"
        }
      }],
      successCriteria: ["Returns the requested bytes", "Returns the requested bytes"],
      availability: "available"
    }
  });

  assert.deepEqual(registered.capability, {
    domain: "filesystem",
    verbs: ["read", "search"],
    effect: "read",
    idempotent: true,
    latency: "instant",
    cost: "none",
    resources: ["workspace"],
    requirements: ["path_within_workspace"],
    examples: [{
      purpose: "Read a project file",
      arguments: {
        path: "README.md",
        apiKey: "[REDACTED]"
      }
    }],
    successCriteria: ["Returns the requested bytes"],
    availability: "available"
  });
  assert.equal(Object.isFrozen(registered.capability), true);
  assert.equal(Object.isFrozen(registered.capability.examples), true);
  assert.equal(Object.isFrozen(registered.capability.examples[0].arguments), true);
});

test("confirmation remains visible even when an explicit manifest omits it", () => {
  const registry = new ToolRegistry();
  const registered = register(registry, "confirmed_write", {
    needsConfirmation: true,
    capability: {
      effect: "write",
      requirements: ["network"]
    }
  });

  assert.deepEqual(registered.capability.requirements, [
    "network",
    "human_confirmation"
  ]);
});

test("invalid capability fields fail registration with field-specific errors", () => {
  const cases = [
    {
      name: "manifest",
      capability: [],
      error: /Tool invalid_manifest capability must be a plain object/
    },
    {
      name: "unknown",
      capability: { callback: () => null },
      error: /capability\.callback is not a supported field/
    },
    {
      name: "domain",
      capability: { domain: "" },
      error: /capability\.domain must be a non-empty string/
    },
    {
      name: "verbs",
      capability: { verbs: "read" },
      error: /capability\.verbs must be an array of strings/
    },
    {
      name: "verb_item",
      capability: { verbs: [() => null] },
      error: /capability\.verbs\[0\] must be a string/
    },
    {
      name: "effect",
      sideEffects: false,
      capability: { effect: "write" },
      error: /capability\.effect must be "read" because sideEffects is false/
    },
    {
      name: "idempotent",
      capability: { idempotent: "yes" },
      error: /capability\.idempotent must be a boolean/
    },
    {
      name: "latency",
      capability: { latency: "eventually" },
      error: /capability\.latency must be one of/
    },
    {
      name: "cost",
      capability: { cost: 1 },
      error: /capability\.cost must be a string/
    },
    {
      name: "resources",
      capability: { resources: {} },
      error: /capability\.resources must be an array of strings/
    },
    {
      name: "requirements",
      capability: { requirements: [Symbol("credential")] },
      error: /capability\.requirements\[0\] must be a string/
    },
    {
      name: "examples",
      capability: { examples: [{ run: () => null }] },
      error: /capability\.examples\[0\]\.run must contain only JSON-serializable values/
    },
    {
      name: "success",
      capability: { successCriteria: [false] },
      error: /capability\.successCriteria\[0\] must be a string/
    },
    {
      name: "availability",
      capability: { availability: "maybe" },
      error: /capability\.availability must be one of/
    }
  ];

  for (const fixture of cases) {
    const registry = new ToolRegistry();
    assert.throws(
      () => register(registry, `invalid_${fixture.name}`, {
        sideEffects: fixture.sideEffects,
        capability: fixture.capability
      }),
      fixture.error,
      fixture.name
    );
    assert.equal(registry.list().length, 0, fixture.name);
  }
});

test("capability accessors are rejected without executing them", () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const capability = {};
  Object.defineProperty(capability, "domain", {
    enumerable: true,
    get() {
      executions += 1;
      return "filesystem";
    }
  });

  assert.throws(
    () => register(registry, "accessor_manifest", { capability }),
    /capability\.domain must not use getters or setters/
  );
  assert.equal(executions, 0);

  const example = {};
  Object.defineProperty(example, "run", {
    enumerable: true,
    get() {
      executions += 1;
      return "hidden callback";
    }
  });
  assert.throws(
    () => register(registry, "accessor_example", {
      capability: { examples: [example] }
    }),
    /capability\.examples\[0\]\.run must not use getters or setters/
  );
  assert.equal(executions, 0);
});

test("list returns detached JSON-safe descriptors and never exposes callbacks", () => {
  const registry = new ToolRegistry();
  const summarize = () => "human summary";
  const metadataCallback = () => "private";
  const parameterCallback = () => "private";
  register(registry, "safe_listing", {
    sideEffects: false,
    summarize,
    metadata: {
      label: "fixture",
      callback: metadataCallback,
      nested: { callback: metadataCallback, visible: true }
    },
    parameters: {
      type: "object",
      properties: {},
      executable: parameterCallback
    },
    capability: {
      effect: "read",
      verbs: ["inspect"]
    }
  });

  const listed = registry.list()[0];
  assert.equal(Object.hasOwn(listed, "handler"), false);
  assert.equal(Object.hasOwn(listed, "preflight"), false);
  assert.equal(Object.hasOwn(listed, "forwardInvocation"), false);
  assert.equal(Object.hasOwn(listed, "summarize"), false);
  assert.deepEqual(listed.metadata, {
    label: "fixture",
    nested: { visible: true }
  });
  assert.equal(Object.hasOwn(listed.parameters, "executable"), false);
  assert.doesNotThrow(() => JSON.stringify(listed));

  listed.capability.verbs.push("mutate-copy");
  listed.metadata.label = "changed-copy";
  assert.deepEqual(registry.get("safe_listing").capability.verbs, ["inspect"]);
  assert.equal(registry.get("safe_listing").metadata.label, "fixture");
  assert.equal(registry.get("safe_listing").summarize, summarize);
  assert.equal(registry.get("safe_listing").metadata.callback, metadataCallback);
});

test("provider tool schemas stay backward compatible when capabilities are present", () => {
  const registry = new ToolRegistry();
  register(registry, "schema_fixture", {
    sideEffects: false,
    description: "Read a fixture",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        constructor: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    capability: {
      domain: "testing",
      verbs: ["read"],
      effect: "read"
    }
  });

  assert.deepEqual(registry.toOpenAITools(), [{
    type: "function",
    name: "schema_fixture",
    description: "Read a fixture",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        constructor: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  }]);
  assert.deepEqual(registry.toAnthropicTools(), [{
    name: "schema_fixture",
    description: "Read a fixture",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        constructor: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  }]);
});
