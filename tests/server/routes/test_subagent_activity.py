# Modified for Triune.

"""Lifecycle notices remain named, ordered, and idempotent across native delivery races."""

from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy import event

from omnigent.entities import MessageData, NewConversationItem
from omnigent.server.routes._sessions.orchestration import (
    _persist_external_conversation_item,
    _persist_external_conversation_items,
)
from omnigent.server.schemas import SessionEventInput
from omnigent.server.subagent_activity import record_subagent_activity
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


@pytest.mark.parametrize("explicit_turn", [False, True])
@pytest.mark.asyncio
async def test_lifecycle_publishes_once_per_child_turn(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, explicit_turn: bool
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=parent.id, title="researcher:Audit")
    publish = Mock()
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", publish)
    await record_subagent_activity(child.id, "delegated", store, parent_id="wrong-parent")
    await record_subagent_activity(child.id, "returned", store)
    assert store.list_items(parent.id).data == []
    for _ in range(2):
        await record_subagent_activity(child.id, "delegated", store)
    for turn_id in ("first", "second"):
        store.append(
            child.id,
            [
                NewConversationItem(
                    type="message",
                    response_id=turn_id,
                    data=MessageData(
                        role="assistant",
                        phase="final_answer",
                        agent="Claude",
                        content=[{"type": "output_text", "text": "Done"}],
                    ),
                )
            ],
        )
        for _ in range(2):
            await record_subagent_activity(
                child.id, "returned", store, turn_id=turn_id if explicit_turn else None
            )
    items = store.list_items(parent.id).data
    assert [item.data.event_type for item in items] == [
        "session.subagent.delegated",
        "session.subagent.returned",
        "session.subagent.returned",
    ]
    assert publish.call_count == 3
    for call, item in zip(publish.call_args_list, items, strict=True):
        assert call.args[0] == parent.id
        assert call.args[1]["type"] == "response.output_item.done"
        assert call.args[1]["item"]["id"] == item.id
        assert item.data.resource_id == child.id
        assert item.data.resource["title"] == "Audit"
        assert item.data.resource["agent_name"] == "researcher"
        assert item.data.resource["agent_name_source"] == "role"
        if item.data.event_type.endswith("returned"):
            assert item.data.resource["result_text"] == "Done"


@pytest.mark.asyncio
async def test_side_chat_child_records_no_lifecycle_notices(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        parent_conversation_id=parent.id,
        labels={"omnigent.codex_native.agent_nickname": "Side chat"},
    )
    publish = Mock()
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", publish)
    await record_subagent_activity(child.id, "delegated", store)
    await record_subagent_activity(child.id, "returned", store, turn_id="t1")
    assert store.list_items(parent.id).data == []
    publish.assert_not_called()


def _message(text: str) -> dict[str, Any]:
    return {"role": "user", "is_meta": True, "content": [{"type": "input_text", "text": text}]}


