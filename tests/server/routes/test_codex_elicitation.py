# Modified for Triune.

"""Tests for the Codex elicitation protocol adapters.

These are pure-function tests — no HTTP or runtime needed.
"""

from __future__ import annotations

import pytest

from omnigent.errors import OmnigentError
from omnigent.server.routes._codex_elicitation import (
    _codex_command_preview,
    _codex_mcp_elicitation_response,
    _codex_mcp_persist_modes,
    _execpolicy_amendment,
    _json_preview,
    _string_list_answer,
    parse_codex_elicitation_request,
)
from omnigent.server.schemas import ElicitationResult

# ── parse_codex_elicitation_request ──────────────────────────────────


@pytest.mark.parametrize("blocking", [False, True])
@pytest.mark.parametrize("request_id", [7, "request-7"])
def test_question_blocking_flags_and_native_answer_correlation(blocking, request_id) -> None:
    request = parse_codex_elicitation_request(
        {
            "id": request_id,
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": "thread-child",
                "turnId": "turn-1",
                "itemId": "item-1",
                "isBlocking": blocking,
                "autoResolutionMs": 0,
                "questions": [
                    {
                        "id": "stable-question",
                        "question": "Pick",
                        "isOther": True,
                        "isSecret": True,
                        "options": None,
                    }
                ],
            },
        }
    )
    params = request.params.model_dump()
    assert params["isBlocking"] is blocking
    assert params["ask_user_question"]["isBlocking"] is blocking
    assert params["autoResolutionMs"] == 0
    assert params["codex_request_id"] == request_id
    assert params["thread_id"] == "thread-child"
    assert params["turn_id"] == "turn-1"
    assert params["item_id"] == "item-1"
    assert request.build_response(
        ElicitationResult(action="accept", content={"stable-question": "Answer"})
    ) == {
        "answers": {"stable-question": {"answers": ["Answer"]}},
    }


@pytest.mark.parametrize(
    "content, expected",
    [
        ({}, {}),
        ({"first": "A"}, {"first": {"answers": ["A"]}}),
        ({"editor": ""}, {"editor": {"answers": [""]}}),
        ({"editor": "  \n"}, {"editor": {"answers": ["  \n"]}}),
        ({"first": "", "Pick": "B"}, {"second": {"answers": ["B"]}}),
        ({"unknown": "A"}, {}),
    ],
)
def test_question_submissions_preserve_omissions_editor_values_and_stable_ids(content, expected):
    request = parse_codex_elicitation_request(
        {
            "id": "request",
            "method": "item/tool/requestUserInput",
            "params": {
                "questions": [
                    {"id": "first", "question": "Pick", "options": [{"label": "A"}]},
                    {"id": "second", "question": "Pick", "options": [{"label": "B"}]},
                    {"id": "editor", "question": "Edit", "textInput": {"default": "original"}},
                ]
            },
        }
    )
    assert request.params.model_dump()["ask_user_question"]["questions"][2]["textInput"] == {
        "default": "original"
    }
    assert request.build_response(ElicitationResult(action="accept", content=content)) == {
        "answers": expected
    }
    assert request.build_response(ElicitationResult(action="decline", content=content)) == {
        "answers": {}
    }


@pytest.mark.parametrize(
    "questions", [[{"title": "Free text"}], [{"title": "Pick", "options": ["Blue", "Green"]}]]
)
def test_async_agent_message_questions_use_durable_item_identity(questions) -> None:
    request = parse_codex_elicitation_request(
        {
            "id": "native-question",
            "method": "item/completed",
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "item": {
                    "type": "agentMessage",
                    "id": "native-question",
                    "delivery": "async",
                    "questions": questions,
                },
            },
        }
    )
    params = request.params.model_dump()
    assert params["codex_method"] == "item/completed"
    assert params["item_id"] == "native-question"
    assert params["isBlocking"] is False
    assert request.build_response(
        ElicitationResult(action="accept", content={"question_0": "Blue"})
    ) == {"input": [{"type": "text", "text": f"{questions[0]['title']}\nBlue"}]}
    assert request.build_response(ElicitationResult(action="cancel")) == {"input": []}
    for action in ["accept", "decline"]:
        assert request.build_response(ElicitationResult(action=action, content={})) == {
            "input": [],
            "question_submission": {"action": action},
        }


@pytest.mark.parametrize(
    "item",
    [
        {"type": "agentMessage", "text": "request_user_input_async({questions: []})"},
        {"type": "agentMessage", "delivery": "async", "questions": []},
        {
            "type": "agentMessage",
            "delivery": "async",
            "questions": [{"title": "Pick", "options": [7]}],
        },
        {
            "type": "agentMessage",
            "delivery": "async",
            "questions": [{"title": "Pick"}],
            "id": "different",
        },
    ],
)
def test_async_questions_require_native_structured_fields_and_matching_identity(item) -> None:
    with pytest.raises(OmnigentError, match="structured message"):
        parse_codex_elicitation_request(
            {
                "id": "native-question",
                "method": "item/completed",
                "params": {"threadId": "thread", "item": item},
            }
        )


