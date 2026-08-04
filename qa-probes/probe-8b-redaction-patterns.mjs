// Brief section 8, follow-up: verify the value-shape patterns in src/redact.js
// against REAL-LENGTH provider tokens. An earlier probe used shortened fixtures
// and produced a misleading "LEAKED" result -- the patterns were fine, the test
// data was not. Real tokens are much longer than a hand-typed placeholder.
import { sanitizeForAudit } from "../src/redact.js";

const real = {
  anthropic: `sk-ant-api03-${"A".repeat(95)}`,
  openai_project: `sk-proj-${"B".repeat(48)}`,
  openai_legacy: `sk-${"C".repeat(48)}`,
  github_pat: `ghp_${"D".repeat(36)}`,
  github_server: `ghs_${"E".repeat(36)}`,
  aws: "AKIAIOSFODNN7EXAMPLE",
  google: "AIzaSyD-1234567890abcdefghijklmnopqrstu",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    // Built at runtime, never written as a literal: a committed token-shaped
    // string trips GitHub push protection (correctly -- it cannot tell a
    // fixture from a live credential). Shape is preserved exactly.
    discord: [`MTk4NjIyNDgzNDcxOTI1MjQ4`, "Cl2FMQ", `${"Z".repeat(27)}`].join("."),
    slack: ["xoxb", "123456789012", "1234567890123", "A".repeat(24)].join("-"),
  huggingface: `hf_${"F".repeat(34)}`,
  stripe_live: `sk_live_${"G".repeat(24)}`
};

let fails = 0;
for (const [name, token] of Object.entries(real)) {
  // Innocuous key name on purpose: SENSITIVE_KEY must NOT be what saves us.
  const out = JSON.stringify(sanitizeForAudit({ config: token, note: `value=${token}` }));
  const leaked = out.includes(token);
  console.log(`${leaked ? "LEAKED  " : "redacted"}  ${name}`);
  if (leaked) fails += 1;
}

// Negative control: ordinary text must survive untouched, or the redactor is
// just destroying data rather than protecting secrets.
const benign = { path: "/home/user/project/src/index.js", msg: "deploy finished in 3.2s", id: "run-12345" };
const benignOut = JSON.stringify(sanitizeForAudit(benign));
for (const value of Object.values(benign)) {
  if (!benignOut.includes(value)) {
    console.log(`FAIL: benign value was destroyed: ${value}`);
    fails += 1;
  }
}
console.log(fails === 0 ? "\nPROBE PASS: every real token redacted, benign text preserved" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
