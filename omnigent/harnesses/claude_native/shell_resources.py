# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Retain Claude native shell identity and actual structured hook output."""

from __future__ import annotations

from dataclasses import dataclass, field

from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    MAX_SHELL_RESOURCES,
    shell_resource_fields,
)
from omnigent.terminals.history import bounded_output
from omnigent.util.json_types import JsonObject


@dataclass
class ClaudeShellResources:
    """Project vendor task ids; never interpret shell descriptions as process handles."""

    session_id: str
    resources: dict[str, JsonObject] = field(default_factory=dict)
    bash_calls: dict[str, JsonObject] = field(default_factory=dict)

    def observe(self, task: JsonObject, *, output: str | None = None) -> JsonObject | None:
        """Merge a native shell observation without erasing ended records or captured output."""
        if task.get("type") not in {"shell", "local_bash"}:
            return None
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            return None
        previous = self.resources.get(task_id, {})
        status = task.get("status")
        if previous.get("status") in ENDED_SHELL_STATUSES and status not in ENDED_SHELL_STATUSES:
            return None
        row = {**previous, **task, "id": task_id, "type": "shell"}
        if output is None:
            existing = previous.get("output")
            output = existing if isinstance(existing, str) else None
        row["output"] = bounded_output(output)
        row.update(
            shell_resource_fields(
                source="claude_native",
                resource_id=task_id,
                session_id=self.session_id,
                output=output,
                stop_disabled_reason="native_tui_control_transport_unavailable",
            )
        )
        self.resources[task_id] = row
        for resource_id in list(self.resources):
            if len(self.resources) <= MAX_SHELL_RESOURCES:
                break
            if self.resources[resource_id].get("status") in ENDED_SHELL_STATUSES:
                del self.resources[resource_id]
        return row

    def observe_hook(self, payload: JsonObject) -> list[JsonObject]:
        """Read explicit hook task ids and tool response fields, without parsing display prose."""
        tasks = payload.get("background_tasks")
        if isinstance(tasks, list):
            for task in tasks[:MAX_SHELL_RESOURCES]:
                if isinstance(task, dict):
                    self.observe(task)
        if payload.get("hook_event_name") != "PostToolUse":
            return list(self.resources.values())
        response, arguments = payload.get("tool_response"), payload.get("tool_input")
        if not isinstance(response, dict) or not isinstance(arguments, dict):
            return list(self.resources.values())
        if payload.get("tool_name") == "Bash":
            task_id = response.get("backgroundTaskId")
            if isinstance(task_id, str) and task_id:
                stdout, stderr = response.get("stdout"), response.get("stderr")
                output = "\n".join(
                    value for value in (stdout, stderr) if isinstance(value, str) and value
                )
                self.observe(
                    {
                        "id": task_id,
                        "type": "shell",
                        "status": "running",
                        "command": arguments.get("command"),
                        "description": arguments.get("description"),
                    },
                    output=output or None,
                )
        return list(self.resources.values())

    def observe_transcript(self, entry: JsonObject) -> list[JsonObject]:
        """Correlate Bash tool metadata by tool-use id, never by its rendered command."""
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and block.get("name") == "Bash":
                    call_id, arguments = block.get("id"), block.get("input")
                    if isinstance(call_id, str) and isinstance(arguments, dict):
                        self.bash_calls[call_id] = arguments
                        if len(self.bash_calls) > MAX_SHELL_RESOURCES:
                            del self.bash_calls[next(iter(self.bash_calls))]
                elif block.get("type") == "tool_result":
                    call_id = block.get("tool_use_id")
                    result = entry.get("toolUseResult")
                    if isinstance(call_id, str) and call_id in self.bash_calls:
                        arguments = self.bash_calls.pop(call_id)
                        if isinstance(result, dict):
                            self.observe_hook(
                                {
                                    "hook_event_name": "PostToolUse",
                                    "tool_name": "Bash",
                                    "tool_input": arguments,
                                    "tool_response": result,
                                }
                            )
        if entry.get("type") == "system" and entry.get("subtype") == "task_notification":
            task_id, status = entry.get("task_id"), entry.get("status")
            if (
                isinstance(task_id, str)
                and task_id in self.resources
                and status in ENDED_SHELL_STATUSES
            ):
                self.observe({**self.resources[task_id], "status": status})
        return list(self.resources.values())
