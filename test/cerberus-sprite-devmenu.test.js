import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createDefaultRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";

const ATLAS = JSON.parse(fs.readFileSync(
  new URL("../cerberus/sprites/runtime/atlas.json", import.meta.url),
  "utf8"
));

class FakeElement {
  constructor(tagName, context) {
    this.tagName = String(tagName).toUpperCase();
    this.context = context;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.parentNode = null;
    this.id = "";
    this._innerHTML = "";
    this._textContent = "";
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ currentTarget: this, target: this });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  querySelectorAll(selector) {
    const output = [];
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    const tagName = attribute ? null : String(selector).toUpperCase();
    const visit = (node) => {
      for (const child of node.children) {
        const matches = attribute
          ? child.attributes.has(attribute[1])
            && (attribute[2] === undefined || child.attributes.get(attribute[1]) === attribute[2])
          : child.tagName === tagName;
        if (matches) output.push(child);
        visit(child);
      }
    };
    visit(this);
    return output;
  }

  getContext() {
    return this.context;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this._textContent = "";
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(value) {
    this._textContent = String(value);
    this._innerHTML = "";
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }
}

function fakeCanvasContext() {
  const target = {
    clearRect() {},
    drawImage() {},
    restore() {},
    save() {}
  };
  return new Proxy(target, {
    get(object, property) {
      if (!(property in object)) object[property] = () => {};
      return object[property];
    }
  });
}

function fakeBrowser(savedSettings = {}) {
  const context = fakeCanvasContext();
  const body = new FakeElement("body", context);
  const document = {
    body,
    hidden: false,
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName, context);
    },
    getElementById(id) {
      if (body.id === id) return body;
      const stack = [...body.children];
      while (stack.length) {
        const node = stack.shift();
        if (node.id === id) return node;
        stack.push(...node.children);
      }
      return null;
    }
  };
  const stored = new Map([
    ["cerbPetSettings", JSON.stringify(savedSettings)]
  ]);
  const localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, String(value)); }
  };
  const intervals = new Map();
  let nextInterval = 1;
  const window = {
    console,
    document,
    innerHeight: 900,
    innerWidth: 1440,
    localStorage,
    addEventListener() {},
    clearInterval(id) { intervals.delete(id); },
    matchMedia() { return { matches: false }; },
    setInterval(fn) {
      const id = nextInterval++;
      intervals.set(id, fn);
      return id;
    }
  };
  class FakeImage {
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  }
  return {
    context,
    document,
    intervals,
    sandbox: {
      Image: FakeImage,
      console,
      document,
      fetch: async () => ({ ok: true, json: async () => structuredClone(ATLAS) }),
      localStorage,
      queueMicrotask,
      requestAnimationFrame() {},
      window
    },
    window
  };
}

async function renderPetBundle() {
  const previousAuthToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "cerb-devmenu-render-test";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cerb-devmenu-test-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir);
  const runtime = createDefaultRuntime({
    dataDir,
    workspaceDir,
    registerDefaults: false,
    semanticBrowser: false,
    modelProvider: {
      isConfigured: () => true,
      async generate() { return { text: "unused" }; }
    },
    backgroundReviewer: {}
  });
  const channels = {
    start() {},
    stop() {},
    status: () => ({ local: { enabled: true } })
  };
  const app = createHostedInterface(runtime, {
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: "",
    channels
  });
  try {
    const address = await app.listen();
    const response = await fetch(address.url + "/");
    assert.equal(response.status, 200);
    const html = await response.text();
    const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(match, "rendered dashboard must contain its inline client bundle");
    assert.doesNotThrow(() => new Function(match[1]));
    const marker = match[1].indexOf("if (window.__cerbPetLoaded) return;");
    const start = match[1].lastIndexOf("(function () {", marker);
    const end = match[1].indexOf("\n})();", marker);
    assert.ok(marker >= 0 && start >= 0 && end > marker);
    return match[1].slice(start, end + 6);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousAuthToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = previousAuthToken;
  }
}

