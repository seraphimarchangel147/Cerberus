// Inline IDE lane for OpenAGI (Azazel) — "hashline-lite".
// Inspired by oh-my-pi's hashline editing + the zerohermes code_intel lane:
//   * code_read / code_search mint a full SHA-256 content tag per file
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { isCredentialEnvName, redactKnownValues } from "./redact.js";
import {
  addInternalCredentialFileRedactions,
  addSecretRedactionSpellings
} from "./credential-redaction.js";
import {
  createLspClient,
  filterNewDiagnostics,
  formatLspDiagnostics
} from "./lsp-client.js";
import { writeTextAtomic } from "./file-utils.js";
import {
  CODE_VERIFIER_LIMITS,
  createIsolatedCodeVerifier
} from "./coder-verifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

const MAX_READ_LINES = 400;
const MAX_SEARCH_RESULTS = 60;
const MAX_OUTPUT = 12000;
// A store value under a non-credential name is only treated as a redaction
// needle at or above this length. Short configuration values ("1", "3", "off")
// would otherwise mask ordinary digits and words throughout child-process
// stdout, destroying diagnostic output; anything this long under an unexpected
// name is still masked so a misnamed credential cannot leak.
const MIN_UNNAMED_SECRET_REDACTION_LENGTH = 12;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);