class TestParseCodexElicitationRequest:
    """Tests for the top-level request parser."""

    def test_missing_method_raises(self) -> None:
        with pytest.raises(OmnigentError, match="non-empty method"):
            parse_codex_elicitation_request({"id": 1, "params": {}})

    def test_empty_method_raises(self) -> None:
        with pytest.raises(OmnigentError, match="non-empty method"):
            parse_codex_elicitation_request({"id": 1, "method": "", "params": {}})

    def test_non_dict_params_raises(self) -> None:
        with pytest.raises(OmnigentError, match="params must be an object"):
            parse_codex_elicitation_request(
                {"id": 1, "method": "mcpServer/elicitation/request", "params": "bad"}
            )

    def test_missing_id_raises(self) -> None:
        with pytest.raises(OmnigentError, match="string or integer id"):
            parse_codex_elicitation_request(
                {"method": "mcpServer/elicitation/request", "params": {}}
            )

    def test_unsupported_method_raises(self) -> None:
        with pytest.raises(OmnigentError, match="Unsupported"):
            parse_codex_elicitation_request({"id": 1, "method": "unknown/method", "params": {}})

    def test_valid_mcp_form_request(self) -> None:
        req = parse_codex_elicitation_request(
            {
                "id": 1,
                "method": "mcpServer/elicitation/request",
                "params": {
                    "mode": "form",
                    "message": "Need input",
                    "requestedSchema": {"type": "object"},
                },
            }
        )
        assert req.method == "mcpServer/elicitation/request"
        assert req.params.mode == "form"

    def test_valid_command_approval(self) -> None:
        req = parse_codex_elicitation_request(
            {
                "id": 2,
                "method": "item/commandExecution/requestApproval",
                "params": {"command": "npm test"},
            }
        )
        assert req.method == "item/commandExecution/requestApproval"


# ── Codex MCP approval persistence ───────────────────────────────────


class TestCodexMcpApprovalPersistence:
    """Tests for Codex's session and durable MCP approval choices."""

    @pytest.mark.parametrize("mode", ["session", "always"])
    def test_returns_advertised_persistence_mode(self, mode: str) -> None:
        result = ElicitationResult.model_validate({"action": "accept", "_meta": {"persist": mode}})

        response = _codex_mcp_elicitation_response(
            result,
            "mcpServer/elicitation/request",
            {
                "_meta": {
                    "codex_approval_kind": "mcp_tool_call",
                    "persist": ["session", "always"],
                }
            },
        )

        assert response == {
            "action": "accept",
            "content": None,
            "_meta": {"persist": mode},
        }

    def test_rejects_unadvertised_persistence_mode(self) -> None:
        result = ElicitationResult.model_validate(
            {"action": "accept", "_meta": {"persist": "always"}}
        )

        with pytest.raises(OmnigentError, match="was not advertised"):
            _codex_mcp_elicitation_response(
                result,
                "mcpServer/elicitation/request",
                {
                    "_meta": {
                        "codex_approval_kind": "mcp_tool_call",
                        "persist": ["session"],
                    }
                },
            )

    def test_ignores_malformed_advertised_modes(self) -> None:
        params = {
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "persist": ["session", {"unexpected": "object"}, None],
            }
        }

        assert _codex_mcp_persist_modes(params) == {"session"}


# ── _string_list_answer ──────────────────────────────────────────────


class TestStringListAnswer:
    """Tests for answer normalization."""

    def test_string_input(self) -> None:
        assert _string_list_answer("React") == ["React"]

    def test_empty_string(self) -> None:
        assert _string_list_answer("") == []

    def test_list_input(self) -> None:
        assert _string_list_answer(["a", "b"]) == ["a", "b"]

    def test_list_with_non_strings(self) -> None:
        assert _string_list_answer(["a", 123, "b"]) == ["a", "b"]

    def test_none_input(self) -> None:
        assert _string_list_answer(None) == []

    def test_numeric_input(self) -> None:
        assert _string_list_answer(42) == ["42"]


# ── _codex_command_preview ───────────────────────────────────────────


class TestCodexCommandPreview:
    """Tests for command preview extraction."""

    def test_string_command(self) -> None:
        assert _codex_command_preview({"command": "npm test"}) == "npm test"

    def test_list_command(self) -> None:
        assert _codex_command_preview({"command": ["npm", "test"]}) == "npm test"

    def test_empty_command(self) -> None:
        assert _codex_command_preview({"command": ""}) is None

    def test_missing_command(self) -> None:
        assert _codex_command_preview({}) is None


# ── _json_preview ────────────────────────────────────────────────────


class TestJsonPreview:
    """Tests for the bounded preview function."""

    def test_simple_object(self) -> None:
        result = _json_preview({"key": "value"})
        assert '"key"' in result

    def test_truncated(self) -> None:
        big = {"k": "x" * 2000}
        result = _json_preview(big)
        assert len(result) <= 1024


# ── _execpolicy_amendment ────────────────────────────────────────────


class TestExecpolicyAmendment:
    """Tests for execpolicy amendment validation."""

    def test_none_returns_none(self) -> None:
        assert _execpolicy_amendment(None) is None

    def test_valid_list(self) -> None:
        assert _execpolicy_amendment(["pytest", "-v"]) == ["pytest", "-v"]

    def test_empty_list_raises(self) -> None:
        with pytest.raises(OmnigentError, match="non-empty list"):
            _execpolicy_amendment([])

    def test_non_list_raises(self) -> None:
        with pytest.raises(OmnigentError, match="non-empty list"):
            _execpolicy_amendment("pytest")

    def test_list_with_non_strings_raises(self) -> None:
        with pytest.raises(OmnigentError, match="non-empty list"):
            _execpolicy_amendment(["pytest", 42])
