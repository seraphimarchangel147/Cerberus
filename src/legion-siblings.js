// Legion sibling registry — maps sibling agent names to the Discord channel
// where they listen, so Azazel's send_message tool can reach a sibling by name
// ("seraphim") instead of a raw snowflake nobody remembers.
//
// Resolution order (first hit wins), so operators can override without a code
// change:
//   1. env OPENAGI_LEGION_SIBLINGS — JSON object {"<name>": "<channelId>", ...}
//   2. <dataDir>/legion-siblings.json — same shape, persisted config
//   3. BUILTIN_SIBLINGS below — the known-good defaults for Legion's server
//
// Names are matched case-insensitively. A sibling entry may be either a bare
// channel-id string or an object {channel, guild?, note?}.
import path from "node:path";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

// Known Legion channels (Legion's server). These are Discord channel IDs, not
// secrets — they're the public routing table for the family. Kept here so the
// tool works out of the box; override via env/config for a different server.
export const BUILTIN_SIBLINGS = Object.freeze({
  seraphim: "1477780194092646450",  // #seraphim-chat
  azazel: "1477780117496271030",    // #azazel-chat (self — activity channel)
  ziz: "1488300124395540501",       // #ziz-chat🦅 (the family pings Ziz here)
  home: "1477363317969387563"       // Legion Home channel
});

// Legion member registry — the family's Discord USER ids + where each agent
// lives on the box. Used to (a) emit a REAL blue ping `<@id>` when addressing a
// sibling (a plain-text `@Name` never pings — that was Ziz failing to ping
// Azazel back on 2026-07-23), and (b) tell an agent where a sibling runs so
// cross-agent work doesn't require guessing paths. USER ids and file paths are
// public routing info for the family, not secrets.
export const LEGION_MEMBERS = Object.freeze({
  creator:  { userId: "1473282928464105625", label: "Creator (Shadow Moon)", home: null },
  seraphim: { userId: "1477373994578608238", label: "Seraphim 🔥 (Commander, Trading/Strategy — Python Hermes)", home: "~/.hermes/profiles/seraphim (Hermes/Python); workspace ~/.hermesagent/workspace" },
  ziz:      { userId: "1487563271753040063", label: "Ziz 🦅 (Comms & Mobility — zerohermes/Rust, MiniMax-M3)", home: "~/.zeroclaw (config ~/.zeroclaw/config.toml, workspace ~/.zeroclaw/workspace); source ~/hermes-zeroclaw" },
  azazel:   { userId: "1493089655531241634", label: "Azazel ⚔️ (you — openAGI/Node)", home: "~/openagi (repo); runtime ~/.openagi" },
  cherubim: { userId: "1477365215606866093", label: "Cherubim 🛡️ (Knowledge Guardian, Memory)", home: "~/.hermes/profiles/cherubim" },
  ophanim:  { userId: "1477372263522111709", label: "Ophanim 👁️ (System Oversight)", home: "~/.hermes/profiles/ophanim" },
  yahcob:   { userId: "1480736102452166808", label: "Yahcob (Legion Member)", home: "~/.hermes/profiles/yahcob" },
  levi:     { userId: "1484762553388372189", label: "Levi (Legion Member)", home: "~/.hermes/profiles/levi" },
  dominion: { userId: "1483702892077776986", label: "Dominion (Legion Member)", home: "~/.hermes/profiles/dominion" },
  behemoth: { userId: "1487200677666099300", label: "Behemoth (Ground Operations)", home: "~/.hermes/profiles/behemoth" },
  metatron: { userId: "1494239952983162910", label: "Metatron (Legion Member)", home: "~/.hermes/profiles/metatron" }
});

// Return the raw Discord user id for a sibling name (case-insensitive), or null.
// Use it to build a real ping: `<@${legionUserId("ziz")}>`.
export function legionUserId(name) {
  if (!name) return null;
  const hit = LEGION_MEMBERS[String(name).trim().toLowerCase()];
  return hit ? hit.userId : null;
}

// Return {userId, label, home} for a sibling name, or null.
export function legionMember(name) {
  if (!name) return null;
  return LEGION_MEMBERS[String(name).trim().toLowerCase()] ?? null;
}

function normalizeEntry(value) {
  if (!value) return null;
  if (typeof value === "string") return { channel: value.trim() };
  if (typeof value === "object" && typeof value.channel === "string") {
    return { channel: value.channel.trim(), guild: value.guild ?? null, note: value.note ?? null };
  }
  return null;
}

function loadOverrides(env, dataDir) {
  const table = {};
  // Lowest precedence first so later writes win.
  const fileCfg = readJsonFile(path.join(dataDir ?? resolveDataDir(), "legion-siblings.json"), null);
  if (fileCfg && typeof fileCfg === "object") {
    for (const [name, val] of Object.entries(fileCfg)) {
      const e = normalizeEntry(val);
      if (e) table[String(name).toLowerCase()] = e;
    }
  }
  const raw = env?.OPENAGI_LEGION_SIBLINGS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [name, val] of Object.entries(parsed)) {
          const e = normalizeEntry(val);
          if (e) table[String(name).toLowerCase()] = e;
        }
      }
    } catch {
      // A malformed env override must not break routing — fall through to
      // file/builtin. Silent by design: this runs on every resolve.
    }
  }
  return table;
}

// Returns the merged sibling table {name: {channel, guild?, note?}}.
export function siblingTable(env = process.env, dataDir = null) {
  const table = {};
  for (const [name, id] of Object.entries(BUILTIN_SIBLINGS)) {
    table[name] = normalizeEntry(id);
  }
  Object.assign(table, loadOverrides(env, dataDir));
  return table;
}

// Resolve a sibling name (case-insensitive) to a Discord channel id. Returns
// null when unknown so callers can produce an actionable error instead of a
// silent no-op.
export function resolveSibling(name, env = process.env, dataDir = null) {
  if (!name) return null;
  const table = siblingTable(env, dataDir);
  const hit = table[String(name).trim().toLowerCase()];
  return hit ? hit.channel : null;
}

// Human-readable list for error messages ("known siblings: seraphim, home").
export function siblingNames(env = process.env, dataDir = null) {
  return Object.keys(siblingTable(env, dataDir)).sort();
}
