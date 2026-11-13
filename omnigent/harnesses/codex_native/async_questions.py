# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Structured async questions emitted by native Codex agent messages."""

from __future__ import annotations

import hashlib

from omnigent.harnesses.codex_native.app_server import (
    CodexAppServerClient,
    CodexAppServerResponseError,
    is_stale_active_turn_error,
)
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
) -> None:
    """Deliver an answer as native user input, retaining its replay identity."""
    inputs = result.get("input")
    if not isinstance(inputs, list) or not inputs:
        return
    thread_id = params.get("threadId")
    item = params.get("item")
    item_id = item.get("id") if isinstance(item, dict) else None
    if not isinstance(thread_id, str) or not thread_id or not isinstance(item_id, str):
        raise ValueError("Native async question is missing thread or item identity")
    digest = hashlib.sha256(f"{thread_id}:{item_id}".encode()).hexdigest()
    client_id = f"omnigent-codex-question:{digest}"
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
                    and previous.get("clientId") == client_id
                ):
                    return
            if turn.get("status") == "inProgress":
                active_turn = turn.get("id")
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
