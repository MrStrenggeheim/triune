# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Versioned product guidance and runtime-scoped UI capability discovery.

This packaged module is independent of workspace instructions and personal skills.
The catalog describes the bundled renderer; tools and execution permissions remain
runtime facts, and an older or absent client must use the declared fallback.
"""

from __future__ import annotations

import shlex
from collections.abc import Iterable, Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

UI_CONTRACT_VERSION = "2026-11-15.1"
ARTIFACT_KIT_VERSION = "1.0.0"

# Output syntax is product guidance. Action names below are filtered against
# actual advertised tools, never inferred from another harness's inventory.
_GROUPS: dict[str, dict[str, Any]] = {
    "formatting": {
        "label": "Markdown, math, diagrams and citations",
        "tools": (),
        "output_only": True,
        "transport": "assistant Markdown",
        "input": "Ordinary assistant text; captured provider citations retain source metadata.",
        "output": (
            "Markdown headings, lists, tables, fenced code; $inline math$ / $$display"
            " math$$; fenced mermaid diagrams; real source links."
        ),
        "ui": (
            "Selectable message text, code controls, KaTeX math, Mermaid preview and source links."
        ),
        "lifecycle": "Use authoritative final/progress phases supplied by the adapter.",
        "persistence": "Captured transcript text and supported source annotations.",
        "limits": (
            "Do not invent citation/file IDs, finality or executable output markers. "
            "Invalid diagrams retain readable source."
        ),
        "fallback": "Plain text, code and ordinary source links.",
    },
    "questions": {
        "label": "Question batches and approvals",
        "tools": ("ask_user_question", "request_user_input", "request_user_input_async"),
        "transport": "registered structured question tool or negotiated native elicitation",
        "input": (
            "A real request with original question IDs, optional header, options/free"
            " text and provider constraints."
        ),
        "output": (
            "One pending card per actual batch; Submit/Decline act on the whole "
            "batch. Navigation and choice selection never submit."
        ),
        "ui": (
            "Shared header arrows; one counted Skip/Next/last-page Submit action; "
            "pending card becomes one Answered batch with original questions."
        ),
        "lifecycle": (
            "Submission, acknowledgement, withdrawal, expiry and cancellation remain "
            "distinct; asynchronous requests need not block input."
        ),
        "persistence": (
            "Canonical submitted batch identity and original questions/answers; "
            "secret answers retain answered/redacted state only."
        ),
        "limits": (
            "Preserve required-schema validation and allowed partial/empty "
            "submissions. Correlate native echoes by exact trusted native "
            "client/submission IDs, never text similarity."
        ),
        "fallback": (
            "Ask in ordinary text when no actual answerable request transport is "
            "exposed; never fabricate a question card or approval."
        ),
    },
    "plans": {
        "label": "Plans and task progress",
        "tools": ("update_plan", "TodoWrite", "TaskCreate", "TaskUpdate"),
        "transport": "registered plan/task tool or captured typed native lifecycle event",
        "input": "Actual steps/tasks and their observed states.",
        "output": (
            "Update existing plan/task identity, with pending/in-progress/completed "
            "states and provider-supported plan review."
        ),
        "ui": "Plan shelf, task progress and status cards.",
        "lifecycle": (
            "Keep original dispatch task; progress cannot replace an authoritative final report."
        ),
        "persistence": "Captured plan/task events and session state where supported.",
        "limits": (
            "A Markdown checklist alone does not mutate the plan shelf. Do not infer "
            "completion from missing output."
        ),
        "fallback": "A concise Markdown plan with explicit observed progress.",
    },
    "agents": {
        "label": "Subagents and peer communication",
        "tools": (
            "sys_session_send",
            "sys_session_create",
            "sys_session_message",
            "sys_read_inbox",
            "sys_session_get_history",
            "Agent",
            "spawn_agent",
        ),
        "transport": "registered managed-session or native delegation tools",
        "input": "Target session/dispatch identity, task, allowed model and source references.",
        "output": (
            "One task per dispatch and one attributed reply; peer incoming/outgoing "
            "messages retain linked source chats."
        ),
        "ui": "Stable message cards, child tabs and originating Orchestration.",
        "lifecycle": (
            "Acceptance is not execution; readable history does not imply "
            "reply/steering/stop capability."
        ),
        "persistence": (
            "Trusted session/native ancestry, exact dispatch identity and final source parts."
        ),
        "limits": (
            "Private-session, permission, orchestration flag and per-child runtime "
            "controls still apply. Never rename roles into fabricated agent "
            "identities."
        ),
        "fallback": (
            "Report unavailable delegation or controls and continue within the "
            "current session's capabilities."
        ),
    },
    "shells": {
        "label": "Shells and Agent CLI",
        "tools": (
            "sys_os_shell",
            "sys_terminal_launch",
            "sys_terminal_list",
            "sys_terminal_read",
            "sys_terminal_close",
            "exec_command",
            "Bash",
            "shell",
            "terminal",
        ),
        "transport": "registered shell/terminal tool or captured native CLI output",
        "input": "Authorized command, workspace and exact process/session identity.",
        "output": (
            "Captured command/output and known outcome; live terminals require an "
            "explicit interactive attachment."
        ),
        "ui": "Shell shelf and retained output; Agent CLI is distinct from auxiliary shells.",
        "lifecycle": (
            "Closing a view does not stop a process. Stop requested is not confirmed "
            "stopped; disconnected is not failed."
        ),
        "persistence": "Captured output remains readable without relaunching a runner.",
        "limits": (
            "Execute only exposed tools under current sandbox and permissions; a "
            "visible transcript is not a writable terminal."
        ),
        "fallback": "Explain the unavailable operation; retain readable captured output.",
    },
    "files": {
        "label": "Uploads, previews, originals and galleries",
        "tools": ("upload_file", "list_files", "download_file"),
        "transport": "authorized upload_file tool or explicit triune attach-file invocation",
        "input": (
            "A real local/workspace file uploaded into the owning chat; use the returned file_id."
        ),
        "output": (
            "Durable authorized attachment/source reference and original download; "
            "supported media has previews/gallery navigation."
        ),
        "ui": "Attachments, image/video/file previews, galleries and live-file editor links.",
        "lifecycle": (
            "Upload bytes before referencing the returned identity; retain source "
            "chat and original filename/path."
        ),
        "persistence": (
            "Server-authorized file resource; a local pathname alone is not a durable upload."
        ),
        "limits": (
            "Workspace and file ACLs still apply. Do not fabricate uploads or turn a "
            "server path into authorization."
        ),
        "fallback": (
            "A normal authorized file link; clearly identify a local-only deliverable"
            " when upload is unavailable."
        ),
    },
    "artifacts": {
        "label": "Interactive HTML and the Triune artifact kit",
        "tools": ("upload_file",),
        "transport": "authorized HTML file resource plus a complete triune-artifact fence",
        "input": (
            "Upload HTML first, then emit exactly: ```triune-artifact\n"
            '{"file_id":"authorized-upload-id","title":"optional"}\n```'
        ),
        "output": (
            'Use <main class="ta-root" data-triune-kit="1"> for injected first-party '
            "kit CSS/icons/runtime. Full documents and fragments may use local "
            "HTML/CSS/JavaScript, SVG and canvas."
        ),
        "ui": (
            "Isolated interactive frame with source, original download and full-window controls."
        ),
        "lifecycle": (
            "Host updates theme/density/visibility; use the injected "
            "window.TriuneArtifactState.get()/set() bridge for application state. Hidden views "
            "pause presentation, not external resource ownership."
        ),
        "persistence": (
            "Durable authorized file identity; bounded per-view state survives "
            "supported remount/reload paths."
        ),
        "limits": (
            "Bundled renderer: HTML preview 50 MiB, state 16 KiB; frame has no "
            "application-origin privilege. No external CDN/network/library imports. "
            "Do not embed the entire SPA CSS/React runtime or emit ChatGPT "
            "visualization references."
        ),
        "fallback": (
            "An ordinary uploaded HTML attachment/link when the client lacks inline "
            "artifact support; never replace file_id with a pathname or URL."
        ),
    },
    "context": {
        "label": "Quotes, comments and forks",
        "tools": (
            "list_comments",
            "update_comment",
            "sys_session_get_history",
            "sys_session_create",
        ),
        "transport": (
            "captured source annotations, user quote/fork actions and exposed "
            "comment/history tools"
        ),
        "input": "Exact captured chat/item/file revision and authorized comment identifiers.",
        "output": (
            "Source-aware quote, review comment or separate fork with inherited reference history."
        ),
        "ui": "Reply/Ask Subchat, file comments and branch boundaries.",
        "lifecycle": (
            "Inherited history is reference context; it does not authorize resuming "
            "old unfinished work."
        ),
        "persistence": (
            "Keep exact source identity and typed drafts; a fork does not isolate the filesystem."
        ),
        "limits": (
            "A source label is presentation, not authentication. Do not serialize "
            "hidden context into the user's editable draft."
        ),
        "fallback": "An explicit quoted excerpt and ordinary source link.",
    },
    "workspace": {
        "label": "Workspace, search and navigation",
        "tools": ("ui_open_file", "sys_os_list", "sys_os_read"),
        "transport": "exposed UI/OS tools and user workspace/search controls",
        "input": "Workspace-relative authorized paths and scoped query/source identities.",
        "output": (
            "Files/editors/diffs, exact search result occurrence and supported adjacent views."
        ),
        "ui": "Shared workspace picker, tabs, search and navigation.",
        "lifecycle": (
            "Background refresh retains resource identity, navigation, scroll, drafts"
            " and selection."
        ),
        "persistence": "Per-chat layout and retained resource state where supported.",
        "limits": (
            "ui_open_file reports request delivery, not proof a client displayed it. "
            "Search scope and workspace_content_search release gates remain "
            "authoritative."
        ),
        "fallback": "A precise authorized path/source link and manual navigation steps.",
    },
    "background": {
        "label": "Queues, inboxes, timers and automations",
        "tools": (
            "sys_call_async",
            "sys_read_inbox",
            "sys_cancel_async",
            "sys_timer_set",
            "sys_timer_cancel",
            "sys_scheduled_task_create",
            "sys_scheduled_task_list",
            "sys_scheduled_task_update",
            "sys_scheduled_task_delete",
        ),
        "transport": "registered async/inbox/timer/scheduled-task tools and user queue controls",
        "input": "Actual task handle, timer/schedule identity and authorized target session.",
        "output": "Queued work, completion inbox or explicitly requested timer/schedule.",
        "ui": "FIFO queue and attention shelves; supported automation views.",
        "lifecycle": (
            "Queued acceptance is not execution. Collect real completions; never "
            "infer them from elapsed time."
        ),
        "persistence": "Browser queues and server schedules have distinct owners and retention.",
        "limits": (
            "Never invent timers/automations or claim future work without a "
            "successful registered-tool result; account, release and scheduling "
            "permissions apply."
        ),
        "fallback": (
            "Explain which operation is unavailable; do not promise a reminder or "
            "background continuation."
        ),
    },
    "notices": {
        "label": "Notices and usage",
        "tools": (),
        "output_only": True,
        "transport": "trusted typed provider/runtime events",
        "input": "Observed provider warning, runtime notice or attributed usage/cost data.",
        "output": (
            "Non-answerable notice and properly scoped accounting; use actual "
            "question tools for answerable requests."
        ),
        "ui": "Notices and usage views with supported Agent CLI/Dismiss actions.",
        "lifecycle": (
            "UI dismissal does not grant approval, send a provider response or spend credits."
        ),
        "persistence": "Captured notice revision and scoped usage observations.",
        "limits": (
            "Do not infer exact token/cost totals, consent or unsupported "
            "model-choice controls from prose."
        ),
        "fallback": "A concise attributed explanation with uncertainty retained.",
    },
}


_PRODUCT_GUIDANCE = (
    (
        "Use Markdown, $math$/$$math$$ and fenced mermaid; preserve real source "
        "citations and authoritative response phases."
    ),
    (
        "Questions are whole elicitation batches: one pending→answered card, original "
        "IDs/category/question, counted Skip/Next/final Submit; no implicit choice "
        "submission or text-based echo matching. Secret answers are redacted in "
        "history."
    ),
    (
        "For supported interactive HTML, upload first, then a triune-artifact fenced "
        'JSON object {"file_id":"authorized-upload-id","title":"optional"}. Never use a'
        " local path/URL as file_id or emit ChatGPT visualization references."
    ),
    (
        'Artifact kit 1.0.0 is injected for class="ta-root" or data-triune-kit="1"; use'
        " local HTML/CSS/JS/SVG/canvas, shared theme/density, no external CDN. Older "
        "clients use the ordinary uploaded file link."
    ),
)


def _tool_name(value: str) -> str:
    return value.removeprefix("mcp__omnigent__")


def ui_capabilities(
    harness: str | None = None,
    *,
    tool_names: Iterable[str] = (),
    feature_flags: Mapping[str, bool] | None = None,
    permissions: Mapping[str, bool] | None = None,
    session_id: str | None = None,
    server_url: str | None = None,
) -> dict[str, Any]:
    """Project the bundled catalog through actual tools, flags and permissions.

    Omitted gates are unknown, not grants. Native event channels are conditional
    until a runtime actually offers the relevant operation. This function never
    creates a terminal, uploads a file, or reads private configuration.
    """
    from omnigent.harness_plugins import harness_aliases, harness_capabilities

    names = tuple(sorted(set(tool_names)))
    normalized = {_tool_name(name): name for name in names}
    flags, access = dict(feature_flags or {}), dict(permissions or {})
    canonical = harness_aliases().get(harness or "", harness or "")
    capability = harness_capabilities().get(canonical)
    attach_command = None
    if session_id and server_url:
        parsed = urlsplit(server_url)
        if (
            parsed.scheme in {"http", "https"}
            and parsed.netloc
            and not parsed.username
            and not parsed.password
        ):
            attach_command = (
                f"triune attach-file PATH --session {shlex.quote(session_id)} "
                f"--server {shlex.quote(server_url)}"
            )
    groups: dict[str, Any] = {}
    for key, definition in _GROUPS.items():
        entry = {
            name: value
            for name, value in definition.items()
            if name not in {"output_only", "tools"}
        }
        tools = [normalized[name] for name in definition["tools"] if name in normalized]
        availability = (
            "available"
            if definition.get("output_only") or tools
            else "conditional"
            if capability
            else "unavailable"
        )
        if key in {"files", "artifacts"} and attach_command:
            availability = "available"
            entry["attach_command"] = attach_command
        if access.get(key) is False or flags.get(key) is False:
            availability = "unavailable"
        if key == "artifacts" and flags.get("inline_html_artifacts") is False:
            availability = "unavailable"
        entry.update(
            id=key,
            availability=availability,
            tools=tools,
            scope="Current authorized chat/workspace; server checks remain authoritative.",
        )
        groups[key] = entry
    return {
        "version": UI_CONTRACT_VERSION,
        "harness": canonical or None,
        "harness_capabilities": capability.as_dict() if capability else None,
        "capability_evidence": (
            "Harness declarations and advertised tools; execution/negotiation remain "
            "authoritative."
        ),
        "tool_inventory": {
            "scope": "Explicitly supplied names only; native builtins may not be inventoried.",
            "complete": False,
            "names": list(names),
        },
        "renderer": {
            "version": 1,
            "active_client_verified": False,
            "artifact_kit": ARTIFACT_KIT_VERSION,
            "external_cdns": False,
            "theme_modes": ["light", "dark"],
            "densities": ["comfortable", "compact"],
            "artifact_helpers": ["tabs", "disclosure", "arrowless tooltip", "theme", "density"],
            "state_api": "window.TriuneArtifactState.get()/set()",
            "custom_surfaces": ["HTML", "CSS", "JavaScript", "SVG", "canvas"],
        },
        "feature_flags": flags,
        "permissions": access,
        "groups": groups,
    }


def native_ui_contract(
    harness: str,
    *,
    tools: Sequence[str] = (),
    session_id: str | None = None,
    server_url: str | None = None,
) -> str:
    """Compact static startup guidance; contains no turn/lifecycle dispatch policy."""
    catalog = ui_capabilities(
        harness, tool_names=tools, session_id=session_id, server_url=server_url
    )
    lines = [
        f"Triune UI contract {UI_CONTRACT_VERSION} (bundled renderer; respect current "
        "tools, permissions and runtime capability results)."
    ]
    for group in catalog["groups"].values():
        tools_text = ", ".join(group["tools"]) or "no registered action tool"
        lines.append(f"- {group['id']}: {group['label']} [{group['availability']}; {tools_text}].")
    lines.extend(_PRODUCT_GUIDANCE)
    command = catalog["groups"]["files"].get("attach_command")
    if command:
        lines.append(
            f"Upload local bytes using {command}; use the returned file_id. "
            "No ambient session/server variables are assumed."
        )
    if "sys_ui_capabilities" in {_tool_name(name) for name in tools}:
        name = next(name for name in tools if _tool_name(name) == "sys_ui_capabilities")
        lines.append(
            f"Call {name} for exact input/output, scope, persistence, "
            "limits and fallbacks by group."
        )
    else:
        lines.append(
            "Detailed guidance is available through sys_ui_capabilities only if "
            "that tool is advertised; otherwise use current tool schemas and the "
            "fallbacks above."
        )
    return "\n".join(lines)


def ui_contract_tool_description() -> str:
    """Canonical static guidance in the advertised read-only discovery schema.

    This channel describes rendering, never AgentSpec roles or permissions.
    It needs no user turn and makes no claim to know the vendor's native tools.
    """
    return (
        f"Triune UI contract {UI_CONTRACT_VERSION}. Discover current UI capabilities "
        "and tool-scoped limits; this read-only tool does not grant permissions.\n"
        + "\n".join(_PRODUCT_GUIDANCE)
        + "\nGroups: "
        + ", ".join(_GROUPS)
        + '\nInvoke this tool with {} for the full catalog or {"group":"artifacts"} '
        "for exact input/output, scope, persistence, limits and fallbacks. "
        "Actual advertised tools and runtime permission results remain authoritative."
    )


def append_ui_contract(instructions: str | None, harness: str, **context: Any) -> str:
    """Keep author startup text intact and append the static product block once."""
    contract = native_ui_contract(harness, **context)
    if instructions and instructions.endswith(contract):
        return instructions
    return f"{instructions}\n\n{contract}" if instructions else contract