async function runPet(bundle, savedSettings) {
  const browser = fakeBrowser(savedSettings);
  const instrumented = bundle.replace(
    "  window.__cerbProbe = function () {",
    "  window.__cerbTestDrawSprite = drawCerbSprite;\n  window.__cerbProbe = function () {"
  );
  assert.notEqual(instrumented, bundle, "test hook must instrument the rendered pet bundle");
  vm.runInNewContext(instrumented, browser.sandbox, { timeout: 5000 });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(browser.window.__cerbProbe().ready, true);
  return browser;
}

test("Cerberus sprite toggle and manifest-driven dev menu", async (t) => {
  const bundle = await renderPetBundle();

  await t.test("sprite art off makes both atlas forms use the procedural fallback", async () => {
    const browser = await runPet(bundle, { sprites: false, stage: 3 });
    assert.equal(browser.window.__cerbProbe().sprites, false);
    assert.equal(
      browser.window.__cerbTestDrawSprite(browser.context, { flick: 0 }, "omega"),
      false
    );
    assert.equal(
      browser.window.__cerbTestDrawSprite(browser.context, { flick: 0 }, "alpha"),
      false
    );
  });

  await t.test("menu measures atlas rows, procedural forms, and forced walk playback", async () => {
    const browser = await runPet(bundle, { sprites: true, stage: 3 });
    assert.equal(browser.window.__cerbProbe().stage, 3, "default atlas-backed stage remains omega");
    assert.equal(browser.window.cerbPetDevMenu(), true, "console hook opens the menu");
    const panel = browser.document.getElementById("cerbPetDevMenuPanel");
    assert.ok(panel);
    /* Row count is read from the MANIFEST, not hardcoded: the whole point of
       the dev menu is that it enumerates whatever the atlas ships. Pinning a
       literal here made the suite fail the moment new state rows landed
       (7 -> 11), which is a stale test, not a regression. */
    const omegaRows = Object.keys(ATLAS.forms.omega.states).length;
    const alphaRows = Object.keys(ATLAS.forms.alpha.states).length;
    assert.ok(omegaRows >= 7, "omega should expose at least the original seven rows");
    assert.equal(panel.querySelectorAll("[data-cerb-row]").length, omegaRows);

    browser.window.cerbPetSetForm(4);
    assert.equal(panel.querySelectorAll("[data-cerb-row]").length, alphaRows);

    for (const stage of [0, 1, 2]) {
      browser.window.cerbPetSetForm(stage);
      assert.equal(panel.querySelectorAll("[data-cerb-row]").length, 0);
      const notice = panel.querySelectorAll("[data-cerb-procedural-only]");
      assert.equal(notice.length, 1);
      assert.equal(notice[0].textContent, "procedural only - no atlas rows for this form");
    }

    browser.window.cerbPetSetForm(3);
    const walkSection = panel.querySelectorAll("[data-cerb-row=\"walk\"]")[0];
    assert.ok(walkSection);
    assert.match(walkSection.textContent, /no alias - forceRow only/);
    const walkPlay = panel.querySelectorAll("[data-cerb-play-row=\"walk\"]")[0];
    assert.ok(walkPlay);
    walkPlay.click();
    assert.equal(browser.window.__cerbProbe().devForceRow, "walk");
    assert.equal(
      browser.window.__cerbTestDrawSprite(browser.context, { flick: 0 }, "omega"),
      true
    );
    const probe = browser.window.__cerbProbe();
    assert.equal(probe.rows.omega, "walk");
    assert.equal(probe.frames.omega, ATLAS.forms.omega.states.walk.seq[0]);
    assert.equal(probe.indices.omega, 0);

    const stop = panel.querySelectorAll("button")
      .find((button) => button.textContent === "Stop / resume live state");
    assert.ok(stop);
    stop.click();
    assert.equal(browser.window.__cerbProbe().devForceRow, null);
    assert.equal(browser.intervals.size, 1);
    assert.equal(browser.window.cerbPetDevMenu(false), false);
    assert.equal(browser.intervals.size, 0, "closing the menu clears its refresh timer");
  });
});
