# Modified for Triune.

"""Session-authorized terminal activity with durable artifact snapshots."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import sqlite3
import weakref
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, TypeVar

import httpx
from cachetools import LRUCache

from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.entities import ConversationItem
from omnigent.entities.conversation import FunctionCallData, FunctionCallOutputData
from omnigent.native.shell_resources import is_agent_terminal_resource
from omnigent.process_logging import redact_log_text
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

_Result = TypeVar("_Result")

_SHELL_TOOLS = frozenset(
    {"shell", "exec_command", "shell_command", "commandExecution", "sys_os_shell", "Bash"}
)
_EXEC_TOOLS = frozenset({"exec_command", "shell_command", "sys_os_shell"})
# Codex's mirror appends this explicit status for nonzero exits.
_EXIT_SUFFIX = re.compile(r"(?:^|\n)\[exit code: (-?\d+)\]\s*$")
# A cold scan keeps the former bounded window: 8 pages of 512 rows and 32 MiB of output.
_SCAN_PAGE = 512
_SCAN_PAGES = 8
_SCAN_OUTPUT_BYTES = 32 * 1024 * 1024
# Each retained chat holds at most two 128-entry projections with 8 KiB outputs.
_RETAINED_CHATS = 64


async def finish_in_thread(function: Callable[..., _Result], /, *args: Any) -> _Result:
    """Run blocking work to completion even when the awaiting request is cancelled.

    Callers hold a per-chat lock around shared state; releasing it while the
    worker still mutates that state would let a second worker race it.
    """
    worker = asyncio.ensure_future(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(worker)
        # Cancellation wins over an unused result or error.
        with contextlib.suppress(Exception, asyncio.CancelledError):
            worker.result()
        raise


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


@dataclass(frozen=True)
class _ShellCall:
    """The parts of a persisted shell invocation that an activity row shows."""

    position: int
    response_id: str
    call_id: str
    name: str
    agent: str
    command: str
    created_at: int

    @property
    def key(self) -> tuple[str, str]:
        return (self.response_id, self.call_id)


@dataclass(frozen=True)
class _CallOutput:
    """Completion facts of one tool output, parsed once when the output is read."""

    position: int
    completed: bool
    created_at: int
    output: str | None
    exit_suffix: int | None = None
    structured: bool = False
    background_task: bool = False
    structured_exit: int | None = None
    structured_session: bool = False
    process_running: bool = False
    source: str | None = None
    source_call_id: str | None = None


def _shell_call(item: ConversationItem, position: int) -> _ShellCall | None:
    if item.type != "function_call" or not isinstance(item.data, FunctionCallData):
        return None
    call = item.data
    if call.name.removeprefix("mcp__omnigent__") not in _SHELL_TOOLS:
        return None
    try:
        arguments = json.loads(call.arguments)
    except (ValueError, TypeError):
        return None
    if not isinstance(arguments, dict):
        return None
    command = arguments.get("command", arguments.get("cmd"))
    if not isinstance(command, str) or not command.strip():
        return None
    return _ShellCall(
        position=position,
        response_id=item.response_id,
        call_id=call.call_id,
        name=call.name,
        agent=call.agent,
        command=redact_log_text(command)[:300],
        created_at=item.created_at,
    )


def _call_output(item: ConversationItem, position: int) -> tuple[tuple[str, str], _CallOutput]:
    data = item.data
    assert isinstance(data, FunctionCallOutputData)
    raw = data.output
    facts: dict[str, Any] = {}
    if item.status == "completed" and isinstance(raw, str):
        suffix = _EXIT_SUFFIX.search(raw)
        facts["exit_suffix"] = int(suffix[1]) if suffix is not None else None
        result = None
        # Only an object result carries exit or background facts.
        if raw.lstrip().startswith("{"):
            with contextlib.suppress(ValueError):
                result = json.loads(raw)
        if isinstance(result, dict):
            code = result.get("exit_code", result.get("exit_status", result.get("exitCode")))
            facts.update(
                structured=True,
                background_task=bool(result.get("backgroundTaskId")),
                structured_exit=code
                if isinstance(code, int) and not isinstance(code, bool)
                else None,
                structured_session=result.get("session_id") is not None,
            )
        else:
            facts["process_running"] = "Process running with session ID" in raw
    native_id = data.source_call_id
    return (item.response_id, data.call_id), _CallOutput(
        position=position,
        completed=item.status == "completed",
        created_at=item.created_at,
        output=bounded_output(raw if isinstance(raw, str) else None),
        source=data.source,
        source_call_id=native_id if isinstance(native_id, str) and native_id else None,
        **facts,
    )


def _command_entry(session_id: str, call: _ShellCall, output: _CallOutput | None) -> ActivityEntry:
    """Project one shell invocation as an execution, never as a shell lifetime."""
    tool = call.name.removeprefix("mcp__omnigent__")
    complete = output is not None and output.completed
    exit_status = None
    if complete and output is not None:
        if (
            output.exit_suffix is not None
            and call.name == "shell"
            and call.agent == "codex-native-ui"
        ):
            exit_status = output.exit_suffix
        if tool == "Bash" and output.background_task:
            complete = False
        if tool in _EXEC_TOOLS:
            if output.structured:
                if output.structured_exit is not None:
                    exit_status = output.structured_exit
                elif output.structured_session:
                    complete = False
            elif output.process_running:
                complete = False
    source = None
    source_call_id = None
    if call.agent == "codex-native-ui" and call.name in {"shell", "commandExecution"}:
        # Codex's commandExecution producer persists item.id verbatim as call_id.
        source, source_call_id = "codex_native", call.call_id
    elif call.name == "Bash":
        if output is not None and output.source == "claude_native":
            source = "claude_native"
            if output.source_call_id is not None:
                source_call_id = output.source_call_id
                complete = False
        elif call.agent == "claude-native-ui":
            source = "claude_native"
    digest = hashlib.sha256(f"{session_id}:{call.response_id}:{call.call_id}".encode()).hexdigest()
    return ActivityEntry(
        id=f"command_{digest}",
        kind="command",
        session_id=session_id,
        turn_id=call.response_id if call.response_id != "codex_native" else None,
        name=call.command,
        state="exited" if complete else "unknown",
        started_at=call.created_at,
        ended_at=output.created_at if complete and output is not None else None,
        exit_status=exit_status,
        output=output.output if output is not None else None,
        owner_id=session_id,
        source=source,
        source_call_id=source_call_id,
    )


@dataclass
class RecordedCommandIndex:
    """The newest persisted shell calls and their outputs, advanced by item position.

    Tool calls and outputs are append-only, so each type keeps its own position
    cursor and a later read decodes only rows written since the previous one.
    """

    scanned: bool = False
    call_cursor: int = -1
    output_cursor: int = -1
    truncated: bool = False
    calls: dict[tuple[str, str], _ShellCall] = field(default_factory=dict)
    outputs: dict[tuple[str, str], _CallOutput] = field(default_factory=dict)

    def add_calls(self, items: Iterable[tuple[ConversationItem, int]]) -> None:
        for item, position in items:
            call = _shell_call(item, position)
            previous = self.calls.get(call.key) if call is not None else None
            if call is not None and (previous is None or call.position > previous.position):
                self.calls[call.key] = call

    def add_outputs(self, items: Iterable[tuple[ConversationItem, int]]) -> None:
        for item, position in items:
            if item.type != "function_call_output" or not isinstance(
                item.data, FunctionCallOutputData
            ):
                continue
            if (item.response_id, item.data.call_id) not in self.calls:
                continue
            key, output = _call_output(item, position)
            previous = self.outputs.get(key)
            if previous is None or output.position > previous.position:
                self.outputs[key] = output

    def prune(self) -> None:
        """Keep the newest calls that one activity page can show."""
        if len(self.calls) <= MAX_ENTRIES:
            return
        newest = sorted(self.calls.values(), key=lambda call: call.position, reverse=True)
        self.calls = {call.key: call for call in newest[:MAX_ENTRIES]}
        self.outputs = {key: value for key, value in self.outputs.items() if key in self.calls}

    def entries(self, session_id: str) -> list[ActivityEntry]:
        """Return command rows newest first."""
        calls = sorted(self.calls.values(), key=lambda call: call.position, reverse=True)
        return [_command_entry(session_id, call, self.outputs.get(call.key)) for call in calls]

    def scan(self, store: Any, session_id: str) -> None:
        """Read rows written since the last scan, or the newest bounded window when cold."""
        if self.scanned:
            calls, call_cursor, calls_behind = _read_after(
                store, session_id, "function_call", self.call_cursor
            )
            outputs, output_cursor, outputs_behind = _read_after(
                store, session_id, "function_call_output", self.output_cursor
            )
            if not calls_behind and not outputs_behind:
                self.add_calls(calls)
                self.add_outputs(outputs)
                self.call_cursor, self.output_cursor = call_cursor, output_cursor
                self.prune()
                return
        # Cold, or too far behind for an incremental read: take the newest window.
        self.calls, self.outputs, self.truncated = {}, {}, False
        self.call_cursor, self.output_cursor, self.scanned = -1, -1, True
        self._scan_newest_calls(store, session_id)
        self._scan_newest_outputs(store, session_id)

    def _scan_newest_calls(self, store: Any, session_id: str) -> None:
        through = None
        for _ in range(_SCAN_PAGES):
            page = store.list_items(
                session_id,
                limit=_SCAN_PAGE,
                order="desc",
                type="function_call",
                through_position=through,
            )
            rows = _positioned(page.data, "function_call")
            if not rows:
                break
            self.call_cursor = max(self.call_cursor, rows[0][1])
            self.add_calls(rows)
            if len(self.calls) >= MAX_ENTRIES or not page.has_more:
                break
            through = rows[-1][1] - 1
        else:
            self.truncated = True
        self.prune()

    def _scan_newest_outputs(self, store: Any, session_id: str) -> None:
        """Read outputs back to the oldest retained call, within the byte bound."""
        oldest = min((call.position for call in self.calls.values()), default=None)
        through = None
        size = 0
        for _ in range(_SCAN_PAGES):
            page = store.list_items(
                session_id,
                limit=1 if oldest is None else _SCAN_PAGE,
                order="desc",
                type="function_call_output",
                through_position=through,
            )
            rows = _positioned(page.data, "function_call_output")
            if rows:
                self.output_cursor = max(self.output_cursor, rows[0][1])
            if oldest is None or not rows:
                return
            wanted = []
            for item, position in rows:
                output = getattr(item.data, "output", None)
                size += len(output.encode("utf-8")) if isinstance(output, str) else 0
                if position < oldest or size > _SCAN_OUTPUT_BYTES:
                    self.truncated = self.truncated or position >= oldest
                    break
                wanted.append((item, position))
            self.add_outputs(wanted)
            if len(wanted) < len(rows) or not page.has_more:
                return
            through = rows[-1][1] - 1
        self.truncated = True


def _positioned(
    items: Iterable[ConversationItem], item_type: str
) -> list[tuple[ConversationItem, int]]:
    """Keep one type's persisted rows; every stored item carries its position."""
    return [
        (item, item.position)
        for item in items
        if item.type == item_type and item.position is not None
    ]