@pytest.mark.parametrize(
    "late,batched", [(False, False), (False, True), (True, False), (True, True)]
)
@pytest.mark.parametrize(
    "data,return_id,expected",
    [
        ({"call_id": "tool-1", "output": "Done"}, "agent-1", "completed"),
        (_message('<agent-message from="reviewer">Done</agent-message>'), "agent-1", "completed"),
        (
            _message(
                "<task-notification><task-id>agent-1</task-id><status>completed</status>"
                "</task-notification>"
            ),
            None,
            "completed",
        ),
        (
            _message(
                "<task-notification><tool-use-id>tool-1</tool-use-id><status>failed</status>"
                "</task-notification>"
            ),
            None,
            "failed",
        ),
        (
            _message(
                "<task-notification><task-id>agent-1</task-id><status>completed</status>"
                "<summary>Clean summary</summary></task-notification>"
            ),
            None,
            "completed",
        ),
        (
            {"call_id": "tool-1", "output": "Async agent launched successfully. agentId: agent-1"},
            None,
            None,
        ),
        ({"call_id": "tool-1", "output": '{"status":"failed","agentId":"agent-1"}'}, None, None),
        (_message('<teammate-message teammate_id="reviewer">Hi</teammate-message>'), None, None),
    ],
    ids=[
        "tool",
        "handback",
        "notification",
        "failure",
        "summary",
        "launch",
        "unconfirmed",
        "chatter",
    ],
)
@pytest.mark.asyncio
async def test_claude_completion_survives_retries_and_late_child_discovery(
    db_uri: str,
    data: dict[str, Any],
    return_id: str | None,
    expected: str | None,
    late: bool,
    batched: bool,
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()

    async def register_child() -> str:
        child = store.create_conversation(
            parent_conversation_id=parent.id, title="Explore:agent-1"
        )
        store.set_labels(
            child.id,
            {
                "omnigent.claude_native.subagent_id": "agent-1",
                "omnigent.claude_native.tool_use_id": "tool-1",
                "omnigent.claude_native.description": "Inspect authentication",
            },
        )
        await record_subagent_activity(child.id, "delegated", store)
        return child.id

    child_id = None if late else await register_child()
    item_type = "function_call_output" if "call_id" in data else "message"
    body = SessionEventInput(
        type="external_conversation_item",
        data={
            "source_id": "result",
            "response_id": "parent-turn",
            "item_type": item_type,
            "item_data": data,
            "subagent_return_id": return_id,
        },
    )

    async def deliver() -> None:
        if batched:
            await _persist_external_conversation_items(parent.id, [body], store)
        else:
            await _persist_external_conversation_item(parent.id, parent, body, store)

    if late and expected:

        def fail_marker_write(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("INSERT") and "session.subagent.completion-observed" in str(
                parameters
            ):
                raise RuntimeError("marker write failed")

        event.listen(store._conv_engine, "after_cursor_execute", fail_marker_write)
        try:
            with pytest.raises(RuntimeError, match="marker write failed"):
                await deliver()
        finally:
            event.remove(store._conv_engine, "after_cursor_execute", fail_marker_write)
        assert store.list_items(parent.id).data == []
    for _ in range(2):
        await deliver()
    [persisted] = store.list_items(parent.id, type=item_type).data
    assert persisted.data.subagent_return_id == return_id
    if late:
        # Reconciliation must work even when completion is outside the latest history page.
        store.append(
            parent.id,
            [
                NewConversationItem(
                    type="message",
                    response_id=f"update-{i}",
                    data=MessageData(
                        role="assistant",
                        phase="final_answer",
                        agent="Claude",
                        content=[{"type": "output_text", "text": "Update"}],
                    ),
                )
                for i in range(101)
            ],
        )
        child_id = await register_child()
    assert child_id is not None
    await record_subagent_activity(child_id, "delegated", store)
    activity = [
        row
        for row in store.list_items(parent.id, type="resource_event").data
        if row.data.event_type != "session.subagent.completion-observed"
    ]
    assert [row.data.event_type for row in activity] == ["session.subagent.delegated"] + (
        ["session.subagent.returned"] if expected else []
    )
    assert all(row.data.resource_id == child_id for row in activity)
    resource = activity[-1].data.resource
    assert resource["title"] == "Inspect authentication"
    assert resource["task_summary"] == "Inspect authentication"
    assert resource["dispatch_id"] == "tool-1"
    if expected:
        assert resource["status"] == expected
        if return_id:
            assert resource["result_text"]
            assert resource["result_ref"] == {
                "conversation_id": parent.id,
                "item_id": persisted.id,
            }
        else:
            assert "result_text" not in resource
            assert "result_ref" not in resource


@pytest.mark.asyncio
async def test_reused_managed_child_keeps_each_dispatch_input_and_result(db_uri: str) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=parent.id, title="researcher:Audit")
    requests = []
    for index, prompt in enumerate(("Inspect navigation", "Inspect permissions")):
        request = store.append(
            child.id,
            [
                NewConversationItem(
                    type="message",
                    response_id=f"input-{index}",
                    data=MessageData(
                        role="user", content=[{"type": "input_text", "text": prompt}]
                    ),
                )
            ],
        )[0]
        requests.append(request)
        await record_subagent_activity(child.id, "delegated", store)
        store.append(
            child.id,
            [
                NewConversationItem(
                    type="message",
                    response_id=f"answer-{index}",
                    data=MessageData(
                        role="assistant",
                        phase="final_answer",
                        agent="researcher",
                        content=[{"type": "output_text", "text": f"Result {index}"}],
                    ),
                )
            ],
        )
        await record_subagent_activity(child.id, "returned", store, turn_id=f"answer-{index}")
    # A late repeated completion must still describe the old input.
    await record_subagent_activity(child.id, "returned", store, turn_id="answer-0")
    activities = store.list_items(parent.id).data
    assert len(activities) == 4
    for index in range(2):
        delegated, returned = activities[index * 2 : index * 2 + 2]
        for activity in (delegated, returned):
            assert activity.data.resource["dispatch_id"] == requests[index].id
            assert activity.data.resource["task_input"] == requests[index].data.content[0]["text"]
            assert activity.data.resource["task_input_ref"]["item_id"] == requests[index].id
        assert returned.data.resource["result_text"] == f"Result {index}"


@pytest.mark.asyncio
async def test_claude_original_call_and_clean_peer_return_project_into_cards(db_uri: str) -> None:
    import json

    from omnigent.entities import FunctionCallData
    from omnigent.native.communication import native_message_text, native_peer_metadata

    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    call = store.append(
        parent.id,
        [
            NewConversationItem(
                type="function_call",
                response_id="parent-turn",
                data=FunctionCallData(
                    agent="Claude",
                    name="Agent",
                    call_id="tool-1",
                    arguments=json.dumps(
                        {
                            "name": "Curie",
                            "description": "Inspect auth",
                            "prompt": "Full original task",
                        }
                    ),
                ),
            )
        ],
    )[0]
    child = store.create_conversation(
        parent_conversation_id=parent.id,
        title="general-purpose:agent-1",
        labels={
            "omnigent.claude_native.subagent_id": "agent-1",
            "omnigent.claude_native.tool_use_id": "tool-1",
        },
    )
    await record_subagent_activity(child.id, "delegated", store)
    origin = {
        "kind": "peer",
        "name": "Curie",
        "senderTaskId": "agent-1",
        "handback": True,
        "handbackReportText": "Clean result",
    }
    body = SessionEventInput(
        type="external_conversation_item",
        data={
            "source_id": "handback",
            "response_id": "parent-turn",
            "item_type": "message",
            "item_data": {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": native_message_text(origin, "wrapper")}
                ],
                **native_peer_metadata(origin, "handback"),
            },
            "subagent_return_id": "agent-1",
        },
    )
    await _persist_external_conversation_item(parent.id, parent, body, store)
    activities = [
        row
        for row in store.list_items(parent.id, type="resource_event").data
        if row.data.event_type in {"session.subagent.delegated", "session.subagent.returned"}
    ]
    assert len(activities) == 2
    for activity in activities:
        assert activity.data.resource["agent_name"] == "Curie"
        assert activity.data.resource["task_input"] == "Full original task"
        assert activity.data.resource["task_input_ref"] == {
            "conversation_id": parent.id,
            "item_id": call.id,
        }
    assert activities[-1].data.resource["result_text"] == "Clean result"


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.asyncio
async def test_steering_keeps_original_task_identity(db_uri: str, native: bool) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        parent_conversation_id=parent.id,
        labels={
            "omnigent.wrapper": "codex-native-ui-subagent",
            "omnigent.codex_native.subagent_thread_id": "thread-1",
            "omnigent.codex_native.task_name": "Inspect navigation",
            "omnigent.codex_native.collab_tool_call_id": "spawn-1",
            "omnigent.codex_native.prompt": "Full original navigation task",
        }
        if native
        else {},
    )
    request = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="request-1",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "Full original navigation task"}],
                ),
            )
        ],
    )[0]
    await record_subagent_activity(child.id, "delegated", store)
    store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="request-2",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "Also inspect keyboard focus"}],
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "delegated", store)
    store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="answer",
                data=MessageData(
                    role="assistant",
                    phase="final_answer",
                    agent="worker",
                    content=[{"type": "output_text", "text": "Both checks completed"}],
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "returned", store, turn_id="answer")
    delegated, returned = store.list_items(parent.id).data
    for row in (delegated, returned):
        resource = row.data.resource
        assert resource["dispatch_id"] == ("spawn-1" if native else request.id)
        assert resource["task_input"] == "Full original navigation task"
        assert "keyboard" not in resource["title"]
        assert "keyboard" not in resource["task_summary"]


