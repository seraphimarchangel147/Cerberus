import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Pet state-vocabulary contract.
 *
 * The pet is the only always-visible status surface on the dashboard, and its
 * failure mode is silent: a state that renders identically to another one
 * doesn't throw, it just stops carrying information. Three such collisions
 * shipped before this suite existed --
 *
 *   thinking vs blocked : opposite meanings (agent busy vs HUMAN is the
 *                         bottleneck) drawn with the same art
 *   error vs offline    : a crashed turn looked like a disconnected daemon
 *   working vs retrying : a provider backoff looked like productive work
 *
 * -- so these tests assert the DISTINCTNESS, not merely the presence, of each
 * state, and pin the harness phases that produce them.
 */

const SRC = new URL("../src/hosted-interface.js", import.meta.url);
const src = await readFile(SRC, "utf8");

/** Pull a brace-balanced object literal assigned to `name`. */
function objectLiteral(name) {
  const start = src.indexOf(`var ${name} = {`);
  assert.notEqual(start, -1, `${name} not found in hosted-interface.js`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced literal for ${name}`);
}

/** Top-level keys of an object literal, ignoring nested objects/comments. */
function topKeys(literal) {
  const body = literal.slice(1, -1).replace(/\/\*[\s\S]*?\*\//g, "");
  const keys = [];
  let depth = 0;
  let token = "";
  for (const ch of body) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth === 0 && ch === ":") {
      const m = token.match(/([A-Za-z_$][\w$]*)\s*$/);
      if (m) keys.push(m[1]);
      token = "";
      continue;
    }
    if (depth === 0 && ch === ",") token = "";
    else token += ch;
  }
  return keys;
}

const STATE_KEYS = topKeys(objectLiteral("STATES"));
const HUD_KEYS = topKeys(objectLiteral("HUD_TONE"));

test("every state the pet can enter is defined in STATES", () => {
  for (const s of ["idle", "running", "review", "failed", "waving", "jumping",
                   "waiting", "blocked", "straining", "hurt", "dozing"]) {
    assert.ok(STATE_KEYS.includes(s), `STATES is missing "${s}"`);
  }
});

test("every state has a HUD tone: an unlabelled state is invisible to the user", () => {
  for (const s of STATE_KEYS) {
    assert.ok(HUD_KEYS.includes(s),
      `state "${s}" has no HUD_TONE entry, so the badge would silently fall back to idle`);
  }
});

test("blocked is visually distinct from thinking -- the collision that hid approval prompts", () => {
  const hud = objectLiteral("HUD_TONE");
  const colour = (s) => hud.match(new RegExp(`${s}:\\s*\\["([^"]+)"`))?.[1];
  const label = (s) => hud.match(new RegExp(`${s}:\\s*\\["[^"]+","([^"]+)"`))?.[1];
  assert.notEqual(colour("blocked"), colour("review"),
    "blocked and review(thinking) share a HUD colour -- the pet cannot say it needs you");
  assert.notEqual(label("blocked"), label("review"));
  assert.match(String(label("blocked")), /block|you/i,
    "the blocked label must name the human as the bottleneck");
});

test("a real error is distinct from an offline droop", () => {
  const react = src.slice(src.indexOf("window.cerbPetReact = function"));
  const errBranch = react.match(/mode === "error"\)\s*\{\s*setState\("([a-z]+)"\)/)?.[1];
  const offBranch = react.match(/mode === "offline"\)\s*\{\s*setState\("([a-z]+)"\)/)?.[1];
  assert.ok(errBranch && offBranch);
  assert.notEqual(errBranch, offBranch,
    "error and offline both map to the same state -- a crash looks like a disconnect");
});

test("provider backoff does not render as productive work", () => {
  const react = src.slice(src.indexOf("window.cerbPetReact = function"));
  const work = react.match(/mode === "working"\)\s*\{\s*setState\("([a-z]+)"\)/)?.[1];
  const strain = react.match(/mode === "straining"[^{]*\{\s*setState\("([a-z]+)"\)/)?.[1];
  assert.ok(work && strain);
  assert.notEqual(work, strain,
    "a rate-limited turn must not be indistinguishable from a busy one");
});

test("harness phases are routed to the states they mean", () => {
  const handler = src.slice(src.indexOf('evt.addEventListener("agent-activity"'));
  const route = (phase) =>
    handler.match(new RegExp(`phase === "${phase}"\\)\\s*petActivityPoke\\("([a-z]+)"`))?.[1];
  assert.equal(route("awaiting-approval"), "blocked",
    "an approval prompt must put the pet in the blocked state");
  assert.equal(route("provider-retry"), "straining",
    "provider-retry was previously dropped, leaving a stalled turn looking busy");
  assert.equal(route("wall-clock-stopped"), "error",
    "a turn killed by the runaway backstop must surface as a failure");
});

test("blocked never decays on harness silence", () => {
  const poke = src.slice(src.indexOf("function petActivityPoke"));
  const guard = poke.match(/if \(mode !== "done"([^)]*)\)/)?.[1] ?? "";
  assert.match(guard, /blocked/,
    "blocked is excluded from the idle-decay timer: the human still hasn't answered " +
    "after 45s of silence, so clearing it would re-hide the prompt");
});

test("dozing reaches the sleep art without going through a failure", () => {
  assert.ok(src.includes("DOZE_AFTER_MS"), "no doze timer defined");
  const doze = src.slice(src.indexOf("function armDoze"));
  assert.match(doze, /state === "idle"/,
    "doze must only trigger from idle -- never mask an error or a block by sleeping on it");
  const setState = src.slice(src.indexOf("function setState(s)"));
  assert.match(setState, /s !== "dozing"/,
    "setState must re-arm the quiet clock on activity, but not from dozing itself");
});

test("states without their own atlas row fall back to real art, not idle", () => {
  const fb = objectLiteral("ROW_FALLBACK");
  for (const s of ["blocked", "straining", "hurt", "dozing"]) {
    assert.ok(fb.includes(`${s}:`), `${s} has no interim row mapping`);
  }
  assert.doesNotMatch(fb, /blocked:\s*"idle"/,
    "falling back to idle would recreate the very collision these states remove");
  const rowFn = src.slice(src.indexOf("function cerbAtlasRow"));
  const aliasAt = rowFn.indexOf("m.alias[engineState]");
  const fallbackAt = rowFn.indexOf("ROW_FALLBACK[engineState]");
  assert.ok(aliasAt !== -1 && fallbackAt !== -1 && aliasAt < fallbackAt,
    "the manifest alias must win over the interim map, so shipping real art " +
    "auto-upgrades these states with no code change");
});
