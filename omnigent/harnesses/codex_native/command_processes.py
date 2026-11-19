# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Project native command lifecycle events into the shared shell inventory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    MAX_SHELL_RESOURCES,
    shell_output_preview,
    shell_resource_fields,
)
from omnigent.terminals.history import bounded_output
from omnigent.util.json_types import JsonObject

_logger = logging.getLogger(__name__)


@dataclass
class CodexCommandProcesses:
    """Retain live commands until Codex reports their actual exit."""

    commands: dict[str, JsonObject] = field(default_factory=dict)
    resources: dict[str, JsonObject] = field(default_factory=dict)
    posted: JsonObject | None = None
    _dirty_output: set[str] = field(default_factory=set, repr=False)
    _last_output_publish: float = field(default=0, repr=False)
    _pending_full: bool = field(default=False, repr=False)
    _pending_ids: set[str] = field(default_factory=set, repr=False)
    _publisher: asyncio.Task[None] | None = field(default=None, repr=False)
    _closing: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def schedule_publication(
        self, publish: Callable[[JsonObject], Awaitable[bool]], *, output_id: str | None = None
    ) -> None:
        """Only the inventory publisher waits on acknowledgment of a shell snapshot."""
        if self._closing.is_set():
            return
        if output_id is None or len(self._pending_ids) >= MAX_SHELL_RESOURCES:
            self._pending_full = True
            self._pending_ids.clear()
        elif not self._pending_full:
            self._pending_ids.add(output_id)
        if self._publisher is None or self._publisher.done():
            self._publisher = asyncio.create_task(
                self._publish_pending(publish), name="codex-shell-inventory"
            )

    async def _publish_pending(self, publish: Callable[[JsonObject], Awaitable[bool]]) -> None:
        backoff = 2.0
        while self._pending_full or self._pending_ids:
            if not self._pending_full and not self._closing.is_set():
                await asyncio.sleep(0.2)
            full, ids = self._pending_full, self._pending_ids
            self._pending_full, self._pending_ids = False, set()
            snapshot = self.snapshot(resource_ids=None if full else sorted(ids))
            if snapshot is None:
                continue
            try:
                delivered = await publish(snapshot)
            except Exception:
                _logger.exception("Codex shell inventory publication failed")
                delivered = False
            if delivered:
                self.posted = snapshot
                backoff = 2.0
            elif not self._closing.is_set():
                self._pending_full |= full
                if not self._pending_full:
                    self._pending_ids.update(ids)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._closing.wait(), timeout=backoff)
                backoff = min(30.0, backoff * 2)

    async def close(self) -> None:
        """Bound the final best-effort inventory flush to an open HTTP client."""
        self._closing.set()
        if self._publisher is None:
            return
        try:
            await asyncio.wait_for(self._publisher, timeout=2)
        except TimeoutError:
            _logger.warning("Codex shell inventory publication timed out at shutdown")

    def observe(
        self,
        item: JsonObject,
        *,
        session_id: str | None = None,
        turn_id: str | None = None,
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
        if turn_id:
            resource["turn_id"] = turn_id
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
        """Capture output and return a throttled snapshot for snapshot consumers."""
        if not self.capture_output(item_id, delta):
            return None
        return self.flush_output(now=now)

    def capture_output(self, item_id: str, delta: str) -> bool:
        """Capture stdout/stderr synchronously; only registered shells own output."""
        previous = self.resources.get(item_id)
        if previous is None or not delta:
            return False
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
        return True

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
