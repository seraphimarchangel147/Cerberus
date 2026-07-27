import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComputerUseController } from "../src/computer-use-controller.js";
import { ComputerUseLog } from "../src/computer-use-log.js";
import {
  COMPUTER_USE_TOOL_NAMES,
  UNIFIED_COMPUTER_USE_TOOL_NAMES,
  registerComputerUseTools
} from "../src/integrations/computer-use.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { SecretsStore } from "../src/secrets-store.js";

function context(overrides = {}) {
  return {
    sessionId: "session-a",
    __projectId: "alpha",
    __projectRevision: 3,
    __confirmed: true,
    ...overrides
  };
}

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cua-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new ComputerUseLog({ dir });
  let generation = 1;
  const calls = [];
  const snapshot = (extra = {}) => ({
    projectId: "alpha",
    sessionId: "session-a",
    generation: `gen_${generation}`,
    url: "https://example.test/private?token=must-not-persist",
    nodes: [
      {
        ref: `bref_${generation}`,
        role: "textbox",
        name: "Search"
      }
    ],
    ...extra
  });
  const semanticBrowser = {
    async open(args) {
      calls.push({ method: "open", args });
      return snapshot({ opened: true });
    },
    async inspect(args) {
      calls.push({ method: "inspect", args });
      return snapshot();
    },
    async input(args) {
      calls.push({ method: "input", args });
      generation += 1;
      return snapshot({ input: true, inspectRequired: true });
    },
    async activate(args) {
      calls.push({ method: "activate", args });
      generation += 1;
      return snapshot({ activated: true, inspectRequired: true });
    },
    async select(args) {
      calls.push({ method: "select", args });
      generation += 1;
      return snapshot({ selected: true, inspectRequired: true });
    },
    async scroll(args) {
      calls.push({ method: "scroll", args });
      generation += 1;
      return snapshot({ scrolled: true, inspectRequired: true });
    },
    async navigate(args) {
      calls.push({ method: "navigate", args });
      generation += 1;
      return snapshot({ navigated: true, inspectRequired: true });
    },
    async screenshot() {
      calls.push({ method: "screenshot" });
      return snapshot({
        evidence: {
          sha256: "a".repeat(64),
          capturedAt: new Date().toISOString(),
          coordinateEligible: true
        },
        image: {
          mediaType: "image/png",
          data: Buffer.from("png").toString("base64")
        },
        width: 800,
        height: 600
      });
    },
    async visualClick(args) {
      calls.push({ method: "visualClick", args });
      generation += 1;
      return snapshot({
        clicked: true,
        strategy: "visual-fallback",
        inspectRequired: true
      });
    },
    async close() {
      calls.push({ method: "close" });
      return { closed: true };
    }
  };
  const project = {
    id: "alpha",
    revision: 3,
    status: "active",
    workspaceRoot: dir,
    secretRefs: [],
    policy: { toolPolicy: "full" }
  };
  const runtime = {
    computerUseLog: log,
    semanticBrowser,
    observations: { search: async () => [] },
    projects: {
      authorize(id, options = {}) {
        if (id !== "alpha" || options.sessionId !== "session-a") {
          return null;
        }
        return structuredClone(project);
      }
    }
  };
  const controller = new ComputerUseController({
    runtime,
    env: { OPENAGI_DESKTOP_LEASE: "0" }
  });
  return { controller, calls, dir, log, runtime };
}

test("browser computer use is scoped, generation-bound, and proof-carrying", async (t) => {
  const h = harness(t);
  const started = await h.controller.start({
    goal: "Search the site",
    surface: "browser",
    url: "https://example.test",
    maxActions: 2
  }, context());
  assert.equal(started.surface, "browser");
  assert.equal(started.observationRevision, 1);

  const observed = await h.controller.observe({}, context());
  const ref = observed.snapshot.nodes[0].ref;
  const acted = await h.controller.act({
    action: "input",
    observationRevision: observed.observationRevision,
    expectedGeneration: observed.snapshot.generation,
    reasoning: "Enter the requested search term.",
    ref,
    text: "private typed value"
  }, context());
  assert.equal(acted.postcondition.verified, true);
  assert.equal(acted.postcondition.observationRevision, 3);
  assert.equal(h.calls.at(-1).method, "inspect");

  const action = h.log.listActions({
    sessionId: started.sessionId
  })[0];
  assert.equal(action.args.text, "[REDACTED]");
  assert.equal(action.args.textLength, 19);
  assert.equal("textSha256" in action.args, false);
  const journal = fs.readFileSync(
    path.join(h.dir, "journal.jsonl"),
    "utf8"
  );
  assert.equal(journal.includes("private typed value"), false);
  assert.equal(journal.includes("must-not-persist"), false);

  await assert.rejects(
    h.controller.observe({}, context({ sessionId: "session-b" })),
    /No active computer-use session/
  );
});

