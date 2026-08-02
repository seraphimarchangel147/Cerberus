import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Static asset serving for the Cerberus pet sprite atlases.
 *
 * The pet renderer used to carry its artwork as ~600KB of base64 data URLs
 * embedded directly in the served HTML. That is ~33% larger than the binary,
 * cannot be cached by the browser, and is re-parsed on every page load. These
 * atlases are instead served as real files with strong ETags.
 *
 * Only a fixed allow-list of filenames is served — the path from the URL is
 * never joined onto the base directory, so there is no traversal surface.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.resolve(HERE, "..", "cerberus", "sprites", "runtime");

export const ASSET_PREFIX = "/assets/cerberus/";

/** filename -> content type. Anything not listed here is a 404. */
const ALLOWED = new Map([
  ["omega_atlas.png", "image/png"],
  ["alpha_atlas.png", "image/png"],
  ["atlas.json", "application/json; charset=utf-8"]
]);

/** Lazily-populated cache: name -> { body, etag, type } */
const cache = new Map();

function load(name) {
  const hit = cache.get(name);
  if (hit) return hit;
  const type = ALLOWED.get(name);
  if (!type) return null;
  const file = path.join(ASSET_ROOT, name);
  let body;
  try {
    body = fsSync.readFileSync(file);
  } catch {
    return null;
  }
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  const entry = { body, etag, type };
  cache.set(name, entry);
  return entry;
}

/** Test/ops hook: drop the in-process cache so a rebuilt atlas is picked up. */
export function clearAssetCache() {
  cache.clear();
}

/** True when `pathname` addresses this asset namespace at all. */
export function isCerberusAsset(pathname) {
  return typeof pathname === "string" && pathname.startsWith(ASSET_PREFIX);
}

/**
 * Serve a Cerberus asset. Returns true when the response was handled.
 *
 * Caller is responsible for the auth gate: these assets sit behind the same
 * gate as the dashboard page that references them, so they inherit its
 * protection rather than opening a new anonymous surface.
 */
export function serveCerberusAsset(req, res, pathname) {
  if (!isCerberusAsset(pathname)) return false;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }
  // Take only the final segment and require it to be an exact allow-list
  // match. No path.join with untrusted input, so "../" can never escape.
  const name = pathname.slice(ASSET_PREFIX.length);
  const entry = ALLOWED.has(name) ? load(name) : null;
  if (!entry) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return true;
  }
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, { etag: entry.etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "content-type": entry.type,
    "content-length": entry.body.length,
    etag: entry.etag,
    // Content-addressed by ETag; the build script rewrites the file whenever
    // the art changes, so a long max-age with revalidation is safe.
    "cache-control": "public, max-age=3600, must-revalidate",
    "x-content-type-options": "nosniff"
  });
  res.end(method === "HEAD" ? undefined : entry.body);
  return true;
}
