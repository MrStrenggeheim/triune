# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Project native command lifecycle events into the shared shell inventory."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    MAX_SHELL_RESOURCES,
    shell_output_preview,
    shell_resource_fields,
)
from omnigent.terminals.history import bounded_output
from omnigent.util.json_types import JsonObject


@dataclass
class CodexCommandProcesses:
    """Retain live commands until Codex reports their actual exit."""

    commands: dict[str, JsonObject] = field(default_factory=dict)
    resources: dict[str, JsonObject] = field(default_factory=dict)
    posted: JsonObject | None = None
    sync_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _dirty_output: set[str] = field(default_factory=set, repr=False)
    _last_output_publish: float = field(default=0, repr=False)

    def observe(
        self,
        item: JsonObject,
        *,
        session_id: str | None = None,
        targeted_stop_supported: bool = False,
    ) -> JsonObject | None:
        """Return a changed snapshot, excluding transient stdin interactions."""
        if item.get("type") != "commandExecution":
            return None
        if item.get("source") == "unifiedExecInteraction":
            return None
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            return None
        status = item.get("status")
        previous = self.resources.get(item_id, {})
        if status == "inProgress":
            # Replayed starts and late output must never resurrect an ended command.
            if previous.get("status") in ENDED_SHELL_STATUSES:
                return None
            command = item.get("command")
            if not isinstance(command, str) or not command:
                return None
            resource: JsonObject = {
                "id": item_id,
                "type": "shell",
                "status": "running",
                "command": command,
            }
        elif status in ENDED_SHELL_STATUSES:
            resource = {**previous, "id": item_id, "type": "shell", "status": status}
            command = item.get("command")
            if isinstance(command, str):
                resource["command"] = command
            code = item.get("exitCode")
            if isinstance(code, int) and not isinstance(code, bool):
                resource["exit_code"] = code
            self.commands.pop(item_id, None)
        else:
            return None
        output = item.get("aggregatedOutput")
        if not isinstance(output, str) or not output:
            output = previous.get("output")
        captured = bounded_output(output if isinstance(output, str) else None)
        resource["output"] = captured
        process_id = item.get("processId")
        resource.update(
            shell_resource_fields(
                source="codex_native",
                resource_id=item_id,
                session_id=session_id,
                output=captured,
                can_stop=(
                    status == "inProgress"
                    and targeted_stop_supported
                    and isinstance(process_id, str)
                    and bool(process_id)
                ),
                stop_disabled_reason=(
                    "shell_ended"
                    if status in ENDED_SHELL_STATUSES
                    else "native_targeted_stop_unverified"
                ),
            )
        )
        self.resources[item_id] = resource
        if status == "inProgress":
            self.commands[item_id] = resource
        self._prune()
        self._dirty_output.clear()
        return self.snapshot()

    def observe_output(
        self, item_id: str, delta: str, *, now: float | None = None
    ) -> JsonObject | None:
        """Append actual stdout/stderr without inventing a shell from an unknown delta."""
        previous = self.resources.get(item_id)
        if previous is None or not delta:
            return None
        output = previous.get("output")
        captured = bounded_output((output if isinstance(output, str) else "") + delta)
        resource = {
            **previous,
            "output": captured,
            "output_preview": shell_output_preview(captured),
        }
        self.resources[item_id] = resource
        if item_id in self.commands:
            self.commands[item_id] = resource
        self._dirty_output.add(item_id)
        return self.flush_output(now=now)

    def flush_output(self, *, now: float | None = None, force: bool = False) -> JsonObject | None:
        """Coalesce output to 200ms; the forwarder's output coalescer flushes a quiet tail."""
        observed_at = time.monotonic() if now is None else now
        if not self._dirty_output or (not force and observed_at - self._last_output_publish < 0.2):
            return None
        changed = sorted(self._dirty_output)
        self._dirty_output.clear()
        self._last_output_publish = observed_at
        return self.snapshot(resource_ids=changed)

    def _prune(self) -> None:
        for resource_id in list(self.resources):
            if len(self.resources) <= MAX_SHELL_RESOURCES:
                break
            if resource_id not in self.commands:
                del self.resources[resource_id]

    def snapshot(self, *, resource_ids: list[str] | None = None) -> JsonObject | None:
        """Keep the legacy active tally and publish retained resources separately."""
        snapshot: JsonObject = {
            "background_task_count": len(self.commands),
            "background_tasks": [
                {key: value for key, value in row.items() if key != "output"}
                for row in self.commands.values()
            ],
            "shell_resources": [
                self.resources[resource_id]
                for resource_id in (resource_ids if resource_ids is not None else self.resources)
                if resource_id in self.resources
            ],
        }
        return snapshot if snapshot != self.posted else None
