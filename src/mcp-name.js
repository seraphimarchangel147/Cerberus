import path from "node:path";
import fs from "node:fs";

// MCP names are both user-facing labels and filename components for OAuth
// caches and transport logs. Keep readable ASCII labels (including the
// existing "BB Staging" form), but exclude separators, controls, encoded
// traversal punctuation, and non-ASCII lookalikes.
const SAFE_MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export function assertSafeMcpServerName(value) {
  if (
    typeof value !== "string"
    || !SAFE_MCP_SERVER_NAME.test(value)
    || /[ .]$/.test(value)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
    || value === "."
    || value === ".."
  ) {
    // Do not echo attacker-controlled path text into an HTTP/model-visible
    // diagnostic.
    throw new TypeError("Invalid MCP server name.");
  }
  return value;
}

export function mcpNamedFilePath(directory, name, suffix) {
  const safeName = assertSafeMcpServerName(name);
  const base = path.resolve(directory);
  try {
    if (fs.lstatSync(base).isSymbolicLink()) {
      throw new TypeError("MCP path base must not be a symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const target = path.resolve(base, `${safeName}${suffix}`);
  if (path.dirname(target) !== base) {
    throw new TypeError("Invalid MCP server name.");
  }
  return target;
}
