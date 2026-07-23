// Inline IDE lane for OpenAGI (Azazel) — "hashline-lite".
// Inspired by oh-my-pi's hashline editing + the zerohermes code_intel lane:
//   * code_read / code_search mint a 4-hex content-hash TAG per file
//   * code_edit applies LINE-anchored range edits, but only if the caller's
//     tag still matches the live file — stale anchors are REJECTED before
//     they can corrupt code (no string-match "not found" loops, no blind writes)
//   * code_lint (node --check), code_test (node --test), code_shell (approval-gated)
// Security:
//   * writes restricted to ALLOWED ROOTS (repo, data dir, /tmp)
//   * homoglyph guard: rejects Cyrillic/Greek lookalikes, zero-width and
//     fullwidth chars in code writes (the `h`→`mcp` ghost bit us before)
//   * code_shell + code_write outside the repo require approval (needsConfirmation)
// Every successful edit/write inside the repo auto-appends CHANGES.md.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { isCredentialEnvName, redactKnownValues } from "./redact.js";
import {
  addInternalCredentialFileRedactions,
  addSecretRedactionSpellings
} from "./credential-redaction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

const MAX_READ_LINES = 400;
const MAX_SEARCH_RESULTS = 60;
const MAX_OUTPUT = 12000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);

// ── tags ─────────────────────────────────────────────────────────────
export function mintTag(content) {
  return createHash("sha256").update(String(content).replace(/\r\n/g, "\n")).digest("hex").slice(0, 4);
}

// ── path guard ───────────────────────────────────────────────────────
export function allowedRoots(dataDir = resolveDataDir()) {
  return [REPO_ROOT, path.resolve(dataDir), "/tmp"];
}

export function resolveSafe(p, { dataDir = resolveDataDir() } = {}) {
  const abs = path.resolve(String(p ?? ""));
  // Lexical containment first (cheap), then REAL containment: resolve
  // symlinks on the nearest existing ancestor so a link inside an allowed
  // root can't smuggle reads/writes outside it (Tier-1 hardening, 2026-07).
  const roots = allowedRoots(dataDir);
  const inRoots = (candidate) => roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
  if (!inRoots(abs)) return { abs, ok: false };
  const realAbs = resolveRealCandidate(abs);
  if (!realAbs) return { abs, ok: false };
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  const okReal = realRoots.some((root) => realAbs === root || realAbs.startsWith(root + path.sep));
  const sensitive = okReal && isSensitiveCodePath(abs, { dataDir, realPath: realAbs });
  return { abs, realAbs, ok: okReal && !sensitive, sensitive };
}

// Uniform gate — every code_* handler goes through this instead of
// destructuring { abs } and silently dropping `ok` (the old bug: code_read /
// code_search / code_lint / code_test skipped the check that edit/write did).
export function mustResolve(p, options = {}) {
  const { abs, ok, sensitive } = resolveSafe(p, options);
  if (sensitive) throw new Error(`Sensitive credential path is not available to code tools: ${abs}`);
  if (!ok) throw new Error(`Path outside allowed roots: ${abs}`);
  return abs;
}

export function isSensitiveCodePath(candidate, {
  dataDir = resolveDataDir(),
  realPath = null
} = {}) {
  const abs = path.resolve(String(candidate ?? ""));
  const realAbs = realPath ?? resolveRealCandidate(abs) ?? abs;
  if (isSensitiveEnvFile(abs) || isSensitiveEnvFile(realAbs)) return true;

  const dataRoot = path.resolve(dataDir);
  const realDataRoot = resolveRealCandidate(dataRoot) ?? dataRoot;
  const sensitiveRoots = [
    path.join(dataRoot, "secrets"),
    path.join(dataRoot, "mcp", "auth"),
    path.join(dataRoot, "checkpoints"),
    path.join(realDataRoot, "secrets"),
    path.join(realDataRoot, "mcp", "auth"),
    path.join(realDataRoot, "checkpoints")
  ];
  if (sensitiveRoots.some((root) => isPathWithin(abs, root) || isPathWithin(realAbs, root))) {
    return true;
  }
  const sensitiveFiles = [
    path.join(dataRoot, "node.json"),
    path.join(dataRoot, "mcp.json"),
    path.join(dataRoot, "nodes", "cache.json"),
    path.join(realDataRoot, "node.json"),
    path.join(realDataRoot, "mcp.json"),
    path.join(realDataRoot, "nodes", "cache.json")
  ];
  return sensitiveFiles.some(
    (file) => abs === path.resolve(file) || realAbs === path.resolve(file)
  );
}

