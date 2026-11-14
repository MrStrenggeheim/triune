# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Inspect and terminate exact native unified-exec resources through Codex RPC."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    MAX_SHELL_RESOURCES,
    shell_resource_fields,
)
from omnigent.terminals.history import bounded_output
from omnigent.util.json_types import JsonObject

if TYPE_CHECKING:
    from omnigent.harnesses.codex_native.app_server import CodexAppServerClient


class NativeShellControlUnavailable(ValueError):
    """The vendor cannot prove an exact, live and supported target."""


@dataclass
class CodexShellControls:
    """Use only handles returned by this thread's native terminal inventory."""

    client: CodexAppServerClient
    thread_id: str
    _stop_supported: bool | None = None

    async def live(self) -> list[JsonObject]:
        """Read a bounded native inventory; truncation cannot authorize a missing target."""
        cursor = None
        rows: list[JsonObject] = []
        for _ in range(4):
            params: JsonObject = {"threadId": self.thread_id, "limit": MAX_SHELL_RESOURCES}
            if cursor is not None:
                params["cursor"] = cursor
            response = await self.client.request("thread/backgroundTerminals/list", params)
            result = response.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise NativeShellControlUnavailable("native_shell_inventory_invalid")
            for row in result["data"]:
                if isinstance(row, dict):
                    rows.append(row)
            cursor = result.get("nextCursor")
            if not isinstance(cursor, str) or not cursor:
                break
        return rows

    async def supports_stop(self) -> bool:
        """Probe method support with an invalid handle that cannot name a process."""
        if self._stop_supported is None:
            try:
                await self.client.request(
                    "thread/backgroundTerminals/terminate",
                    {"threadId": self.thread_id, "processId": "triune-invalid-process-id"},
                )
            except CodexAppServerResponseError as exc:
                if exc.code == -32600 and (exc.message or "").startswith(
                    "invalid background terminal process id:"
                ):
                    self._stop_supported = True
                elif exc.code in {-32601, -32600}:
                    self._stop_supported = False
                else:
                    raise
            else:
                # An unexpected protocol accepting an invalid id proves no safe mapping.
                self._stop_supported = False
        return self._stop_supported

    async def inventory(self, session_id: str) -> list[JsonObject]:
        """Project live native handles without using command text or OS process ids."""
        rows = await self.live()
        supported = await self.supports_stop()
        resources: list[JsonObject] = []
        for row in rows[:MAX_SHELL_RESOURCES]:
            item_id, process_id = row.get("itemId"), row.get("processId")
            if not isinstance(item_id, str) or not item_id:
                continue
            can_stop = supported and isinstance(process_id, str) and bool(process_id)
            resources.append(
                {
                    "id": item_id,
                    "type": "shell",
                    "status": "running",
                    "command": row.get("command"),
                    **shell_resource_fields(
                        source="codex_native",
                        resource_id=item_id,
                        session_id=session_id,
                        can_stop=can_stop,
                        stop_disabled_reason=None
                        if can_stop
                        else "native_targeted_stop_unavailable",
                    ),
                }
            )
        return resources

    async def read(self, resource_id: str, session_id: str) -> JsonObject | None:
        """Read captured native item output without attaching, resuming or executing."""
        cursor = None
        for _ in range(4):
            params: JsonObject = {
                "threadId": self.thread_id,
                "limit": 20,
                "itemsView": "full",
            }
            if cursor is not None:
                params["cursor"] = cursor
            try:
                response = await self.client.request("thread/turns/list", params)
            except CodexAppServerResponseError as exc:
                if exc.code == -32600 and exc.message == (
                    "ephemeral threads do not support thread/turns/list"
                ):
                    # Ephemeral output is retained from actual forwarder lifecycle/delta events.
                    return None
                raise
            result = response.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise NativeShellControlUnavailable("native_shell_history_invalid")
            for turn in result["data"]:
                if not isinstance(turn, dict) or not isinstance(turn.get("items"), list):
                    continue
                for item in turn["items"]:
                    if (
                        isinstance(item, dict)
                        and item.get("id") == resource_id
                        and item.get("type") == "commandExecution"
                        and item.get("source") != "unifiedExecInteraction"
                    ):
                        output = item.get("aggregatedOutput")
                        captured = bounded_output(output if isinstance(output, str) else None)
                        return {
                            "id": resource_id,
                            "type": "shell",
                            "status": item.get("status"),
                            "command": item.get("command"),
                            "exit_code": item.get("exitCode"),
                            "output": captured,
                            **shell_resource_fields(
                                source="codex_native",
                                resource_id=resource_id,
                                session_id=session_id,
                                output=captured,
                                stop_disabled_reason=(
                                    "shell_ended"
                                    if item.get("status") in ENDED_SHELL_STATUSES
                                    else "native_live_inventory_required"
                                ),
                            ),
                        }
            cursor = result.get("nextCursor")
            if not isinstance(cursor, str) or not cursor:
                break
        return None

    async def stop(self, resource_id: str) -> bool:
        """Revalidate item-to-handle identity immediately before targeted termination."""
        matches = [row for row in await self.live() if row.get("itemId") == resource_id]
        if len(matches) != 1:
            raise NativeShellControlUnavailable("native_shell_target_missing_or_ambiguous")
        process_id = matches[0].get("processId")
        if not isinstance(process_id, str) or not process_id:
            raise NativeShellControlUnavailable("native_shell_process_handle_missing")
        if not await self.supports_stop():
            raise NativeShellControlUnavailable("native_targeted_stop_unavailable")
        response = await self.client.request(
            "thread/backgroundTerminals/terminate",
            {"threadId": self.thread_id, "processId": process_id},
        )
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("terminated"), bool):
            raise NativeShellControlUnavailable("native_shell_stop_response_invalid")
        return result["terminated"]