@pytest.mark.parametrize("batched", [False, True])
@pytest.mark.asyncio
async def test_return_before_transcript_enriches_same_event_and_republishes(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
    batched: bool,
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        parent_conversation_id=parent.id,
        labels={
            "omnigent.wrapper": "codex-native-ui-subagent",
            "omnigent.codex_native.subagent_thread_id": "native-child",
            "omnigent.codex_native.task_name": "Inspect navigation",
            "omnigent.codex_native.collab_tool_call_id": "spawn-1",
        },
    )
    publish = Mock()
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", publish)
    await record_subagent_activity(child.id, "delegated", store)
    await record_subagent_activity(child.id, "returned", store, turn_id="native-turn")
    delegated, initial = store.list_items(parent.id).data
    assert delegated.data.resource["task_summary"] == "Inspect navigation"
    assert "task_input" not in delegated.data.resource
    assert "result_text" not in initial.data.resource
    bodies = [
        SessionEventInput(
            type="external_conversation_item",
            data={
                "source_id": f"part-{index}",
                "response_id": "native-turn",
                "item_type": "message",
                "item_data": {
                    "role": "assistant",
                    "phase": "final_answer",
                    "agent": "worker",
                    "content": [{"type": "output_text", "text": text}],
                },
            },
        )
        for index, text in enumerate(("First part", "Second part"))
    ]
    for body in bodies:
        if batched:
            await _persist_external_conversation_items(child.id, [body], store)
        else:
            await _persist_external_conversation_item(child.id, child, body, store)
    await record_subagent_activity(child.id, "returned", store, turn_id="native-turn")
    _, enriched = store.list_items(parent.id).data
    assert enriched.id == initial.id
    assert enriched.created_at == initial.created_at
    assert enriched.response_id == initial.response_id
    assert enriched.data.resource["result_text"] == "First part\n\nSecond part"
    assert len(enriched.data.resource["result_refs"]) == 2
    assert [part["text"] for part in enriched.data.resource["result_parts"]] == [
        "First part",
        "Second part",
    ]
    assert [
        {key: part[key] for key in ("conversation_id", "item_id")}
        for part in enriched.data.resource["result_parts"]
    ] == enriched.data.resource["result_refs"]
    for ref in enriched.data.resource["result_refs"]:
        assert ref["conversation_id"] == child.id
        assert store.get_item(child.id, ref["item_id"]).response_id == "native-turn"
    updates = [
        call.args[1]
        for call in publish.call_args_list
        if call.args[1]["type"] == "response.output_item.updated"
    ]
    assert len(updates) == 2
    assert updates[-1]["item"]["id"] == initial.id
    assert updates[-1]["item"]["resource"]["result_text"] == "First part\n\nSecond part"


