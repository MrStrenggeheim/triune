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
        else:
            assert "<task-notification>" not in resource.get("result_text", "")
            if "Clean summary" in str(data):
                assert resource["result_text"] == "Clean summary"
        assert resource["result_ref"] == {"conversation_id": parent.id, "item_id": persisted.id}


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
