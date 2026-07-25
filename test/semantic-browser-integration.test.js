import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AbiRuntime } from "../src/abi-runtime.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  buildDefaultInstructions
} from "../src/model-provider.js";
import {
  SEMANTIC_BROWSER_TOOL_NAMES,
  ToolRegistry,
  registerSemanticBrowserTools
} from "../src/tool-registry.js";

const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function semanticBrowserDouble(calls = []) {
  const service = {};
  for (const method of [
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
  ]) {
    service[method] = async (args, context) => {
      calls.push({ method, args, context });
      if (method === "screenshot") {
        return {
          image: {
            mediaType: "image/png",
            data: IMAGE_DATA
          },
          width: 1,
          height: 1,
          generation: 3,
          url: "https://example.test/"
        };
      }
      return { method, projectId: context.projectId, sessionId: context.sessionId };
    };
  }
  service.closeAll = async () => {};
  return service;
}

function scopedRuntime(calls = []) {
  const project = {
    id: "alpha",
    revision: 7,
    status: "active",
    workspaceRoot: path.resolve("alpha-workspace"),
    secretRefs: ["ALPHA_TOKEN"],
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  };
  const projects = {
    authorize(id, options = {}) {
      if (id !== "alpha") throw new Error("project unavailable");
      if (options.sessionId && options.sessionId !== "alpha-session") {
        throw new Error("foreign session");
      }
      return structuredClone(project);
    },
    get(id) {
      return id === "alpha" ? structuredClone(project) : null;
    }
  };
  return {
    projects,
    secrets: {
      getSecret() {
        throw new Error("integration preflight must not resolve secret values");
      },
      listAllowedNames() {
        return ["ALPHA_TOKEN", "OTHER_TOKEN"];
      }
    },
    semanticBrowser: semanticBrowserDouble(calls)
  };
}

function projectContext(overrides = {}) {
  return {
    channel: "local",
    from: "tester",
    agentId: "main",
    sessionId: "alpha-session",
    __projectId: "alpha",
    __projectRevision: 7,
    __projectWorkspaceDir: path.resolve("forged-workspace"),
    __projectSecretRefs: ["*"],
    ...overrides
  };
}

test("semantic browser tools expose bounded schemas, capabilities, and approval classes", () => {
  const runtime = scopedRuntime();
  const registry = new ToolRegistry({ projects: runtime.projects });
  const registered = registerSemanticBrowserTools(registry, runtime);
  assert.equal(registered.registered, true);
  assert.deepEqual(registered.names, [...SEMANTIC_BROWSER_TOOL_NAMES]);

  const descriptors = new Map(registry.list().map((tool) => [tool.name, tool]));
  for (const name of SEMANTIC_BROWSER_TOOL_NAMES) {
    const descriptor = descriptors.get(name);
    assert.ok(descriptor, `${name} must be registered`);
    assert.equal(descriptor.parameters.additionalProperties, false);
    assert.equal(descriptor.capability.domain, "browser");
    assert.ok(descriptor.capability.resources.includes("ui"));
    assert.equal(
      descriptor.capability.effect,
      descriptor.sideEffects ? "write" : "read"
    );
  }

  for (const name of [
    "browser_open",
    "browser_navigate",
    "browser_activate",
    "browser_input",
    "browser_input_secret",
    "browser_select",
    "browser_download",
    "browser_upload",
    "browser_screenshot"
  ]) {
    assert.equal(descriptors.get(name).needsConfirmation, true, `${name} approval`);
  }
  for (const name of ["browser_close"]) {
    assert.equal(descriptors.get(name).sideEffects, true, `${name} is a mutation`);
    assert.equal(descriptors.get(name).needsConfirmation, false);
  }
  for (const name of [
    "browser_inspect",
    "browser_scroll",
    "browser_screenshot"
  ]) {
    assert.equal(descriptors.get(name).sideEffects, false, `${name} is read-only`);
  }
  assert.deepEqual(
    Object.keys(descriptors.get("browser_input_secret").parameters.properties).sort(),
    ["ref", "secretRef"]
  );
});

test("semantic browser invocation re-authorizes scope and rejects secret smuggling", async () => {
  const calls = [];
  const runtime = scopedRuntime(calls);
  const registry = new ToolRegistry({ projects: runtime.projects });
  registerSemanticBrowserTools(registry, runtime);

  const inspected = await registry.invoke(
    "browser_inspect",
    { query: "main" },
    projectContext({ __scrutinyPolicy: "read-only" })
  );
  assert.equal(inspected.ok, true);
  assert.equal(calls[0].context.projectId, "alpha");
  assert.equal(calls[0].context.sessionId, "alpha-session");
  assert.equal(calls[0].context.workspaceRoot, path.resolve("alpha-workspace"));
  assert.deepEqual(calls[0].context.__projectSecretRefs, ["ALPHA_TOKEN"]);

  const literal = await registry.invoke(
    "browser_input_secret",
    { ref: "e_1", secretRef: "ALPHA_TOKEN", value: "must-not-pass" },
    projectContext({ __confirmed: true })
  );
  assert.equal(literal.ok, false);
  assert.equal(literal.code, "invalid_tool_arguments");
  assert.equal(calls.length, 1);

  const denied = await registry.invoke(
    "browser_input_secret",
    { ref: "e_1", secretRef: "OTHER_TOKEN" },
    projectContext({ __confirmed: true })
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not granted to project/);
  assert.equal(calls.length, 1);

  const allowed = await registry.invoke(
    "browser_input_secret",
    { ref: "e_1", secretRef: "ALPHA_TOKEN" },
    projectContext({ __confirmed: true })
  );
  assert.equal(allowed.ok, true);
  assert.equal(calls.at(-1).method, "inputSecret");
  assert.deepEqual(calls.at(-1).args, {
    ref: "e_1",
    secretRef: "ALPHA_TOKEN"
  });

  const foreign = await registry.invoke(
    "browser_inspect",
    {},
    projectContext({ sessionId: "foreign-session" })
  );
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "project_scope_invalid");
});

