import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tool-registry.js";
import {
  normalizeToolInputSchema,
  validateToolContractValue
} from "../src/tool-contract.js";

test("registry validates nested input contracts before preflight, hooks, or handlers", async () => {
  let preflights = 0;
  let hooks = 0;
  let handlers = 0;
  const registry = new ToolRegistry({
    hooks: {
      beforeToolCall: async () => {
        hooks += 1;
        return { action: "allow" };
      },
      notify() {}
    }
  });
  registry.register({
    name: "contract_write",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            retries: { type: "integer", minimum: 0, maximum: 3 }
          },
          required: ["path"],
          additionalProperties: false
        },
        mode: { type: "string", enum: ["replace", "append"] }
      },
      required: ["target", "mode"],
      additionalProperties: false
    },
    preflight: () => {
      preflights += 1;
    },
    handler: () => {
      handlers += 1;
      return { saved: true };
    }
  });

  const result = await registry.invoke("contract_write", {
    target: {
      path: "",
      retries: 7,
      surprise: true
    },
    mode: "delete",
    extra: "not allowed"
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "invalid_tool_arguments");
  assert.match(result.error, /\$\.target\.path must contain at least 1 characters/u);
  assert.match(result.error, /\$\.target\.retries must be at most 3/u);
  assert.match(result.error, /\$\.target\.surprise is not an allowed property/u);
  assert.equal(preflights, 0);
  assert.equal(hooks, 0);
  assert.equal(handlers, 0);
});

test("input contract errors expose paths but never rejected argument values", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "secret_shaped_input",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", pattern: "^safe_[a-z]+$" }
      },
      required: ["token"],
      additionalProperties: false
    },
    handler: () => ({ ok: true })
  });

  const secret = "sk-super-secret-value-that-must-not-echo";
  const result = await registry.invoke("secret_shaped_input", { token: secret });

  assert.equal(result.outcome.code, "invalid_tool_arguments");
  assert.match(result.error, /\$\.token does not match the declared pattern/u);
  assert.doesNotMatch(result.error, new RegExp(secret, "u"));
});

test("valid oneOf, arrays, unique items, formats, and local refs pass", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "contract_read",
    sideEffects: false,
    parameters: {
      type: "object",
      $defs: {
        identifier: {
          type: "string",
          pattern: "^[a-z][a-z0-9_-]+$"
        }
      },
      properties: {
        id: { $ref: "#/$defs/identifier" },
        selector: {
          oneOf: [
            { type: "string", minLength: 1 },
            {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "integer", minimum: 1 }
            }
          ]
        },
        date: { type: "string", format: "date" }
      },
      required: ["id", "selector", "date"],
      additionalProperties: false
    },
    handler: (args) => ({ selected: args.selector })
  });

  const result = await registry.invoke("contract_read", {
    id: "build_7",
    selector: [1, 2, 3],
    date: "2026-07-25"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { selected: [1, 2, 3] });
});

test("declared output contracts reject false successes after dispatch", async () => {
  let handlers = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "typed_result",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 0 },
        items: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["count", "items"],
      additionalProperties: false
    },
    handler: () => {
      handlers += 1;
      return { count: "two", items: [1, 2] };
    }
  });

  const result = await registry.invoke("typed_result", {});

  assert.equal(handlers, 1);
  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "invalid_tool_result");
  assert.equal(result.outcome.changed, false);
  assert.match(result.error, /\$\.count must be an integer/u);
  assert.match(result.error, /\$\.items\[0\] must be a string/u);
});

test("output contracts remain private from provider input schemas and visible to discovery", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "typed_discovery",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        found: { type: "boolean" }
      },
      required: ["found"],
      additionalProperties: false
    },
    handler: () => ({ found: true })
  });

  const listed = registry.list()[0];
  const openai = registry.toOpenAITools()[0];
  assert.deepEqual(listed.outputSchema, {
    type: "object",
    properties: {
      found: { type: "boolean" }
    },
    required: ["found"],
    additionalProperties: false
  });
  assert.equal(Object.hasOwn(openai, "outputSchema"), false);
  assert.equal(Object.hasOwn(openai.parameters, "outputSchema"), false);
});

test("invalid and executable schemas fail closed during registration", () => {
  assert.throws(
    () => normalizeToolInputSchema({ type: "string" }, "wrong_root"),
    /must accept only an object at its root/u
  );
  assert.throws(
    () => normalizeToolInputSchema({
      type: "object",
      properties: {
        value: { type: "string", pattern: "[" }
      }
    }, "bad_pattern"),
    /must be a valid ECMAScript regular expression/u
  );
  assert.throws(
    () => normalizeToolInputSchema({
      type: "object",
      properties: {
        value: { $ref: "https:\/\/example.invalid\/schema.json" }
      }
    }, "external_ref"),
    /must be a local JSON pointer/u
  );
  assert.throws(
    () => normalizeToolInputSchema({
      type: "object",
      transform: () => null
    }, "callback"),
    /must contain only JSON-safe values/u
  );
});

test("validation supports finite recursive local schema references", () => {
  const schema = normalizeToolInputSchema({
    type: "object",
    $defs: {
      recursive: {
        type: "object",
        properties: {
          child: { $ref: "#/$defs/recursive" }
        }
      }
    },
    properties: {
      root: { $ref: "#/$defs/recursive" }
    }
  }, "recursive");

  const result = validateToolContractValue(schema, {
    root: {
      child: {
        child: {}
      }
    }
  });

  assert.equal(result.ok, true);
});