def _read_after(
    store: Any, session_id: str, item_type: str, cursor: int
) -> tuple[list[tuple[ConversationItem, int]], int, bool]:
    """Read one type's rows after *cursor*; report whether more remain past the bound."""
    rows: list[tuple[ConversationItem, int]] = []
    for _ in range(_SCAN_PAGES):
        page = store.list_items(
            session_id,
            limit=_SCAN_PAGE,
            order="asc",
            type=item_type,
            after_position=cursor,
        )
        batch = [
            (item, position)
            for item, position in _positioned(page.data, item_type)
            if position > cursor
        ]
        rows.extend(batch)
        if batch:
            cursor = batch[-1][1]
        if not page.has_more or not batch:
            return rows, cursor, False
    return rows, cursor, True


def recorded_commands(items: list[ConversationItem], session_id: str) -> list[ActivityEntry]:
    """Project persisted shell invocations from a newest-first item list."""
    index = RecordedCommandIndex()
    # Newest-first order stands in for positions the caller may not have.
    positioned = [(item, len(items) - offset) for offset, item in enumerate(items)]
    index.add_calls(positioned)
    index.prune()
    index.add_outputs(positioned)
    return index.entries(session_id)


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


@dataclass
class _ChatActivity:
    """One chat's command index and the entries its stored snapshot holds."""

    commands: RecordedCommandIndex = field(default_factory=RecordedCommandIndex)
    retained: list[ActivityEntry] | None = None
    stored_data: list[dict[str, object]] | None = None