test("AbiRuntime owns an injected semantic browser and closes it", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-browser-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = semanticBrowserDouble();
  let factoryInput;
  let closed = 0;
  service.closeAll = async () => {
    closed += 1;
  };
  const adapter = { id: "injected-adapter" };
  const runtime = new AbiRuntime({
    dataDir,
    skills: false,
    externalMemoryProvider: null,
    semanticBrowserAdapter: adapter,
    semanticBrowserFactory(options) {
      factoryInput = options;
      return service;
    }
  });
  assert.equal(runtime.semanticBrowser, service);
  assert.equal(factoryInput.runtime, runtime);
  assert.equal(factoryInput.projects, runtime.projects);
  assert.equal(factoryInput.secrets, runtime.secrets);
  assert.equal(factoryInput.adapter, adapter);
  for (const name of SEMANTIC_BROWSER_TOOL_NAMES) {
    assert.equal(runtime.tools.has(name), true);
  }

  await runtime.close();
  assert.equal(closed, 1);
});

test("AbiRuntime activates the default semantic browser from its environment", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-browser-default-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = new AbiRuntime({
    dataDir,
    skills: false,
    externalMemoryProvider: null,
    env: {
      OPENAGI_SEMANTIC_BROWSER: "1"
    }
  });

  assert.ok(runtime.semanticBrowser);
  for (const name of SEMANTIC_BROWSER_TOOL_NAMES) {
    assert.equal(runtime.tools.has(name), true);
  }

  await runtime.close();
});

test("the static provider prompt documents every semantic browser tool", () => {
  const prompt = buildDefaultInstructions({
    agent: { name: "Semantic Browser Tester" }
  });
  for (const name of SEMANTIC_BROWSER_TOOL_NAMES) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`));
  }
});

for (const spec of [
  {
    name: "OpenAI",
    provider() {
      const provider = new OpenAIResponsesProvider({
        apiKey: "test-key",
        maxIterations: 2
      });
      const requests = [];
      provider.postResponses = async (body) => {
        requests.push(structuredClone(body));
        if (requests.length === 1) {
          return {
            id: "browser_openai_tool",
            output: [{
              type: "function_call",
              call_id: "browser_shot",
              name: "browser_screenshot",
              arguments: "{}"
            }]
          };
        }
        return {
          id: "browser_openai_done",
          output_text: "screenshot inspected",
          output: []
        };
      };
      return { provider, requests };
    },
    registry: {
      toOpenAITools: () => [{
        type: "function",
        name: "browser_screenshot",
        parameters: { type: "object", properties: {} }
      }]
    },
    assertImage(requests) {
      const image = requests[1].input
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .find((item) => item.type === "input_image");
      assert.equal(image.image_url, `data:image/png;base64,${IMAGE_DATA}`);
      const output = requests[1].input.find(
        (item) => item.type === "function_call_output"
      );
      assert.equal(output.output.includes(IMAGE_DATA), false);
    }
  },
  {
    name: "Anthropic",
    provider() {
      const provider = new AnthropicProvider({
        apiKey: "test-key",
        maxIterations: 2
      });
      const requests = [];
      provider.postMessages = async (body) => {
        requests.push(structuredClone(body));
        if (requests.length === 1) {
          return {
            id: "browser_anthropic_tool",
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "browser_shot",
              name: "browser_screenshot",
              input: {}
            }]
          };
        }
        return {
          id: "browser_anthropic_done",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "screenshot inspected" }]
        };
      };
      return { provider, requests };
    },
    registry: {
      toAnthropicTools: () => [{
        name: "browser_screenshot",
        input_schema: { type: "object", properties: {} }
      }]
    },
    assertImage(requests) {
      const result = requests[1].messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((item) => item.type === "tool_result");
      const image = result.content.find((item) => item.type === "image");
      assert.deepEqual(image.source, {
        type: "base64",
        media_type: "image/png",
        data: IMAGE_DATA
      });
      const text = result.content.find((item) => item.type === "text");
      assert.equal(text.text.includes(IMAGE_DATA), false);
    }
  }
]) {
  test(`${spec.name} receives nested semantic-browser screenshots as native images`, async () => {
    const { provider, requests } = spec.provider();
    const toolRegistry = {
      ...spec.registry,
      async invoke(name) {
        assert.equal(name, "browser_screenshot");
        return {
          ok: true,
          result: {
            image: {
              mediaType: "image/png",
              data: IMAGE_DATA
            },
            width: 1,
            height: 1,
            generation: 3,
            url: "https://example.test/"
          }
        };
      }
    };
    const result = await provider.generate({
      input: "inspect the screenshot",
      agent: { id: "main", name: "Main" },
      toolRegistry
    });
    assert.equal(result.text, "screenshot inspected");
    assert.equal(requests.length, 2);
    spec.assertImage(requests);
  });
}
