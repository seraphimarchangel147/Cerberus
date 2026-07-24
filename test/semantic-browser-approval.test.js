import assert from "node:assert/strict";
import test from "node:test";
import {
  SEMANTIC_BROWSER_TOOL_NAMES,
  ToolRegistry,
  registerSemanticBrowserTools
} from "../src/tool-registry.js";

const SERVICE_METHODS = [
  "open",
  "navigate",
  "inspect",
  "activate",
  "input",
  "inputSecret",
  "select",
  "scroll",
  "download",
  "upload",
  "screenshot",
  "close"
];

function createService() {
  return Object.fromEntries(
    SERVICE_METHODS.map((name) => [name, async () => ({ ok: true, method: name })])
  );
}

test("semantic browser tools use conservative side-effect and approval classes", () => {
  const registry = new ToolRegistry();
  const result = registerSemanticBrowserTools(registry, {
    semanticBrowser: createService()
  });

  assert.equal(result.registered, true);
  assert.deepEqual(result.names, SEMANTIC_BROWSER_TOOL_NAMES);

  const expected = new Map([
    ["browser_open", [true, true]],
    ["browser_navigate", [true, true]],
    ["browser_inspect", [false, false]],
    ["browser_activate", [true, true]],
    ["browser_input", [true, true]],
    ["browser_input_secret", [true, true]],
    ["browser_select", [true, true]],
    ["browser_scroll", [false, false]],
    ["browser_download", [true, true]],
    ["browser_upload", [true, true]],
    ["browser_screenshot", [false, true]],
    ["browser_close", [true, false]]
  ]);

  assert.equal(expected.size, SEMANTIC_BROWSER_TOOL_NAMES.length);
  for (const [name, [sideEffects, needsConfirmation]] of expected) {
    const descriptor = registry.get(name);
    assert.ok(descriptor, `${name} must be registered`);
    assert.equal(descriptor.source, "browser");
    assert.equal(descriptor.sideEffects, sideEffects, `${name} sideEffects`);
    assert.equal(
      descriptor.needsConfirmation,
      needsConfirmation,
      `${name} needsConfirmation`
    );
    assert.equal(descriptor.capability.effect, sideEffects ? "write" : "read");
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  }
});

test("semantic browser tools remain absent when the optional service is disabled", () => {
  const registry = new ToolRegistry();
  const result = registerSemanticBrowserTools(registry, {});

  assert.deepEqual(result, {
    registered: false,
    reason: "semantic browser is disabled",
    names: []
  });
  for (const name of SEMANTIC_BROWSER_TOOL_NAMES) {
    assert.equal(registry.get(name), undefined);
  }
});
