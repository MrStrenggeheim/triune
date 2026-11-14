# Chat activity

Activity combines the selected chat's main agent and subagents with recorded shell sessions and command executions, retaining source identity and bounded historical output independently of the live terminal list.

## Sub-features

- `agents`: retain the existing agent tree, graph and navigation within the expanded Activity panel.
- `shells`: live shell sessions open their existing terminal; completed sessions open retained output and exit details.
- `commands`: captured noninteractive commands appear as command executions rather than fabricated interactive terminals.
- `history`: keep ended activity available offline with truthful per-entry state, without exposing internal capture diagnostics.
- `provenance`: descendant activity preserves its source chat and agent; each descendant needs its own existing read permission.
- `filters`: shared All, Agents and Shells control filters separate sections, including settled records, ordered by last observed activity.
- `source`: current-chat origin or explicit originating link; alternative combined Host/workspace selector limits independent inventory.
- `controls`: shared two-line rows in shelves and Orchestration show name, task/output, natural-width status and exact-resource side-opening controls.
- `outcomes`: shared labels distinguish known Completed/Failed, acknowledged Stopped, Declined and confirmed Ended with unknown outcome; Disconnected never proves exit.
- `native-shells`: captured provider resource IDs preserve output and truthful capabilities; supported live records expose targeted Stop without joining commands by text.

## How to get to it (user POV)

- Desktop: open Orchestration from the shared Open menu or a task card's square-arrow button; the stored activity identifier remains compatible.
- Phone: open Orchestration through the shared Open menu or a task shortcut.
- Click an agent/shell row, filter Shells, open a live terminal or inspect retained output; use Graph from its menu when needed.
- Change Chat to Host/workspace in the source picker; the current source chat's location is prefilled until confirmation.
- Return from another chat to see that conversation's activity rather than the selected filesystem workspace's inventory.

## Driving it with the repro environment

Preconditions: use the isolated [verification environment](skills/verify-omnigent/SKILL.md) and temporary terminal sessions; historical coverage depends on recorded tool/lifecycle data.

- Seeded persisted-command projection, retained-output dialog and no terminal attachment: `tests/e2e_ui/agents/test_chat_activity_history.py::test_activity_inspects_recorded_commands_without_attaching_a_terminal`.
- Filters, history, intent consumption and tab navigation: `web/src/shell/ChatActivityPanel.test.tsx`, `web/src/workbench/ActivityView.test.tsx` and `web/src/hooks/useChatActivity.test.tsx`.
- Recorded commands open without a terminal attach: `web/src/workbench/TerminalResourceView.test.tsx`.
- Lifecycle capture, command versus shell completion and bounded durable history: `tests/terminals/test_activity_history.py`, `tests/runner/test_session_activity.py` and `tests/server/test_session_activity.py`.
- Existing session resource permission gates: `tests/server/routes/test_shell_permission_gate.py`.
- Markdown, source prefilling and absence of diagnostic/menu clutter: `web/src/shell/ChatActivityPanel.test.tsx` and `web/src/workbench/ActivityView.test.tsx`.
- Shared rows, hover/touch Stop and shelf reuse: `web/src/components/ActivityRow.test.tsx`, `web/src/components/composer/BackgroundTaskIndicator.test.tsx` and `web/src/components/composer/SubagentTaskIndicator.test.tsx`.
- Captured native output, query identity and read-only side views: `web/src/hooks/useSessionShellResources.test.tsx` and `web/src/workbench/ShellResourceView.test.tsx`.
- Authenticated provider resources, retained history and targeted control: `tests/server/test_shell_resource_routes.py`, `tests/server/test_shell_resources.py` and `tests/runner/test_native_shell_resources.py`.
- Actual native command lifecycle through the isolated browser: `tests/e2e_ui/agents/test_native_capability_shelf.py`.
- Manually run a command in a shell while leaving the shell open, then end the shell: the command can complete while the shell is still live, and only the shell's actual end supplies its ended state.
- Typed offline, upstream permission/replica preservation and passive retained reads: `tests/server/test_shell_resource_routes.py`.
- Disconnect the runner and inspect recorded output; verify that disconnection does not invent a successful exit.

## Gotchas

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
