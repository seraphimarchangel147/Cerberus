import assert from "node:assert/strict";
import test from "node:test";
import { registerCodeTools } from "../src/code-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("code_verify is agent-visible and forwards scrubbed bounded context", async () => {
  let received;
  const verifier = {
    verify: async (options) => {
      received = options;
      return {
        ok: true,
        status: "passed",
        checksPlanned: 1,
        checksCompleted: 1,
        durationMs: 1,
        results: []
      };
    }
  };
  const registry = new ToolRegistry();
  registerCodeTools(registry, {
    secrets: {
      dataDir: process.cwd(),
      listSecretNames: () => ["OPENAI_API_KEY"],
      listAllowedNames: () => ["OPENAI_API_KEY"],
      exportEnv: () => ({ OPENAI_API_KEY: "verifier-secret" })
    }
  }, { codeVerifier: verifier });

  const result = await registry.invoke("code_verify", {
    checks: [{ type: "syntax", path: "src" }]
  }, {
    __abortSignal: new AbortController().signal
  });
  const descriptor = registry.get("code_verify");

  assert.equal(result.ok, true);
  assert.equal(descriptor.sideEffects, false);
  assert.deepEqual(descriptor.parameters.required, ["checks"]);
  assert.equal(received.workspaceDir, process.cwd());
  assert.equal(received.checks[0].path, "src");
  assert.equal(received.env.OPENAGI_TEST, "1");
  assert.equal(received.env.OPENAI_API_KEY, undefined);
});