// ── tags ─────────────────────────────────────────────────────────────
export function mintTag(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

// ── path guard ───────────────────────────────────────────────────────
export function allowedRoots(dataDir = resolveDataDir(), explicitRoots = null) {
  if (Array.isArray(explicitRoots)) {
    return [...new Set(explicitRoots.map((root) => path.resolve(String(root))))];
  }
  return [...new Set([
    REPO_ROOT,
    path.resolve(dataDir),
    path.resolve("/tmp"),
    path.resolve(os.tmpdir())
  ])];
}

export function resolveSafe(p, {
  dataDir = resolveDataDir(),
  roots = null
} = {}) {
  const abs = path.resolve(String(p ?? ""));
  // Lexical containment first (cheap), then REAL containment: resolve
  // symlinks on the nearest existing ancestor so a link inside an allowed
  // root can't smuggle reads/writes outside it (Tier-1 hardening, 2026-07).
  const effectiveRoots = allowedRoots(dataDir, roots);
  const inRoots = (candidate) => effectiveRoots.some(
    (root) => candidate === root || candidate.startsWith(root + path.sep)
  );
  if (!inRoots(abs)) return { abs, ok: false };
  const realAbs = resolveRealCandidate(abs);
  if (!realAbs) return { abs, ok: false };
  const realRoots = effectiveRoots.map((r) => {
    try { return fs.realpathSync(r); } catch { return r; }
  });
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
    const stamp = nowIso();
    // Same-day dedupe guard: refuse an identical entry (same file + action +
    // summary) already recorded today. Kills double-appends from retried
    // edits without blocking legitimate same-day entries for other files.
    const today = stamp.slice(0, 10);
    const signature = `${action} \`${rel}\`${summary ? ` — ${String(summary).slice(0, 160)}` : ""}`;
    try {
      const tail = fs.readFileSync(changesPath, "utf8").split("\n").slice(-40);
      for (const line of tail) {
        if (line.includes(today) && line.includes(signature)) return false;
      }
    } catch { /* unreadable changelog — append anyway */ }
    const entry = `\n- ${stamp} · **azazel** · ${action} \`${rel}\`${summary ? ` — ${String(summary).slice(0, 160)}` : ""}`;
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
  // A verifier may itself run under `node --test`. Forwarding this private
  // marker makes a nested test process skip its targets as a recursive run,
  // which can turn an unexecuted check into a false pass.
  delete env.NODE_TEST_CONTEXT;
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

function buildShellEnvironment(runtime, {
  command,
  decidedBy,
  allowedSecretRefs = ["*"]
}) {
  const secretStore = runtime?.secrets ?? runtime?.secretStore ?? null;
  if (!secretStore) return { env: undefined, redactValues: new Set() };

  const { configuredNames, managedNames } = secretNameSets(secretStore, { decidedBy });
  const grantedNames = new Set(
    Array.isArray(allowedSecretRefs)
      ? allowedSecretRefs.map((name) => String(name))
      : []
  );
  const referencedNames = [...shellEnvReferences(command)]
    .filter((name) => (
      configuredNames.has(name)
      && (grantedNames.has("*") || grantedNames.has(name))
    ));

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
  // Only credential-shaped names become redaction needles. The store also owns
  // ordinary configuration (OPENAGI_AUTO_APPROVE=1, OPENAGI_CHECKPOINTS=3,
  // ANTHROPIC_MODEL), and treating a value such as "1" or "3" as a secret makes
  // every digit in stdout a needle - masking commit hashes, counts, ages and
  // lease ids in exactly the diagnostic output you are reading when debugging.
  // buildTestExecution already applies this filter for the same reason.
  // Values under a non-credential name are still redacted when they are long
  // enough to be secret-shaped, so a misnamed credential cannot leak.
  const redactValues = new Set();
  for (const [name, value] of Object.entries(configuredEnv)) {
    if (
      !isCredentialEnvName(name)
      && String(value ?? "").length < MIN_UNNAMED_SECRET_REDACTION_LENGTH
    ) {
      continue;
    }
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

function buildTestExecution(runtime, { decidedBy, projectScoped = false }) {
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
      scrubCredentialShaped: Boolean(secretStore) || projectScoped
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
async function captureLspBaseline(lspClient, filePath) {
  try {
    const diagnostics = await lspClient?.getDiagnostics?.(filePath);
    return {
      ok: Array.isArray(diagnostics),
      diagnostics: Array.isArray(diagnostics) ? diagnostics : []
    };
  } catch {
    return { ok: false, diagnostics: [] };
  }
}

function codeExecutionScope(context, safetyOptions) {
  const projectId = String(context?.__projectId ?? "default").trim() || "default";
  const configuredWorkspace = String(context?.__projectWorkspaceDir ?? "").trim();
  const workspaceDir = configuredWorkspace
    ? path.resolve(configuredWorkspace)
    : REPO_ROOT;
  const projectScoped = projectId !== "default";
  return {
    projectId,
    projectScoped,
    workspaceDir,
    safetyOptions: projectScoped
      ? { ...safetyOptions, roots: [workspaceDir] }
      : safetyOptions
  };
}

function assertProjectShellBoundary(context) {
  const projectId = String(context?.__projectId ?? "default").trim() || "default";
  if (projectId === "default") return;
  throw new Error(
    `code_shell is unavailable in isolated project '${projectId}' because a working directory is not a filesystem sandbox.`
  );
}

function resolveWorkspaceOperand(operand, workspaceDir, safetyOptions) {
  const candidate = path.isAbsolute(String(operand ?? ""))
    ? String(operand)
    : path.join(workspaceDir, String(operand ?? ""));
  return mustResolve(candidate, safetyOptions);
}

function codePathJobResources(args, context, safetyOptions) {
  const scope = codeExecutionScope(context, safetyOptions);
  const abs = resolveWorkspaceOperand(
    args?.path,
    scope.workspaceDir,
    scope.safetyOptions
  );
  const resolved = resolveSafe(abs, scope.safetyOptions);
  if (!resolved.ok || resolved.sensitive) {
    throw new Error(`Unsafe durable job path: ${abs}`);
  }
  const identity = process.platform === "win32"
    ? String(resolved.realAbs ?? abs).toLowerCase()
    : String(resolved.realAbs ?? abs);
  const digest = createHash("sha256").update(identity).digest("hex");
  return [`workspace/file/${digest}`];
}

function revalidateBeforeFsOperation(abs, safetyOptions, callback, operation) {
  if (typeof callback === "function") {
    const result = callback({ path: abs, operation });
    if (result && typeof result.then === "function") {
      throw new TypeError("beforeFsOperation must be synchronous.");
    }
  }
  const verified = mustResolve(abs, safetyOptions);
  if (verified !== abs) throw new Error(`Unsafe path changed before ${operation}.`);
  return verified;
}

async function collectNewLspDiagnostics(lspClient, filePath, baseline, syntaxClean) {
  if (!syntaxClean || !baseline.ok) return null;
  try {
    const diagnostics = await lspClient?.getDiagnostics?.(filePath);
    if (!Array.isArray(diagnostics)) return null;
    const introduced = filterNewDiagnostics(diagnostics, baseline.diagnostics);
    return introduced.length > 0
      ? formatLspDiagnostics(filePath, introduced)
      : null;
  } catch {
    return null;
  }
}

function readTextFileState(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        content: null,
        tag: null,
        mode: 0o644
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Atomic code mutation refuses a symbolic-link target: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Code mutation requires a regular file target: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf8");
  return {
    exists: true,
    content,
    tag: mintTag(content),
    mode: stat.mode & 0o777
  };
}

function assertUnchangedTextState(filePath, expected, observed) {
  if (expected.exists !== observed.exists) {
    throw new Error(
      `Stale write: ${filePath} ${expected.exists ? "was removed" : "was created"} before commit. ` +
      "Re-read the target and retry."
    );
  }
  if (expected.exists && expected.tag !== observed.tag) {
    throw new Error(
      `Stale write: file is now #${observed.tag}, expected #${expected.tag}. ` +
      "Re-read the file and retry."
    );
  }
}

function commitAtomicText(filePath, content, expectedState, atomicWriter) {
  const observed = readTextFileState(filePath);
  assertUnchangedTextState(filePath, expectedState, observed);
  atomicWriter(filePath, content, observed.exists ? observed.mode : expectedState.mode);
  const committed = readTextFileState(filePath);
  const intendedTag = mintTag(content);
  if (!committed.exists || committed.tag !== intendedTag) {
    throw new Error(`Atomic write verification failed for ${filePath}.`);
  }
  return committed;
}

async function validateCandidateSyntax(content, filePath) {
  if (!filePath.endsWith(".js") && !filePath.endsWith(".mjs")) return null;
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-code-candidate-"));
  const candidatePath = path.join(candidateDir, "candidate.mjs");
  try {
    writeTextAtomic(candidatePath, content, 0o600);
    const result = await run(process.execPath, ["--check", candidatePath]);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout || "syntax error").trim();
      throw new Error(
        `Syntax validation failed for ${filePath}; no file was changed. ${detail}`.slice(0, MAX_OUTPUT)
      );
    }
    return "ok";
  } finally {
    try {
      fs.rmSync(candidateDir, { recursive: true, force: true });
    } catch {
      // The private candidate contains no committed state; temp cleanup is best effort.
    }
  }
}

export function registerCodeTools(registry, runtime, options = {}) {
  const safetyOptions = {
    dataDir: runtime?.secrets?.dataDir
      ?? runtime?.secretStore?.dataDir
      ?? runtime?.dataDir
      ?? resolveDataDir()
  };
  const lspClient = options.lspClient
    ?? runtime?.lspClient
    ?? createLspClient({ dataDir: safetyOptions.dataDir });
  const atomicWriter = options.writeTextAtomic ?? writeTextAtomic;
  const codeVerifier = options.codeVerifier
    ?? runtime?.codeVerifier
    ?? createIsolatedCodeVerifier();
  registry.register({
    name: "code_read",
    description: "Read a file with line numbers. Returns a full SHA-256 content tag required by code_edit and by code_write when overwriting an existing file. Re-read after any edit to get the fresh tag.",
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
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const abs = resolveWorkspaceOperand(
        args.path,
        scope.workspaceDir,
        scope.safetyOptions
      );
      revalidateBeforeFsOperation(
        abs,
        scope.safetyOptions,
        options.beforeFsOperation,
        "read"
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
    description: "Regex search across files (like ripgrep). Returns matches with line numbers plus each matching file's full SHA-256 tag for compare-and-swap edits.",
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
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const dir = args.dir
        ? resolveWorkspaceOperand(args.dir, scope.workspaceDir, scope.safetyOptions)
        : scope.workspaceDir;
      const re = new RegExp(args.pattern, args.ignoreCase ? "i" : undefined);
      const files = [];
      walk(dir, files, 0, scope.safetyOptions);
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
            results.push({
              file: path.relative(scope.workspaceDir, f),
              line: i + 1,
              text: lines[i].slice(0, 200)
            });
            if (!tags[f]) tags[f] = mintTag(content);
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }
        }
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
      return {
        matches: results,
        truncated: results.length >= MAX_SEARCH_RESULTS,
        tags: Object.fromEntries(
          Object.entries(tags).map(([f, t]) => [path.relative(scope.workspaceDir, f), t])
        )
      };
    }
  });

  registry.register({
    name: "code_edit",
    description: "Transactional line-anchored file edit. Provide the file's full SHA-256 tag from your latest code_read/code_search. The candidate is syntax-checked before an atomic compare-and-swap commit; stale content leaves the file untouched. Each edit replaces lines start..end (inclusive, 1-based) with new text. Edits are applied bottom-up so line numbers all refer to the version you read. To insert without deleting, set end = start-1.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        tag: {
          type: "string",
          pattern: "^[a-fA-F0-9]{64}$",
          description: "Full SHA-256 tag from code_read/code_search."
        },
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
    jobResources: (args, context) => codePathJobResources(
      args,
      context,
      safetyOptions
    ),
    jobResourceRevision: "code-path-v1",
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const abs = resolveWorkspaceOperand(
        args.path,
        scope.workspaceDir,
        scope.safetyOptions
      );
      revalidateBeforeFsOperation(
        abs,
        scope.safetyOptions,
        options.beforeFsOperation,
        "edit-read"
      );
      const initialState = readTextFileState(abs);
      if (!initialState.exists) throw new Error(`Cannot edit a missing file: ${abs}`);
      const content = initialState.content;
      const liveTag = initialState.tag;
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
      const lspBaseline = await captureLspBaseline(lspClient, abs);
      const lint = await validateCandidateSyntax(next, abs);
      revalidateBeforeFsOperation(
        abs,
        scope.safetyOptions,
        options.beforeFsOperation,
        "edit-write"
      );
      const committed = commitAtomicText(abs, next, initialState, atomicWriter);
      const newTag = committed.tag;
      const lspDiagnostics = await collectNewLspDiagnostics(
        lspClient,
        abs,
        lspBaseline,
        lint === null || lint === "ok"
      );
      appendChangelog("edit", abs, args.summary);
      return {
        path: abs,
        tag: newTag,
        previousTag: initialState.tag,
        atomic: true,
        totalLines: lines.length,
        lint,
        lsp_diagnostics: lspDiagnostics
      };
    }
  });

  registry.register({
    name: "code_write",
    description: "Transactionally create or replace a whole file inside the current project workspace. New files require no expectedTag. Existing files require the full SHA-256 expectedTag from code_read/code_search; blind or stale overwrites are rejected. JavaScript candidates are syntax-checked before an atomic commit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedTag: {
          type: "string",
          pattern: "^[a-fA-F0-9]{64}$",
          description: "Required full SHA-256 tag when the target already exists."
        },
        summary: { type: "string", description: "One-line changelog summary." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    summarize: (args) => `Write ${args.path} (${String(args.content ?? "").length} chars)`,
    jobResources: (args, context) => codePathJobResources(
      args,
      context,
      safetyOptions
    ),
    jobResourceRevision: "code-path-v1",
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const abs = resolveWorkspaceOperand(
        args.path,
        scope.workspaceDir,
        scope.safetyOptions
      );
      const ghost = scanGhosts(args.content);
      if (ghost) throw new Error(`Rejected: suspicious character ${ghost.codePoint} at line ${ghost.line} (homoglyph/zero-width).`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const initialState = readTextFileState(abs);
      const existed = initialState.exists;
      if (existed && !args.expectedTag) {
        throw new Error(
          `Blind overwrite rejected for ${abs}. Read the file and retry with expectedTag #${initialState.tag}.`
        );
      }
      if (existed && initialState.tag !== String(args.expectedTag).toLowerCase()) {
        throw new Error(
          `Stale write: file is now #${initialState.tag}, you provided #${args.expectedTag}. ` +
          "Re-read the file and retry."
        );
      }
      const lspBaseline = await captureLspBaseline(lspClient, abs);
      const lint = await validateCandidateSyntax(args.content, abs);
      revalidateBeforeFsOperation(
        abs,
        scope.safetyOptions,
        options.beforeFsOperation,
        "write"
      );
      const committed = commitAtomicText(abs, args.content, initialState, atomicWriter);
      const lspDiagnostics = await collectNewLspDiagnostics(
        lspClient,
        abs,
        lspBaseline,
        lint === null || lint === "ok"
      );
      appendChangelog(existed ? "rewrite" : "create", abs, args.summary);
      return {
        path: abs,
        tag: committed.tag,
        previousTag: initialState.tag,
        atomic: true,
        created: !existed,
        lint,
        lsp_diagnostics: lspDiagnostics
      };
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
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const target = resolveWorkspaceOperand(
        args.path ?? "src",
        scope.workspaceDir,
        scope.safetyOptions
      );
      const files = [];
      if (fs.statSync(target).isDirectory()) {
        walk(target, files, 0, scope.safetyOptions);
      }
      else files.push(target);
      const jsFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
      const failures = [];
      for (const f of jsFiles) {
        const r = await run(process.execPath, ["--check", f]);
        if (!r.ok) {
          failures.push({
            file: path.relative(scope.workspaceDir, f),
            error: r.stderr.slice(0, 400)
          });
        }
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
      const scope = codeExecutionScope(context, safetyOptions);
      const testArgs = scope.projectScoped
        ? [
            "--permission",
            `--allow-fs-read=${scope.workspaceDir}`,
            "--test-isolation=none",
            "--test"
          ]
        : ["--test"];
      if (args.file) {
        const absoluteFile = resolveWorkspaceOperand(
          args.file,
          scope.workspaceDir,
          scope.safetyOptions
        );
        // Node's permission model cannot resolve an ABSOLUTE test-file spec:
        // `node --permission --allow-fs-read=<dir> --test <dir>/x.test.js`
        // reports "Could not find '<dir>/x.test.js'" even when the directory
        // is readable. The same run succeeds with a workspace-relative spec,
        // and the child already runs with cwd = scope.workspaceDir. Resolve
        // and validate absolutely (so traversal is still rejected), then hand
        // the runner the relative form.
        testArgs.push(scope.projectScoped
          ? path.relative(scope.workspaceDir, absoluteFile) || "."
          : absoluteFile);
      }
      const runTest = options.runTest ?? run;
      const execution = buildTestExecution(runtime, {
        decidedBy: decisionActor(context, "tool:code_test"),
        projectScoped: scope.projectScoped
      });
      const runOptions = {
        cwd: scope.workspaceDir,
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
    name: "code_verify",
    description: "Run 1-16 syntax and targeted test checks in isolated, no-shell Node subprocesses with a scrubbed secret environment, bounded output, and cancellation. Use this as the final evidence gate after code edits.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          minItems: 1,
          maxItems: CODE_VERIFIER_LIMITS.maxChecks,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                pattern: "^[a-z][a-z0-9_-]{0,63}$",
                description: "Optional stable ASCII identity for evidence mapping."
              },
              type: { type: "string", enum: ["syntax", "test"] },
              path: { type: "string", description: "Workspace-relative file or directory. Required for syntax; optional for a full test run." },
              timeoutMs: {
                type: "integer",
                minimum: 1,
                maximum: CODE_VERIFIER_LIMITS.maxTimeoutMs
              }
            },
            required: ["type"],
            additionalProperties: false
          }
        }
      },
      required: ["checks"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const scope = codeExecutionScope(context, safetyOptions);
      const execution = buildTestExecution(runtime, {
        decidedBy: decisionActor(context, "tool:code_verify"),
        projectScoped: scope.projectScoped
      });
      return codeVerifier.verify({
        workspaceDir: scope.workspaceDir,
        checks: args.checks,
        signal: context?.__abortSignal,
        env: execution.env,
        redactValues: execution.redactValues,
        projectScoped: scope.projectScoped
      });
    }
  });

  registry.register({
    name: "code_shell",
    description: "Run a shell command in the current project workspace. THIS REQUIRES USER APPROVAL because arbitrary commands are dangerous. Prefer the specific code_* tools when they cover the need. Commands must be non-interactive; use flags like `git --no-pager` to avoid pagers. When you start background work, capture its PID or process group and use that exact identifier to stop it later. Never use broad command-line matching such as `pkill -f` or `killall` - the pattern can match this agent's own supervising process and terminate the harness mid-task.",
    needsConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run via bash -lc." },
        cwd: { type: "string", description: "Working directory (default project workspace)." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 }
      },
      required: ["command"],
      additionalProperties: false
    },
    summarize: (args) => `shell: ${String(args.command).slice(0, 120)}`,
    preflight: (_args, context) => assertProjectShellBoundary(context),
    handler: async (args, context) => {
      assertProjectShellBoundary(context);
      const scope = codeExecutionScope(context, safetyOptions);
      const cwd = args.cwd
        ? resolveWorkspaceOperand(args.cwd, scope.workspaceDir, scope.safetyOptions)
        : scope.workspaceDir;
      const { env, redactValues } = buildShellEnvironment(runtime, {
        command: args.command,
        decidedBy: decisionActor(context, "tool:code_shell"),
        allowedSecretRefs: context?.__projectSecretRefs ?? ["*"]
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
