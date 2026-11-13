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
- `controls`: clickable two-line Markdown rows open named tabs; semantic status pills and supported Stop stay aligned, without redundant Open buttons.

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
- Manually run a command in a shell while leaving the shell open, then end the shell: the command can complete while the shell is still live, and only the shell's actual end supplies its ended state.
- Disconnect the runner and inspect recorded output; verify that disconnection does not invent a successful exit.

## Gotchas

- Activity records usage and provenance; workspace manual terminals remain independently owned resources.
- History retains at most 128 entries per chat and 8 KiB output snapshots; the runner's local capture is also bounded globally.
- Native vendor commands are projected only where persisted tool records provide evidence; missing completion or exit information remains unknown.
- Viewing historical output never launches, resumes or reruns a process.
- Root activity scans at most 32 authorized sessions and does not expose inaccessible descendants.
