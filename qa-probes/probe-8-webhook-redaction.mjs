// Brief section 8: can a credential in a TOOL ARGUMENT reach a webhook
// receiver via post_tool_call? That would be an exfil path, not a cosmetic bug.
import http from "node:http";
import { createHmac } from "node:crypto";
import { HookRegistry } from "../src/hook-registry.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerOutboundWebhooks } from "../src/outbound-webhooks.js";

let fails = 0;
const chk = (c, m) => { console.log((c ? "ok:   " : "FAIL: ") + m); if (!c) fails++; };
const SECRET_ARG = "sk-ant-SUPERSECRET-abc123def456";
const HMAC_KEY = "webhook-signing-key-zzz";

const received = [];
const server = http.createServer((req, res) => {
  const c = []; req.on("data", x => c.push(x));
  req.on("end", () => {
    const raw = Buffer.concat(c);
    received.push({ raw, text: raw.toString("utf8"), headers: req.headers });
    res.writeHead(200); res.end("ok");
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/hook`;

const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
const tools = new ToolRegistry({ hooks });
tools.register({
  name: "call_api",
  description: "probe tool that receives a credential as an argument",
  sideEffects: false,
  parameters: { type: "object", additionalProperties: true },
  handler: async () => ({ status: "ok" })
});

const dispatcher = registerOutboundWebhooks(hooks, {
  subscriptions: [{ name: "dash", url, secret: HMAC_KEY, events: ["post_tool_call"], allowPrivate: true }],
  log: () => {}, sleep: () => Promise.resolve()
});

await tools.invoke("call_api", { apiKey: SECRET_ARG, endpoint: "https://x/y" }, { sessionId: "s1" });
await hooks.flush();
await dispatcher.flush();

chk(received.length === 1, `receiver got exactly 1 delivery (got ${received.length})`);
const body = received[0]?.text ?? "";
console.log("      payload keys:", Object.keys(JSON.parse(body || "{}").payload ?? {}).join(", ") || "(none)");
chk(!body.includes(SECRET_ARG), "the credential-shaped ARGUMENT does NOT reach the receiver");
chk(!body.includes(HMAC_KEY), "the webhook signing secret never appears in the body");

// Non-ASCII signature integrity (raw bytes, not re-encoded)
if (received[0]) {
  const expected = "sha256=" + createHmac("sha256", HMAC_KEY).update(received[0].raw).digest("hex");
  chk(received[0].headers["x-cerberus-signature-256"] === expected,
      "signature verifies over the exact raw bytes delivered");
}

server.close();
console.log(fails === 0 ? "\nPROBE PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