@pytest.mark.asyncio
async def test_native_v2_registration_keeps_named_task_without_inventing_prompt(
    client,
    db_uri: str,
) -> None:
    from omnigent.server.routes._sessions.orchestration import (
        _persist_external_codex_subagent_start,
    )
    from tests.server.helpers import create_test_agent

    agent = await create_test_agent(client)
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation(agent_id=agent["id"])
    child_id = await _persist_external_codex_subagent_start(
        parent.id,
        parent,
        SessionEventInput(
            type="external_codex_subagent_start",
            data={
                "thread_id": "thread-1",
                "tool_call_id": "spawn-1",
                "task_name": "sleep_three_minutes",
                "native_payload": "opaque-encrypted-data",
            },
        ),
        store,
    )
    await _persist_external_codex_subagent_start(
        parent.id,
        parent,
        SessionEventInput(
            type="external_codex_subagent_start",
            data={
                "thread_id": "thread-1",
                "tool_call_id": "steering-2",
                "task_name": "follow-up",
            },
        ),
        store,
    )
    [delegated] = store.list_items(parent.id).data
    assert delegated.data.resource["dispatch_id"] == "spawn-1"
    assert delegated.data.resource["task_summary"] == "sleep_three_minutes"
    assert "task_input" not in delegated.data.resource
    child = store.get_conversation(child_id)
    assert child.labels["omnigent.codex_native.task_name"] == "sleep_three_minutes"
    assert child.labels["omnigent.codex_native.collab_tool_call_id"] == "spawn-1"


