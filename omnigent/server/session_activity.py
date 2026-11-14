# Modified for Triune.

"""Session-authorized terminal activity with durable artifact snapshots."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
from typing import TYPE_CHECKING

import httpx

from omnigent.entities import ConversationItem
from omnigent.entities.conversation import FunctionCallData, FunctionCallOutputData
from omnigent.native.shell_resources import is_agent_terminal_resource
from omnigent.process_logging import redact_log_text
from omnigent.server.agent_file_diff import read_recorded_turn_items
from omnigent.stores.artifact_store import ArtifactStore
from omnigent.terminals.history import (
    MAX_ENTRIES,
    ActivityEntry,
    ActivityPage,
    activity_page,
    bounded_output,
)

if TYPE_CHECKING:
    from omnigent.terminals.registry import TerminalRegistry

logger = logging.getLogger(__name__)


def _entries(payload: object, session_id: str) -> list[ActivityEntry]:
    """Validate a capture at the transport boundary; never import another chat."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("Activity must contain a data list")
    entries = [ActivityEntry.model_validate(row) for row in payload["data"][:MAX_ENTRIES]]
    if any(entry.session_id != session_id for entry in entries):
        raise ValueError("Activity session mismatch")
    for entry in entries:
        entry.output = bounded_output(entry.output)
    return entries


def _disconnected(entry: ActivityEntry) -> ActivityEntry:
    if entry.state in ("running", "idle", "unknown"):
        return entry.model_copy(update={"state": "disconnected"})
    return entry


def recorded_commands(items: list[ConversationItem], session_id: str) -> list[ActivityEntry]:
    """Project persisted shell invocations as executions, never shell lifetimes."""
    outputs = {
        (item.response_id, item.data.call_id): item
        for item in reversed(items)
        if item.type == "function_call_output" and isinstance(item.data, FunctionCallOutputData)
    }
    commands = {}
    for item in items:
        if item.type != "function_call" or not isinstance(item.data, FunctionCallData):
            continue
        call = item.data
        if call.name not in {"shell", "exec_command", "shell_command", "commandExecution", "Bash"}:
            continue
        try:
            arguments = json.loads(call.arguments)
        except (ValueError, TypeError):
            continue
        if not isinstance(arguments, dict):
            continue
        command = arguments.get("command", arguments.get("cmd"))
        if not isinstance(command, str) or not command.strip():
            continue
        key = (item.response_id, call.call_id)
        if key in commands:
            continue
        output_item = outputs.get(key)
        output = (
            output_item.data.output
            if output_item is not None and isinstance(output_item.data, FunctionCallOutputData)
            else None
        )
        complete = output_item is not None and output_item.status == "completed"
        exit_status = None
        if complete and isinstance(output, str):
            # Codex's mirror appends this explicit status for nonzero exits.
            status = re.search(r"(?:^|\n)\[exit code: (-?\d+)\]\s*$", output)
            if status is not None and call.name == "shell" and call.agent == "codex-native-ui":
                exit_status = int(status[1])
            try:
                result = json.loads(output)
            except ValueError:
                result = None
            if call.name in {"exec_command", "shell_command"}:
                if isinstance(result, dict):
                    code = result.get(
                        "exit_code", result.get("exit_status", result.get("exitCode"))
                    )
                    if isinstance(code, int) and not isinstance(code, bool):
                        exit_status = code
                    elif result.get("session_id") is not None:
                        complete = False
                elif "Process running with session ID" in output:
                    complete = False
        source = None
        source_call_id = None
        if call.agent == "codex-native-ui" and call.name in {"shell", "commandExecution"}:
            # Codex's commandExecution producer persists item.id verbatim as call_id.
            source, source_call_id = "codex_native", call.call_id
        elif call.name == "Bash":
            native_output = output_item.data if output_item is not None else None
            if getattr(native_output, "source", None) == "claude_native":
                source = "claude_native"
                native_id = getattr(native_output, "source_call_id", None)
                if isinstance(native_id, str) and native_id:
                    source_call_id = native_id
            elif call.agent == "claude-native-ui":
                source = "claude_native"
        digest = hashlib.sha256(
            f"{session_id}:{item.response_id}:{call.call_id}".encode()
        ).hexdigest()
        commands[key] = ActivityEntry(
            id=f"command_{digest}",
            kind="command",
            session_id=session_id,
            name=redact_log_text(command)[:300],
            state="exited" if complete else "unknown",
            started_at=item.created_at,
            ended_at=output_item.created_at if complete and output_item is not None else None,
            exit_status=exit_status,
            output=bounded_output(output),
            owner_id=session_id,
            source=source,
            source_call_id=source_call_id,
        )
        if len(commands) == MAX_ENTRIES:
            break
    return list(commands.values())


