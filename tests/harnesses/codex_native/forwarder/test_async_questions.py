# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Real async message fields cross the forwarder and question adapter boundary."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from omnigent.harnesses.codex_native import forwarder as fwd
from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.harnesses.codex_native.async_questions import (
    async_question_answer_client_id,
    submit_async_question_answer,
)
from omnigent.server.routes._codex_elicitation import parse_codex_elicitation_request
from omnigent.server.routes._question_receipts import build_question_receipt_payload
from omnigent.server.schemas import ElicitationResult
from tests.harnesses.codex_native.session._support import _write_forwarder_bridge


def _question_event(thread="thread"):
    return {
        "method": "item/completed",
        "params": {
            "threadId": thread,
            "turnId": "turn",
            "item": {
                "id": "call-question",
                "type": "agentMessage",
                "text": "Choose native color\n- Blue\n- Green",
                "delivery": "async",
                "questions": [{"title": "Choose native color", "options": ["Blue", "Green"]}],
            },
        },
    }


class _NativeAnswerClient:
    def __init__(self, status="completed", failure=None):
        self.turns = [{"id": "turn", "status": status, "items": []}]
        self.calls = []
        self.failure = failure

    async def request(self, method, params):
        self.calls.append((method, params))
        if method in {"thread/read", "thread/resume"}:
            return {"result": {"thread": {"turns": self.turns}}}
        if self.failure:
            error, self.failure = self.failure, None
            self.turns[0]["status"] = "completed"
            raise error
        self.turns[0]["items"].append(
            {"type": "userMessage", "clientId": params["clientUserMessageId"]}
        )
        return {"result": {"turn": {"id": "answer-turn"}}}

    async def respond(self, request_id, result):
        raise AssertionError("Native async messages have no RPC question-response channel")


@pytest.mark.asyncio
async def test_canonical_receipt_correlates_native_echo_without_consuming_equal_human_text():
    event = _question_event()
    request = parse_codex_elicitation_request({"id": "call-question", **event})
    verdict = ElicitationResult(action="accept", content={"question_0": "Blue"})
    receipt = build_question_receipt_payload(
        "session", "elicitation", request.params.model_dump(), verdict.model_dump()
    )
    identity = {
        **receipt["source"],
        "session_id": "session",
        "elicitation_id": "elicitation",
        "submission_id": receipt["submission_id"],
    }
    response = request.build_response(
        verdict.model_copy(update={"meta": {"question_submission": identity}})
    )
    assert response["question_submission"] == identity
    native = _NativeAnswerClient()
    await submit_async_question_answer(native, event["params"], response)
    _, sent = native.calls[-1]
    assert sent["input"] == [{"type": "text", "text": "Choose native color\nBlue"}]
    assert (
        sent["clientUserMessageId"]
        == identity["native_client_id"]
        == async_question_answer_client_id("thread", "call-question")
    )
    posts = []

    def handle(post):
        posts.append(json.loads(post.content))
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(
        base_url="http://test", transport=httpx.MockTransport(handle)
    ) as client:
        for client_id in [
            sent["clientUserMessageId"],
            "genuine-human-input",
            "omnigent-codex-question:invalid",
        ]:
            assert await fwd._post_user_message(
                client,
                "session",
                event["params"],
                {
                    "id": client_id,
                    "type": "userMessage",
                    "clientId": client_id,
                    "content": [{"type": "text", "text": "Choose native color\nBlue"}],
                },
            )
    assert len(posts) == 2
    assert all(
        body["data"]["item_data"]["content"]
        == [{"type": "input_text", "text": "Choose native color\nBlue"}]
        for body in posts
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("child", [False, True])
async def test_async_question_survives_turn_end_and_answers_its_native_thread(
    tmp_path: Path, child: bool
) -> None:
    started, answer = asyncio.Event(), asyncio.Event()
    posts, questions = [], []
    native = _NativeAnswerClient()
    state = fwd._CodexForwarderState(
        parent_session_id="parent", mcp_startup_settled=True, codex_client=native
    )
    thread = "child-thread" if child else "thread"
    if child:
        state.note_child_thread(thread, "child")
        state.child_streams.clear()
    state.posted_user_turns.add("turn")
    _write_forwarder_bridge(
        tmp_path, active_turn_id="turn", session_id="parent", thread_id="thread"
    )

    async def handle(request):
        body = json.loads(request.content)
        posts.append((request.url.path, body))
        if request.url.path.endswith("/hooks/codex-elicitation-request"):
            parsed = parse_codex_elicitation_request(body)
            questions.append(parsed.params.model_dump())
            started.set()
            await answer.wait()
            return httpx.Response(
                200,
                json=parsed.build_response(
                    ElicitationResult(action="accept", content={"question_0": "Blue"})
                ),
            )
        return httpx.Response(200, json={})

    tracker = fwd._CodexElicitationTaskTracker()
    async with httpx.AsyncClient(
        base_url="http://test", transport=httpx.MockTransport(handle)
    ) as client:

        async def emit(event):
            await fwd._handle_event(
                client,
                session_id="parent",
                bridge_dir=tmp_path,
                event=event,
                usage_coalescer=fwd._SessionUsageCoalescer(client, "parent"),
                elicitation_tracker=tracker,
                expected_thread_id="thread",
                forwarder_state=state,
            )

        try:
            await emit(_question_event(thread))
            await asyncio.wait_for(started.wait(), 2)
            await emit(_question_event(thread))
            await emit(
                {
                    "method": "turn/completed",
                    "params": {
                        "threadId": thread,
                        "turn": {"id": "turn", "status": "completed", "items": []},
                    },
                }
            )
            assert not any(
                body.get("type") == "external_elicitation_resolved" for _, body in posts
            )
            assert len(questions) == 1
            assert questions[0]["isBlocking"] is False
            assert questions[0]["ask_user_question"]["questions"][0]["options"] == [
                {"label": "Blue"},
                {"label": "Green"},
            ]
            hook_path = next(
                path for path, _ in posts if path.endswith("/hooks/codex-elicitation-request")
            )
            assert hook_path == (
                "/v1/sessions/child/hooks/codex-elicitation-request"
                if child
                else "/v1/sessions/parent/hooks/codex-elicitation-request"
            )
            answer.set()
            active_tracker = state.child_streams[thread].elicitation_tracker if child else tracker
            await asyncio.wait_for(active_tracker.drain(), 2)
            method, params = native.calls[-1]
            assert method == "turn/start"
            assert params["threadId"] == thread
            assert params["input"] == [{"type": "text", "text": "Choose native color\nBlue"}]
            assert params["clientUserMessageId"].startswith("omnigent-codex-question:")
            # A new forwarder can replay a durable answer without resending it.
            before = len(native.calls)
            await submit_async_question_answer(
                native, _question_event(thread)["params"], {"input": params["input"]}
            )
            assert len(native.calls) == before + 1
            assert native.calls[-1][0] == "thread/read"
        finally:
            await tracker.close()
            await state.close_child_streams()


@pytest.mark.asyncio
@pytest.mark.parametrize("generated", [False, True])
async def test_async_answer_recovers_only_authoritatively_rejected_stale_steer(generated):
    error = CodexAppServerResponseError({"code": -32600, "message": "no active turn to steer"})
    native = _NativeAnswerClient(status="inProgress", failure=error)
    result = (
        {"input": [], "question_submission": {"action": "accept"}}
        if generated
        else {"input": [{"type": "text", "text": "Blue"}]}
    )
    register = AsyncMock(
        return_value=[{"type": "input_text", "text": "registered framework envelope"}]
    )
    await submit_async_question_answer(
        native, _question_event()["params"], result, prepare_framework_input=register
    )
    assert [method for method, _ in native.calls] == [
        "thread/read",
        "turn/steer",
        "thread/read",
        "turn/start",
    ]
    assert register.await_count == (1 if generated else 0)
    native = _NativeAnswerClient(
        status="inProgress", failure=ConnectionError("lost acknowledgement")
    )
    with pytest.raises(ConnectionError, match="lost acknowledgement"):
        await submit_async_question_answer(
            native, _question_event()["params"], result, prepare_framework_input=register
        )
    assert [method for method, _ in native.calls] == ["thread/read", "turn/steer"]


@pytest.mark.asyncio
async def test_async_generated_submission_reuses_answer_identity_and_requires_acknowledgement():
    native = _NativeAnswerClient(
        status="inProgress", failure=ConnectionError("lost acknowledgement")
    )
    result = {"input": [], "question_submission": {"action": "accept"}}
    register = AsyncMock(
        return_value=[{"type": "input_text", "text": "registered framework envelope"}]
    )
    with pytest.raises(ConnectionError, match="lost acknowledgement"):
        await submit_async_question_answer(
            native, _question_event()["params"], result, prepare_framework_input=register
        )
    assert [method for method, _ in native.calls] == ["thread/read", "turn/steer"]
    await submit_async_question_answer(
        native, _question_event()["params"], result, prepare_framework_input=register
    )
    calls = len(native.calls)
    # A later full-answer replay cannot send the same submitted request twice.
    await submit_async_question_answer(
        native, _question_event()["params"], {"input": [{"type": "text", "text": "Blue"}]}
    )
    assert len(native.calls) == calls + 1
    assert native.calls[-1][0] == "thread/read"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["accept", "decline"])