@pytest.mark.parametrize("allowed", [False, True])
@pytest.mark.asyncio
async def test_legacy_report_uses_authorized_exact_refs_without_mutating_history(
    client,
    db_uri: str,
    allowed: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import AsyncMock

    from omnigent.entities import ResourceEventData
    from omnigent.server.subagent_activity import recover_subagent_activity

    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        parent_conversation_id=parent.id,
        labels={
            "omnigent.subagent.task_summary": "New unrelated task",
        },
    )
    original, result, _ = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="input-1",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Full original task"}]
                ),
            ),
            NewConversationItem(
                type="message",
                response_id="old-turn",
                data=MessageData(
                    role="assistant",
                    phase="final_answer",
                    agent="worker",
                    content=[{"type": "output_text", "text": "Full original result"}],
                ),
            ),
            NewConversationItem(
                type="message",
                response_id="new-turn",
                data=MessageData(
                    role="assistant",
                    phase="final_answer",
                    agent="worker",
                    content=[{"type": "output_text", "text": "New unrelated result"}],
                ),
            ),
        ],
    )
    [legacy] = store.append(
        parent.id,
        [
            NewConversationItem(
                type="resource_event",
                response_id="legacy",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_type="session",
                    resource_id=child.id,
                    resource={
                        "dispatch_id": original.id,
                        "turn_id": "old-turn",
                        "task_input": "Full",
                        "result_text": "Full",
                        "result_parts": [
                            {"text": "Full", "conversation_id": child.id, "item_id": result.id}
                        ],
                        "task_input_ref": {"conversation_id": child.id, "item_id": original.id},
                        "result_ref": {"conversation_id": child.id, "item_id": result.id},
                    },
                ),
            )
        ],
    )
    authorize = AsyncMock(return_value=allowed)
    [recovered] = await recover_subagent_activity(parent.id, [legacy], store, authorize)
    authorize.assert_awaited_once_with(child.id)
    if allowed:
        assert recovered.data.resource["task_input"] == "Full original task"
        assert recovered.data.resource["result_text"] == "Full original result"
        response = await client.get(f"/v1/sessions/{parent.id}/items")
        assert response.status_code == 200, response.text
        assert response.json()["data"][0]["resource"]["result_text"] == "Full original result"
        point_read = Mock(wraps=store.get_item)
        monkeypatch.setattr(store, "get_item", point_read)
        page = await recover_subagent_activity(parent.id, [legacy] * 40, store, authorize)
        assert point_read.call_count == 64
        assert (
            sum(row.data.resource.get("result_text") == "Full original result" for row in page)
            == 32
        )
        point_read.reset_mock()
        foreign = legacy.model_copy(
            update={
                "data": legacy.data.model_copy(
                    update={
                        "resource": {
                            "task_input_ref": {
                                "conversation_id": "another-chat",
                                "item_id": original.id,
                            },
                            "result_ref": {
                                "conversation_id": "another-chat",
                                "item_id": result.id,
                            },
                        }
                    }
                )
            }
        )
        [unresolved] = await recover_subagent_activity(parent.id, [foreign], store, authorize)
        point_read.assert_not_called()
        assert "result_text" not in unresolved.data.resource
    else:
        assert recovered.data.resource["task_input"] == "Full"
        assert recovered.data.resource["result_text"] == "Full"
    assert store.get_item(parent.id, legacy.id).data.resource == legacy.data.resource


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.asyncio
async def test_late_old_report_updates_only_original_dispatch(
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
    legacy: bool,
) -> None:
    from omnigent.entities import ResourceEventData
    from omnigent.server.subagent_activity import _activity_id

    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=parent.id)
    [request] = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="old-input",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Original task"}]
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "delegated", store)
    if legacy:
        store.append(
            parent.id,
            [
                NewConversationItem(
                    type="resource_event",
                    response_id="legacy-result",
                    stable_id=_activity_id(child.id, "returned", request.id),
                    data=ResourceEventData(
                        event_type="session.subagent.returned",
                        resource_type="session",
                        resource_id=child.id,
                        resource={
                            "dispatch_id": request.id,
                            "turn_id": "old-turn",
                            "task_summary": "Original task",
                            "task_input_ref": {"conversation_id": child.id, "item_id": request.id},
                        },
                    ),
                )
            ],
        )
    await record_subagent_activity(child.id, "returned", store, turn_id="old-turn")
    initial = store.list_items(parent.id).data[-1]
    [new_request] = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="new-input",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "New unrelated task"}]
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "delegated", store)
    publish = Mock()
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", publish)
    body = SessionEventInput(
        type="external_conversation_item",
        data={
            "source_id": "old-late-result",
            "response_id": "old-turn",
            "item_type": "message",
            "item_data": {
                "role": "assistant",
                "phase": "final_answer",
                "agent": "worker",
                "content": [{"type": "output_text", "text": "Original task result"}],
            },
        },
    )
    await _persist_external_conversation_items(child.id, [body], store)
    rows = store.list_items(parent.id).data
    assert len(rows) == 3
    old, current = rows[1:]
    assert old.id == initial.id
    assert old.data.resource["task_summary"] == "Original task"
    assert old.data.resource["result_text"] == "Original task result"
    assert current.data.resource["task_summary"] == "New unrelated task"
    assert current.data.resource["dispatch_id"] == new_request.id
    assert "result_text" not in current.data.resource
    assert (
        store.get_conversation(child.id).labels["omnigent.subagent.dispatch_id"] == new_request.id
    )
    updates = [
        call.args[1]
        for call in publish.call_args_list
        if call.args[1]["type"] == "response.output_item.updated"
    ]
    assert len(updates) == 1
    assert updates[0]["item"]["id"] == initial.id


