# Chat activity

Activity combines the selected chat's main agent and subagents with recorded shell sessions and command executions, retaining source identity and bounded historical output independently of the live terminal list.

## Sub-features

- Main chat and subchat share the same pending-input anchors and ordered message projection.
- After a Claude image prompt, commentary and the final answer each replace their own live preview and remain below the prompt through reconnect.
- A subchat hides inherited rows through its server-issued fork boundary; a legacy fork with unknown provenance keeps readable rows.
- A visible message or interactive row separates adjacent work disclosures, and the narration preference controls whether commentary stays visible after settlement.

- `agents`: retain the existing agent tree, graph and navigation within the expanded Activity panel.
- `shells`: live shell sessions open their existing terminal; completed sessions open retained output and exit details.
- `commands`: completed one-shot commands share a collapsed Commands row per source session and recorded turn. Expand it for each command, captured output and exit code when known.
- `history`: keep ended activity available offline with truthful per-entry state, without exposing internal capture diagnostics.
- `provenance`: descendant activity preserves its source chat and agent; each descendant needs its own existing read permission.
- `filters`: shared All, Agents and Shells control filters separate sections, including settled records, ordered by last observed activity.
- `header`: the shared chat/host header measures pane width and moves filters into its existing options menu, preserving source, category and List/Graph state through resizing.
- `source`: current-chat origin or explicit originating link; alternative combined Host/workspace selector limits independent inventory.
- `controls`: shared two-line rows ellipsize task/output, preserve exact-resource controls and collapse narrow status text to accessible icons; message-card controls move below text when needed.
- `positioned-updates`: missing activity with canonical identity/position inserts once in order; loaded cards enrich without replacing their identity, while unpositioned legacy updates retain bounded recovery.
- `old-card-recovery`: same-epoch recovery point-reads tracked old-card mutations before replaying appended items; expired/untracked changes still require a full authorized reset.
- `outcomes`: shared labels distinguish known Completed/Failed, acknowledged Stopped, Declined and confirmed Ended with unknown outcome; Disconnected never proves exit.
- `native-shells`: captured provider resource IDs preserve output and truthful capabilities; supported live records expose targeted Stop without joining commands by text.

## How to get to it (user POV)

- Desktop: open Orchestration from the shared Open menu or a task card's square-arrow button; the stored activity identifier remains compatible.
- Phone: open Orchestration through the shared Open menu or a task shortcut.
- Use the chat or shell icon to open the resource beside the current view. The shelf and chat entries also offer Show in Orchestration.
- Change Chat to Host/workspace in the source picker; the current source chat's location is prefilled until confirmation.
- Return from another chat to see that conversation's activity rather than the selected filesystem workspace's inventory.

## Driving it with the repro environment

Preconditions: use the isolated [verification environment](skills/verify-omnigent/SKILL.md) and temporary terminal sessions; historical coverage depends on recorded tool/lifecycle data.

