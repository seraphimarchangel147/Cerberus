        # object.__new__ and skip __init__.
        _tracker = getattr(self, "_tool_worker_threads", None)
        _tracker_lock = getattr(self, "_tool_worker_threads_lock", None)
        if _tracker is not None and _tracker_lock is not None:
            with _tracker_lock:
                _worker_tids = list(_tracker)
            for _wtid in _worker_tids:
                try:
                    _set_interrupt(False, _wtid)
                except Exception:
                    pass
        # A hard interrupt supersedes any pending /steer — the steer was
        # meant for the agent's next tool-call iteration, which will no
        # longer happen. Drop it instead of surprising the user with a
        # late injection on the post-interrupt turn.
        _steer_lock = getattr(self, "_pending_steer_lock", None)
        if _steer_lock is not None:
            with _steer_lock:
                self._pending_steer = None
        return True

    def steer(self, text: str) -> bool:
        """
        Inject a user message into the next tool result without interrupting.

        Unlike interrupt(), this does NOT stop the current tool call. The
        text is stashed and the agent loop appends it to the LAST tool
        result's content once the current tool batch finishes. The model
        sees the steer as part of the tool output on its next iteration.

        Thread-safe: callable from gateway/CLI/TUI threads. Multiple calls
        before the drain point concatenate with newlines.

        Args:
            text: The user text to inject. Empty strings are ignored.

        Returns:
            True if the steer was accepted, False if the text was empty.
        """
        if not text or not text.strip():
            return False
        cleaned = text.strip()
        _lock = getattr(self, "_pending_steer_lock", None)
        if _lock is None:
            # Test stubs that built AIAgent via object.__new__ skip __init__.
            # Fall back to direct attribute set; no concurrent callers expected
            # in those stubs.
            existing = getattr(self, "_pending_steer", None)
            self._pending_steer = (existing + "\n" + cleaned) if existing else cleaned
            return True
        with _lock:
            if self._pending_steer:
                self._pending_steer = self._pending_steer + "\n" + cleaned
            else:
                self._pending_steer = cleaned
        return True

    def redirect(self, text: str) -> bool:
        """Redirect the active turn without converting it into a new task.

        During a normal Hermes model request this cancels only that request;
        the conversation loop retains completed messages/tool results, records
        the displayed partial reasoning as plain assistant context, appends the
        correction as a real user message, and retries. During tool execution
        it degrades to ``steer()`` so the tool can finish at a safe boundary.
        Codex app-server has a native ``turn/steer`` operation and uses it
        directly instead of cancelling.

        Returns ``False`` when there is no live turn or the text is empty, so
        surfaces can fall back to their existing next-turn queue.
        """
        if not text or not text.strip():
            return False
        cleaned = text.strip()

        # Codex owns its internal reasoning/tool loop, so use its first-class
        # active-turn steering protocol rather than interrupting the subprocess.
        if getattr(self, "api_mode", None) == "codex_app_server":
            _codex_session = getattr(self, "_codex_session", None)
            _native_steer = getattr(_codex_session, "request_steer", None)
            if callable(_native_steer):
                _redirect_lock = getattr(self, "_pending_redirect_lock", None)
                if _redirect_lock is not None:
                    with _redirect_lock:
                        if self._interrupt_requested:
                            return False
                elif self._interrupt_requested:
                    return False
                try:
                    return bool(_native_steer(cleaned))
                except Exception:
                    logger.debug("Codex app-server turn/steer failed", exc_info=True)
                    return False

        # Never kill a tool merely to deliver conversational guidance. The
        # existing steer drain puts it on the final tool result before the next
        # model decision, including delegate_task children.
        if getattr(self, "_executing_tools", False):
            return self.steer(cleaned)

        _model_active = getattr(self, "_model_request_active", None)
        _redirect_lock = getattr(self, "_pending_redirect_lock", None)
        if _redirect_lock is None:
            if _model_active is None or not _model_active.is_set():
                return False
            existing = getattr(self, "_pending_redirect", None)
            if self._interrupt_requested and not existing:
                return False
            self._pending_redirect = (
                f"{existing}\n\n[Additional user correction]\n{cleaned}"
                if existing
                else cleaned
            )
            self._interrupt_requested = True
            self._interrupt_message = None
        else:
            with _redirect_lock:
                if _model_active is None or not _model_active.is_set():
                    # The response completed before we acquired the state lock.
                    # Reject so the surface queues a new turn.
                    return False
                if self._interrupt_requested and not self._pending_redirect:
                    return False
                if self._pending_redirect:
                    self._pending_redirect = (
                        f"{self._pending_redirect}\n\n"
                        f"[Additional user correction]\n{cleaned}"
                    )
                else:
                    self._pending_redirect = cleaned
                self._interrupt_requested = True
                self._interrupt_message = None

        # Interrupt only the model request. Do not fan out to tool workers or
        # child agents as interrupt() does.
        _execution_thread_id = getattr(self, "_execution_thread_id", None)
        if _execution_thread_id is not None:
            _set_interrupt(True, _execution_thread_id)
            self._interrupt_thread_signal_pending = False
        else:
            self._interrupt_thread_signal_pending = True
    def _drain_pending_steer(self) -> Optional[str]:
        """Return the pending steer text (if any) and clear the slot.

        Safe to call from the agent execution thread after appending tool
        results. Returns None when no steer is pending.
        """
        _lock = getattr(self, "_pending_steer_lock", None)
        if _lock is None:
            text = getattr(self, "_pending_steer", None)
            self._pending_steer = None
            return text
        with _lock:
            text = self._pending_steer
            self._pending_steer = None
        return text

    def _record_file_mutation_result(
        self,
        tool_name: str,
        args: Dict[str, Any],
        result: Any,
        is_error: bool,
    ) -> None:
        """Record a ``write_file`` / ``patch`` outcome for the turn-end verifier.

        On failure, store ``{path: {error_preview, tool}}`` entries.  On
        success, remove any prior failure entries for the same paths (the



def apply_pending_steer_to_tool_results(agent, messages: list, num_tool_msgs: int) -> None:
    """Append any pending /steer text to the last tool result in this turn.

    Called at the end of a tool-call batch, before the next API call.
    The steer is appended to the last ``role:"tool"`` message's content
    with a clear marker so the model understands it came from the user
    and NOT from the tool itself. Role alternation is preserved —
    nothing new is inserted, we only modify existing content.

    Args:
        messages: The running messages list.
        num_tool_msgs: Number of tool results appended in this batch;
            used to locate the tail slice safely.
    """
    if num_tool_msgs <= 0 or not messages:
        return
    steer_text = agent._drain_pending_steer()
    if not steer_text:
        return
    # Find the last tool-role message in the recent tail. Skipping
    # non-tool messages defends against future code appending
    # something else at the boundary.
    target_idx = None
    for j in range(len(messages) - 1, max(len(messages) - num_tool_msgs - 1, -1), -1):
        msg = messages[j]
        if isinstance(msg, dict) and msg.get("role") == "tool":
            target_idx = j
            break
    if target_idx is None:
        # No tool result in this batch (e.g. all skipped by interrupt);
        # put the steer back so the caller's fallback path can deliver
        # it as a normal next-turn user message.
        _lock = getattr(agent, "_pending_steer_lock", None)
        if _lock is not None:
            with _lock:
                if agent._pending_steer:
                    agent._pending_steer = agent._pending_steer + "\n" + steer_text
                else:
                    agent._pending_steer = steer_text
        else:
            existing = getattr(agent, "_pending_steer", None)
            agent._pending_steer = (existing + "\n" + steer_text) if existing else steer_text
        return
    marker = format_steer_marker(steer_text)
    existing_content = messages[target_idx].get("content", "")
    if not isinstance(existing_content, str):
        # Anthropic multimodal content blocks — preserve them and append
        # a text block at the end.
        try:
            blocks = list(existing_content) if existing_content else []
            blocks.append({"type": "text", "text": marker.lstrip()})
            messages[target_idx]["content"] = blocks
        except Exception:
            # Fall back to string replacement if content shape is unexpected.
            messages[target_idx]["content"] = f"{existing_content}{marker}"
    else:
        messages[target_idx]["content"] = existing_content + marker
    _ra().logger.info(
        "Delivered /steer to agent after tool batch (%d chars): %s",
        len(steer_text),
        steer_text[:120] + ("..." if len(steer_text) > 120 else ""),
    )



def force_close_tcp_sockets(client: Any) -> int:
    """Abort in-flight TCP I/O by shutting down sockets WITHOUT closing FDs.

