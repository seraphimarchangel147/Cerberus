// POST /memory/remember — direct memory import (for migrations / seeding).
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface, MemorySystem } from "../src/index.js";

test("POST /memory/remember imports a memory item", async () => {
  const runtime = createDefaultRuntime();
  const app = createHostedInterface(runtime, { port: 0 });
  const address = await app.listen();
  try {
    const res = await fetch(`${address.url}/memory/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Spencer's cruise: Australia → New Zealand, Mar 15-30", tags: ["cruise"], importance: "high" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.id);
    // It's recallable.
    const hits = runtime.memory.retrieve("cruise itinerary");
    assert.ok(hits.some((h) => /Australia/.test(h.item.content)));
    assert.ok(hits.some((h) => h.item.tags.includes("import") && h.item.tags.includes("cruise")));
  } finally {
    await app.close();
  }
});

test("POST /memory/remember rejects empty content", async () => {
  const app = createHostedInterface(createDefaultRuntime(), { port: 0 });
  const address = await app.listen();
  try {
    const res = await fetch(`${address.url}/memory/remember`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "  " })
    });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("POST /memory/remember fails closed for invalid replacement and capacity requests", async () => {
  const runtime = createDefaultRuntime({
    memory: new MemorySystem({ curatedMemoryMaxChars: 20 })
  });
  const app = createHostedInterface(runtime, { port: 0 });
  const address = await app.listen();
  const post = (body) => fetch(`${address.url}/memory/remember`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const malformed = await post({ content: "fact", replaceIds: "not-an-array" });
    assert.equal(malformed.status, 400);
    assert.equal(runtime.memory.curatedItems().length, 0);

    const duplicate = await post({ content: "fact", replaceIds: ["same", "same"] });
    assert.equal(duplicate.status, 400);
    assert.equal(runtime.memory.curatedItems().length, 0);

    const stale = await post({ content: "fact", replaceIds: ["missing"] });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "MEMORY_REPLACEMENT_CONFLICT");
    assert.equal(runtime.memory.curatedItems().length, 0);

    const overCap = await post({ content: "x".repeat(100) });
    assert.equal(overCap.status, 409);
    assert.equal((await overCap.json()).code, "MEMORY_CAPACITY_EXCEEDED");
    assert.equal(runtime.memory.curatedItems().length, 0);
  } finally {
    await app.close();
  }
});
