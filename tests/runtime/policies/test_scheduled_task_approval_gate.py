"""Scheduled-task mutations require approval even without configured guardrails.

``build_policy_engine`` injects the mandatory approval guards into every engine
and ``any_policies_apply`` never fast-paths their tools; reads and deletes stay
allowed.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from omnigent.entities import Conversation
from omnigent.policies.types import EvaluationContext
from omnigent.runtime.policies.builder import any_policies_apply, build_policy_engine
from omnigent.spec.parser import parse
from omnigent.spec.types import AgentSpec, Phase, PolicyAction
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)

_TASK_ID = "0123456789abcdef0123456789abcdef"
_CREATE_ARGS = {
    "name": "nightly triage",
    "prompt": "Triage new issues.",
    "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    "agent_id": "ag_1",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("child", [False, True])
@pytest.mark.parametrize("tool", ["sys_scheduled_task_create", "sys_scheduled_task_update"])
async def test_only_the_current_runner_can_suppress_the_scheduling_guard(
    tmp_path: Path, conversation_store: SqlAlchemyConversationStore, child: bool, tool: str
) -> None:
    spec, parent = _no_guardrails_spec(tmp_path, conversation_store)
    conv = conversation_store.create_conversation(
        kind="sub_agent" if child else "default",
        parent_conversation_id=parent.id if child else None,
        runner_id="current",
        labels={"omnigent.codex_native.approval_mode": "full-access"},
    )
    ctx = EvaluationContext(
        phase=Phase.TOOL_CALL,
        tool_name=tool,
        content={
            "name": tool,
            "arguments": {
                **_CREATE_ARGS,
                "permission_mode": "bypassPermissions",
                "full_access": True,
            },
        },
    )
    for proof, expected in [
        (None, PolicyAction.ASK),
        ("old", PolicyAction.ASK),
        ("current", PolicyAction.ALLOW),
    ]:
        engine = build_policy_engine(
            spec=spec,
            conversation_id=conv.id,
            conversation_store=conversation_store,
            scheduling_runner_id=proof,
        )
        assert (await engine.evaluate(ctx)).action == expected
        assert (
            await engine.evaluate(
                EvaluationContext(
                    phase=Phase.TOOL_CALL,
                    tool_name="sys_add_policy",
                    content={"name": "sys_add_policy", "arguments": {}},
                )
            )
        ).action == PolicyAction.ASK


@pytest.mark.asyncio
async def test_codex_requires_the_applied_profile_on_the_exact_live_turn(tmp_path: Path) -> None:
    from omnigent.runner.scheduling_permissions import codex_turn_has_full_access

    rollout = tmp_path / "sessions" / "rollout.jsonl"
    rollout.parent.mkdir()
    thread = {
        "id": "thread",
        "status": {"type": "active"},
        "path": str(rollout),
        "approvalPolicy": "never",
        "sandboxPolicy": {"type": "dangerFullAccess"},
    }
    turn = {"id": "new", "status": "inProgress"}
    client = AsyncMock()
    loaded = {"data": ["thread"], "nextCursor": None}
    results = {
        "thread/read": {"thread": thread},
        "thread/turns/list": {"data": [turn]},
        "thread/loaded/list": loaded,
    }
    client.request.side_effect = lambda method, _: {"result": results[method]}
    policy = {
        "approval_policy": "never",
        "sandbox_policy": {"type": "danger-full-access"},
        "permission_profile": {"type": "disabled"},
    }

    def record(id_: str, fields: dict) -> str:
        return json.dumps({"type": "turn_context", "payload": {"turn_id": id_, **fields}}) + "\n"

    rollout.write_text(record("old", policy))
    assert not await codex_turn_has_full_access(client, "thread", str(tmp_path))

    for fields in [
        {**policy, "approval_policy": "on-request"},
        {**policy, "permission_profile": {"type": "custom"}},
    ]:
        rollout.write_text(record("new", fields))
        assert not await codex_turn_has_full_access(client, "thread", str(tmp_path))
    rollout.write_text(record("new", policy) + "x" * (3 * 1024 * 1024) + "\n")
    assert await codex_turn_has_full_access(client, "thread", str(tmp_path))
    loaded["data"].append("restricted-child")
    assert not await codex_turn_has_full_access(client, "thread", str(tmp_path))
    loaded["data"].remove("restricted-child")
    assert not await codex_turn_has_full_access(client, "thread", str(tmp_path), "old")
    assert not await codex_turn_has_full_access(client, "different-thread", str(tmp_path))
    assert not await codex_turn_has_full_access(client, "thread", str(tmp_path / "unrelated"))
    turn["status"] = "completed"
    assert not await codex_turn_has_full_access(client, "thread", str(tmp_path))


def _no_guardrails_spec(
    tmp_path: Path,
    conversation_store: SqlAlchemyConversationStore,
) -> tuple[AgentSpec, Conversation]:
    (tmp_path / "config.yaml").write_text("spec_version: 1\nname: scheduler-probe\n")
    return parse(tmp_path), conversation_store.create_conversation()


@pytest.mark.asyncio
@pytest.mark.parametrize("child", [False, True])
async def test_scheduling_authority_is_read_from_the_bound_runner_and_exact_session(
    conversation_store: SqlAlchemyConversationStore, monkeypatch: pytest.MonkeyPatch, child: bool
) -> None:
    from omnigent.server.routes._sessions import helpers
    from omnigent.server.scheduling_permissions import scheduling_full_access

    parent = conversation_store.create_conversation(runner_id="runner")
    conv = (
        conversation_store.create_conversation(
            kind="sub_agent",
            parent_conversation_id=parent.id,
            runner_id="runner",
            labels={"omnigent.wrapper": "codex-native-ui-subagent"},
        )
        if child
        else parent
    )
    route = f"/v1/sessions/{parent.id}"
    if child:
        route += f"/native-children/{conv.id}"
    result = {"session_id": conv.id, "runner_id": "runner", "full_access": True}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == route + "/current-turn/scheduling-permissions"
        return httpx.Response(200, json=result)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://runner"
    ) as client:
        lookup = AsyncMock(return_value=client)
        monkeypatch.setattr(helpers, "_get_runner_client", lookup)

        async def confirmed() -> bool:
            return await scheduling_full_access(
                conv, Phase.TOOL_CALL, "sys_scheduled_task_create", None
            )

        assert await confirmed()
        lookup.assert_awaited_with(parent.id, None)
        for field, incorrect in [
            ("session_id", "another"),
            ("runner_id", "previous"),
            ("full_access", "true"),
        ]:
            original = result[field]
            result[field] = incorrect
            assert not await confirmed()
            result[field] = original
        assert not await scheduling_full_access(
            conv, Phase.TOOL_RESULT, "sys_scheduled_task_create", None
        )
        assert not await scheduling_full_access(conv, Phase.TOOL_CALL, "sys_add_policy", None)
        lookup.return_value = None
        assert not await confirmed()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected"),
    [
        ("sys_add_policy", {"name": "shell_gate", "handler": "x.y"}, PolicyAction.ASK),
        ("sys_scheduled_task_create", _CREATE_ARGS, PolicyAction.ASK),
        (
            "sys_scheduled_task_update",
            {"scheduled_task_id": _TASK_ID, "state": "paused"},
            PolicyAction.ASK,
        ),
    ],
    ids=["add_policy_control", "create", "update"],
)
async def test_scheduled_task_mutation_asks_without_guardrails(
    tmp_path: Path,
    conversation_store: SqlAlchemyConversationStore,
    tool_name: str,
    arguments: dict[str, object],
    expected: PolicyAction,
) -> None:
    spec, conv = _no_guardrails_spec(tmp_path, conversation_store)
    engine = build_policy_engine(
        spec=spec,
        conversation_id=conv.id,
        conversation_store=conversation_store,
    )
    result = await engine.evaluate(
        EvaluationContext(
            phase=Phase.TOOL_CALL,
            content={"name": tool_name, "arguments": arguments},
            tool_name=tool_name,
        )
    )
    assert result.action == expected, result.reason


@pytest.mark.parametrize(
    "tool_name",
    ["sys_add_policy", "sys_scheduled_task_create", "sys_scheduled_task_update"],
)
def test_no_policy_fast_path_keeps_mutation_gates(
    tmp_path: Path,
    conversation_store: SqlAlchemyConversationStore,
    tool_name: str,
) -> None:
    spec, conv = _no_guardrails_spec(tmp_path, conversation_store)
    assert any_policies_apply(
        spec=spec,
        conversation_id=conv.id,
        default_policies=None,
        policy_store=None,
        phase=Phase.TOOL_CALL,
        tool_name=tool_name,
        conversation=conv,
    )


@pytest.mark.parametrize("tool_name", ["sys_scheduled_task_list", "sys_scheduled_task_delete"])
def test_no_policy_fast_path_skips_ungated_scheduled_task_tools(
    tmp_path: Path,
    conversation_store: SqlAlchemyConversationStore,
    tool_name: str,
) -> None:
    spec, conv = _no_guardrails_spec(tmp_path, conversation_store)
    assert not any_policies_apply(
        spec=spec,
        conversation_id=conv.id,
        default_policies=None,
        policy_store=None,
        phase=Phase.TOOL_CALL,
        tool_name=tool_name,
        conversation=conv,
    )
