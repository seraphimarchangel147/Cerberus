import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SYNTAX_FILES = 500;
const SAFE_SOURCE_PATH = /^(?:src|bin|scripts|examples)\/[A-Za-z0-9._/-]+\.(?:cjs|js|mjs)$/;

function boundedError(error) {
  return String(error?.stderr ?? error?.message ?? error ?? "update rehearsal failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function candidateSyntaxPaths(changedFiles) {
  const requested = String(changedFiles ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => SAFE_SOURCE_PATH.test(value) && !value.includes(".."));
  const unique = [...new Set(requested)].slice(0, MAX_SYNTAX_FILES);
  return unique.length > 0
    ? unique
    : ["src/abi-runtime.js", "src/model-provider.js", "src/boot.js"];
}

async function command(file, args, options = {}) {
  return execFileAsync(file, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 2 * 1024 * 1024,
    cwd: options.cwd
  });
}

/**
 * Rehearse an update in a detached git worktree before the live checkout moves.
 * The candidate is always removed. A failed cleanup is reported separately and
 * still fails the rehearsal closed: abandoned update state is not activation.
 */
export async function rehearseUpdateCandidate({
  repoRoot,
  upstream,
  changedFiles = "",
  depsChanged = false,
  runCommand = command
} = {}) {
  const root = path.resolve(String(repoRoot ?? "."));
  const target = String(upstream ?? "").trim();
  if (!target) return { ok: false, stage: "admission", error: "missing upstream revision" };

  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-update-candidate-"));
  let worktreeAdded = false;
  let stage = "worktree";
  let result;
  try {
    await runCommand("git", ["worktree", "add", "--detach", candidateDir, target], {
      cwd: root,
      timeout: 120_000
    });
    worktreeAdded = true;

    if (depsChanged) {
      stage = "dependencies";
      await runCommand(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
        { cwd: candidateDir, timeout: 300_000 }
      );
    }

    stage = "syntax";
    const checked = [];
    for (const relative of candidateSyntaxPaths(changedFiles)) {
      const absolute = path.join(candidateDir, relative);
      if (!fs.existsSync(absolute)) continue;
      await runCommand(process.execPath, ["--check", relative], {
        cwd: candidateDir,
        timeout: 30_000
      });
      checked.push(relative);
    }
    if (checked.length === 0) {
      throw new Error("candidate contained none of the expected runtime entry points");
    }

    stage = "identity";
    const identity = await runCommand("git", ["rev-parse", "--short", "HEAD"], {
      cwd: candidateDir,
      timeout: 30_000
    });
    result = {
      ok: true,
      stage: "complete",
      candidateRevision: String(identity?.stdout ?? "").trim() || target,
      depsChecked: depsChanged,
      syntaxChecked: checked
    };
  } catch (error) {
    result = { ok: false, stage, error: boundedError(error) };
  }

  let cleanupError = null;
  try {
    if (worktreeAdded) {
      await runCommand("git", ["worktree", "remove", "--force", candidateDir], {
        cwd: root,
        timeout: 120_000
      });
    }
  } catch (error) {
    cleanupError = boundedError(error);
  }
  try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch (error) {
    cleanupError ??= boundedError(error);
  }
  if (cleanupError) {
    return { ...result, ok: false, stage: "cleanup", cleanupError };
  }
  return result;
}

export const UPDATE_REHEARSAL_LIMITS = Object.freeze({
  maxSyntaxFiles: MAX_SYNTAX_FILES
});
