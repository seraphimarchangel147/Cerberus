import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boot provenance: report WHICH code is actually running.
 *
 * Motivation (a real incident, 2026-08-11): a fix was committed, pushed to
 * origin/main, and the daemon restarted — but the daemon's checkout was on a
 * feature branch that did not contain the commit, so the restart deployed
 * nothing while the report said "live". `git log` on origin/main looked
 * perfect; the running process was unaffected.
 *
 * One line at boot makes that class of mistake self-evident:
 *
 *   [boot] sha=3a61554 branch=feat/new-artwork dirty=6 contains_origin_main=no
 *
 * `contains_origin_main=no` is the tell: the running tree is missing
 * commits that main has. (`yes` means main is fully contained in HEAD; a
 * feature branch ahead of main is the normal, healthy case.)
 *
 * Everything here is best-effort. A daemon must never fail to start because
 * provenance could not be determined — every failure degrades to "unknown".
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { cwd = REPO_ROOT, timeout = 2000 } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
}

export function bootProvenance({ cwd = REPO_ROOT } = {}) {
  const sha = git(["rev-parse", "--short", "HEAD"], { cwd });
  if (!sha) {
    // Not a git checkout (packaged install, tarball deploy) — say so plainly
    // rather than emitting a misleading half-answer.
    return { sha: null, branch: null, dirty: null, ancestorOfOriginMain: null, available: false };
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const status = git(["status", "--porcelain"], { cwd });
  const dirty = status === null ? null : (status === "" ? 0 : status.split("\n").length);

  // `--is-ancestor A B` answers "is A an ancestor of B". We ask whether
  // origin/main is contained in HEAD — i.e. "does the running tree CONTAIN
  // main?" — so the honest field name is containsOriginMain. It exits 0 for
  // true, 1 for false, and non-zero for "no such ref" — which git() flattens
  // to null. Distinguish "does not contain" from "could not determine" by
  // checking the ref resolves at all first.
  let containsOriginMain = null;
  if (git(["rev-parse", "--verify", "--quiet", "origin/main"], { cwd })) {
    containsOriginMain = git(["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd }) !== null;
  }

  return { sha, branch, dirty, containsOriginMain, available: true };
}

export function formatBootProvenance(info) {
  if (!info?.available) return "[boot] provenance=unavailable (not a git checkout)";
  const parts = [
    `sha=${info.sha}`,
    `branch=${info.branch ?? "unknown"}`,
    `dirty=${info.dirty ?? "unknown"}`,
    `contains_origin_main=${
      info.containsOriginMain === null ? "unknown" : (info.containsOriginMain ? "yes" : "no")
    }`
  ];
  return `[boot] ${parts.join(" ")}`;
}

/** Log the provenance line. Never throws — observability must not break boot. */
export function logBootProvenance({ logger = console.log, cwd = REPO_ROOT } = {}) {
  try {
    const line = formatBootProvenance(bootProvenance({ cwd }));
    logger(line);
    return line;
  } catch {
    return null;
  }
}
