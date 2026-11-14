# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Session-authorized shell snapshots, retaining ended resources and captured output."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import TYPE_CHECKING

from cachetools import LRUCache

from omnigent.db.db_models import current_workspace_id
from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    MAX_SHELL_RESOURCES,
    SHELL_SOURCES,
    is_agent_terminal_resource,
    shell_output_preview,
    shell_resource_fields,
)
from omnigent.server.schemas import BackgroundTaskInfo
from omnigent.terminals.history import ActivityEntry, bounded_output
from omnigent.util.json_types import JsonObject

if TYPE_CHECKING:
    from omnigent.stores.artifact_store import ArtifactStore


def registered_shell_resource(entry: ActivityEntry, *, can_stop: bool = False) -> JsonObject:
    """Project a captured terminal by its exact resource id, including after it ends."""
    if (
        entry.kind != "terminal"
        or not entry.terminal_id
        or is_agent_terminal_resource(entry.terminal_id)
    ):
        raise ValueError("A registered shell needs a captured terminal resource id")
    running = entry.state in {"running", "idle"}
    return {
        "id": entry.id,
        "terminal_id": entry.terminal_id,
        "type": "shell",
        "status": entry.state,
        "description": entry.name,
        "exit_code": entry.exit_status,
        "output": bounded_output(entry.output),
        **shell_resource_fields(
            source="registered_terminal",
            resource_id=entry.id,
            session_id=entry.session_id,
            output=entry.output,
            can_stop=can_stop and running,
            stop_disabled_reason="terminal_control_unavailable" if running else "shell_ended",
        ),
    }


class SessionShellResources:
    """Capture trusted producer records; callers authorize the owning session first."""

    def __init__(self, artifact_store: ArtifactStore | None = None) -> None:
        self.artifact_store = artifact_store
        self._lock = asyncio.Lock()
        self._recent: WorkspaceScopedCache[str, list[JsonObject]] = WorkspaceScopedCache(
            lambda: LRUCache(maxsize=128)
        )

    @staticmethod
    def _key(session_id: str) -> str:
        digest = hashlib.sha256(session_id.encode()).hexdigest()
        return f"session-shells/{current_workspace_id()}/{digest}.json"

    @staticmethod
    def _validated(session_id: str, records: list[object]) -> list[JsonObject]:
        validated: list[JsonObject] = []
        for raw in records[:MAX_SHELL_RESOURCES]:
            if not isinstance(raw, dict):
                raise ValueError("A shell record must be an object")
            task = BackgroundTaskInfo.model_validate(raw)
            if task.source is None or task.source not in SHELL_SOURCES or not task.resource_id:
                raise ValueError("A shell record needs a known source and resource id")
            if task.source == "registered_terminal" and is_agent_terminal_resource(
                task.terminal_id
            ):
                continue
            owner = raw.get("session_id", session_id)
            if owner != session_id:
                raise ValueError("Shell resource session mismatch")
            output = raw.get("output")
            captured = bounded_output(output if isinstance(output, str) else None)
            row = task.model_dump(mode="json")
            row.update(
                output=captured,
                **shell_resource_fields(
                    source=task.source,
                    resource_id=task.resource_id,
                    session_id=session_id,
                    output=captured,
                    # A stored observation never proves the current runtime's control.
                    stop_disabled_reason=(
                        "shell_ended"
                        if task.status in ENDED_SHELL_STATUSES
                        else "native_tui_control_transport_unavailable"
                        if task.source == "claude_native"
                        else "native_live_inventory_required"
                    ),
                ),
            )
            if captured is None:
                row["output_preview"] = shell_output_preview(task.output_preview)
            validated.append(row)
        return validated

    async def capture(self, session_id: str, records: list[object]) -> list[JsonObject]:
        """Merge bounded evidence atomically; an empty live tally does not erase history."""
        fresh = self._validated(session_id, records)
        async with self._lock:
            previous = self._recent.get(session_id)
            if previous is None:
                previous = []
                if self.artifact_store is not None:
                    try:
                        payload = await asyncio.to_thread(
                            self.artifact_store.get, self._key(session_id)
                        )
                    except KeyError:
                        pass
                    else:
                        stored = json.loads(payload)
                        if not isinstance(stored, list):
                            raise ValueError("A retained shell snapshot must be a list")
                        previous = self._validated(session_id, stored)
            merged = {
                (row["source"], row["resource_id"]): row
                for row in previous
                if not (
                    row.get("source") == "registered_terminal"
                    and is_agent_terminal_resource(
                        row.get("terminal_id") if isinstance(row.get("terminal_id"), str) else None
                    )
                )
            }
            for row in fresh:
                key = (row["source"], row["resource_id"])
                old = merged.get(key)
                if old is not None:
                    if (
                        old.get("status") in ENDED_SHELL_STATUSES
                        and row.get("status") not in ENDED_SHELL_STATUSES
                    ):
                        continue
                    if (
                        old.get("status") == "stopped"
                        and row.get("status") in ENDED_SHELL_STATUSES
                    ):
                        row["status"] = "stopped"
                    if row.get("output") is None:
                        row["output"] = old.get("output")
                        row["output_preview"] = old.get("output_preview")
                merged.pop(key, None)
                merged[key] = row
            retained = list(merged.values())[-MAX_SHELL_RESOURCES:]
            if self.artifact_store is not None and fresh:
                await asyncio.to_thread(
                    self.artifact_store.put,
                    self._key(session_id),
                    json.dumps(retained).encode(),
                )
            self._recent[session_id] = retained
            return [dict(row) for row in retained]

    async def get(self, session_id: str, source: str, resource_id: str) -> JsonObject | None:
        """Read one retained source/id pair without spawning or attaching any process."""
        return next(
            (
                row
                for row in await self.capture(session_id, [])
                if row["source"] == source and row["resource_id"] == resource_id
            ),
            None,
        )
