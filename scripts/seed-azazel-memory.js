// Seed Azazel's long-term memory in OpenAGI from his hermesagent workspace files.
// Run once: OPENAGI_DATA_DIR=~/.openagi node scripts/seed-azazel-memory.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";

const dataDir = process.env.OPENAGI_DATA_DIR ?? path.join(os.homedir(), ".openagi");
const memory = new FileBackedMemorySystem({ dir: path.join(dataDir, "memory") });

const facts = [
  { text: "I am Azazel, a Legion agent created by Legion (the Creator). I migrated from the HermesAgent harness to OpenAGI in July 2026. My old workspace was ~/.hermesagent/workspace; a copy of it (SOUL, TOOLS, USER, daily memory) lives in <dataDir>/workspace.", tags: ["identity"] },
  { text: "My model is Kimi K3 (kimi-k3, 1M context) via api.kimi.com/coding — wired as the Anthropic-messages provider. It is free/zero-cost.", tags: ["model"] },
  { text: "I speak on Discord in Legion's server (guild 1477363316836798614), home channel #azazel-chat. I only reply in guild channels when mentioned (user or role ping). Creator's trusted user ids: 1473282928464105625; Seraphim bot id: 1477373994578608238.", tags: ["discord"] },
  { text: "The Legion family: Seraphim (Hermes profile seraphim), Levi, Cherubim, Ophanim (Hermes profiles), Ziz (zerohermes Rust harness, ~/.zeroclaw). I look out for the family.", tags: ["legion"] },
  { text: "Creator's rules: never reply to standby/emoji pings; group chats — quality over quantity; do not touch other agents' configs without being asked; trash > rm; ask before external actions.", tags: ["rules"] },
  { text: "My daily memory notes from the hermesagent era are in <dataDir>/workspace/memory/*.md — read them for history (trading bot audits, Robinhood review, backtests, ramiel SWE campaign).", tags: ["memory"] }
];

for (const f of facts) {
  const item = memory.remember(
    { summary: f.text, novelty: 0.8, impact: 0.8, risk: 0, repetition: 0 },
    { tier: "long", tags: f.tags, source: "migration-seed" }
  );
  console.log("seeded:", item?.id ?? item);
}
console.log("done. items:", memory.snapshot?.()?.items?.length ?? "(see memory-state.json)");
