_lock = threading.Lock()
_pending: dict[str, dict] = {}
_session_approved: dict[str, set] = {}
_session_yolo: set[str] = set()
_permanent_approved: set = set()

# =========================================================================
# Consecutive-denial circuit breaker for smart approvals
# =========================================================================
# Nothing stops the model from retrying variants of a smart-denied command —
# each retry burns another guardian LLM call and agent iteration. After
# ``approvals.denial_breaker_threshold`` consecutive guardian DENY verdicts
# in one session (default 3; 0 disables), the deny message returned to the
# model escalates to a hard-stop instruction. Any approval resets the tally.
# This changes only the TOOL RESULT text — no message-history surgery, no
# interrupts — so it is prompt-cache-invariant by construction. Inspired by
# ChatGPT Work's auto-review circuit breaker (3 consecutive denials).
_denial_tally: dict[str, int] = {}
# Plain dict with a small cap so an army of short-lived session keys cannot
# grow it without bound; oldest (least recently denied) entries are evicted.
_DENIAL_TALLY_MAX_SESSIONS = 256


def _get_denial_breaker_threshold() -> int:
    """Read ``approvals.denial_breaker_threshold`` from config.

    Defaults to 3 consecutive guardian denials; 0 (or negative) disables
    the breaker entirely.
    """
    try:
        return int(_get_approval_config().get("denial_breaker_threshold", 3))
    except (ValueError, TypeError):
        return 3


def _record_denial(session_key: str) -> int:
    """Increment and return the session's consecutive guardian-denial count.

    Pop-and-reinsert keeps actively-denying sessions at the most-recent end
    of the dict so eviction (insertion-ordered) drops genuinely idle keys.
    """
    with _lock:
        count = _denial_tally.pop(session_key, 0) + 1
        _denial_tally[session_key] = count
        while len(_denial_tally) > _DENIAL_TALLY_MAX_SESSIONS:
            _denial_tally.pop(next(iter(_denial_tally)))
        return count


def _reset_denials(session_key: str) -> None:
    """Clear the session's consecutive-denial tally (an approval happened)."""
    with _lock:
        _denial_tally.pop(session_key, None)


def _denial_breaker_addendum(session_key: str) -> str:
    """Return the escalated hard-stop text when the breaker has tripped.

    Read-only: callers increment via :func:`_record_denial` on the guardian
    DENY verdict; this just checks the session's tally against the
    configured threshold. Returns '' below the threshold (or when
    disabled), otherwise a leading-space addendum the caller appends
    verbatim to the deny message returned to the model.
    """
    with _lock:
        count = _denial_tally.get(session_key, 0)
    threshold = _get_denial_breaker_threshold()
    if threshold <= 0 or count < threshold:
        return ""
    logger.warning(
        "Smart-approval circuit breaker tripped for session %s: "
        "%d consecutive denials (threshold %d)",
        session_key, count, threshold,
    )
    return (
        f" CIRCUIT BREAKER: {count} consecutive commands were blocked by "
        "the security reviewer. STOP attempting variations of this "
        "operation. Report the blocked operation to the user and either "
        "ask them to run it manually or use /approve."
    )

# =========================================================================
# Blocking gateway approval (mirrors CLI's synchronous input() flow)
# =========================================================================
# Per-session QUEUE of pending approvals.  Multiple threads (parallel
# subagents, execute_code RPC handlers) can block concurrently — each gets
# its own threading.Event.  /approve resolves the oldest, /approve all
# resolves every pending approval in the session.


class _ApprovalEntry:
    """One pending dangerous-command approval inside a gateway session."""
    __slots__ = ("event", "data", "result", "reason")

    def __init__(self, data: dict):
        self.event = threading.Event()
    if approval_mode == "smart":
        combined_desc_for_llm = "; ".join(desc for _, desc, _ in warnings)
        observer_payload = _prepare_smart_approval_observer(
            command=command,
            description=combined_desc_for_llm,
            pattern_key=warnings[0][0],
            pattern_keys=[key for key, _, _ in warnings],
            session_key=session_key,
        )
        verdict = _smart_approve(command, combined_desc_for_llm)
        _observe_smart_approval_verdict(observer_payload, verdict)
        if verdict == "approve":
            # Approve this command only. Pattern-level persistence would let one
            # benign command suppress review of later commands that happen to
            # match the same broad detector category.
            _reset_denials(session_key)
            logger.debug("Smart approval: auto-approved '%s' (%s)",
                         command[:60], combined_desc_for_llm)
            return {"approved": True, "message": None,
                    "smart_approved": True,
                    "description": combined_desc_for_llm}
        elif verdict == "deny" and not (is_cli or is_gateway or is_ask):
            _record_denial(session_key)
            breaker_addendum = _denial_breaker_addendum(session_key)
            return {
                "approved": False,
                "message": f"BLOCKED by smart approval: {combined_desc_for_llm}. "
                           "The command was assessed as genuinely dangerous. "
                           f"Do NOT retry.{breaker_addendum}",
                "smart_denied": True,
            }
        elif verdict == "deny":
            # Guardian DENY that falls through to a one-operation human
            # override still counts toward the consecutive-denial breaker;
            # a subsequent human approval resets the tally below.
            _record_denial(session_key)
            smart_denied_for_owner = True
        # An interactive owner may override DENY for this operation only.
        # ESCALATE follows the normal, potentially persistent manual behavior.

    # --- Phase 3: Approval ---

    # Combine descriptions for a single approval prompt
    combined_desc = "; ".join(desc for _, desc, _ in warnings)
    primary_key = warnings[0][0]
    all_keys = [key for key, _, _ in warnings]
    # "Always" is offered when at least one warning is a dangerous-pattern
    # key that the persistence layer would actually allowlist permanently.
    # Pure-tirith findings are session-max by design (no broad permanent
    # allowlisting of content-level security findings), so a prompt with
    # ONLY tirith warnings keeps Always hidden.  Mixed prompts (pattern +
    # tirith) previously hid Always too, even though choosing it would
    # correctly persist the pattern key and downgrade the tirith key to
    # session — the UI was stricter than the persistence layer.
    has_permanent_capable = any(not is_t for _, _, is_t in warnings)

    # Gateway/async approval — block the agent thread until the user
    # responds with /approve or /deny, mirroring the CLI's synchronous
    # input() flow.  The agent never sees "approval_required"; it either
    # gets the command output (approved) or a definitive "BLOCKED" message.
    if is_gateway or is_ask:
