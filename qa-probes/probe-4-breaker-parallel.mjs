// Brief section 4: does the denial breaker false-fire on a PARALLEL batch, and
// is reset-on-success order-dependent (i.e. nondeterministic)?
import { HookRegistry } from "../src/hook-registry.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { DenialBreaker } from "../src/denial-breaker.js";

let fails = 0;
const chk = (c, m) => { console.log((c ? "ok:   " : "FAIL: ") + m); if (!c) fails++; };

function makeRegistry({ threshold = 3, blockNames = [] } = {}) {
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  hooks.register({
    name: "selective-block",
    event: "pre_tool_call",
    tier: "plugin",
    handler: (payload) => (blockNames.includes(payload?.toolName)
      ? { action: "block", message: "blocked by policy" }
      : { action: "allow" })
  });
  const tools = new ToolRegistry({ hooks, denialBreaker: new DenialBreaker({ threshold }) });
  for (const n of ["a", "b", "c", "ok1"]) {
    tools.register({
      name: n, description: n, sideEffects: false,
      parameters: { type: "object", additionalProperties: true },
      handler: async () => ({ ran: n })
    });
  }
  return tools;
}

// --- A: 3 blocked tools issued in ONE parallel batch ---
{
  const tools = makeRegistry({ threshold: 3, blockNames: ["a", "b", "c"] });
  const ctx = { sessionId: "parallel", __turnId: "t1" };
  const results = await Promise.all([
    tools.invoke("a", {}, ctx), tools.invoke("b", {}, ctx), tools.invoke("c", {}, ctx)
  ]);
  const tripped = results.filter(r => /CIRCUIT BREAKER/.test(String(r.error ?? "")));
  console.log(`      parallel batch of 3 blocked tools -> ${tripped.length} tripped`);
  chk(tripped.length >= 1, "A: the breaker DOES fire on a single parallel batch of 3 denials");
  console.log("      (one model decision, not three retries -- arguably a false-fire)");
}

// --- B: mixed batch, does a success clobber the tally by completion order? ---
{
  const tools = makeRegistry({ threshold: 3, blockNames: ["a", "b"] });
  const ctx = { sessionId: "mixed", __turnId: "t2" };
  await tools.invoke("a", {}, ctx);          // denial 1
  await tools.invoke("b", {}, ctx);          // denial 2
  // A success lands between denial 2 and 3
  const good = await tools.invoke("ok1", {}, ctx);
  chk(good.ok === true, "B: the allowed tool dispatched");
  const third = await tools.invoke("a", {}, ctx);
  chk(!/CIRCUIT BREAKER/.test(String(third.error ?? "")),
      "B: a success between denials RESETS the tally (no trip on the next denial)");
}

// --- C: is the outcome order-dependent when success/denial race? ---
{
  const orders = [];
  for (let run = 0; run < 6; run++) {
    const tools = makeRegistry({ threshold: 3, blockNames: ["a", "b"] });
    const ctx = { sessionId: `race-${run}`, __turnId: `t${run}` };
    const res = await Promise.all([
      tools.invoke("a", {}, ctx), tools.invoke("ok1", {}, ctx), tools.invoke("b", {}, ctx)
    ]);
    orders.push(res.some(r => /CIRCUIT BREAKER/.test(String(r.error ?? ""))));
  }
  const stable = orders.every(o => o === orders[0]);
  chk(stable, `C: mixed parallel batch outcome is STABLE across 6 runs (got ${JSON.stringify(orders)})`);
}

console.log(fails === 0 ? "\nPROBE COMPLETE" : `\n${fails} assertion(s) FAILED`);
process.exit(0);