test("visual fallback requires the latest screenshot receipt", async (t) => {
  const h = harness(t);
  await h.controller.start({
    goal: "Use the canvas control",
    surface: "browser"
  }, context());
  const shot = await h.controller.screenshot({
    reasoning: "The canvas exposes no semantic target."
  }, context());

  await assert.rejects(
    h.controller.act({
      action: "visual_click",
      observationRevision: shot.observationRevision,
      expectedGeneration: shot.generation,
      reasoning: "Click the canvas target.",
      x: 10,
      y: 20,
      screenshotSha256: "b".repeat(64),
      fallbackReason: "Canvas has no semantic ref."
    }, context()),
    /screenshot/i
  );

  const result = await h.controller.act({
    action: "visual_click",
    observationRevision: shot.observationRevision,
    expectedGeneration: shot.generation,
    reasoning: "Click the canvas target.",
    x: 10,
    y: 20,
    screenshotSha256: shot.evidence.sha256,
    fallbackReason: "Canvas has no semantic ref."
  }, context());
  assert.equal(result.strategy, "visual-fallback");
  assert.equal(result.postcondition.verified, true);
});

test("computer-use registry exposes unified tools and verifies postconditions", async (t) => {
  const h = harness(t);
  const registry = new ToolRegistry({ projects: h.runtime.projects });
  const registered = registerComputerUseTools(registry, h.runtime, {
    env: {}
  });
  assert.equal(registered.registered, true);
  assert.deepEqual(registered.names, [...COMPUTER_USE_TOOL_NAMES]);

  const descriptors = new Map(
    registry.list().map((descriptor) => [
      descriptor.name,
      descriptor
    ])
  );
  assert.equal(descriptors.get("computer_observe").sideEffects, false);
  assert.equal(descriptors.get("computer_act").needsConfirmation, true);
  assert.equal(descriptors.get("computer_screenshot").needsConfirmation, true);
  assert.equal(descriptors.get("computer_act").capability.domain, "computer");
  assert.equal(descriptors.get("computer_act").metadata.privateInput, true);

  const started = await registry.get("start_computer_use_session").handler({
    goal: "Exercise private lifecycle visibility",
    surface: "browser"
  }, context());
  const observed = await registry.get("computer_observe").handler(
    {},
    context()
  );
  const events = [];
  const invoked = await registry.invoke("computer_act", {
    action: "input",
    observationRevision: observed.observationRevision,
    expectedGeneration: observed.snapshot.generation,
    reasoning: "Enter a private fixture value.",
    ref: observed.snapshot.nodes[0].ref,
    text: "lifecycle-private-canary"
  }, context({
    __onToolEvent: (event) => events.push(structuredClone(event))
  }));
  assert.equal(invoked.ok, true);
  assert.equal(invoked.outcome.verification.status, "passed");
  assert.equal(JSON.stringify(events).includes("lifecycle-private-canary"), false);
  assert.equal(
    events.find((event) => event.phase === "start").args.text,
    "[PRIVATE INPUT OMITTED]"
  );
  assert.ok(started.sessionId);
});

test("the provider prompt documents every unified computer-use tool", () => {
  const prompt = buildDefaultInstructions({
    agent: { name: "Computer Use Tester" }
  });
  for (const name of UNIFIED_COMPUTER_USE_TOOL_NAMES) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`));
  }
});

test("computer-use action budgets survive journal replay", (t) => {
  const h = harness(t);
  const session = h.log.startSession({
    goal: "Bound actions",
    approvedBy: "user",
    maxActions: 1
  });
  h.log.recordAction({
    sessionId: session.id,
    kind: "type",
    args: { text: "secret text" },
    reasoning: "First action."
  });
  assert.throws(
    () => h.log.recordAction({
      sessionId: session.id,
      kind: "click",
      args: { x: 1, y: 2 },
      reasoning: "Second action."
    }),
    /budget exhausted/
  );

  const replayed = new ComputerUseLog({ dir: h.dir });
  assert.equal(replayed.getSession(session.id).mutationCount, 1);
  assert.throws(
    () => replayed.recordAction({
      sessionId: session.id,
      kind: "click",
      args: { x: 1, y: 2 },
      reasoning: "Still over budget."
    }),
    /budget exhausted/
  );
});

test("computer-use audit text redacts managed secrets", async (t) => {
  const h = harness(t);
  const secret = "cua-managed-secret-canary";
  const secretDir = path.join(h.dir, "managed");
  const secrets = new SecretsStore({
    dataDir: secretDir,
    allowlist: ["CUA_SECRET"],
    env: {}
  });
  secrets.initialize();
  secrets.setSecret("CUA_SECRET", secret);
  h.runtime.secrets = secrets;

  const started = await h.controller.start({
    goal: `Inspect ${secret}`,
    surface: "desktop"
  });
  await h.controller.screenshot({
    reasoning: `Need pixels for ${secret}`
  });
  await h.controller.end({
    reason: `Finished ${secret}`
  });

  const journal = fs.readFileSync(
    path.join(h.dir, "journal.jsonl"),
    "utf8"
  );
  assert.equal(journal.includes(secret), false);
  assert.match(journal, /\[(?:REDACTED|HIDDEN)\]/);
  assert.equal(h.log.getSession(started.sessionId).goal.includes(secret), false);
});
