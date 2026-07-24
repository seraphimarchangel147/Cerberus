import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  saveEnv,
  SETUP_FIELDS
} from "../src/setup-wizard.js";

const BROWSER_ENV_FIELDS = [
  "OPENAGI_SEMANTIC_BROWSER",
  "OPENAGI_BROWSER_CDP_URL"
];

const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_navigate",
  "browser_inspect",
  "browser_activate",
  "browser_input",
  "browser_input_secret",
  "browser_select",
  "browser_scroll",
  "browser_download",
  "browser_upload",
  "browser_screenshot",
  "browser_close"
];

const BENCHMARK_SNAPSHOT = {
  untrusted: true,
  generation: 7,
  url: "https://travel.example/request",
  title: "Travel request",
  nodes: [
    { ref: "g7:e1", role: "heading", name: "Travel request", level: 1 },
    { ref: "g7:e2", role: "status", name: "Draft request" },
    { ref: "g7:e3", role: "textbox", name: "Destination", value: "Boston" },
    { ref: "g7:e4", role: "textbox", name: "Departure", value: "2026-08-10" },
    { ref: "g7:e5", role: "textbox", name: "Return", value: "2026-08-14" },
    { ref: "g7:e6", role: "combobox", name: "Cabin", value: "Economy" },
    {
      ref: "g7:e7",
      role: "textbox",
      name: "Notes",
      value: "Window seat if available"
    },
    { ref: "g7:e8", role: "button", name: "Review request" },
    { ref: "g7:e9", role: "heading", name: "Travel policy", level: 2 },
    {
      ref: "g7:e10",
      role: "list",
      name: "Choose refundable fares. Keep receipts. Manager approval is required."
    }
  ]
};

test("semantic browser environment options are setup-wizard persistable", (t) => {
  for (const name of BROWSER_ENV_FIELDS) {
    assert.ok(SETUP_FIELDS.includes(name), `${name} must be setup-wizard persistable`);
  }

  const previous = Object.fromEntries(
    BROWSER_ENV_FIELDS.map((name) => [name, process.env[name]])
  );
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-browser-env-"));
  const result = saveEnv({
    dataDir,
    values: {
      OPENAGI_SEMANTIC_BROWSER: "1",
      OPENAGI_BROWSER_CDP_URL: "http://127.0.0.1:9222",
      OPENAGI_BROWSER_UNSAFE_EXTRA: "must-not-persist"
    }
  });

  assert.deepEqual(
    [...result.keys].sort(),
    [...BROWSER_ENV_FIELDS].sort()
  );
  const saved = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(saved, /^OPENAGI_SEMANTIC_BROWSER=1$/mu);
  assert.match(saved, /^OPENAGI_BROWSER_CDP_URL=http:\/\/127\.0\.0\.1:9222$/mu);
  assert.doesNotMatch(saved, /OPENAGI_BROWSER_UNSAFE_EXTRA/u);
});

test("semantic browser public identifiers and benchmark fixture are ASCII-safe", () => {
  const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
  for (const name of [...BROWSER_ENV_FIELDS, ...BROWSER_TOOL_NAMES]) {
    assert.match(name, identifierPattern);
    assert.equal(Buffer.byteLength(name, "utf8"), name.length);
  }

  const fixturePath = new URL("./fixtures/semantic-browser-page.html", import.meta.url);
  const fixture = fs.readFileSync(fixturePath, "utf8");
  assert.doesNotMatch(fixture, /[^\x00-\x7F]/u);
});

test("compact semantic snapshot uses at most 20 percent of screenshot-loop context", () => {
  const semanticContext = JSON.stringify({
    task: "Review the travel request and identify the submit control.",
    snapshot: BENCHMARK_SNAPSHOT,
    actions: [
      { tool: "browser_input", ref: "g7:e3", value: "Boston" },
      { tool: "browser_select", ref: "g7:e6", value: "Economy" }
    ]
  });

  // A screenshot loop carries three bounded 64 KiB image payloads: initial
  // inspection, post-input verification, and pre-submit review. Base64 is the
  // representation placed in a multimodal provider request.
  const screenshotPayload = Buffer.alloc(64 * 1024, 0x61).toString("base64");
  const screenshotContext = JSON.stringify({
    task: "Review the travel request and identify the submit control.",
    turns: ["initial", "post-input", "pre-submit"].map((stage) => ({
      stage,
      image: {
        mediaType: "image/png",
        data: screenshotPayload
      }
    }))
  });

  const semanticBytes = Buffer.byteLength(semanticContext);
  const screenshotBytes = Buffer.byteLength(screenshotContext);
  const ratio = semanticBytes / screenshotBytes;
  assert.ok(
    ratio <= 0.2,
    `expected compact semantic context <=20%, got ${(ratio * 100).toFixed(2)}%`
  );

  // The same fixture also stays below the threshold when image payloads are
  // charged as multimodal context instead of base64 text. A 1024x768 detailed
  // image occupies one base unit plus four tile units in this benchmark.
  const semanticTokenEstimate = Math.ceil(semanticBytes / 4);
  const screenshotTokenEstimate = (3 * (85 + (4 * 170))) + 16;
  const tokenRatio = semanticTokenEstimate / screenshotTokenEstimate;
  assert.ok(
    tokenRatio <= 0.2,
    `expected compact semantic token estimate <=20%, got ${(tokenRatio * 100).toFixed(2)}%`
  );
});
