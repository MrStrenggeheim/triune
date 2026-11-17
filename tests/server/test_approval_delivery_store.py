"""Approval reservation persists across processes without storing a verdict payload."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from omnigent.db.db_models import workspace_scope
from omnigent.errors import OmnigentError
from omnigent.server.approval_delivery_store import ApprovalDeliveryStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


def reservation(session_id, *, attempt="a" * 64):
    return {
        "identity": {
            "session_id": session_id,
            "elicitation_id": "exact-question",
            "attempt_id": attempt,
        },
        "action": "decline",
        "event": {
            "type": "response.elicitation_request",
            "elicitation_id": "exact-question",
            "params": {"message": "Original request"},
        },
        "question_receipt": None,
        "conversation_binding": None,
    }


def test_only_one_concurrent_attempt_claims_and_restart_preserves_hold(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    session = conversations.create_conversation()
    stores = [ApprovalDeliveryStore(db_uri), ApprovalDeliveryStore(db_uri)]
    records = [reservation(session.id, attempt=value * 64) for value in "ab"]
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(
            workers.map(
                lambda pair: pair[0].reserve(
                    session.id, "exact-question", pair[1], expected_runner_binding=None
                ),
                zip(stores, records, strict=True),
            )
        )
    assert sum(created for _, created in results) == 1
    assert results[0][0] == results[1][0]
    fresh = ApprovalDeliveryStore(db_uri)
    held = fresh.read(session.id, "exact-question")
    assert held["state"] == "held"
    assert fresh.held(session.id) == [held]
    assert conversations.get_conversation(session.id).pending_elicitation_count == 1
    assert not fresh.accept(
        session.id, "exact-question", {**held["identity"], "attempt_id": "c" * 64}
    )
    assert fresh.accept(session.id, "exact-question", held["identity"])
    assert ApprovalDeliveryStore(db_uri).read(session.id, "exact-question")["state"] == "accepted"
    assert fresh.held(session.id) == []


def test_binding_change_and_raw_result_field_fail_before_reservation(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    session = conversations.create_conversation()
    store = ApprovalDeliveryStore(db_uri)
    with pytest.raises(OmnigentError):
        store.reserve(
            session.id,
            "exact-question",
            reservation(session.id),
            expected_runner_binding="foreign-runner",
        )
    with pytest.raises(OmnigentError):
        store.reserve(
            session.id,
            "exact-question",
            {**reservation(session.id), "result": {"secret": "must never be stored"}},
            expected_runner_binding=None,
        )
    assert store.read(session.id, "exact-question") is None


def test_journal_is_partitioned_by_workspace_and_recovers_only_held_records(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    store = ApprovalDeliveryStore(db_uri)
    with workspace_scope(41):
        first = conversations.create_conversation()
        row, _ = store.reserve(
            first.id, "exact-question", reservation(first.id), expected_runner_binding=None
        )
    with workspace_scope(42):
        assert store.read(first.id, "exact-question") is None
        second = conversations.create_conversation()
        store.reserve(
            second.id, "exact-question", reservation(second.id), expected_runner_binding=None
        )
    rows = store.recovery_page()
    assert {(wid, sid) for wid, sid, _, _ in rows} == {(41, first.id), (42, second.id)}
    with workspace_scope(41):
        store.accept(first.id, "exact-question", row["identity"])
    assert [(wid, sid) for wid, sid, _, _ in store.recovery_page()] == [(42, second.id)]


def test_release_recovery_is_paged_exact_and_excludes_unaccepted(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    conversation = conversations.create_conversation()
    store = ApprovalDeliveryStore(db_uri)
    rows = []
    for number in range(10):
        eid = f"question-{number:02}"
        payload = reservation(conversation.id)
        payload["identity"]["elicitation_id"] = eid
        payload["event"]["elicitation_id"] = eid
        row, _ = store.reserve(conversation.id, eid, payload, expected_runner_binding=None)
        rows.append((eid, row))
        if number < 9:
            assert store.accept(conversation.id, eid, row["identity"])
    first = store.release_page()
    assert len(first) == 8
    second = store.release_page(first[-1][:3])
    assert len(second) == 1 and second[0][2] == "question-08"
    assert store.release_page(second[-1][:3]) == []
    assert not store.mark_released(conversation.id, "question-09", rows[-1][1]["identity"])
    assert not store.mark_released(conversation.id, "question-00", {"foreign": True})
    assert store.mark_released(conversation.id, "question-00", rows[0][1]["identity"])
    assert len(store.release_page()) == 8
    assert conversations.get_conversation(conversation.id).pending_elicitation_count == 1
    # Repeated acceptance cannot decrement a separate unresolved hold.
    assert store.accept(conversation.id, "question-00", rows[0][1]["identity"])
    assert conversations.get_conversation(conversation.id).pending_elicitation_count == 1


@pytest.mark.asyncio
async def test_explicit_conversation_delete_cleans_journal_projection(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    parent = conversations.create_conversation()
    child = conversations.create_conversation(parent_conversation_id=parent.id, title="child")
    store = ApprovalDeliveryStore(db_uri)
    payload = {**reservation(child.id), "mirror_sessions": [parent.id]}
    store.reserve(child.id, "exact-question", payload, expected_runner_binding=None)
    conversations.set_pending_elicitation_count(parent.id, 0)
    assert conversations.get_conversation(parent.id).pending_elicitation_count == 1
    assert await conversations.delete_conversation(parent.id)
    assert store.recovery_page() == []
