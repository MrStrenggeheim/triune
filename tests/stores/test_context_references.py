"""Cross-chat references freeze exact bounded context and recheck both ACLs."""

import json

# Modified for Triune.
import pytest
from fastapi import HTTPException

from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ
from omnigent.server.routes.sessions.context_references import (
    CaptureReference,
    capture_items,
    validate_context_references,
)
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore


def message(text, *, role="user", response="turn", interrupted=False):
    return NewConversationItem(
        type="message",
        response_id=response,
        status="completed",
        data=MessageData(
            agent="model" if role == "assistant" else None,
            role=role,
            content=[{"type": "input_text", "text": text}],
            interrupted=interrupted,
        ),
    )


def test_reference_whole_paginates_and_freezes_boundary(conversation_store):
    store = conversation_store
    source = store.create_conversation()
    items = store.append(
        source.id, [message(str(index), response=str(index)) for index in range(205)]
    )
    request = CaptureReference(scope="whole", boundary_id=items[150].id)
    frozen = capture_items(store, source.id, request)
    assert [item["id"] for item in frozen] == [item.id for item in items[:151]]
    store.append(source.id, [message("later")])
    assert capture_items(store, source.id, request) == frozen
    assert all("created_at" in item for item in frozen)


def test_reference_scopes_do_not_substitute_or_truncate(conversation_store):
    store = conversation_store
    source = store.create_conversation()
    items = store.append(
        source.id,
        [
            message("question", response="one"),
            message("first", role="assistant", response="one"),
            message("second", role="assistant", response="one"),
            message("partial", role="assistant", response="two", interrupted=True),
        ],
    )
    answer = capture_items(store, source.id, CaptureReference(scope="last_answer"))
    assert [item["id"] for item in answer] == [item.id for item in items[1:3]]
    selected = capture_items(
        store,
        source.id,
        CaptureReference(scope="messages", message_ids=[items[0].id, items[2].id]),
    )
    assert [item["id"] for item in selected] == [items[0].id, items[2].id]
    quote = capture_items(
        store,
        source.id,
        CaptureReference(scope="quote", boundary_id="one", quote="rendered selection"),
    )
    assert quote[-1]["id"] == items[2].id
    with pytest.raises(HTTPException, match="selected message"):
        capture_items(
            store, source.id, CaptureReference(scope="messages", message_ids=["missing"])
        )
    long_item = store.append(source.id, [message("x" * 128_001)])[0]
    assert (
        capture_items(
            store, source.id, CaptureReference(scope="quote", boundary_id=long_item.id, quote="x")
        )[0]["id"]
        == long_item.id
    )
    with pytest.raises(HTTPException) as error:
        capture_items(store, source.id, CaptureReference(scope="whole"))
    assert error.value.status_code == 413
    assert "nothing was summarized" in error.value.detail
    assert capture_items(
        store, source.id, CaptureReference(scope="messages", message_ids=[items[0].id])
    ) == [items[0].to_api_dict()]


@pytest.mark.asyncio
async def test_reference_send_checks_revoked_source_and_destination(conversation_store):
    store = conversation_store
    permissions = SqlAlchemyPermissionStore(str(store._engine.url))
    for user in ("alice", "bob"):
        permissions.ensure_user(user)
    source, destination = store.create_conversation(), store.create_conversation()
    permissions.grant("bob", source.id, LEVEL_OWNER)
    permissions.grant("alice", source.id, LEVEL_READ)
    permissions.grant("alice", destination.id, LEVEL_EDIT)
    payload = json.dumps({"version": 1, "source_id": source.id})
    data = {
        "content": [
            {
                "type": "input_text",
                "text": f"[Chat context snapshot]\n{payload}\n[/Chat context snapshot]",
            }
        ]
    }

    async def check():
        await validate_context_references(
            data,
            user_id="alice",
            destination_id=destination.id,
            conversation_store=store,
            permission_store=permissions,
        )

    await check()
    permissions.revoke("alice", source.id)
    with pytest.raises(OmnigentError):
        await check()
    permissions.grant("alice", source.id, LEVEL_READ)
    permissions.grant("alice", destination.id, LEVEL_READ)
    with pytest.raises(OmnigentError):
        await check()


@pytest.mark.asyncio
async def test_reference_send_limits_apply_across_content_blocks(conversation_store):
    source = conversation_store.create_conversation()
    payload = json.dumps({"version": 1, "source_id": source.id})
    data = {
        "content": [{"text": f"[Chat context snapshot]\n{payload}\n[/Chat context snapshot]"}] * 9
    }
    with pytest.raises(HTTPException) as error:
        await validate_context_references(
            data,
            user_id=None,
            destination_id="target",
            conversation_store=conversation_store,
            permission_store=None,
        )
    assert error.value.status_code == 413


