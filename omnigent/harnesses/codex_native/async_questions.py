# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Structured async questions emitted by native Codex agent messages."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Awaitable, Callable

from omnigent.harnesses.codex_native.app_server import (
    CodexAppServerClient,
    CodexAppServerResponseError,
    is_stale_active_turn_error,
)
from omnigent.native.communication import NATIVE_INPUT_CLIENT_ID_PREFIX
from omnigent.util.json_types import JsonObject


def async_question_params(params: JsonObject) -> JsonObject | None:
    """Normalize observed async message fields into the shared question form."""
    item = params.get("item")
    if not isinstance(item, dict) or item.get("type") != "agentMessage":
        return None
    if item.get("delivery") != "async":
        return None
    raw_questions = item.get("questions")
    if not isinstance(raw_questions, list) or not raw_questions:
        return None
    questions = []
    for index, raw in enumerate(raw_questions):
        if not isinstance(raw, dict) or not isinstance(raw.get("title"), str) or not raw["title"]:
            return None
        options = raw.get("options")
        if options is not None and (
            not isinstance(options, list)
            or any(not isinstance(option, str) or not option for option in options)
        ):
            return None
        questions.append(
            {
                "id": f"question_{index}",
                "question": raw["title"],
                "options": [{"label": option} for option in options or []],
                "isOther": True,
            }
        )
    return {
        "threadId": params.get("threadId"),
        "turnId": params.get("turnId"),
        "itemId": item.get("id"),
        "isBlocking": False,
        "questions": questions,
    }


async def submit_async_question_answer(
    client: CodexAppServerClient,
    params: JsonObject,
    result: JsonObject,
    *,
    prepare_framework_input: Callable[[str, str, str], Awaitable[list[JsonObject]]] | None = None,
) -> None:
    """Deliver human answers or registered framework controls with replay identity.

    ``prepare_framework_input(input_id, text, label)`` must durably register
    system authorship and return prepared API ``input_text`` blocks.
    """
    inputs = result.get("input")
    submission = result.get("question_submission")
    generated = (
        isinstance(submission, dict)
        and submission.get("action") in {"accept", "decline"}
        and inputs == []
    )
    if not generated and (not isinstance(inputs, list) or not inputs):
        return
    thread_id = params.get("threadId")
    item = params.get("item")
    item_id = item.get("id") if isinstance(item, dict) else None
    if not isinstance(thread_id, str) or not thread_id or not isinstance(item_id, str):
        raise ValueError("Native async question is missing thread or item identity")
    digest = hashlib.sha256(f"{thread_id}:{item_id}".encode()).hexdigest()
    answer_id = f"omnigent-codex-question:{digest}"
    framework_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{answer_id}:system").hex
    framework_client_id = f"{NATIVE_INPUT_CLIENT_ID_PREFIX}{framework_id}"
    client_id = framework_client_id if generated else answer_id
    replay_ids = {answer_id, framework_client_id}
    prepared = False
    # Only retry a rejected stale steer. Socket loss may mean input was accepted;
    # a replay checks the durable native user-message identity before sending.
    for attempt in range(2):
        response = await client.request(
            "thread/read", {"threadId": thread_id, "includeTurns": True}
        )
        read_result = response.get("result", {})
        thread = read_result.get("thread", {}) if isinstance(read_result, dict) else {}
        turns = thread.get("turns") if isinstance(thread, dict) else None
        if not isinstance(turns, list):
            raise ValueError("Native async answer requires authoritative thread history")
        active_turn = None
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            for previous in turn.get("items", []):
                if (
                    isinstance(previous, dict)
                    and previous.get("type") == "userMessage"
                    and previous.get("clientId") in replay_ids
                ):
                    return
            if turn.get("status") == "inProgress":
                active_turn = turn.get("id")
        if generated and not prepared:
            if prepare_framework_input is None:
                raise ValueError("Native async submission requires framework input registration")
            normalized = async_question_params(params)
            if normalized is None or not isinstance(submission, dict):
                raise ValueError("Native async submission requires structured questions")
            action = submission["action"]
            text = json.dumps(
                {
                    "event": "question_submission",
                    "item_id": item_id,
                    "action": action,
                    "answers": {},
                },
                ensure_ascii=False,
            )
            label = (
                "Question request declined"
                if action == "decline"
                else "Questions submitted without answers"
            )
            content = await prepare_framework_input(framework_id, text, label)
            if not content or any(
                part.get("type") != "input_text" or not isinstance(part.get("text"), str)
                for part in content
            ):
                raise ValueError("Framework input registration returned no native content")
            inputs = [{"type": "text", "text": part["text"]} for part in content]
            prepared = True
        request: JsonObject = {
            "threadId": thread_id,
            "clientUserMessageId": client_id,
            "input": inputs,
        }
        method = "turn/start"
        if isinstance(active_turn, str) and active_turn:
            method = "turn/steer"
            request["expectedTurnId"] = active_turn
        try:
            await client.request(method, request)
            return
        except CodexAppServerResponseError as error:
            if attempt or method != "turn/steer" or not is_stale_active_turn_error(error):
                raise
