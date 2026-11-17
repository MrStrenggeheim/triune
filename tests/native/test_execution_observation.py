# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Execution labels require exact native evidence and retain bounded reads."""

import json

import httpx

from omnigent.native.execution_observation import claude_execution, codex_turn_execution


def test_codex_selects_exact_turn_not_latest_configuration(tmp_path):
    path = tmp_path / "rollout.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(
                {
                    "type": "turn_context",
                    "payload": {
                        "turn_id": turn,
                        "model": model,
                        "collaboration_mode": {"settings": {"reasoning_effort": effort}},
                    },
                }
            )
            for turn, model, effort in [
                ("first", "first-model", "low"),
                ("second", "second-model", "high"),
            ]
        )
    )
    assert codex_turn_execution(path, "first") == {
        "model": "first-model",
        "effort": "low",
        "source": "codex_turn_context",
        "turn_id": "first",
    }
    assert codex_turn_execution(path, "unknown") is None
    assert claude_execution({"model": "reported-model"}) == {
        "model": "reported-model",
        "source": "claude_response",
    }
    assert claude_execution({"configured_model": "parent-model"}) is None


def test_codex_bounded_tail_does_not_guess_missing_history(tmp_path, monkeypatch):
    from omnigent.native import execution_observation as module

    monkeypatch.setattr(module, "_TAIL_BYTES", 250)
    path = tmp_path / "rollout.jsonl"
    old = json.dumps({"type": "turn_context", "payload": {"turn_id": "old", "model": "old-model"}})
    current = json.dumps(
        {"type": "turn_context", "payload": {"turn_id": "current", "model": "current-model"}}
    )
    path.write_text(old + "\n" + "x" * 1000 + "\n" + current + "\n{broken")
    assert codex_turn_execution(path, "old") is None
    assert codex_turn_execution(path, "current")["model"] == "current-model"
    assert codex_turn_execution(tmp_path, "current") is None


async def test_codex_forwarder_attaches_exact_execution_to_child_message(tmp_path):
    from omnigent.harnesses.codex_native import forwarder

    path = tmp_path / "child.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "turn_context",
                "payload": {
                    "turn_id": "child-turn",
                    "model": "child-actual",
                    "collaboration_mode": {"settings": {"reasoning_effort": "low"}},
                },
            }
        )
    )
    state = forwarder._CodexForwarderState(model="wrong-parent-setting", rollout_path=path)
    posts = []

    def handle(request):
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(
        base_url="http://isolated", transport=httpx.MockTransport(handle)
    ) as client:
        await forwarder._handle_completed_item(
            client,
            "child",
            {
                "threadId": "child-thread",
                "turnId": "child-turn",
                "item": {
                    "id": "answer",
                    "type": "agentMessage",
                    "text": "Done",
                    "phase": "final_answer",
                },
            },
            forwarder_state=state,
        )
    message = next(
        post["data"]["item_data"]
        for post in posts
        if post.get("type") == "external_conversation_item"
    )
    assert message["execution"] == {
        "model": "child-actual",
        "effort": "low",
        "source": "codex_turn_context",
        "turn_id": "child-turn",
    }


def test_claude_parser_retains_response_model_without_configured_effort():
    from omnigent.harnesses.claude_native.bridge import _transcript_items_from_entry

    _, [item] = _transcript_items_from_entry(
        {
            "type": "assistant",
            "uuid": "assistant",
            "message": {
                "model": "observed-child",
                "role": "assistant",
                "content": "Done",
                "stop_reason": "end_turn",
            },
        },
        line_number=1,
        record_offset=None,
        agent_name="claude-native",
        current_response_id="turn",
    )
    assert item.data["execution"] == {"model": "observed-child", "source": "claude_response"}