function resolveRealCandidate(abs) {
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { return null; }
  const tail = path.relative(probe, abs);
  return path.resolve(real, tail);
}

function isPathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSensitiveEnvFile(candidate) {
  const name = path.basename(candidate).toLowerCase();
  return name !== ".env.example" && name.startsWith(".env");
}

// ── homoglyph / ghost-byte guard ─────────────────────────────────────
// Targeted ranges (not all non-ASCII — legit em-dashes in comments are fine):
// Cyrillic, Greek, zero-width, fullwidth forms.
const GHOST_RE = /[\u0400-\u04FF\u0370-\u03FF\u200B-\u200F\u2060\uFEFF\uFF00-\uFFEF]/;
export function scanGhosts(content) {
  const m = GHOST_RE.exec(String(content));
  if (!m) return null;
  const idx = m.index;
  const line = String(content).slice(0, idx).split("\n").length;
  return { char: m[0], codePoint: "U+" + m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0"), line };
}

// ── changelog ────────────────────────────────────────────────────────
export function appendChangelog(action, filePath, summary, root = REPO_ROOT) {
  try {
    const rel = path.relative(root, filePath);
    if (rel.startsWith("..")) return false; // outside the repo — not harness surface
    const changesPath = path.join(root, "CHANGES.md");
    const entry = `\n- ${nowIso()} · **azazel** · ${action} \`${rel}\`${summary ? ` — ${String(summary).slice(0, 160)}` : ""}`;
    fs.appendFileSync(changesPath, entry, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ── helpers ──────────────────────────────────────────────────────────
function numberLines(text, offset = 1) {
  return text.split("\n").map((l, i) => `${offset + i}:${l}`).join("\n");
}

function walk(dir, out, depth = 0, safetyOptions = {}) {
  if (depth > 8 || out.length > 4000) return;
  if (!resolveSafe(dir, safetyOptions).ok) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (!resolveSafe(full, safetyOptions).ok) continue;
    if (e.isDirectory()) walk(full, out, depth + 1, safetyOptions);
    else out.push(full);
  }
}

function run(cmd, args, { cwd, timeoutMs = 120000, env, redactValues } = {}) {
  return new Promise((resolve) => {
    const execOptions = { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 };
    // Omit `env` entirely for ordinary code tools so Node preserves its
    // existing inherit-from-parent behavior. Only code_test opts into a
    // scrubbed child environment below.
    if (env !== undefined) execOptions.env = env;
    execFile(cmd, args, execOptions, (error, stdout, stderr) => {
      const safeStdout = redactKnownValues(String(stdout ?? ""), redactValues);
      const safeStderr = redactKnownValues(String(stderr ?? ""), redactValues);
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: safeStdout.slice(0, MAX_OUTPUT),
        stderr: safeStderr.slice(0, MAX_OUTPUT)
      });
    });
  });
}

export function scrubTestEnvironment(source = process.env, {
  secretStore = null,
  decidedBy = "tool:code_test",
  managedNames = null,
  scrubCredentialShaped = Boolean(secretStore)
} = {}) {
  const env = { ...source };
  const channelKeys = new Set([
    "DISCORD_BOT_TOKEN",
    "DISCORD_ACTIVITY_CHANNEL",
    "DISCORD_ALLOW_FROM",
    "DISCORD_GUILDS",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET"
  ]);
  for (const key of Object.keys(env)) {
    if (channelKeys.has(key) || key.endsWith("_WEBHOOK_SECRET")) delete env[key];
  }
  const namesToScrub = managedNames
    ?? secretNameSets(secretStore, { decidedBy }).managedNames;
  for (const name of namesToScrub) delete env[name];
  if (scrubCredentialShaped) {
    for (const name of Object.keys(env)) {
      if (isCredentialEnvName(name)) delete env[name];
    }
  }
  // Test-mode channel construction is the second line of defense if a new
  // credential-bearing variable is added later and omitted from this scrub.
  env.OPENAGI_TEST = "1";
  return env;
}

function secretNameSets(secretStore, { decidedBy }) {
  if (!secretStore) {
    return { configuredNames: new Set(), managedNames: new Set() };
  }
  let listed;
  try {
    listed = typeof secretStore.listSecretNames === "function"
      ? secretStore.listSecretNames({ decidedBy: `${decidedBy}:list` })
      : secretStore.listSecrets?.({ decidedBy: `${decidedBy}:list` })
          ?.map((entry) => entry?.name);
  } catch {
    throw new Error("Secret store unavailable for execution.");
  }
  if (!listed || listed && typeof listed.then === "function") {
    throw new TypeError("Secret store list operations must be synchronous");
  }
  let allowed;
  try {
    allowed = typeof secretStore.listAllowedNames === "function"
      ? secretStore.listAllowedNames()
      : secretStore.allowlist instanceof Set
        ? [...secretStore.allowlist]
        : [];
  } catch {
    throw new Error("Secret store unavailable for execution.");
  }
  if (allowed && typeof allowed.then === "function") {
    throw new TypeError("Secret store policy operations must be synchronous");
  }
  const configuredNames = new Set(listed.map((name) => String(name ?? "")).filter(Boolean));
  const managedNames = new Set([
    ...configuredNames,
    ...(allowed ?? []).map((name) => String(name ?? "")).filter(Boolean)
  ]);
  return { configuredNames, managedNames };
}

function exportConfiguredSecrets(secretStore, configuredNames, { decidedBy }) {
  const names = [...configuredNames];
  if (!secretStore || names.length === 0) return {};
  let secretEnv;
  try {
    if (typeof secretStore.exportEnv === "function") {
      secretEnv = secretStore.exportEnv({ names, decidedBy });
    } else if (typeof secretStore.getSecret === "function") {
      secretEnv = Object.fromEntries(
        names.map((name) => [name, secretStore.getSecret(name, { decidedBy })])
      );
    } else {
      throw new TypeError("Secret store must implement exportEnv() or getSecret()");
    }
  } catch {
    throw new Error("Secret store unavailable for execution.");
  }
  if (secretEnv && typeof secretEnv.then === "function") {
    throw new TypeError("Secret store access operations must be synchronous");
  }
  if (!secretEnv || typeof secretEnv !== "object" || Array.isArray(secretEnv)) {
    throw new TypeError("Secret store exportEnv() must return an object");
  }
  const filtered = {};
  for (const name of names) {
    if (!Object.hasOwn(secretEnv, name) || secretEnv[name] === null || secretEnv[name] === undefined) {
      throw new Error(`Secret value unavailable for execution: ${name}`);
    }
    filtered[name] = secretEnv[name];
  }
  return filtered;
}

function buildShellEnvironment(runtime, { command, decidedBy }) {
  const secretStore = runtime?.secrets ?? runtime?.secretStore ?? null;
  if (!secretStore) return { env: undefined, redactValues: new Set() };

  const { configuredNames, managedNames } = secretNameSets(secretStore, { decidedBy });
  const referencedNames = [...shellEnvReferences(command)]
    .filter((name) => configuredNames.has(name));

  // Fetch every configured value for boundary redaction. Only the explicitly
  // referenced subset is injected below; the broader read prevents a command
  // such as `cat .../secrets/secrets.json` from reflecting an unreferenced
  // value through stdout or stderr.
  const configuredEnv = exportConfiguredSecrets(
    secretStore,
    configuredNames,
    { decidedBy }
  );

  const env = { ...process.env };
  for (const name of managedNames) delete env[name];
  for (const name of Object.keys(env)) {
    if (isCredentialEnvName(name)) delete env[name];
  }
  const redactValues = new Set();
  for (const value of Object.values(configuredEnv)) {
    addSecretRedactionSpellings(redactValues, value);
  }
  addParentCredentialRedactions(redactValues, process.env);
  addInternalCredentialFileRedactions(redactValues, runtimeCredentialDataDir(runtime));
  for (const name of referencedNames) {
    const value = configuredEnv[name];
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new TypeError(`Invalid secret environment name: ${name}`);
    }
    if (value === null || value === undefined) continue;
    env[name] = String(value);
  }
  return { env, redactValues };
}

