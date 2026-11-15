"""Read-only discovery of the current harness UI capability contract.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from typing import Any

from omnigent.tools.base import Tool, ToolContext
from omnigent.tools.builtins._arguments import parse_json_object_arguments


def _select_group(registry: dict[str, Any], group: str) -> dict[str, Any]:
    """Return one canonical group while retaining the registry version."""
    groups = registry.get("groups")
    selected: Any = None
    if isinstance(groups, dict):
        selected = groups.get(group)
    elif isinstance(groups, list):
        selected = next(
            (entry for entry in groups if isinstance(entry, dict) and entry.get("id") == group),
            None,
        )
    if selected is None:
        available = (
            sorted(str(name) for name in groups)
            if isinstance(groups, dict)
            else sorted(
                str(entry["id"])
                for entry in groups or []
                if isinstance(entry, dict) and "id" in entry
            )
        )
        raise ValueError(f"unknown capability group {group!r}; available groups: {available}")
    return {"version": registry.get("version"), "group": selected}


class SysUiCapabilitiesTool(Tool):
    """Project the canonical UI contract for this tool manager."""

    def __init__(
        self,
        *,
        harness: str,
        tool_names: Callable[[], Iterable[str]],
        server_url: str | None = None,
    ) -> None:
        self._harness = harness
        self._tool_names = tool_names
        self._server_url = server_url

    @classmethod
    def name(cls) -> str:
        return "sys_ui_capabilities"

    @classmethod
    def description(cls) -> str:
        from omnigent.runtime.ui_contract import ui_contract_tool_description

        return ui_contract_tool_description()

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "group": {
                            "type": "string",
                            "description": "Optional canonical capability group identifier.",
                        }
                    },
                    "additionalProperties": False,
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return f"Error: {error}"
        assert args is not None

        unexpected = sorted(set(args) - {"group"})
        if unexpected:
            return f"Error: unexpected argument(s): {', '.join(unexpected)}"
        group = args.get("group")
        if group is not None and not isinstance(group, str):
            return "Error: 'group' must be a string"

        # Import at invocation time so the tool and canonical registry do not
        # create an initialization cycle through runtime -> tools -> runtime.
        from omnigent.runtime.ui_contract import ui_capabilities

        try:
            result = ui_capabilities(
                harness=self._harness,
                tool_names=self._tool_names(),
                session_id=ctx.conversation_id,
                server_url=self._server_url,
            )
            if group is not None:
                result = _select_group(result, group)
        except (TypeError, ValueError, KeyError) as exc:
            return f"Error: {exc}"
        return json.dumps(result, sort_keys=True)
