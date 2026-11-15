"""Focused tests for the always-on UI capability discovery tool."""

from __future__ import annotations

import json
from typing import Any

from omnigent.runtime import ui_contract
from omnigent.spec.types import AgentSpec, ToolGroupsConfig
from omnigent.tools import ToolManager
from omnigent.tools.base import ToolContext


def _invoke(manager: ToolManager, arguments: str = "{}") -> dict[str, Any] | str:
    result = manager.call_tool(
        "sys_ui_capabilities",
        arguments,
        ToolContext(
            task_id="task_test",
            agent_id="agent_test",
            conversation_id="conversation_test",
        ),
    )
    if result.startswith("Error:"):
        return result
    return json.loads(result)


def test_ui_capabilities_invokes_real_canonical_projection() -> None:
    manager = ToolManager(AgentSpec(spec_version=1))

    result = _invoke(manager)

    assert isinstance(result, dict)
    assert result["version"] == ui_contract.UI_CONTRACT_VERSION
    assert result["groups"]["formatting"]["availability"] == "available"
    assert result["groups"]["background"]["availability"] == "available"
    assert result["groups"]["questions"]["availability"] == "unavailable"


def test_ui_capabilities_is_always_registered_and_locally_invokable(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}

    def project(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {"version": 3, "groups": {"messages": {"id": "messages"}}}

    monkeypatch.setattr(ui_contract, "ui_capabilities", project)
    manager = ToolManager(AgentSpec(spec_version=1))

    assert manager.get_tool("sys_ui_capabilities") is not None
    assert _invoke(manager) == {
        "groups": {"messages": {"id": "messages"}},
        "version": 3,
    }
    assert captured["harness"] == manager._spec.executor.harness_kind
    assert captured["session_id"] == "conversation_test"
    assert "sys_ui_capabilities" in captured["tool_names"]
    assert "permissions" not in captured
    assert "feature_flags" not in captured
    assert captured["server_url"] is None


def test_ui_capabilities_uses_live_registered_names_and_respects_gates(
    monkeypatch: Any,
) -> None:
    observed_names: list[set[str]] = []

    def project(**kwargs: Any) -> dict[str, Any]:
        observed_names.append(set(kwargs["tool_names"]))
        return {"version": 3, "groups": {}}

    monkeypatch.setattr(ui_contract, "ui_capabilities", project)
    spec = AgentSpec(
        spec_version=1,
        tool_groups=ToolGroupsConfig(browser=False, comments=False),
    )
    manager = ToolManager(spec)
    _invoke(manager)
    manager._tools["post_start_tool"] = manager.get_tool("sys_ui_capabilities")  # type: ignore[assignment]
    _invoke(manager)

    assert "browser_navigate" not in observed_names[0]
    assert "list_comments" not in observed_names[0]
    assert "post_start_tool" not in observed_names[0]
    assert "post_start_tool" in observed_names[1]


def test_ui_capabilities_lazily_includes_runner_supplied_advertised_names(
    monkeypatch: Any,
) -> None:
    observed_names: list[set[str]] = []
    runtime_names = ["mcp__native__first"]

    def project(**kwargs: Any) -> dict[str, Any]:
        observed_names.append(set(kwargs["tool_names"]))
        return {"version": 3, "groups": {}}

    monkeypatch.setattr(ui_contract, "ui_capabilities", project)
    manager = ToolManager(AgentSpec(spec_version=1))
    manager.set_ui_capability_runtime_tool_names(lambda: runtime_names)
    _invoke(manager)
    runtime_names.append("mcp__native__later")
    _invoke(manager)

    assert "mcp__native__first" in observed_names[0]
    assert "mcp__native__later" not in observed_names[0]
    assert "mcp__native__later" in observed_names[1]


def test_ui_capabilities_selects_group_and_rejects_unknown_group(
    monkeypatch: Any,
) -> None:
    monkeypatch.setattr(
        ui_contract,
        "ui_capabilities",
        lambda **kwargs: {
            "version": 3,
            "groups": {"messages": {"id": "messages", "available": True}},
        },
    )
    manager = ToolManager(AgentSpec(spec_version=1))

    assert _invoke(manager, '{"group":"messages"}') == {
        "group": {"available": True, "id": "messages"},
        "version": 3,
    }
    assert _invoke(manager, '{"group":"missing"}') == (
        "Error: unknown capability group 'missing'; available groups: ['messages']"
    )


def test_ui_capabilities_rejects_malformed_arguments() -> None:
    manager = ToolManager(AgentSpec(spec_version=1))

    assert _invoke(manager, "{") == "Error: malformed JSON arguments"
    assert _invoke(manager, "[]") == "Error: arguments must be a JSON object"
    assert _invoke(manager, '{"group":3}') == "Error: 'group' must be a string"
    assert _invoke(manager, '{"permissions":{}}') == ("Error: unexpected argument(s): permissions")
