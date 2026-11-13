# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Project native command lifecycle events into the shared shell inventory."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from omnigent.util.json_types import JsonObject


@dataclass
class CodexCommandProcesses:
    """Retain live commands until Codex reports their actual exit."""

    commands: dict[str, JsonObject] = field(default_factory=dict)
    posted: JsonObject | None = None
    sync_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def observe(self, item: JsonObject) -> JsonObject | None:
        """Return a changed snapshot, excluding transient stdin interactions."""
        if item.get("type") != "commandExecution":
            return None
        if item.get("source") == "unifiedExecInteraction":
            return None
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            return None
        status = item.get("status")
        if status == "inProgress":
            command = item.get("command")
            if not isinstance(command, str) or not command:
                return None
            self.commands[item_id] = {
                "id": item_id,
                "type": "shell",
                "status": "running",
                "command": command,
            }
        elif status in {"completed", "failed", "declined"}:
            self.commands.pop(item_id, None)
        else:
            return None
        snapshot: JsonObject = {
            "background_task_count": len(self.commands),
            "background_tasks": list(self.commands.values()),
        }
        return snapshot if snapshot != self.posted else None
