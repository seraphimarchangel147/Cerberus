// Catastrophic-class command/tool-call policy — SCAFFOLD (Tier-2, see
// docs/plans/2026-07-17-tier2-3-hardening-spec.md §T2a for the full spec).
//
// Purpose: a SMALL hard-gated class that auto-approve can never bypass —
// machine-destroying deletes, WSL/host shutdown, killing sibling Legion
// engines, disk surgery, force-push to main, credential-file writes.
// Everything else stays auto-approved (Creator's "smart gates" policy).
//
// Implementor (Zed): fill PATTERNS, wire classifyCommand into
// tool-registry.js invoke() BEFORE the autoApproveEnabled() check, and
// force-divert catastrophic calls to PendingActionStore with
// severity:"catastrophic". Tests must pass in BOTH lanes without pinning env.

/** @returns {{catastrophic: boolean, reason: string|null}} */
export function classifyCommand(command) {
  // TODO(zed): implement per spec §T2a. Until implemented, nothing is
  // classified catastrophic — behavior is unchanged from before this file.
  void command;
  return { catastrophic: false, reason: null };
}

/** @returns {{catastrophic: boolean, reason: string|null}} */
export function isCatastrophicToolCall({ toolName, args } = {}) {
  if (toolName === "code_shell" && args?.command) return classifyCommand(String(args.command));
  return { catastrophic: false, reason: null };
}