function buildTestExecution(runtime, { decidedBy }) {
  const secretStore = runtime?.secrets ?? runtime?.secretStore ?? null;
  const { configuredNames, managedNames } = secretNameSets(secretStore, { decidedBy });
  // The store also owns ordinary configuration (for example model names and
  // OPENAGI_AUTO_APPROVE). Scrub every managed name from the child, but only
  // fetch credential-shaped values for parent-side output redaction. Treating
  // an ordinary value such as "1" as a secret would corrupt TAP "# pass 1".
  const credentialNames = new Set(
    [...configuredNames].filter((name) => isCredentialEnvName(name))
  );
  const secretEnv = exportConfiguredSecrets(secretStore, credentialNames, { decidedBy });
  const redactValues = new Set();
  for (const value of Object.values(secretEnv)) {
    addSecretRedactionSpellings(redactValues, value);
  }
  if (secretStore) {
    addParentCredentialRedactions(redactValues, process.env);
    addInternalCredentialFileRedactions(redactValues, runtimeCredentialDataDir(runtime));
  }
  return {
    env: scrubTestEnvironment(process.env, {
      managedNames,
      scrubCredentialShaped: Boolean(secretStore)
    }),
    redactValues
  };
}

function addParentCredentialRedactions(redactValues, source) {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (!isCredentialEnvName(name)) continue;
    addSecretRedactionSpellings(redactValues, value);
  }
}