- Three shell executions in two persisted turns, collapsed history, output and exit codes: `tests/e2e_ui/agents/test_chat_activity_history.py::test_activity_groups_recorded_commands_by_turn`.
- Filters, history, intent consumption and tab navigation: `web/src/shell/ChatActivityPanel.test.tsx`, `web/src/workbench/ActivityView.test.tsx` and `web/src/hooks/useChatActivity.test.tsx`.
- Recorded commands open without a terminal attach: `web/src/workbench/TerminalResourceView.test.tsx`.
- Lifecycle capture, command versus shell completion and bounded durable history: `tests/terminals/test_activity_history.py`, `tests/runner/test_session_activity.py` and `tests/server/test_session_activity.py`.
- Existing session resource permission gates: `tests/server/routes/test_shell_permission_gate.py`.
- Markdown, source prefilling and absence of diagnostic/menu clutter: `web/src/shell/ChatActivityPanel.test.tsx` and `web/src/workbench/ActivityView.test.tsx`.
- Shared rows, hover/touch Stop and shelf reuse: `web/src/components/ActivityRow.test.tsx`, `web/src/components/composer/BackgroundTaskIndicator.test.tsx` and `web/src/components/composer/SubagentTaskIndicator.test.tsx`.
- Iteration6 candidate narrow popup text, status and separate controls: `tests/browser_ui/chat/test_iteration6.py::test_queue_plan_popup_and_synthetic_safe_top_follow_density`.
- Positioned updates into an empty transcript or before its loaded window, deduplication and loaded-context retention: `web/src/store/chatStore.test.ts`, under `SYNC-ACCEPTANCE canonical resource update`.
- Changed-card replay, mutations during replay, authorization before point reads and reset fallback: `tests/server/routes/test_session_recovery.py`.
- After parent freeze/build, narrow an agent popup or Orchestration pane: title detail and preview each stay on one ellipsized line; status and navigation remain reachable.
- Narrow a task message card below 480px: status and actions move beneath the text without overlap; below 440px resource rows retain accessible status while hiding its visible label.
- Resize an Orchestration pane until filters move into Options, choose Shells there, then widen it; the inline Shells filter remains selected and the source stays unchanged.
- Agents/Shells popups and Orchestration use the same density-aware resource rows, with equal leading and vertical padding and the same navigation and Stop controls.
- Agent cards, shelf and Orchestration share child snapshots, reconcile on reconnect and refresh active or unresolved children every five seconds while visible.
- Sent and received peer cards retain delivery tracking and show delivery failures as inline errors.
- Active and pending Plan items share the empty checkbox; active uses the shared active border and accessible In progress text, while completion keeps the read-only checkmark.
- Queue, attention and child-context shelf backgrounds continue behind both rounded composer corners; their existing 200ms entrance/exit and reduced-motion behavior remain.
- Captured native output, query identity and read-only side views: `web/src/hooks/useSessionShellResources.test.tsx` and `web/src/workbench/ShellResourceView.test.tsx`.
- Authenticated provider resources, retained history and targeted control: `tests/server/test_shell_resource_routes.py`, `tests/server/test_shell_resources.py` and `tests/runner/test_native_shell_resources.py`.
- The shell-resource suites also cover FIFO validation off the event loop, repeated cancellation draining, workspace context and exact redaction through retained-snapshot reloads.
- Actual native command lifecycle through the isolated browser: `tests/e2e_ui/agents/test_native_capability_shelf.py`.
- Manually run a command in a shell while leaving the shell open, then end the shell: the command can complete while the shell is still live, and only the shell's actual end supplies its ended state.
- Typed offline, upstream permission/replica preservation and passive retained reads: `tests/server/test_shell_resource_routes.py`.
- Disconnect the runner and inspect recorded output; verify that disconnection does not invent a successful exit.

## Gotchas

- Iteration6 source acceptance remains separate from the installed release and parent-owned compiled verification; a positioned-update fix does not establish the cause of a reported production disconnect.
- Unpositioned legacy recovery still needs authorized history and can report a genuine unavailable item; missing positioned cards should not trigger that fallback.
- Activity records usage and provenance; workspace manual terminals remain independently owned resources.
- History retains at most 128 entries per chat and 8 KiB output snapshots; the runner's local capture is also bounded globally.
- Native vendor commands are projected only where persisted tool records provide evidence; missing completion or exit information remains unknown.
- Viewing historical output never launches, resumes or reruns a process.
- All three navigation/disclosure controls share ghost hover; the trailing right/down disclosure has no animation and these message cards omit their footer slots.
- Expected offline history uses captured output and safe notices; raw runner and conversation identifiers never appear in errors.
- Native shell controls reflect the installed runtime: Codex supports targeted termination where negotiated; Claude native TUI output is read-only when no incoming control channel exists.
- Native primary CLI terminals are excluded from shell inventory and targeted Stop; stable provider call IDs deduplicate captured command history.
- Codex may omit its initial yield buffer from live deltas; completion supplies complete aggregated output, while later streamed chunks are captured after the assistant turn ends.
- Root activity scans at most 32 authorized sessions and does not expose inaccessible descendants.