@pytest.mark.asyncio
async def test_full_native_input_survives_label_limit_and_exact_reference(
    client,
    db_uri: str,
) -> None:
    import json

    from omnigent.entities import FunctionCallData
    from omnigent.server.routes._sessions.orchestration import (
        _persist_external_codex_subagent_start,
    )
    from tests.server.helpers import create_test_agent

    agent = await create_test_agent(client)
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation(agent_id=agent["id"])
    prompt = "Full original task. " * 80
    [source] = store.append(
        parent.id,
        [
            NewConversationItem(
                type="function_call",
                response_id="parent-turn",
                data=FunctionCallData(
                    agent="worker",
                    name="spawn_agent",
                    call_id="spawn-long",
                    arguments=json.dumps({"task_name": "Audit", "prompt": prompt}),
                ),
            )
        ],
    )
    child_id = await _persist_external_codex_subagent_start(
        parent.id,
        parent,
        SessionEventInput(
            type="external_codex_subagent_start",
            data={
                "thread_id": "long-task",
                "tool_call_id": "spawn-long",
                "task_name": "Audit",
                "prompt": prompt,
            },
        ),
        store,
    )
    child = store.get_conversation(child_id)
    assert len(child.labels["omnigent.codex_native.prompt"]) == 256
    [delegated] = store.list_items(parent.id, type="resource_event").data
    assert delegated.data.resource["task_input"] == prompt
    assert delegated.data.resource["task_input_ref"] == {
        "conversation_id": parent.id,
        "item_id": source.id,
    }
    await _persist_external_codex_subagent_start(
        parent.id,
        parent,
        SessionEventInput(
            type="external_codex_subagent_start",
            data={
                "thread_id": "long-task",
                "tool_call_id": "steer-long",
                "prompt": "Steering instructions " * 100,
            },
        ),
        store,
    )
    [delegated] = store.list_items(parent.id, type="resource_event").data
    assert delegated.data.resource["task_input"] == prompt