@pytest.mark.parametrize(
    "status, expected_method", [("completed", "turn/start"), ("inProgress", "turn/steer")]
)
async def test_async_empty_controls_register_trusted_framework_content(
    action, status, expected_method
):
    native = _NativeAnswerClient(status=status)
    register = AsyncMock(
        return_value=[{"type": "input_text", "text": "registered framework envelope"}]
    )
    event = _question_event()
    response = parse_codex_elicitation_request({"id": "call-question", **event}).build_response(
        ElicitationResult(action=action, content={})
    )
    await submit_async_question_answer(
        native, event["params"], response, prepare_framework_input=register
    )
    input_id, text, label = register.call_args.args
    assert uuid.UUID(hex=input_id).hex == input_id
    assert json.loads(text) == {
        "event": "question_submission",
        "item_id": "call-question",
        "action": action,
        "answers": {},
    }
    assert label == (
        "Question request declined"
        if action == "decline"
        else "Questions submitted without answers"
    )
    method, request = native.calls[-1]
    assert method == expected_method
    assert request["clientUserMessageId"] == f"omnigent-input:{input_id}"
    assert request["input"] == [{"type": "text", "text": "registered framework envelope"}]
    await submit_async_question_answer(
        native, event["params"], response, prepare_framework_input=register
    )
    register.assert_awaited_once()
    assert native.calls[-1][0] == "thread/read"


@pytest.mark.asyncio
async def test_async_empty_control_cannot_send_without_durable_registration():
    result = {"input": [], "question_submission": {"action": "accept"}}
    native = _NativeAnswerClient()
    with pytest.raises(ValueError, match="framework input registration"):
        await submit_async_question_answer(native, _question_event()["params"], result)
    assert [method for method, _ in native.calls] == ["thread/read"]
    register = AsyncMock(side_effect=ConnectionError("registration failed"))
    with pytest.raises(ConnectionError, match="registration failed"):
        await submit_async_question_answer(
            native, _question_event()["params"], result, prepare_framework_input=register
        )
    assert [method for method, _ in native.calls] == ["thread/read", "thread/read"]
