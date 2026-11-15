# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Tests for durable answered-question receipts."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from omnigent.db.db_models import workspace_scope
from omnigent.entities import ConversationItem
from omnigent.server.routes._question_receipts import (
    build_question_receipt_payload,
    question_resolution_lock,
    record_question_receipt,
)


def test_resolution_locks_separate_imported_request_ids_between_workspaces():
    with workspace_scope(41):
        first = question_resolution_lock("imported-chat", "same-question")
        assert question_resolution_lock("imported-chat", "same-question") is first
    with workspace_scope(42):
        second = question_resolution_lock("imported-chat", "same-question")
        assert second is not first
        assert question_resolution_lock("imported-chat", "same-question") is second
    with workspace_scope(41):
        assert question_resolution_lock("imported-chat", "same-question") is first


@pytest.mark.asyncio
async def test_resolver_persists_before_native_wakeup_and_preserves_provider_schema(monkeypatch):
    from omnigent.runtime import pending_elicitations
    from omnigent.server.routes._codex_elicitation import parse_codex_elicitation_request
    from omnigent.server.routes._sessions import orchestration as routes

    request = parse_codex_elicitation_request(
        {
            "id": 17,
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "questions": [
                    {
                        "id": "secret",
                        "header": "Auth",
                        "question": "Token?",
                        "isSecret": True,
                        "options": [],
                    }
                ],
            },
        }
    )
    session_id, elicitation_id = "receipt-resolution", "receipt-question"
    params = request.params.model_dump(exclude_none=True)
    pending_elicitations.record_publish(
        session_id,
        {
            "type": "response.elicitation_request",
            "elicitation_id": elicitation_id,
            "params": params,
        },
    )
    future = asyncio.get_running_loop().create_future()
    monkeypatch.setitem(routes._harness_elicitation_registry, elicitation_id, future)
    monkeypatch.setitem(routes._harness_elicitation_owners, elicitation_id, session_id)
    monkeypatch.setattr(routes, "_resolve_native_delivery", AsyncMock(return_value=False))
    monkeypatch.setattr(routes, "_forward_approval_to_runner", AsyncMock())
    monkeypatch.setattr(routes, "_publish_elicitation_resolved_to_ancestors", Mock())
    published = []

    def publish(sid, event):
        published.append(event)
        pending_elicitations.record_publish(sid, event)

    monkeypatch.setattr(routes.session_stream, "publish", publish)
    store = Mock()

    def append(_session_id, items):
        assert not future.done()
        item = items[0]
        return [
            ConversationItem(
                id=item.stable_id,
                type=item.type,
                status=item.status,
                response_id=item.response_id,
                created_at=123,
                data=item.data,
            )
        ]

    store.append.side_effect = append
    try:
        await asyncio.gather(
            *[
                routes._resolve_elicitation(
                    session_id,
                    {
                        "elicitation_id": elicitation_id,
                        "action": "accept",
                        "content": {"secret": answer},
                    },
                    None,
                    store,
                )
                for answer in ["exact-secret", "competing-answer"]
            ]
        )
        verdict = future.result()
        assert verdict.content == {"secret": "exact-secret"}
        assert request.build_response(verdict) == {
            "answers": {"secret": {"answers": ["exact-secret"]}}
        }
        receipt_events = [
            event for event in published if event["type"] == "response.output_item.done"
        ]
        assert len(receipt_events) == 1
        receipt = receipt_events[0]["item"]["resource"]
        assert receipt["questions"] == [
            {
                "id": "secret",
                "header": "Auth",
                "question": "Token?",
                "answered": True,
                "redacted": True,
            }
        ]
        assert "exact-secret" not in json.dumps(receipt_events)
        assert verdict.meta["question_submission"]["submission_id"] == receipt["submission_id"]
        assert receipt["source"]["item_id"] == "item-1"
        store.append.assert_called_once()
    finally:
        pending_elicitations.resolve(session_id, elicitation_id)
        routes._harness_pre_resolved_elicitations.pop(elicitation_id, None)


def _params() -> dict[str, Any]:
    return {
        "ask_user_question": {
            "questions": [
                {"id": "framework", "header": "Framework", "question": "Which framework?"},
                {"question": "Notes?"},
                {"id": "targets", "question": "Targets?"},
            ]
        },
        "thread_id": "thread-1",
        "turn_id": "turn-1",
        "item_id": "item-1",
        "codex_request_id": 17,
        "tool_use_id": "toolu-1",
        "call_id": "call-1",
        "tool_call_id": "tool-call-1",
    }


def test_payload_preserves_order_empty_missing_and_multi_answers() -> None:
    params = _params()
    payload = build_question_receipt_payload(
        "session-1",
        "elicit-1",
        params,
        {"action": "accept", "content": {"framework": "", "targets": ["web", "cli"]}},
    )

    assert payload is not None
    assert payload["questions"] == [
        {
            "id": "framework",
            "question": "Which framework?",
            "header": "Framework",
            "answer": "",
            "answered": True,
        },
        {"id": "question_1", "question": "Notes?", "answered": False},
        {
            "id": "targets",
            "question": "Targets?",
            "answer": ["web", "cli"],
            "answered": True,
        },
    ]
    assert payload["source"] == {
        "thread_id": "thread-1",
        "turn_id": "turn-1",
        "item_id": "item-1",
        "codex_request_id": 17,
        "tool_use_id": "toolu-1",
        "call_id": "call-1",
        "tool_call_id": "tool-call-1",
    }
    assert payload["request"] == params
    assert payload["request"] is not params


