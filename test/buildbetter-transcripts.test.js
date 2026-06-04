// test/buildbetter-transcripts.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";

function fakeObservations() {
  const rows = [];
  return {
    record: async (o) => { rows.push(o); return { count: 1 }; },
    search: async () => rows,
    existsRef: async (ref) => rows.some((o) => o.ref === ref),
    _rows: rows
  };
}

test("syncTranscripts records one transcript per call and dedupes", async () => {
  const observations = fakeObservations();
  const src = new BuildBetterTaskSource({
    apiKey: "k", userEmail: "me@x.com",
    runtime: { observations }
  });
  // Stub the two network calls.
  src.getRecentCalls = async () => [{ id: 7, name: "Acme Discovery", started_at: "2026-06-01T10:00:00Z" }];
  src.getTranscript = async (callId) => `Transcript for ${callId}: ship it by Friday.`;

  const first = await src.syncTranscripts({ now: new Date("2026-06-02T00:00:00Z") });
  assert.equal(first.created, 1);
  assert.equal(observations._rows[0].kind, "transcript");
  assert.equal(observations._rows[0].ref, "buildbetter:call:7");

  // Second run: same call already recorded -> no new row.
  const second = await src.syncTranscripts({ now: new Date("2026-06-02T00:05:00Z") });
  assert.equal(second.created, 0);
});

test("ingestMode defaults to signals", () => {
  const prev = process.env.BUILDBETTER_INGEST_MODE;
  delete process.env.BUILDBETTER_INGEST_MODE;
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  assert.equal(src.ingestMode, "signals");
  if (prev !== undefined) process.env.BUILDBETTER_INGEST_MODE = prev;
});