function runtimeCredentialDataDir(runtime) {
  return runtime?.secrets?.dataDir
    ?? runtime?.secretStore?.dataDir
    ?? runtime?.dataDir
    ?? resolveDataDir();
}

function shellEnvReferences(command) {
  const names = new Set();
  const matcher = /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g;
  let match;
  while ((match = matcher.exec(String(command ?? ""))) !== null) {
    names.add(match[1] ?? match[2]);
  }
  return names;
}

function decisionActor(context, fallback) {
  return context?.__approval?.decidedBy
    ?? context?.__approval?.decider
    ?? context?.from
    ?? context?.userId
    ?? fallback;
}

// ── registration ─────────────────────────────────────────────────────
export function registerCodeTools(registry, runtime, options = {}) {
  const safetyOptions = {
    dataDir: runtime?.secrets?.dataDir
      ?? runtime?.secretStore?.dataDir
      ?? runtime?.dataDir
      ?? resolveDataDir()
  };
  registry.register({
    name: "code_read",
    description: "Read a file with line numbers. Returns a 4-hex content tag — REQUIRED by code_edit to prove you saw the current version. Re-read after any edit to get the fresh tag.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or repo-relative)." },
        offset: { type: "integer", minimum: 1, description: "First line to read (1-based). Default 1." },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES, description: `Max lines (default ${MAX_READ_LINES}).` }
      },
      required: ["path"],
      additionalProperties: false
    },
    handler: async (args) => {
      const abs = mustResolve(
        path.isAbsolute(args.path) ? args.path : path.join(REPO_ROOT, args.path),
        safetyOptions
      );
      const content = fs.readFileSync(abs, "utf8");
      const tag = mintTag(content);
      const lines = content.split("\n");
      const offset = Math.max(1, args.offset ?? 1);
      const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return {
        path: abs,
        tag,
        totalLines: lines.length,
        offset,
        content: numberLines(slice.join("\n"), offset)
      };
    }
  });

  registry.register({
    name: "code_search",
    description: "Regex search across files (like ripgrep). Returns matches with line numbers plus each matching file's current 4-hex tag (usable by code_edit).",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS regex source, e.g. 'registerCoreTools\\\\(' " },
        dir: { type: "string", description: "Directory to search. Default: repo root." },
        glob: { type: "string", description: "Filename suffix filter, e.g. '.js'." },
        ignoreCase: { type: "boolean" }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    handler: async (args) => {
      const dir = args.dir
        ? mustResolve(
            path.isAbsolute(args.dir) ? args.dir : path.join(REPO_ROOT, args.dir),
            safetyOptions
          )
        : REPO_ROOT;
      const re = new RegExp(args.pattern, args.ignoreCase ? "i" : undefined);
      const files = [];
      walk(dir, files, 0, safetyOptions);
      const results = [];
      const tags = {};
      for (const f of files) {
        if (args.glob && !f.endsWith(args.glob)) continue;
        let content;
        try { content = fs.readFileSync(f, "utf8"); } catch { continue; }
        if (content.includes("\u0000")) continue; // binary
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            results.push({ file: path.relative(REPO_ROOT, f), line: i + 1, text: lines[i].slice(0, 200) });
            if (!tags[f]) tags[f] = mintTag(content);
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }
        }
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
      return {
        matches: results,
        truncated: results.length >= MAX_SEARCH_RESULTS,
        tags: Object.fromEntries(Object.entries(tags).map(([f, t]) => [path.relative(REPO_ROOT, f), t]))
      };
    }
  });

  registry.register({
    name: "code_edit",
    description: "Line-anchored file edit (hashline-lite). Provide the file's 4-hex tag from your latest code_read/code_search — if the file changed since, the edit is REJECTED (stale anchor) and you must re-read. Each edit replaces lines start..end (inclusive, 1-based) with new text. Edits are applied bottom-up so line numbers all refer to the version you read. To insert without deleting, set end = start-1.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        tag: { type: "string", description: "4-hex tag from code_read/code_search." },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              start: { type: "integer", minimum: 1 },
              end: { type: "integer", minimum: 0 },
              replace: { type: "string", description: "Replacement text (may be multi-line, or empty to delete)." }
            },
            required: ["start", "end", "replace"],
            additionalProperties: false
          }
        },
        summary: { type: "string", description: "One-line changelog summary of the edit." }
      },
      required: ["path", "tag", "edits"],
      additionalProperties: false
    },
    summarize: (args) => `Edit ${args.path} (${args.edits?.length ?? 0} hunk${(args.edits?.length ?? 0) === 1 ? "" : "s"})`,
    handler: async (args) => {
      const abs = mustResolve(
        path.isAbsolute(args.path) ? args.path : path.join(REPO_ROOT, args.path),
        safetyOptions
      );
      const content = fs.readFileSync(abs, "utf8");
      const liveTag = mintTag(content);
      if (liveTag !== String(args.tag).toLowerCase()) {
        throw new Error(`Stale anchor: file is now #${liveTag}, you provided #${args.tag}. Re-read the file and retry with fresh line numbers.`);
      }
      for (const e of args.edits) {
        const ghost = scanGhosts(e.replace);
        if (ghost) throw new Error(`Rejected: suspicious character ${ghost.codePoint} (homoglyph/zero-width) in replacement text.`);
      }
      const lines = content.split("\n");
      // bottom-up so earlier line numbers stay valid
      const sorted = [...args.edits].sort((a, b) => b.start - a.start);
      let prevStart = Infinity;
      for (const e of sorted) {
        if (e.end >= prevStart) throw new Error(`Overlapping edits (lines ${e.start}-${e.end} vs edit starting at ${prevStart}).`);
        if (e.end !== e.start - 1 && (e.start > lines.length || e.end > lines.length)) {
          throw new Error(`Edit range ${e.start}-${e.end} beyond end of file (${lines.length} lines).`);
        }
        const replacement = e.replace === "" ? [] : e.replace.split("\n");
        lines.splice(e.start - 1, Math.max(0, e.end - e.start + 1), ...replacement);
        prevStart = e.start;
      }
      const next = lines.join("\n");
      fs.writeFileSync(abs, next, "utf8");
      const newTag = mintTag(next);
      let lint = null;
      if (abs.endsWith(".js") || abs.endsWith(".mjs")) {
        const r = await run(process.execPath, ["--check", abs]);
        lint = r.ok ? "ok" : (r.stderr || "syntax error");
      }
      appendChangelog("edit", abs, args.summary);
      return { path: abs, tag: newTag, totalLines: lines.length, lint };
    }
  });

  registry.register({
    name: "code_write",
    description: "Create or overwrite a whole file inside the repo/data/tmp roots. For existing files prefer code_edit (anchored, safer). Runs the homoglyph guard and node --check on .js files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        summary: { type: "string", description: "One-line changelog summary." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    summarize: (args) => `Write ${args.path} (${String(args.content ?? "").length} chars)`,
    handler: async (args) => {
      const abs = mustResolve(
        path.isAbsolute(args.path) ? args.path : path.join(REPO_ROOT, args.path),
        safetyOptions
      );
      const ghost = scanGhosts(args.content);
      if (ghost) throw new Error(`Rejected: suspicious character ${ghost.codePoint} at line ${ghost.line} (homoglyph/zero-width).`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      fs.writeFileSync(abs, args.content, "utf8");
      let lint = null;
      if (abs.endsWith(".js") || abs.endsWith(".mjs")) {
        const r = await run(process.execPath, ["--check", abs]);
        lint = r.ok ? "ok" : (r.stderr || "syntax error");
      }
      appendChangelog(existed ? "rewrite" : "create", abs, args.summary);
      return { path: abs, tag: mintTag(args.content), created: !existed, lint };
    }
  });

  registry.register({
    name: "code_lint",
    description: "Syntax-check JS files with node --check. Pass a file or a directory (checks every .js under it, skipping node_modules).",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File or directory. Default: src/" } },
      additionalProperties: false
    },
    handler: async (args) => {
      const target = mustResolve(
        path.isAbsolute(args.path ?? "") ? args.path : path.join(REPO_ROOT, args.path ?? "src"),
        safetyOptions
      );
      const files = [];
      if (fs.statSync(target).isDirectory()) walk(target, files, 0, safetyOptions);
      else files.push(target);
      const jsFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
      const failures = [];
      for (const f of jsFiles) {
        const r = await run(process.execPath, ["--check", f]);
        if (!r.ok) failures.push({ file: path.relative(REPO_ROOT, f), error: r.stderr.slice(0, 400) });
      }
      return { checked: jsFiles.length, ok: failures.length === 0, failures };
    }
  });

  registry.register({
    name: "code_test",
    description: "Run the repo's node --test suite (optionally a single test file). Returns pass/fail summary and tail of output.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { file: { type: "string", description: "Optional single test file, e.g. 'test/tool-registry-cap.test.js'." } },
      additionalProperties: false
    },
    handler: async (args, context) => {
      const testArgs = ["--test"];
      if (args.file) {
        testArgs.push(mustResolve(
          path.isAbsolute(args.file) ? args.file : path.join(REPO_ROOT, args.file),
          safetyOptions
        ));
      }
      const runTest = options.runTest ?? run;
      const execution = buildTestExecution(runtime, {
        decidedBy: decisionActor(context, "tool:code_test")
      });
      const runOptions = {
        cwd: REPO_ROOT,
        timeoutMs: 300000,
        env: execution.env
      };
      if (!options.runTest) runOptions.redactValues = execution.redactValues;
      const r = await runTest(process.execPath, testArgs, runOptions);
      // Parse structural TAP fields before redacting the display text. A
      // credential can be the string "1", "0", or "true"; it must never
      // replace the result's typed pass/fail/ok fields.
      const rawOut = `${String(r.stdout ?? "")}\n${String(r.stderr ?? "")}`;
      const pass = /# pass (\d+)/.exec(rawOut)?.[1] ?? null;
      const fail = /# fail (\d+)/.exec(rawOut)?.[1] ?? null;
      const stdout = redactKnownValues(String(r.stdout ?? ""), execution.redactValues);
      const stderr = redactKnownValues(String(r.stderr ?? ""), execution.redactValues);
      const out = `${stdout}\n${stderr}`;
      return {
        ok: Boolean(r.ok),
        pass: pass != null ? Number(pass) : null,
        fail: fail != null ? Number(fail) : null,
        tail: out.slice(-2500)
      };
    }
  });

  registry.register({
    name: "code_shell",
    description: "Run a shell command in the repo (git, grep, npm, etc). THIS REQUIRES USER APPROVAL — arbitrary commands are dangerous. Prefer the specific code_* tools when they cover the need.",
    needsConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run via bash -lc." },
        cwd: { type: "string", description: "Working directory (default repo root)." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 }
      },
      required: ["command"],
      additionalProperties: false
    },
    summarize: (args) => `shell: ${String(args.command).slice(0, 120)}`,
    handler: async (args, context) => {
      const cwd = args.cwd ? mustResolve(args.cwd, safetyOptions) : REPO_ROOT;
      const { env, redactValues } = buildShellEnvironment(runtime, {
        command: args.command,
        decidedBy: decisionActor(context, "tool:code_shell")
      });
      const runShell = options.runShell ?? run;
      let result;
      try {
        const runnerOptions = {
          cwd,
          timeoutMs: (args.timeoutSeconds ?? 120) * 1000,
          ...(env === undefined ? {} : { env })
        };
        if (!options.runShell) runnerOptions.redactValues = redactValues;
        result = await runShell("bash", ["-lc", args.command], runnerOptions);
      } catch (error) {
        throw new Error(redactKnownValues(String(error?.message ?? error), redactValues));
      }
      return {
        exitCode: redactKnownValues(result?.code ?? 0, redactValues),
        stdout: redactKnownValues(
          String(result?.stdout ?? ""),
          redactValues
        ).slice(-6000),
        stderr: redactKnownValues(
          String(result?.stderr ?? ""),
          redactValues
        ).slice(-4000)
      };
    }
  });

}