@pytest.mark.parametrize("action", ["decline", "cancel"])
def test_non_accept_actions_leave_all_questions_unanswered(action: str) -> None:
    payload = build_question_receipt_payload(
        "session-1", "elicit-1", _params(), {"action": action, "content": {"framework": "React"}}
    )
    assert payload is not None
    assert payload["action"] == action
    assert all(
        question == {key: value for key, value in question.items() if key != "answer"}
        for question in payload["questions"]
    )
    assert all(question["answered"] is False for question in payload["questions"])


def test_full_ask_user_question_preview_is_supported_but_binary_approval_is_skipped() -> None:
    preview_params = {
        "tool_name": "AskUserQuestion",
        "content_preview": 'AskUserQuestion({"questions":[{"question":"Pick?","options":[]}]})',
    }
    payload = build_question_receipt_payload(
        "session-1", "elicit-1", preview_params, {"action": "accept", "content": {"Pick?": "A"}}
    )
    assert payload is not None
    assert payload["questions"] == [
        {"id": "question_0", "question": "Pick?", "answer": "A", "answered": True}
    ]
    assert (
        build_question_receipt_payload(
            "session-1",
            "elicit-2",
            {"message": "Run command?", "content_preview": "rm something"},
            {"action": "accept"},
        )
        is None
    )


def test_submission_identity_uses_original_request_not_answer_text() -> None:
    first = build_question_receipt_payload(
        "session-1", "elicit-1", _params(), {"action": "accept", "content": {"framework": "React"}}
    )
    second = build_question_receipt_payload(
        "session-1", "elicit-1", _params(), {"action": "accept", "content": {"framework": "Vue"}}
    )
    other = build_question_receipt_payload(
        "session-1", "elicit-2", _params(), {"action": "accept", "content": {"framework": "React"}}
    )
    assert first is not None and second is not None and other is not None
    assert first["submission_id"] == second["submission_id"]
    assert first["submission_id"] != other["submission_id"]


@pytest.mark.parametrize(
    "secret_answer",
    ["raw-secret-value", ["first-secret", "second-secret"]],
)
def test_secret_answers_and_defaults_are_absent_from_receipt_history(
    secret_answer: str | list[str],
) -> None:
    params = {
        "ask_user_question": {
            "questions": [
                {
                    "id": "credential",
                    "question": "Credential?",
                    "isSecret": True,
                    "textInput": {"default": "default-secret"},
                }
            ]
        },
        "content_preview": (
            'AskUserQuestion({"questions":[{"id":"credential",'
            '"question":"Credential?","isSecret":true,'
            '"textInput":{"default":"default-secret"}}]})'
        ),
    }
    result = {"action": "accept", "content": {"credential": secret_answer}}

    payload = build_question_receipt_payload("session-1", "elicit-secret", params, result)

    assert payload is not None
    assert payload["questions"] == [
        {
            "id": "credential",
            "question": "Credential?",
            "answered": True,
            "redacted": True,
        }
    ]
    assert payload["request"]["ask_user_question"]["questions"][0]["textInput"] == {}
    assert "content_preview" not in payload["request"]
    persisted_text = json.dumps(payload)
    assert "default-secret" not in persisted_text
    if isinstance(secret_answer, str):
        assert secret_answer not in persisted_text
    else:
        assert all(answer not in persisted_text for answer in secret_answer)
    # Receipt sanitization never mutates the provider-bound result.
    assert result["content"]["credential"] == secret_answer


@pytest.mark.asyncio
async def test_record_persists_resource_event_and_returns_wire_item() -> None:
    store = Mock()

    def append(session_id: str, items: list[Any]) -> list[ConversationItem]:
        assert session_id == "session-1"
        new = items[0]
        assert new.stable_id is not None
        return [
            ConversationItem(
                id=new.stable_id,
                type=new.type,
                status=new.status,
                response_id=new.response_id,
                created_at=123,
                data=new.data,
            )
        ]

    store.append.side_effect = append
    item = await record_question_receipt(
        store,
        "session-1",
        "elicit-1",
        _params(),
        {"action": "accept", "content": {"framework": "React"}},
    )

    assert item is not None
    assert item["type"] == "resource_event"
    assert item["event_type"] == "session.question.answered"
    assert item["resource_type"] == "question_batch"
    assert item["resource_id"] == "elicit-1"
    assert item["resource"]["questions"][0]["answer"] == "React"


@pytest.mark.asyncio
async def test_record_suppresses_duplicate_publish_item() -> None:
    store = Mock()

    def append(_session_id: str, items: list[Any]) -> list[ConversationItem]:
        new = items[0]
        return [
            ConversationItem(
                id=new.stable_id,
                type=new.type,
                status=new.status,
                response_id=new.response_id,
                created_at=123,
                data=new.data,
                deduplicated=True,
            )
        ]

    store.append.side_effect = append
    assert (
        await record_question_receipt(
            store,
            "session-1",
            "elicit-1",
            _params(),
            {"action": "accept", "content": {"framework": "React"}},
        )
        is None
    )
