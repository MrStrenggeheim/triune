# Modified for Triune.

"""Durable parent-chat links for subagent delegation and returned results."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterator
from typing import Literal

from omnigent.entities import (
    Conversation,
    ConversationItem,
    FunctionCallData,
    FunctionCallOutputData,
    MessageData,
    NewConversationItem,
    ResourceEventData,
    SlashCommandData,
)
from omnigent.harness_aliases import is_native_harness
from omnigent.harnesses.codex_native.side_chat import is_side_chat_child
from omnigent.native.child_metadata import child_metadata, short_task
from omnigent.runtime import session_stream
from omnigent.server.schemas import OutputItemDoneEvent, OutputItemUpdatedEvent
from omnigent.stores import ConversationStore

_logger = logging.getLogger(__name__)
_TASK_NOTIFICATION_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.DOTALL)
_TERMINAL_TASK_STATUS_RE = re.compile(
    r"<status>\s*(completed|failed|cancelled|killed)\s*</status>"
)
_TASK_ID_RE = re.compile(r"<(task-id|tool-use-id)>\s*([^<]+?)\s*</\1>")
_TASK_REPORT_RE = re.compile(r"<(summary|result)>(.*?)</\1>", re.DOTALL)
_COMPLETION_EVENT_TYPE = "session.subagent.completion-observed"
_COMPLETION_RESOURCE_TYPE = "subagent_completion"
_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
_activity_write_lock = asyncio.Lock()


def native_subagent_terminal_status(
    status: str,
    *,
    harness: str | None,
    turn_outcome: object = None,
    turn_completed: object = None,
) -> str | None:
    """A Claude or unresolved-harness idle needs an explicit completion signal."""
    if status not in {"idle", "failed"}:
        return None
    if isinstance(turn_outcome, str) and turn_outcome in {"completed", "failed", "cancelled"}:
        return turn_outcome
    if status == "failed":
        return "failed"
    if harness in {None, "auto", "any", "claude-native"} and turn_completed is not True:
        return None
    return "completed"


def _title(child: Conversation) -> str:
    named = (
        child.task_summary
        or child.labels.get("omnigent.claude_native.description")
        or child.labels.get("omnigent.codex_native.agent_nickname")
        or child.labels.get("omnigent.codex_native.agent_role")
    )
    if named:
        return named
    title = child.title or ""
    if child.labels.get("omnigent.wrapper", "").endswith("-subagent"):
        if child.sub_agent_name:
            return child.sub_agent_name.rpartition(":")[2]
        prefix = title.partition(":")[0]
        if prefix.endswith("-native-ui-subagent"):
            return "Sub-agent"
        return prefix or child.sub_agent_name or "Sub-agent"
    if title.startswith("ui:"):
        return title.split(":", 2)[-1]
    return title.partition(":")[2] or title or child.sub_agent_name or "Sub-agent"


def _completion_marker_id(kind: str, native_id: str) -> str:
    key = f"claude-subagent-completion:{kind}:{native_id}"
    return hashlib.sha256(key.encode()).hexdigest()[:32]


def _completion_marker(
    kind: str, native_id: str, status: str, metadata: dict[str, object]
) -> NewConversationItem:
    stable_id = _completion_marker_id(kind, native_id)
    return NewConversationItem(
        type="resource_event",
        stable_id=stable_id,
        response_id="subagent_" + stable_id,
        data=ResourceEventData(
            event_type=_COMPLETION_EVENT_TYPE,
            resource_id=native_id,
            resource_type=_COMPLETION_RESOURCE_TYPE,
            resource={"kind": kind, "status": status, **metadata},
        ),
    )


def _completion_status(
    parent_id: str,
    kind: str,
    native_id: str,
    store: ConversationStore,
) -> str | None:
    marker = store.get_item(parent_id, _completion_marker_id(kind, native_id))
    if marker is None or not isinstance(marker.data, ResourceEventData):
        return None
    resource = marker.data.resource
    status = resource.get("status") if isinstance(resource, dict) else None
    if (
        marker.data.event_type != _COMPLETION_EVENT_TYPE
        or marker.data.resource_id != native_id
        or marker.data.resource_type != _COMPLETION_RESOURCE_TYPE
        or not isinstance(resource, dict)
        or resource.get("kind") != kind
        or not isinstance(status, str)
        or status not in _TERMINAL_STATUSES
    ):
        return None
    return status


async def _recorded_completion_status(
    parent_id: str,
    child: Conversation,
    store: ConversationStore,
) -> str | None:
    for kind, label in (
        ("task", "omnigent.claude_native.subagent_id"),
        ("call", "omnigent.claude_native.tool_use_id"),
    ):
        native_id = child.labels.get(label)
        if native_id:
            status = await asyncio.to_thread(_completion_status, parent_id, kind, native_id, store)
            if status:
                return status
    return None


def _completion_result(
    parent_id: str, captured: dict[str, object], store: ConversationStore
) -> dict[str, object]:
    for kind, field in (
        ("task", "native_task_id"),
        ("call", "dispatch_id"),
    ):
        native_id = captured.get(field)
        if (
            not isinstance(native_id, str)
            or not native_id
            or _completion_status(parent_id, kind, native_id, store) is None
        ):
            continue
        marker = store.get_item(parent_id, _completion_marker_id(kind, native_id))
        if marker is not None and isinstance(marker.data, ResourceEventData):
            resource = marker.data.resource
            if isinstance(resource, dict):
                metadata = {
                    key: resource[key]
                    for key in ("result_text", "agent_name", "result_item_id")
                    if resource.get(key)
                }
                item_id = metadata.pop("result_item_id", None)
                if item_id:
                    metadata["result_ref"] = {"conversation_id": parent_id, "item_id": item_id}
                    metadata["result_refs"] = [metadata["result_ref"]]
                    if metadata.get("result_text"):
                        metadata["result_parts"] = [
                            {
                                "text": metadata["result_text"],
                                "conversation_id": parent_id,
                                "item_id": item_id,
                            }
                        ]
                if metadata.get("agent_name"):
                    metadata["agent_name_source"] = "native"
                return metadata
    return {}


def _activity_id(child_id: str, phase: str, identity: str) -> str:
    return hashlib.sha256(f"{child_id}:{phase}:{identity}".encode()).hexdigest()[:32]


def _returned_activity(
    store: ConversationStore,
    parent_id: str,
    child_id: str,
    turn_id: str,
    dispatch_id: str | None = None,
) -> ConversationItem | None:
    for identity in dict.fromkeys((turn_id, dispatch_id)):
        if not identity:
            continue
        item = store.get_item(parent_id, _activity_id(child_id, "returned", identity))
        if (
            item
            and isinstance(item.data, ResourceEventData)
            and isinstance(item.data.resource, dict)
            and item.data.resource.get("turn_id") == turn_id
        ):
            return item
    # A reused child may now point at another dispatch.
    return next(
        (
            row
            for row in _recorded_items(store, parent_id, type="resource_event")
            if isinstance(row.data, ResourceEventData)
            and row.data.event_type == "session.subagent.returned"
            and row.data.resource_id == child_id
            and isinstance(row.data.resource, dict)
            and row.data.resource.get("turn_id") == turn_id
        ),
        None,
    )


def _recorded_items(
    store: ConversationStore, conversation_id: str, *, type: str | None = None
) -> Iterator[ConversationItem]:
    """Bound capture work even when a native transcript never supplies the target."""
    after = None
    for _ in range(10):
        page = store.list_items(conversation_id, order="desc", limit=100, after=after, type=type)
        yield from page.data
        if not page.has_more or page.last_id is None:
            break
        after = page.last_id


def _message_text(row: ConversationItem | NewConversationItem, *, role: str) -> str | None:
    if role == "user" and isinstance(row.data, SlashCommandData):
        return row.data.arguments or f"/{row.data.name}"
    if not isinstance(row.data, MessageData) or row.data.role != role or row.data.is_meta:
        return None
    if row.data.subagent_return_id:
        return None
    return "\n".join(
        block["text"]
        for block in row.data.content
        if isinstance(block.get("text"), str)
        and block.get("type") == ("input_text" if role == "user" else "output_text")
    )


def _refresh_task_input(metadata: dict[str, object], store: ConversationStore) -> None:
    ref = metadata.get("task_input_ref")
    if not isinstance(ref, dict):
        return
    conversation_id, item_id = ref.get("conversation_id"), ref.get("item_id")
    if not isinstance(conversation_id, str) or not isinstance(item_id, str):
        return
    row = store.get_item(conversation_id, item_id)
    if row is None:
        return
    prompt = _message_text(row, role="user")
    if isinstance(row.data, FunctionCallData) and row.data.call_id == metadata.get("dispatch_id"):
        try:
            arguments = json.loads(row.data.arguments)
        except (ValueError, TypeError):
            arguments = None
        prompt = arguments.get("prompt") if isinstance(arguments, dict) else None
    if isinstance(prompt, str) and prompt:
        metadata["task_input"] = prompt
        metadata["task_input_captured"] = True


def _turn_report(
    rows: list[ConversationItem], child_id: str, turn_id: str | None
) -> dict[str, object]:
    parts = []
    refs = []
    for row in reversed(rows):
        if not turn_id or row.response_id != turn_id:
            continue
        result = _message_text(row, role="assistant")
        if (
            isinstance(row.data, ResourceEventData)
            and row.data.event_type == "session.subagent.result"
            and isinstance(row.data.resource, dict)
        ):
            result = row.data.resource.get("result_text")
        if isinstance(result, str) and result.strip():
            parts.append(result)
            refs.append({"conversation_id": child_id, "item_id": row.id})
    if not parts:
        return {}
    return {
        "result_text": "\n\n".join(parts),
        "result_ref": refs[0],
        "result_refs": refs,
        "result_parts": [{"text": part, **ref} for part, ref in zip(parts, refs, strict=True)],
    }


def _dispatch_metadata(
    child: Conversation, turn_id: str | None, store: ConversationStore, *, returned: bool
) -> dict[str, object]:
    """Resolve a dispatch from its captured event or exact transcript turn."""
    metadata: dict[str, object] = dict(child_metadata(child))
    native = (
        child.labels.get("omnigent.wrapper", "").endswith("-subagent")
        or any(metadata.get(key) for key in ("native_thread_id", "native_task_id"))
        or bool(child.labels.get("omnigent.claude_native.tool_use_id"))
    )
    rows = list(_recorded_items(store, child.id))
    report = _turn_report(rows, child.id, turn_id) if returned else {}
    if returned and turn_id and child.parent_conversation_id:
        prior = _returned_activity(
            store,
            child.parent_conversation_id,
            child.id,
            turn_id,
            child.labels.get("omnigent.subagent.dispatch_id"),
        )
        if (
            prior
            and isinstance(prior.data, ResourceEventData)
            and isinstance(prior.data.resource, dict)
        ):
            captured = dict(prior.data.resource)
            _refresh_task_input(captured, store)
            return {**captured, **report}

    saved_dispatch = child.labels.get("omnigent.subagent.dispatch_id")
    saved = None
    if saved_dispatch and child.parent_conversation_id:
        item = store.get_item(
            child.parent_conversation_id, _activity_id(child.id, "delegated", saved_dispatch)
        )
        if (
            item
            and isinstance(item.data, ResourceEventData)
            and isinstance(item.data.resource, dict)
        ):
            saved = item.data.resource
    if saved and (
        native or child.labels.get("omnigent.subagent.completed_dispatch_id") != saved_dispatch
    ):
        metadata = {**metadata, **saved}
    elif not native:
        for key in ("task_summary", "task_input", "dispatch_id"):
            metadata.pop(key, None)

    found_turn = not returned
    request = None
    for row in rows:
        if (
            not returned
            and request is not None
            and row.id == saved_dispatch
            and child.labels.get("omnigent.subagent.completed_dispatch_id") == saved_dispatch
        ):
            break
        if returned and (row.response_id == turn_id or row.id == turn_id):
            found_turn = True
        if not found_turn:
            continue
        if (
            isinstance(row.data, MessageData)
            and row.data.role == "assistant"
            and row.response_id != turn_id
            and request is not None
        ):
            break
        prompt = _message_text(row, role="user")
        if prompt is None:
            continue
        if native and (
            not isinstance(row.data, MessageData)
            or row.data.communication is None
            or row.data.communication.kind != "native_agent"
        ):
            break
        request = row
    if request is not None:
        prompt = _message_text(request, role="user")
        if not native and not (saved and metadata.get("dispatch_id") == saved_dispatch):
            metadata.update(
                dispatch_id=request.id,
                task_input=prompt,
                task_summary=short_task(prompt or ""),
                task_input_captured=True,
            )
        if not native or prompt == metadata.get("task_input"):
            metadata["task_input_ref"] = {"conversation_id": child.id, "item_id": request.id}
        if returned and saved and metadata.get("dispatch_id") == saved_dispatch:
            metadata = {**metadata, **saved}

    call_id = child.labels.get("omnigent.claude_native.tool_use_id") or child.labels.get(
        "omnigent.codex_native.collab_tool_call_id"
    )
    if call_id and child.parent_conversation_id and not metadata.get("task_input_ref"):
        call = next(
            (
                row
                for row in _recorded_items(
                    store, child.parent_conversation_id, type="function_call"
                )
                if isinstance(row.data, FunctionCallData) and row.data.call_id == call_id
            ),
            None,
        )
        if call is not None and isinstance(call.data, FunctionCallData):
            try:
                arguments = json.loads(call.data.arguments)
            except (ValueError, TypeError):
                _logger.warning("Invalid native delegation arguments for %s", call_id)
                arguments = None
            if isinstance(arguments, dict):
                for key, field in (
                    ("name", "agent_name"),
                    ("description", "task_summary"),
                    ("task_name", "task_summary"),
                    ("prompt", "task_input"),
                ):
                    value = arguments.get(key)
                    if (
                        isinstance(value, str)
                        and value.strip()
                        and (
                            not metadata.get(field)
                            or key == "prompt"
                            or (key == "name" and metadata.get("agent_name_source") != "native")
                        )
                    ):
                        metadata[field] = value
                        if key == "name":
                            metadata["agent_name_source"] = "native"
                metadata["task_input_ref"] = {
                    "conversation_id": child.parent_conversation_id,
                    "item_id": call.id,
                }
    _refresh_task_input(metadata, store)
    metadata.setdefault("dispatch_id", turn_id or child.id)
    if turn_id:
        metadata["turn_id"] = turn_id
    return {**metadata, **report}


def _fully_captured_activity(
    event_type: str, resource: dict[str, object], parent_id: str, child_id: str
) -> bool:
    """Recognize complete copies without resolving their source records again."""
    if resource.get("capture_version") != 1:
        return False
    if (resource.get("task_input") or resource.get("task_input_ref")) and resource.get(
        "task_input_captured"
    ) is not True:
        return False
    if event_type == "session.subagent.delegated":
        return True
    parts = resource.get("result_parts")
    if not isinstance(parts, list) or not parts:
        return False
    texts = []
    refs = []
    for part in parts:
        if not isinstance(part, dict):
            return False
        text, conversation_id, item_id = (
            part.get("text"),
            part.get("conversation_id"),
            part.get("item_id"),
        )
        if (
            not isinstance(text, str)
            or not text
            or not isinstance(conversation_id, str)
            or conversation_id not in {parent_id, child_id}
            or not isinstance(item_id, str)
            or not item_id
        ):
            return False
        texts.append(text)
        refs.append({"conversation_id": conversation_id, "item_id": item_id})
    return (
        resource.get("result_text") == "\n\n".join(texts)
        and resource.get("result_ref") == refs[0]
        and resource.get("result_refs", refs) == refs
    )


async def recover_subagent_activity(
    parent_id: str,
    items: list[ConversationItem],
    store: ConversationStore,
    can_read: Callable[[str], Awaitable[bool]],
) -> list[ConversationItem]:
    """Project legacy references without changing history or reading latest labels.

    The caller has authorized the parent; can_read must authorize other sessions.
    At most 32 lifecycle rows and 64 exact source items are read per page.
    """
    recovered = []
    budget = 64
    remaining_rows = 32
    allowed: dict[str, bool] = {parent_id: True}
    for item in items:
        data = item.data
        if (
            remaining_rows <= 0
            or not isinstance(data, ResourceEventData)
            or data.event_type not in {"session.subagent.delegated", "session.subagent.returned"}
            or not isinstance(data.resource, dict)
            or _fully_captured_activity(
                data.event_type, data.resource, parent_id, data.resource_id
            )
        ):
            recovered.append(item)
            continue
        remaining_rows -= 1
        resource = dict(data.resource)
        child_id = data.resource_id
        if child_id not in allowed:
            allowed[child_id] = await can_read(child_id)
            if allowed[child_id]:
                child = await asyncio.to_thread(store.get_conversation, child_id)
                allowed[child_id] = child is not None and child.parent_conversation_id == parent_id

        async def source(ref, child_id=child_id):
            nonlocal budget
            if not isinstance(ref, dict) or budget <= 0:
                return None
            conversation_id, item_id = ref.get("conversation_id"), ref.get("item_id")
            if (
                not isinstance(conversation_id, str)
                or conversation_id not in {parent_id, child_id}
                or not allowed.get(conversation_id)
                or not isinstance(item_id, str)
            ):
                return None
            budget -= 1
            return await asyncio.to_thread(store.get_item, conversation_id, item_id)

        request = await source(resource.get("task_input_ref"))
        if request is not None:
            prompt = _message_text(request, role="user")
            if isinstance(request.data, FunctionCallData) and request.data.call_id == resource.get(
                "dispatch_id"
            ):
                try:
                    arguments = json.loads(request.data.arguments)
                except (TypeError, ValueError):
                    arguments = None
                prompt = arguments.get("prompt") if isinstance(arguments, dict) else None
            if isinstance(prompt, str) and prompt:
                resource["task_input"] = prompt
        if (
            not resource.get("result_text")
            or resource.get("result_ref")
            or resource.get("result_refs")
        ):
            parts = []
            result_parts = []
            refs = resource.get("result_refs") or [resource.get("result_ref")]
            for ref in refs[:32] if isinstance(refs, list) else []:
                result = await source(ref)
                if result is None:
                    continue
                if ref.get("conversation_id") == child_id and result.response_id == resource.get(
                    "turn_id"
                ):
                    text = _message_text(result, role="assistant")
                elif (
                    ref.get("conversation_id") == parent_id
                    and isinstance(result.data, (MessageData, FunctionCallOutputData))
                    and result.data.subagent_return_id == resource.get("native_task_id")
                    and resource.get("native_task_id")
                ):
                    text = (
                        result.data.output
                        if isinstance(result.data, FunctionCallOutputData)
                        else "\n".join(
                            block["text"]
                            for block in result.data.content
                            if isinstance(block.get("text"), str)
                        )
                    )
                else:
                    text = None
                if text:
                    parts.append(text)
                    result_parts.append({"text": text, **ref})
            if parts and len("\n\n".join(parts)) > len(resource.get("result_text", "")):
                resource["result_text"] = "\n\n".join(parts)
                resource["result_parts"] = result_parts
            elif (
                not resource.get("result_text")
                and resource.get("turn_id")
                and allowed.get(child_id)
                and budget >= 10
            ):
                budget -= 10
                report = await asyncio.to_thread(
                    _capture_turn_report, store, child_id, resource["turn_id"]
                )
                resource.update(report)
        recovered.append(
            item.model_copy(update={"data": data.model_copy(update={"resource": resource})})
        )
    return recovered


def _capture_turn_report(
    store: ConversationStore, child_id: str, turn_id: str
) -> dict[str, object]:
    return _turn_report(list(_recorded_items(store, child_id)), child_id, turn_id)


async def _persist_activity(
    parent_id: str, item: NewConversationItem, store: ConversationStore
) -> None:
    # Serialize publication with writes so an enrichment cannot precede .done.
    async with _activity_write_lock:
        persisted = (await asyncio.to_thread(store.append, parent_id, [item]))[0]
        if not persisted.deduplicated:
            event = OutputItemDoneEvent(
                type="response.output_item.done", item=persisted.to_api_dict()
            )
            session_stream.publish(parent_id, event.model_dump())
        else:
            assert isinstance(item.data, ResourceEventData) and item.data.resource is not None
            enriched = await asyncio.to_thread(
                store.enrich_resource_event, parent_id, persisted.id, item.data.resource
            )
            if enriched is not None:
                event = OutputItemUpdatedEvent(
                    type="response.output_item.updated", item=enriched.to_api_dict()
                )
                session_stream.publish(parent_id, event.model_dump())


async def record_subagent_activity(
    child_id: str,
    phase: Literal["delegated", "returned"],
    store: ConversationStore,
    *,
    parent_id: str | None = None,
    turn_id: str | None = None,
    status: str | None = None,
    from_runner: bool = False,
    task_input: str | None = None,
) -> None:
    """Persist and publish a child lifecycle edge once, including across retries."""
    try:
        child = await asyncio.to_thread(store.get_conversation, child_id)
        if (
            child is None
            or child.parent_conversation_id is None
            or is_side_chat_child(child.labels)
        ):
            # A side chat lives in its own rail tab; it is not delegated work.
            return
        if parent_id is not None and child.parent_conversation_id != parent_id:
            return
        parent_id = child.parent_conversation_id
        native_completion = False
        if phase == "returned" and status == "completed":
            from omnigent.server.routes._sessions.orchestration import _native_pane_harness

            # Native runner completion acknowledges prompt delivery; the
            # forwarder confirms when the child actually finishes.
            harness = await asyncio.to_thread(_native_pane_harness, child)
            native_completion = is_native_harness(harness)
            if native_completion and from_runner:
                return
        if phase == "returned" and turn_id is None:
            latest = await asyncio.to_thread(store.list_items, child.id, limit=20, order="desc")
            turn_id = next(
                (
                    row.response_id
                    for row in latest.data
                    if (
                        isinstance(row.data, MessageData)
                        and (row.data.role == "assistant" or status == "failed")
                        and not row.data.is_meta
                    )
                    or row.type in {"function_call", "function_call_output"}
                ),
                None,
            )
            if turn_id is None:
                if status != "failed":
                    return
                # A runner can die before producing any transcript for its first turn.
                turn_id = child.id
        metadata = await asyncio.to_thread(
            _dispatch_metadata, child, turn_id, store, returned=phase == "returned"
        )
        if task_input:
            metadata["task_input"] = task_input
            metadata["task_input_captured"] = True
        metadata["capture_version"] = 1
        if (
            phase == "delegated"
            and child.labels.get("omnigent.wrapper") == "codex-native-ui-subagent"
            and not (metadata.get("task_input") or metadata.get("task_summary"))
        ):
            return
        if phase == "returned":
            metadata.update(
                await asyncio.to_thread(_completion_result, parent_id, metadata, store)
            )
        else:
            labels = {
                f"omnigent.subagent.{key}": value
                for key in ("dispatch_id", "task_summary", "task_input")
                if isinstance(value := metadata.get(key), str)
                and child.labels.get(f"omnigent.subagent.{key}") != value
            }
            if labels:
                await asyncio.to_thread(store.set_labels, child.id, labels)
        if child.labels.get("omnigent.claude_native.tool_use_id"):
            labels = {
                f"omnigent.claude_native.{label}": value
                for label, field in (("prompt", "task_input"), ("agent_name", "agent_name"))
                if isinstance(value := metadata.get(field), str)
                and (field != "agent_name" or metadata.get("agent_name_source") == "native")
                and child.labels.get(f"omnigent.claude_native.{label}") != value
            }
            if labels:
                await asyncio.to_thread(store.set_labels, child.id, labels)
        stable_id = _activity_id(
            child.id,
            phase,
            str(metadata["dispatch_id"]),
        )
        item = NewConversationItem(
            type="resource_event",
            stable_id=stable_id,
            response_id="subagent_" + stable_id,
            data=ResourceEventData(
                event_type=f"session.subagent.{phase}",
                resource_id=child.id,
                resource_type="session",
                resource={
                    **metadata,
                    "title": metadata.get("task_summary")
                    or metadata.get("title")
                    or _title(child),
                    **({"status": status} if status else {}),
                },
            ),
        )
        await _persist_activity(parent_id, item, store)
        if phase == "returned" and metadata["dispatch_id"] == child.labels.get(
            "omnigent.subagent.dispatch_id"
        ):
            await asyncio.to_thread(
                store.set_labels,
                child.id,
                {"omnigent.subagent.completed_dispatch_id": str(metadata["dispatch_id"])},
            )
        if phase == "delegated" and any(
            child.labels.get(label)
            for label in (
                "omnigent.claude_native.subagent_id",
                "omnigent.claude_native.tool_use_id",
            )
        ):
            # A quick result may reach the parent before child discovery runs.
            completion_status = await _recorded_completion_status(parent_id, child, store)
            if completion_status:
                await record_subagent_activity(
                    child.id,
                    "returned",
                    store,
                    parent_id=parent_id,
                    turn_id=child.labels.get("omnigent.claude_native.tool_use_id") or child.id,
                    status=completion_status,
                )
    except Exception:  # display metadata must not interrupt child delivery
        _logger.warning("Could not record subagent activity for %s", child_id, exc_info=True)


async def record_claude_subagent_return(
    parent_id: str,
    item: NewConversationItem | ConversationItem,
    store: ConversationStore,
) -> None:
    """Match an actual Claude result to its child; launch handles are not results."""
    try:
        # The transcript can arrive after the terminal-status event.
        if _message_text(item, role="assistant") or (
            isinstance(item.data, ResourceEventData)
            and item.data.event_type == "session.subagent.result"
        ):
            child = await asyncio.to_thread(store.get_conversation, parent_id)
            if child is not None and child.parent_conversation_id is not None:
                prior = await asyncio.to_thread(
                    _returned_activity,
                    store,
                    child.parent_conversation_id,
                    child.id,
                    item.response_id,
                    child.labels.get("omnigent.subagent.dispatch_id"),
                )
                if (
                    prior
                    and isinstance(prior.data, ResourceEventData)
                    and isinstance(prior.data.resource, dict)
                ):
                    await record_subagent_activity(
                        child.id,
                        "returned",
                        store,
                        turn_id=item.response_id,
                        status=prior.data.resource.get("status"),
                    )
        await _record_claude_subagent_return(parent_id, item, store)
    except Exception:  # optional correlation must not interrupt transcript delivery
        _logger.warning("Could not match Claude subagent result in %s", parent_id, exc_info=True)


def _claude_completion_ids(
    item: NewConversationItem | ConversationItem,
) -> tuple[dict[str, str], dict[str, str]]:
    task_ids: dict[str, str] = {}
    call_ids: dict[str, str] = {}
    if isinstance(item.data, FunctionCallOutputData) or (
        isinstance(item.data, MessageData)
        and (item.data.is_meta or item.data.communication is not None)
    ):
        if item.data.subagent_return_id:
            task_ids[item.data.subagent_return_id] = "completed"
    if isinstance(item.data, MessageData) and item.data.is_meta:
        for block in item.data.content:
            text = block.get("text")
            if not isinstance(text, str):
                continue
            for notification in _TASK_NOTIFICATION_RE.finditer(text):
                body = notification.group(1)
                status_match = _TERMINAL_TASK_STATUS_RE.search(body)
                if status_match is None:
                    continue
                status = status_match.group(1)
                if status == "killed":
                    status = "cancelled"
                for key, value in _TASK_ID_RE.findall(body):
                    (task_ids if key == "task-id" else call_ids)[value] = status
    return task_ids, call_ids


def claude_subagent_completion_markers(
    item: NewConversationItem | ConversationItem,
) -> list[NewConversationItem]:
    """Build stable markers to commit in the same transaction as the result."""
    task_ids, call_ids = _claude_completion_ids(item)
    metadata: dict[str, object] = {}
    if isinstance(item.data, FunctionCallOutputData):
        metadata["result_text"] = item.data.output
    elif isinstance(item.data, MessageData):
        result_text = "\n".join(
            block["text"] for block in item.data.content if isinstance(block.get("text"), str)
        )
        notifications = _TASK_NOTIFICATION_RE.findall(result_text) if item.data.is_meta else []
        metadata["result_text"] = (
            "\n".join(
                report.strip()
                for notification in notifications
                for _, report in _TASK_REPORT_RE.findall(notification)
            )
            if notifications
            else result_text
        )
        if item.data.communication and item.data.communication.source_agent_name:
            metadata["agent_name"] = item.data.communication.source_agent_name
    item_id = item.id if isinstance(item, ConversationItem) else item.stable_id
    if item_id:
        metadata["result_item_id"] = item_id
    return [
        _completion_marker(kind, native_id, status, metadata)
        for kind, completions in (("task", task_ids), ("call", call_ids))
        for native_id, status in completions.items()
    ]


async def _record_claude_subagent_return(
    parent_id: str,
    item: NewConversationItem | ConversationItem,
    store: ConversationStore,
) -> None:
    task_ids, call_ids = _claude_completion_ids(item)
    if not task_ids and not call_ids:
        return
    for marker in claude_subagent_completion_markers(item):
        if (
            marker.stable_id
            and isinstance(marker.data, ResourceEventData)
            and marker.data.resource is not None
        ):
            await asyncio.to_thread(
                store.enrich_resource_event, parent_id, marker.stable_id, marker.data.resource
            )
    after: str | None = None
    while True:
        page = await asyncio.to_thread(
            store.list_conversations,
            kind="sub_agent",
            parent_conversation_id=parent_id,
            limit=100,
            after=after,
        )
        for child in page.data:
            status = task_ids.get(
                child.labels.get("omnigent.claude_native.subagent_id", "")
            ) or call_ids.get(child.labels.get("omnigent.claude_native.tool_use_id", ""))
            if status:
                await record_subagent_activity(
                    child.id,
                    "returned",
                    store,
                    parent_id=parent_id,
                    turn_id=child.labels.get("omnigent.claude_native.tool_use_id") or child.id,
                    status=status,
                )
        if not page.has_more or page.last_id is None:
            return
        after = page.last_id
