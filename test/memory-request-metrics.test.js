import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeMemoryRequestMetrics,
  incrementMemoryRequestMetric,
  initializeMemoryRequestMetrics,
  peekMemoryRequestMetrics,
  setMemoryBytesInjected
} from "../src/memory-request-metrics.js";

test("memory request counters retain injected bytes and consume event deltas", () => {
  const context = {};
  initializeMemoryRequestMetrics(context, { memoryBytesInjected: 4096 });
  incrementMemoryRequestMetric(context, "spillCount", 2);
  incrementMemoryRequestMetric(context, "mergesRequested", 3);
  incrementMemoryRequestMetric(context, "mergesCompleted");

  assert.deepEqual(consumeMemoryRequestMetrics(context), {
    memoryBytesInjected: 4096,
    spillCount: 2,
    mergesRequested: 3,
    mergesCompleted: 1
  });
  assert.deepEqual(peekMemoryRequestMetrics(context), {
    memoryBytesInjected: 4096,
    spillCount: 0,
    mergesRequested: 0,
    mergesCompleted: 0
  });

  setMemoryBytesInjected(context, 512);
  assert.equal(consumeMemoryRequestMetrics(context).memoryBytesInjected, 512);
});

test("memory request counters reject unknown names and bound invalid input", () => {
  const context = {};
  initializeMemoryRequestMetrics(context, { memoryBytesInjected: -1 });
  incrementMemoryRequestMetric(context, "spillCount", Number.POSITIVE_INFINITY);
  assert.equal(peekMemoryRequestMetrics(context).memoryBytesInjected, 0);
  assert.equal(peekMemoryRequestMetrics(context).spillCount, 0);
  assert.throws(
    () => incrementMemoryRequestMetric(context, "unknownCounter"),
    /Unknown memory request counter/u
  );
});