@pytest.mark.asyncio
async def test_complete_activity_refresh_skips_source_authorization_and_reads(
    client,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import AsyncMock

    from omnigent.server.routes.sessions import routes_items
    from omnigent.server.subagent_activity import recover_subagent_activity

    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=parent.id)
    store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="input",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "Complete input " * 40}],
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "delegated", store)
    await record_subagent_activity(child.id, "returned", store, turn_id="answer")
    initial = store.list_items(parent.id).data[-1]
    authorize = AsyncMock(return_value=True)
    [incomplete] = await recover_subagent_activity(parent.id, [initial], store, authorize)
    authorize.assert_awaited_once_with(child.id)
    assert "result_text" not in incomplete.data.resource
    for index, text in enumerate(("First report part", "Second report part")):
        await _persist_external_conversation_items(
            child.id,
            [
                SessionEventInput(
                    type="external_conversation_item",
                    data={
                        "source_id": f"complete-part-{index}",
                        "response_id": "answer",
                        "item_type": "message",
                        "item_data": {
                            "role": "assistant",
                            "phase": "final_answer",
                            "agent": "worker",
                            "content": [{"type": "output_text", "text": text}],
                        },
                    },
                )
            ],
            store,
        )
    rows = store.list_items(parent.id).data
    assert all(row.data.resource["task_input_captured"] is True for row in rows)
    assert len(rows[-1].data.resource["result_parts"]) == 2
    assert rows[-1].id == initial.id

    point_read = Mock()
    child_read = Mock()
    access_calls = Mock()
    get_item = SqlAlchemyConversationStore.get_item
    get_conversation = SqlAlchemyConversationStore.get_conversation
    require_access = routes_items._require_access_and_level

    def read_item(self, conversation_id, item_id):
        point_read(conversation_id, item_id)
        return get_item(self, conversation_id, item_id)

    def read_conversation(self, conversation_id):
        if conversation_id == child.id:
            child_read(conversation_id)
        return get_conversation(self, conversation_id)

    async def check_access(user_id, session_id, *args):
        access_calls(session_id)
        return await require_access(user_id, session_id, *args)

    monkeypatch.setattr(SqlAlchemyConversationStore, "get_item", read_item)
    monkeypatch.setattr(SqlAlchemyConversationStore, "get_conversation", read_conversation)
    monkeypatch.setattr(routes_items, "_require_access_and_level", check_access)
    authorize.reset_mock()
    # Complete rows neither consume recovery budget nor resolve their sources.
    projected = await recover_subagent_activity(parent.id, rows * 40, store, authorize)
    assert projected == rows * 40
    authorize.assert_not_awaited()
    for _ in range(3):
        response = await client.get(f"/v1/sessions/{parent.id}/items")
        assert response.status_code == 200, response.text
        returned = response.json()["data"][-1]
        assert returned["resource"]["result_text"] == "First report part\n\nSecond report part"
    assert [call.args[0] for call in access_calls.call_args_list] == [parent.id] * 3
    point_read.assert_not_called()
    child_read.assert_not_called()


@pytest.mark.asyncio
async def test_progress_shorter_final_atomic_replacement_and_old_turn_guard(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=parent.id)
    store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="t-final",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": "Do the task"}]
                ),
            )
        ],
    )
    await record_subagent_activity(child.id, "delegated", store)
    [progress] = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="t-final",
                data=MessageData(
                    role="assistant",
                    agent="worker",
                    phase="commentary",
                    content=[{"type": "output_text", "text": "Long progress details"}],
                ),
            )
        ],
    )
    await record_subagent_activity(
        child.id, "returned", store, turn_id="t-final", status="completed"
    )
    returned = store.list_items(parent.id).data[-1]
    assert "result_text" not in returned.data.resource
    legacy = {
        **returned.data.resource,
        "result_text": "A long historical report",
        "result_finality": "unknown",
        "result_ref": {"conversation_id": child.id, "item_id": progress.id},
        "result_refs": [{"conversation_id": child.id, "item_id": progress.id}],
    }
    assert store.enrich_resource_event(parent.id, returned.id, legacy)
    [final] = store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="t-final",
                data=MessageData(
                    role="assistant",
                    agent="worker",
                    phase="final_answer",
                    content=[{"type": "output_text", "text": "Done"}],
                ),
            )
        ],
    )
    for _ in range(2):
        await record_subagent_activity(
            child.id, "returned", store, turn_id="t-final", status="completed"
        )
    updated = store.get_item(parent.id, returned.id)
    assert updated.data.resource["result_text"] == "Done"
    assert updated.data.resource["result_refs"] == [
        {"conversation_id": child.id, "item_id": final.id}
    ]
    assert (
        len(
            [
                row
                for row in store.list_items(parent.id).data
                if row.data.event_type.endswith("returned")
            ]
        )
        == 1
    )
    assert (
        store.enrich_resource_event(
            parent.id,
            returned.id,
            {
                **updated.data.resource,
                "turn_id": "another-turn",
                "result_finality": "handback",
                "result_text": "Wrong",
            },
        )
        is None
    )
