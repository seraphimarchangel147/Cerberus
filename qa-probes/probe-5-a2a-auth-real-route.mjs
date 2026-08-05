// Probe 5 (brief section 5): A2A auth on the REAL hosted-interface route.
// Stands up createHostedInterface with a real A2AServer and drives real HTTP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const TOKEN = "a2a-probe-token-9f2c";
const LAN_IP = process.argv[2]; // non-loopback address of this box
let failures = 0;
const fail = (m) => { failures += 1; console.log("FAIL:", m); };
const ok = (m) => console.log("ok:", m);

const RPC = (token) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} })
});

async function statusOf(base, route, options = {}) {
  const res = await fetch(`${base}${route}`, options);
  const text = await res.text();
  return { status: res.status, text };
}

async function makeApp({ a2a, host }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-probe-"));
  process.env.OPENAGI_AUTH_TOKEN = TOKEN;
  if (a2a) process.env.OPENAGI_A2A_ENABLED = "1";
  else delete process.env.OPENAGI_A2A_ENABLED;
  const runtime = createDurableRuntime({
    dataDir,
    autoConnectMcp: false,
    observations: {},
    sessionIndexOptions: { fallback: true }
  });
  runtime.agentHost = { handleMessage: async () => ({ reply: "probe-ok" }) };
  const app = createHostedInterface(runtime, { host, port: 0, tickerMs: 0, dataDir, authToken: TOKEN });
  const listened = await app.listen();
  return { app, port: listened.port };
}

// --- Scenario A: A2A disabled -> both routes 404 -------------------------
{
  const { app, port } = await makeApp({ a2a: false, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${port}`;
  const card = await statusOf(base, "/.well-known/agent-card.json");
  const rpc = await statusOf(base, "/a2a", RPC(TOKEN));
  if (card.status === 404 && rpc.status === 404) ok("A: disabled -> card and /a2a both 404");
  else fail(`A: disabled should 404 both routes (card=${card.status}, rpc=${rpc.status})`);
  await app.close();
}

// --- Scenario B: enabled, loopback client --------------------------------
{
  const { app, port } = await makeApp({ a2a: true, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${port}`;
  const card = await statusOf(base, "/.well-known/agent-card.json");
  if (card.status === 200) ok("B: card is 200 with NO token (public by contract)");
  else fail(`B: card should be public, got ${card.status}`);
  if (card.status === 200 && card.text.includes(TOKEN)) fail("B: card leaks the auth token");

  const noTok = await statusOf(base, "/a2a", RPC(null));
  const wrongTok = await statusOf(base, "/a2a", RPC("wrong-token"));
  const rightTok = await statusOf(base, "/a2a", RPC(TOKEN));
  console.log(`B: /a2a over loopback -> no-token=${noTok.status}, wrong-token=${wrongTok.status}, right-token=${rightTok.status}`);
  console.log(`B: no-token body: ${noTok.text.slice(0, 120)}`);
  await app.close();
}

// --- Scenario C: enabled + remote allowed, NON-loopback client -----------
if (LAN_IP) {
  process.env.OPENAGI_A2A_ALLOW_REMOTE = "1";
  const { app, port } = await makeApp({ a2a: true, host: "0.0.0.0" });
  const base = `http://${LAN_IP}:${port}`;
  const card = await statusOf(base, "/.well-known/agent-card.json");
  const noTok = await statusOf(base, "/a2a", RPC(null));
  const wrongTok = await statusOf(base, "/a2a", RPC("wrong-token"));
  const rightTok = await statusOf(base, "/a2a", RPC(TOKEN));
  console.log(`C: remote -> card=${card.status}, no-token=${noTok.status}, wrong-token=${wrongTok.status}, right-token=${rightTok.status}`);
  if (card.status === 200) ok("C: card public from remote peer");
  else fail(`C: card should be public even for remote peers, got ${card.status}`);
  if (noTok.status === 401) ok("C: /a2a rejects missing token (remote)");
  else fail(`C: /a2a accepted MISSING token from remote: ${noTok.status} ${noTok.text.slice(0, 100)}`);
  if (wrongTok.status === 401) ok("C: /a2a rejects wrong token (remote)");
  else fail(`C: /a2a accepted WRONG token from remote: ${wrongTok.status}`);
  if (rightTok.status === 200) ok("C: /a2a accepts right token (remote)");
  else fail(`C: /a2a rejected the RIGHT token from remote: ${rightTok.status} ${rightTok.text.slice(0, 100)}`);
  await app.close();
  delete process.env.OPENAGI_A2A_ALLOW_REMOTE;

  // And the default (no ALLOW_REMOTE): remote peer must not even fingerprint.
  const { app: app2, port: port2 } = await makeApp({ a2a: true, host: "0.0.0.0" });
  const base2 = `http://${LAN_IP}:${port2}`;
  const noTok2 = await statusOf(base2, "/a2a", RPC(null));
  const rightTok2 = await statusOf(base2, "/a2a", RPC(TOKEN));
  console.log(`C2: remote, no ALLOW_REMOTE -> no-token=${noTok2.status}, right-token=${rightTok2.status}`);
  if (noTok2.status === 404 && rightTok2.status === 404) ok("C2: without ALLOW_REMOTE, remote peers get 404 even with the right token");
  else fail(`C2: expected 404/404 for remote without ALLOW_REMOTE, got ${noTok2.status}/${rightTok2.status}`);
  await app2.close();
}

console.log(failures === 0 ? "PROBE PASS" : `PROBE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
