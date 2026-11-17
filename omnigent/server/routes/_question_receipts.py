# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Build and persist durable receipts for answered question batches."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any
from weakref import WeakValueDictionary

from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.entities import NewConversationItem, ResourceEventData
from omnigent.harnesses.codex_native.async_questions import (
    async_question_answer_client_id,
    async_question_framework_input_id,
)
from omnigent.stores import ConversationStore

_ASK_USER_QUESTION_PREFIX = "AskUserQuestion("
_resolution_locks: WorkspaceScopedCache[tuple[str, str], asyncio.Lock] = WorkspaceScopedCache(
    WeakValueDictionary
)


def question_resolution_lock(session_id: str, elicitation_id: str) -> asyncio.Lock:
    """Serialize persistence and wakeup for competing answers to one request."""
    key = (session_id, elicitation_id)
    lock = _resolution_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _resolution_locks[key] = lock
    return lock


def _canonical_json(value: object) -> str:
    """Return a deterministic JSON representation for receipt identities."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _preview_ask_user_question(params: dict[str, Any]) -> dict[str, Any] | None:
    preview = params.get("content_preview")
    if not isinstance(preview, str):
        return None
    text = preview.strip()
    if not text.startswith(_ASK_USER_QUESTION_PREFIX) or not text.endswith(")"):
        return None
    try:
        parsed = json.loads(text[len(_ASK_USER_QUESTION_PREFIX) : -1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _ask_user_question(params: dict[str, Any]) -> dict[str, Any] | None:
    structured = params.get("ask_user_question")
    if isinstance(structured, dict):
        return structured
    if params.get("tool_name") != "AskUserQuestion":
        return None
    return _preview_ask_user_question(params)


def _receipt_request(params: dict[str, Any], *, has_secret_questions: bool) -> dict[str, Any]:
    """Copy request params without persisting secret text defaults."""
    copied = json.loads(_canonical_json(params))

    def sanitize(value: object) -> None:
        if isinstance(value, dict):
            if value.get("isSecret") is True:
                text_input = value.get("textInput")
                if isinstance(text_input, dict):
                    text_input.pop("default", None)
            for nested in value.values():
                sanitize(nested)
        elif isinstance(value, list):
            for nested in value:
                sanitize(nested)

    sanitize(copied)
    # A legacy preview duplicates the complete question JSON as text, where a
    # structural sanitizer cannot safely remove only secret defaults.
    if has_secret_questions:
        copied.pop("content_preview", None)
    return copied


def build_question_receipt_payload(
    session_id: str,
    elicitation_id: str,
    params: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any] | None:
    """Build a question-batch resource, or ``None`` for non-question elicitations.

    ``params`` must be the trusted pending-elicitation params captured before
    resolution drains the registry. The returned mapping is the
    ``ResourceEventData.resource`` payload, not a conversation item.
    """
    ask_payload = _ask_user_question(params)
    questions_raw = ask_payload.get("questions") if ask_payload is not None else None
    action = result.get("action")
    if not isinstance(questions_raw, list) or not questions_raw:
        return None
    if action not in {"accept", "decline", "cancel"}:
        return None

    content = result.get("content")
    answers = content if action == "accept" and isinstance(content, dict) else {}
    questions: list[dict[str, Any]] = []
    has_secret_questions = False
    for index, raw_question in enumerate(questions_raw):
        if not isinstance(raw_question, dict):
            continue
        question_text = raw_question.get("question")
        if not isinstance(question_text, str) or not question_text:
            continue
        explicit_id = raw_question.get("id")
        question_id = (
            explicit_id if isinstance(explicit_id, str) and explicit_id else f"question_{index}"
        )
        answer_key = explicit_id if isinstance(explicit_id, str) and explicit_id else question_text
        is_secret = raw_question.get("isSecret") is True
        has_secret_questions = has_secret_questions or is_secret
        question: dict[str, Any] = {
            "id": question_id,
            "question": question_text,
            "answered": answer_key in answers,
        }
        header = raw_question.get("header")
        if isinstance(header, str) and header:
            question["header"] = header
        if answer_key in answers:
            if is_secret:
                question["redacted"] = True
            else:
                question["answer"] = answers[answer_key]
        questions.append(question)
    if not questions:
        return None

    receipt_request = _receipt_request(params, has_secret_questions=has_secret_questions)
    identity = {
        "session_id": session_id,
        "elicitation_id": elicitation_id,
        "request": receipt_request,
    }
    digest = hashlib.sha256(_canonical_json(identity).encode()).hexdigest()
    source = {
        key: params[key]
        for key in (
            "thread_id",
            "turn_id",
            "item_id",
            "codex_request_id",
            "tool_use_id",
            "call_id",
            "tool_call_id",
        )
        if key in params and params[key] is not None
    }
    if (
        params.get("codex_method") == "item/completed"
        and isinstance(source.get("thread_id"), str)
        and isinstance(source.get("item_id"), str)
    ):
        source["native_client_id"] = async_question_answer_client_id(
            source["thread_id"], source["item_id"]
        )
        source["framework_input_id"] = async_question_framework_input_id(
            source["thread_id"], source["item_id"]
        )
    return {
        "version": 1,
        "session_id": session_id,
        "elicitation_id": elicitation_id,
        "submission_id": f"question_submission_{digest[:32]}",
        "questions": questions,
        "action": action,
        "source": source,
        "request": receipt_request,
    }


async def record_question_receipt(
    conversation_store: ConversationStore,
    session_id: str,
    elicitation_id: str,
    params: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any] | None:
    """Persist one idempotent receipt and return its flat API item.

    The caller publishes the returned mapping as the ``item`` of a normal
    ``response.output_item.done`` event. ``None`` means the elicitation was not
    an actual AskUserQuestion batch or this submission was already stored.
    """
    resource = build_question_receipt_payload(session_id, elicitation_id, params, result)
    if resource is None:
        return None
    submission_id = str(resource["submission_id"])
    stable_id = hashlib.sha256(submission_id.encode()).hexdigest()[:32]
    item = NewConversationItem(
        type="resource_event",
        response_id=submission_id,
        stable_id=stable_id,
        data=ResourceEventData(
            resource_type="question_batch",
            event_type="session.question.answered",
            resource_id=elicitation_id,
            resource=resource,
        ),
    )
    persisted = (await asyncio.to_thread(conversation_store.append, session_id, [item]))[0]
    if persisted.deduplicated:
        return None
    return persisted.to_api_dict()
