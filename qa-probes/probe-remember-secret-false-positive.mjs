// Reproduce the remember() failure Azazel hit during Wave 4 QA.
//
// assertSafeMemoryContent scans memory text for any CONFIGURED SECRET VALUE.
// The secrets store also holds ordinary configuration (OPENAGI_AUTO_APPROVE=1,
// OPENAGI_CHECKPOINTS=3), so treating every stored value as a secret needle
// makes the digit "1" a secret -- and any memory containing it is rejected as
// MEMORY_SECRET_CONTENT. That is why remember() failed on plain English text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretsStore } from "../src/secrets-store.js";
import { assertSafeMemoryContent } from "../src/memory-intake-policy.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-secret-"));
const secrets = new SecretsStore({
  dataDir,
  allowlist: ["OPENAGI_AUTO_APPROVE", "OPENAGI_CHECKPOINTS", "ANTHROPIC_API_KEY"]
});
// Ordinary config values -- NOT credentials.
secrets.setSecret("OPENAGI_AUTO_APPROVE", "1", { decidedBy: "probe" });
secrets.setSecret("OPENAGI_CHECKPOINTS", "3", { decidedBy: "probe" });
// A genuine credential, which MUST still be caught.
const realKey = `sk-ant-api03-${"A".repeat(95)}`;
secrets.setSecret("ANTHROPIC_API_KEY", realKey, { decidedBy: "probe" });
secrets.redactionSnapshot?.();

const runtime = { secrets };
const cases = [
  ["benign text containing the digit 1", "Wave 4 shipped 1 auth fix and 3 harness fixes.", "ACCEPT"],
  ["benign text, no digits", "The read-only ceiling is enforced at the registry.", "ACCEPT"],
  ["a REAL configured credential", `the key is ${realKey}`, "REJECT"]
];

let fails = 0;
for (const [label, text, want] of cases) {
  let got = "ACCEPT";
  let code = "";
  try {
    assertSafeMemoryContent(text, { runtime });
  } catch (error) {
    got = "REJECT";
    code = error?.code ?? error?.message ?? "?";
  }
  const ok = got === want;
  if (!ok) fails += 1;
  console.log(`${ok ? "ok:   " : "FAIL: "}${got.padEnd(6)} (want ${want.padEnd(6)}) ${label}${code ? ` [${code}]` : ""}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fails === 0
  ? "\nPROBE PASS: config values are not secrets; real credentials still blocked"
  : `\n${fails} FAILED -- ordinary memory text is being rejected as a secret leak`);
process.exit(fails === 0 ? 0 : 1);