def merge_activity_pages(
    pages: list[ActivityPage],
    *,
    include_children: bool,
    truncated: bool,
) -> ActivityPage:
    """Combine already-authorized sessions while retaining each entry's provenance."""
    entries = [ActivityEntry.model_validate(row) for page in pages for row in page["data"]]
    entries.sort(
        key=lambda entry: (entry.state not in ("running", "idle"), -(entry.started_at or 0))
    )
    result = activity_page(entries, available=False)
    coverage = result["coverage"]
    captured = [page["coverage"]["terminals"] == "captured" for page in pages]
    coverage["terminals"] = (
        "captured" if all(captured) else "partial" if any(captured) else "unavailable"
    )
    if any(page["coverage"]["non_tty_commands"] == "persisted_tools" for page in pages):
        coverage["non_tty_commands"] = "persisted_tools"
    coverage["children"] = "accessible_descendants" if include_children else "session_only"
    coverage["max_sessions"] = 32
    warnings = list(dict.fromkeys(str(page["warning"]) for page in pages if page.get("warning")))
    if truncated:
        warnings.append("Child activity reached the 32-session scan limit.")
    if len(entries) > MAX_ENTRIES:
        warnings.append("Activity reached the combined 128-entry retention limit.")
    result["warning"] = " ".join(warnings)
    return result


class SessionActivityService:
    """Cache captured history; callers must authorize the session before reading."""

    def __init__(self, artifact_store: ArtifactStore | None) -> None:
        self.artifact_store = artifact_store
        # Serializes read/merge/write for this router without retaining a lock per chat.
        self._lock = asyncio.Lock()

    @staticmethod
    def _key(session_id: str) -> str:
        digest = hashlib.sha256(session_id.encode()).hexdigest()
        return f"session-activity/{digest}.json"

    async def page(
        self,
        session_id: str,
        *,
        runner_client: httpx.AsyncClient | None = None,
        local_registry: TerminalRegistry | None = None,
        parent_agent_id: str | None = None,
        conversation_store: object | None = None,
    ) -> ActivityPage:
        """Merge fresh evidence with retained launches, keeping ended rows offline."""
        warnings: list[str] = []
        available = False
        fresh: list[ActivityEntry] = []
        try:
            if runner_client is not None:
                response = await runner_client.get(
                    f"/v1/sessions/{session_id}/activity", timeout=10
                )
                response.raise_for_status()
                payload = response.json()
                fresh = _entries(payload, session_id)
                coverage = payload.get("coverage", {})
                if not isinstance(coverage, dict):
                    raise ValueError("Activity coverage must be an object")
                available = coverage.get("terminals") == "captured"
            elif local_registry is not None:
                fresh = await asyncio.to_thread(local_registry.activity_entries, session_id)
                available = not local_registry.activity_capture_failed
        except (httpx.HTTPError, ValueError, OSError, sqlite3.Error) as exc:
            logger.warning(
                "Activity capture unavailable for %s: %s", session_id, type(exc).__name__
            )
            warnings.append(
                "Current terminal activity is unavailable; retained live entries are disconnected."
            )
        if not available:
            fresh = [_disconnected(entry) for entry in fresh]
            warnings.append(
                "Current terminal connection or capture is unavailable; exit is not inferred."
            )
        commands_available = conversation_store is not None and hasattr(
            conversation_store, "list_items"
        )
        if commands_available:
            items, truncated = await asyncio.to_thread(
                read_recorded_turn_items, conversation_store, session_id
            )
            fresh.extend(recorded_commands(items, session_id))
            if truncated:
                warnings.append("Persisted command scan reached its bounded history window.")
        for entry in fresh:
            if parent_agent_id is not None:
                entry.parent_agent_id = parent_agent_id
        async with self._lock:
            retained: list[ActivityEntry] = []
            if self.artifact_store is not None:
                try:
                    raw = await asyncio.to_thread(self.artifact_store.get, self._key(session_id))
                    retained = _entries(json.loads(raw), session_id)
                except KeyError:
                    pass
                except (OSError, ValueError) as exc:
                    logger.warning(
                        "Activity snapshot unreadable for %s: %s", session_id, type(exc).__name__
                    )
                    warnings.append("A retained activity snapshot could not be read.")
            merged = {entry.id: _disconnected(entry) for entry in retained}
            for entry in fresh:
                previous = merged.get(entry.id)
                # An incomplete response must not erase already captured exit evidence.
                if previous is not None and previous.state == "exited" and entry.state != "exited":
                    continue
                merged[entry.id] = entry
            entries = sorted(
                (
                    entry
                    for entry in merged.values()
                    if not (
                        entry.kind == "terminal" and is_agent_terminal_resource(entry.terminal_id)
                    )
                ),
                key=lambda entry: (
                    entry.state not in ("running", "idle"),
                    -(entry.started_at or 0),
                ),
            )[:MAX_ENTRIES]
            page = activity_page(entries, available=available)
            if commands_available:
                page["coverage"]["non_tty_commands"] = "persisted_tools"
                warnings.append("Persisted commands may lack completion or exit status.")
            if self.artifact_store is not None and fresh:
                try:
                    await asyncio.to_thread(
                        self.artifact_store.put,
                        self._key(session_id),
                        json.dumps(page).encode(),
                    )
                except OSError:
                    logger.exception("Could not retain activity snapshot for %s", session_id)
                    warnings.append(
                        "Server history persistence failed; runner capture may still be retained."
                    )
            elif self.artifact_store is None:
                warnings.append(
                    "Server history persistence is unavailable; history relies on runner storage."
                )
        if warnings:
            page["warning"] = " ".join([str(page["warning"]), *warnings])
        return page
