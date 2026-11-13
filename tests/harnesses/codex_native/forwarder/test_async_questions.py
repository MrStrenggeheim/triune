# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Real async message fields cross the forwarder and question adapter boundary."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from omnigent.harnesses.codex_native import forwarder as fwd
from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.harnesses.codex_native.async_questions import submit_async_question_answer
from omnigent.server.routes._codex_elicitation import parse_codex_elicitation_request
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
async def test_async_answer_recovers_only_authoritatively_rejected_stale_steer():
    error = CodexAppServerResponseError({"code": -32600, "message": "no active turn to steer"})
    native = _NativeAnswerClient(status="inProgress", failure=error)
    await submit_async_question_answer(
        native, _question_event()["params"], {"input": [{"type": "text", "text": "Blue"}]}
    )
    assert [method for method, _ in native.calls] == [
        "thread/read",
        "turn/steer",
        "thread/read",
        "turn/start",
    ]
    native = _NativeAnswerClient(
        status="inProgress", failure=ConnectionError("lost acknowledgement")
    )
    with pytest.raises(ConnectionError, match="lost acknowledgement"):
        await submit_async_question_answer(
            native, _question_event()["params"], {"input": [{"type": "text", "text": "Blue"}]}
        )
    assert [method for method, _ in native.calls] == ["thread/read", "turn/steer"]
