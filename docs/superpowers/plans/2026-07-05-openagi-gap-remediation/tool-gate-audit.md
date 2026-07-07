# Tool confirmation-gate audit — 2026-07-05 (Task E3)

Scope: every tool registered in src/tool-registry.js and src/integrations/*.js
(plus MCP-sourced tools as a class). A tool is "gated" only if it sets
needsConfirmation: true (intercepted at src/tool-registry.js:157). sideEffects
defaults to TRUE when absent (src/tool-registry.js:31), so unflagged tools are
already blocked on watch/ask verdict turns — the exposure is act-verdict turns,
where only needsConfirmation gates execution.

This is a REPORT for Spencer to review. No flags were changed by this audit;
the only code change in Task E3 was replay_skill (now gated).

| Tool | Registered at | Writes/sends what | sideEffects | needsConfirmation | Suggested |
|---|---|---|---|---|---|
| replay_skill | src/tool-registry.js:484 | AppleScript/keyboard control of the Mac | true (explicit, E3) | true (E3) | done |
| send_message | src/tool-registry.js:352 | outbound SMS/Telegram/local delivery | true (default) | false | consider gating |
| restart_daemon | src/tool-registry.js:1027 | kills the daemon process | true (default) | true | ok |
| register_mcp_server | src/tool-registry.js:561 | spawns arbitrary process / contacts arbitrary host | true (default) | true | ok |
| connect_catalog_mcp | src/tool-registry.js:969 | persists API keys to .env, registers MCP | true (default) | true | ok |
| remember | src/tool-registry.js:190 | writes to long-lived memory store | true (default) | false | ok (reversible via correct_memory) |
| correct_memory | src/tool-registry.js:267 | supersedes/locks memory items | true (default) | false | ok (that is its purpose) |
| schedule_message | src/tool-registry.js:303 | creates a cron job that later runs a prompt and delivers to a channel | true (default) | false | consider gating (deferred send_message) |
| run_skill | src/tool-registry.js:510 | runs a named skill (model calls, spend); no direct Mac control | true (default) | false | ok; see Notes |
| run_mcp_tool | src/tool-registry.js:540 | invokes an arbitrary tool on a connected MCP server | true (default) | false | consider per-server policy (same class as MCP tools row) |
| connect_mcp_server | src/tool-registry.js:609 | spawns/connects a REGISTERED server (registration itself is gated); may open OAuth flow | true (default) | false | ok (registration is the gate) |
| disconnect_mcp_server | src/tool-registry.js:626 | kills an MCP stdio child / drops HTTP session | true (default) | false | ok (recoverable) |
| cancel_cron_job | src/tool-registry.js:650 | removes a scheduled job (incl. system jobs like outreach-digest) | true (default) | false | consider gating for system-job ids |
| set_provider | src/tool-registry.js:678 | mutates process env and persists OPENAGI_PROVIDER to .env | true (default) | false | consider gating (writes .env) |
| add_task | src/tool-registry.js:710 | writes to the task store | true (default) | false | ok |
| complete_task | src/tool-registry.js:761 | mutates task status | true (default) | false | ok |
| move_task | src/tool-registry.js:779 | mutates task bucket/queue | true (default) | false | ok |
| add_goal | src/tool-registry.js:804 | writes to the goal store | true (default) | false | ok |
| link_task_to_goal | src/tool-registry.js:842 | mutates task-goal links | true (default) | false | ok |
| agent_pick_next | src/tool-registry.js:857 | pops a task off the agent queue (state mutation) | true (default) | false | ok |
| save_draft | src/tool-registry.js:909 | writes a draft artifact (explicitly does NOT send) | true (default) | false | ok (designed as the safe alternative to sending) |
| retire_specialist | src/tool-registry.js:1046 | retires a propagated specialist | true (default) | false | ok (reversible in store) |
| start_computer_use_session | src/integrations/computer-use.js:102 | opens a computer-use session (gates all computer_* actions) | true (default) | true | ok |
| end_computer_use_session | src/integrations/computer-use.js:125 | closes the active session record | true (default) | false | ok |
| computer_click / computer_type / computer_key / computer_scroll / computer_move | src/integrations/computer-use.js:245-262 (via registerAction, 204) | synthesizes real mouse/keyboard input on the computer-use node | true (default) | false | ok-with-caveat: gated at session level by start_computer_use_session approval, not per-action; see Notes |
| rize_query | src/integrations/rize.js:49 | raw GraphQL — can carry MUTATIONS against the user's Rize account | true (default) | false | consider gating or restricting to queries |
| rize_today_summary | src/integrations/rize.js:65 | read-only external API query | true (default, unflagged) | false | flag sideEffects: false |
| rize_recent_sessions | src/integrations/rize.js:94 | read-only external API query | true (default, unflagged) | false | flag sideEffects: false |
| calendar_today_events | src/integrations/calendar.js:70 | read-only ICS fetch | true (default, unflagged) | false | flag sideEffects: false |
| calendar_events_between | src/integrations/calendar.js:89 | read-only ICS fetch | true (default, unflagged) | false | flag sideEffects: false |
| MCP tools (all, source "mcp") | src/mcp-registry.js | arbitrary per-server actions | true (default) | false | per-server policy (future task) |

Read-only tools with explicit sideEffects: false (verified, out of scope):
recall, recall_activity, recall_spend, list_sessions, search_sessions,
list_skills, list_mcp_tools, list_cron_jobs, get_audit, get_budget,
list_tasks, list_goals, daily_recap, daily_plan, list_mcp_catalog,
computer_screenshot, imessage_search (imessage-search-tool.js), web_search
tools (web-search.js x2).

## Notes
- computer_* input-synthesis actions (click/type/key/scroll/move) rely on a
  session-scoped approval: start_computer_use_session is confirmation-gated,
  and every action handler calls requireActiveSession() first, so no action
  runs without a prior approved session — but within an approved session,
  individual actions do NOT re-prompt. That is the documented design
  ("once approved, subsequent computer_* actions in this session won't
  re-prompt"), worth a conscious sign-off.
- rize_query's description explicitly permits "query or mutation" strings, so
  it is a write-capable external API surface with no gate. Lowest-effort fix
  would be rejecting strings starting with "mutation", but per E3 scope no
  change was made.
- run_skill executes a skill's prompt through the model host; it cannot drive
  the Mac directly (that path is replay_skill, now gated), but it does incur
  model spend and whatever tools the skill's turns invoke are still individually
  subject to this same gate table.
- set_provider persists to the live .env via setup-wizard saveEnv — an env/file
  write from an act-verdict turn with no confirmation.
- schedule_message is effectively a deferred send_message (the fired prompt's
  result is delivered to a channel), so if send_message gets gated,
  schedule_message should be considered alongside it.
- Registration line numbers reflect the repo as of this audit (2026-07-06
  execution of the 2026-07-05 plan); the plan's seed rows cited pre-E1 line
  numbers (e.g. replay_skill at 453, now 484) — same code, shifted by earlier
  plan tasks adding tools above.