class SessionActivityService:
    """Cache captured history; callers must authorize the session before reading."""

    def __init__(self, artifact_store: ArtifactStore | None) -> None:
        self.artifact_store = artifact_store
        self._chats: WorkspaceScopedCache[str, _ChatActivity] = WorkspaceScopedCache(
            lambda: LRUCache(maxsize=_RETAINED_CHATS)
        )
        # One lock per chat in use; unrelated chats never wait for each other.
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    @staticmethod
    def _key(session_id: str) -> str:
        digest = hashlib.sha256(session_id.encode()).hexdigest()
        return f"session-activity/{digest}.json"

    def _lock(self, session_id: str) -> asyncio.Lock:
        lock = self._locks.get(session_id)
        if lock is None:
            lock = self._locks[session_id] = asyncio.Lock()
        return lock

    async def _capture(
        self,
        session_id: str,
        runner_client: httpx.AsyncClient | None,
        local_registry: TerminalRegistry | None,
    ) -> tuple[list[ActivityEntry], bool, list[str]]:
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
        return fresh, available, warnings

    async def page(
        self,
        session_id: str,
        *,
        runner_client: httpx.AsyncClient | None = None,
        local_registry: TerminalRegistry | None = None,
        parent_agent_id: str | None = None,
        conversation_store: object | None = None,
        include_commands: bool = True,
    ) -> ActivityPage:
        """Merge fresh evidence with retained launches, keeping ended rows offline.

        ``include_commands=False`` captures terminals only and leaves retained
        command rows exactly as stored.
        """
        fresh, available, warnings = await self._capture(session_id, runner_client, local_registry)
        commands_store = (
            conversation_store
            if include_commands
            and conversation_store is not None
            and hasattr(conversation_store, "list_items")
            else None
        )
        async with self._lock(session_id):
            page, merge_warnings = await finish_in_thread(
                self._merge,
                self._chat(session_id),
                session_id,
                fresh,
                available,
                commands_store,
                parent_agent_id,
                include_commands,
            )
        warnings.extend(merge_warnings)
        if warnings:
            page["warning"] = " ".join([str(page["warning"]), *warnings])
        return page

    def _chat(self, session_id: str) -> _ChatActivity:
        """Look up chat state on the event loop; the LRU cache is not thread-safe."""
        chat = self._chats.get(session_id)
        if chat is None:
            chat = self._chats[session_id] = _ChatActivity()
        return chat

    def _merge(
        self,
        chat: _ChatActivity,
        session_id: str,
        fresh: list[ActivityEntry],
        available: bool,
        store: object | None,
        parent_agent_id: str | None,
        include_commands: bool,
    ) -> tuple[ActivityPage, list[str]]:
        """Merge under the chat lock in a worker thread; writes only a changed snapshot."""
        warnings: list[str] = []
        if store is not None:
            chat.commands.scan(store, session_id)
            fresh = [*fresh, *chat.commands.entries(session_id)]
            if chat.commands.truncated:
                warnings.append("Persisted command scan reached its bounded history window.")
        for entry in fresh:
            if parent_agent_id is not None:
                entry.parent_agent_id = parent_agent_id
        if chat.retained is None:
            chat.retained = []
            if self.artifact_store is not None:
                try:
                    stored = json.loads(self.artifact_store.get(self._key(session_id)))
                    chat.retained = _entries(stored, session_id)
                    chat.stored_data = stored["data"]
                except KeyError:
                    pass
                except (OSError, ValueError) as exc:
                    logger.warning(
                        "Activity snapshot unreadable for %s: %s", session_id, type(exc).__name__
                    )
                    warnings.append("A retained activity snapshot could not be read.")
        merged = {
            entry.id: _disconnected(entry)
            if include_commands or entry.kind == "terminal"
            else entry
            for entry in chat.retained
        }
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
                if not (entry.kind == "terminal" and is_agent_terminal_resource(entry.terminal_id))
            ),
            key=lambda entry: (entry.state not in ("running", "idle"), -(entry.started_at or 0)),
        )[:MAX_ENTRIES]
        page = activity_page(entries, available=available)
        if store is not None:
            page["coverage"]["non_tty_commands"] = "persisted_tools"
            warnings.append("Persisted commands may lack completion or exit status.")
        if self.artifact_store is None:
            warnings.append(
                "Server history persistence is unavailable; history relies on runner storage."
            )
        elif fresh and page["data"] != chat.stored_data:
            try:
                self.artifact_store.put(self._key(session_id), json.dumps(page).encode())
            except OSError:
                logger.exception("Could not retain activity snapshot for %s", session_id)
                warnings.append(
                    "Server history persistence failed; runner capture may still be retained."
                )
            else:
                chat.retained, chat.stored_data = entries, page["data"]
        elif fresh:
            chat.retained = entries
        return page, warnings