@pytest.mark.asyncio
async def test_reference_routes_include_authorized_children_and_disclose_exact_capture(
    conversation_store,
):
    from types import SimpleNamespace

    import httpx
    from fastapi import APIRouter, FastAPI

    from omnigent.server.routes.sessions.context_references import (
        register_context_reference_routes,
    )

    store = conversation_store
    permissions = SqlAlchemyPermissionStore(str(store._engine.url))
    for user in ("alice", "bob"):
        permissions.ensure_user(user)
    parent = store.create_conversation(title="Parent", agent_id="a" * 32)
    child = store.create_conversation(
        title="Child", agent_id="a" * 32, parent_conversation_id=parent.id, kind="sub_agent"
    )
    private = store.create_conversation(title="Private", agent_id="a" * 32)
    for conv in (parent, child):
        permissions.grant("alice", conv.id, LEVEL_OWNER)
    permissions.grant("bob", private.id, LEVEL_OWNER)
    item = store.append(child.id, [message("needle exact **markdown**")])[0]
    store.append(private.id, [message("needle secret")])
    app, router = FastAPI(), APIRouter(prefix="/v1")
    register_context_reference_routes(
        router,
        conversation_store=store,
        auth_provider=SimpleNamespace(get_user_id=lambda request: "alice"),
        permission_store=permissions,
    )
    app.include_router(router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        chats = await client.get("/v1/context-references/chats")
        assert {row["id"] for row in chats.json()["data"]} == {parent.id, child.id}
        hits = await client.get("/v1/context-references/chats?messages=true&query=needle")
        assert [(row["id"], row["message_id"]) for row in hits.json()["data"]] == [
            (child.id, item.id)
        ]
        response = await client.post(
            f"/v1/sessions/{child.id}/context-reference",
            json={"scope": "whole", "destination_id": parent.id},
        )
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["items"] == [item.to_api_dict()]
        assert snapshot["boundary_id"] == item.id
        assert "future participants" in snapshot["audience"]
        assert "not attached bytes" in snapshot["representation"]
        assert len(snapshot["snapshot_id"]) == 64
        permissions.grant("alice", parent.id, LEVEL_READ)
        with pytest.raises(OmnigentError):
            await client.post(
                f"/v1/sessions/{child.id}/context-reference",
                json={"scope": "whole", "destination_id": parent.id},
            )


def test_last_answer_excludes_the_live_response_even_if_its_message_is_committed(
    conversation_store,
):
    source = conversation_store.create_conversation()
    items = conversation_store.append(
        source.id,
        [
            message("finished", role="assistant", response="done"),
            message("commentary", role="assistant", response="live"),
        ],
    )
    result = capture_items(
        conversation_store,
        source.id,
        CaptureReference(scope="last_answer"),
        active_response_id="live",
    )
    assert [item["id"] for item in result] == [items[0].id]


def test_reference_does_not_claim_to_deliver_media_as_whole_chat(conversation_store):
    source = conversation_store.create_conversation()
    entry = message("caption")
    entry.data.content.append(
        {"type": "input_image", "image_url": "https://example.test/image.png"}
    )
    item = conversation_store.append(source.id, [entry])[0]
    with pytest.raises(HTTPException) as error:
        capture_items(conversation_store, source.id, CaptureReference(scope="whole"))
    assert error.value.status_code == 422
    assert "attach original files" in error.value.detail
    quoted = capture_items(
        conversation_store,
        source.id,
        CaptureReference(scope="quote", boundary_id=item.id, quote="caption"),
    )
    assert quoted[0]["id"] == item.id
    assert "content" not in quoted[0]


def test_selected_context_seeks_old_boundaries_and_stops_in_long_history(
    conversation_store, monkeypatch
):
    store = conversation_store
    source = store.create_conversation()
    items = store.append(
        source.id, [message(str(index), response=str(index)) for index in range(10_050)]
    )
    from unittest.mock import Mock

    list_items = Mock(wraps=store.list_items)
    monkeypatch.setattr(store, "list_items", list_items)
    # Both ends of a history larger than the scan budget use scoped point lookups.
    for selected in (items[-1], items[0]):
        for scope in ("quote", "messages"):
            result = capture_items(
                store,
                source.id,
                CaptureReference(
                    scope=scope,
                    boundary_id=selected.id,
                    message_ids=[selected.id],
                    quote="exact selected text",
                ),
            )
            assert [entry["id"] for entry in result] == [selected.id]
            if scope == "quote":
                assert "content" not in result[0]
            assert result[0]["created_at"] == selected.created_at
    assert list_items.call_count == 0
    assert capture_items(
        store, source.id, CaptureReference(scope="messages", message_ids=[items[0].id])
    ) == [items[0].to_api_dict()]
    assert list_items.call_count == 0

    # A multi-item selection stops on its oldest requested item, not at history end.
    result = capture_items(
        store,
        source.id,
        CaptureReference(
            scope="quote",
            boundary_id=items[-1].id,
            message_ids=[items[-3].id, items[-1].id],
            quote="two selected messages",
        ),
    )
    assert [entry["id"] for entry in result] == [items[-3].id, items[-1].id]
    assert list_items.call_count == 1


def test_selected_context_rejects_messages_outside_the_boundary_or_conversation(
    conversation_store,
):
    store = conversation_store
    source, other = store.create_conversation(), store.create_conversation()
    old, new = store.append(source.id, [message("old"), message("new")])
    foreign = store.append(other.id, [message("private")])[0]
    for request in (
        CaptureReference(scope="quote", boundary_id=old.id, message_ids=[new.id], quote="later"),
        CaptureReference(
            scope="quote", boundary_id=new.id, message_ids=[foreign.id], quote="foreign"
        ),
        CaptureReference(
            scope="quote", boundary_id=foreign.id, message_ids=[old.id], quote="foreign boundary"
        ),
    ):
        with pytest.raises(HTTPException) as error:
            capture_items(store, source.id, request)
        assert error.value.status_code == 409


def test_response_selection_keeps_all_items_across_pages_before_stopping(
    conversation_store, monkeypatch
):
    from unittest.mock import Mock

    store = conversation_store
    source = store.create_conversation()
    store.append(source.id, [message("older", response=f"old-{index}") for index in range(150)])
    items = store.append(
        source.id, [message(str(index), response="selected-response") for index in range(105)]
    )
    list_items = Mock(wraps=store.list_items)
    monkeypatch.setattr(store, "list_items", list_items)
    result = capture_items(
        store,
        source.id,
        CaptureReference(scope="quote", boundary_id="selected-response", quote="exact selection"),
    )
    assert [entry["id"] for entry in result] == [entry.id for entry in items]
    assert list_items.call_count == 2
