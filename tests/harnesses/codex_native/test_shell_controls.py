# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Native shell control uses protocol handles scoped to the owning thread."""

from unittest.mock import AsyncMock

import pytest

from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.harnesses.codex_native.shell_controls import (
    CodexShellControls,
    NativeShellControlUnavailable,
)


@pytest.mark.parametrize(
    "case", ["live", "missing", "ambiguous", "no-handle", "unsupported", "ended"]
)
async def test_stop_revalidates_exact_native_item_without_interrupting_parent(case: str) -> None:
    stopped = []
    first = {"itemId": "one", "processId": "vendor-42", "osPid": 987, "command": "same"}
    second = {"itemId": "two", "processId": "vendor-43", "command": "same"}

    async def request(method, params):
        assert params["threadId"] == "owning-thread"
        if method == "thread/backgroundTerminals/list":
            rows = [first, second]
            if case == "missing":
                rows = [second]
            if case == "ambiguous":
                rows.append(first)
            if case == "no-handle":
                rows = [{**first, "processId": None}]
            return {"result": {"data": rows}}
        assert method == "thread/backgroundTerminals/terminate"
        handle = params["processId"]
        if handle == "triune-invalid-process-id":
            raise CodexAppServerResponseError(
                {
                    "code": -32601 if case == "unsupported" else -32600,
                    "message": "unknown method"
                    if case == "unsupported"
                    else "invalid background terminal process id: invalid digit found in string",
                }
            )
        stopped.append(handle)
        return {"result": {"terminated": case != "ended"}}

    client = AsyncMock(request=AsyncMock(side_effect=request))
    controls = CodexShellControls(client, "owning-thread")
    if case in {"missing", "ambiguous", "no-handle", "unsupported"}:
        with pytest.raises(NativeShellControlUnavailable):
            await controls.stop("one")
        assert stopped == []
    else:
        assert await controls.stop("one") == (case == "live")
        assert stopped == ["vendor-42"]
    assert all(call.args[0] != "turn/interrupt" for call in client.request.await_args_list)


async def test_inventory_and_history_keep_identity_output_and_pagination_separate() -> None:
    async def request(method, params):
        if method == "thread/backgroundTerminals/terminate":
            raise CodexAppServerResponseError(
                {
                    "code": -32600,
                    "message": (
                        "invalid background terminal process id: invalid digit found in string"
                    ),
                }
            )
        if method == "thread/backgroundTerminals/list":
            return {"result": {"data": [{"itemId": "one", "processId": "12", "command": "same"}]}}
        assert method == "thread/turns/list"
        assert params["itemsView"] == "full" and params["limit"] == 20
        if "cursor" not in params:
            return {"result": {"data": [], "nextCursor": "older"}}
        return {
            "result": {
                "data": [
                    {
                        "items": [
                            {
                                "id": "one",
                                "type": "commandExecution",
                                "command": "same",
                                "status": "completed",
                                "exitCode": 9,
                                "aggregatedOutput": "old\n\x1b[31mactual result\x1b[0m\n",
                            }
                        ]
                    }
                ]
            }
        }

    client = AsyncMock(request=AsyncMock(side_effect=request))
    controls = CodexShellControls(client, "thread")
    live = await controls.inventory("chat")
    assert live[0]["resource_id"] == "one" and live[0]["can_stop"]
    assert live[0]["output_preview"] is None
    recorded = await controls.read("one", "chat")
    assert recorded["output_preview"] == "actual result"
    assert recorded["exit_code"] == 9 and not recorded["can_stop"]
    assert recorded["resource_url"] == live[0]["resource_url"]


@pytest.mark.parametrize("payload", [{}, {"result": {}}, {"result": {"data": None}}])
async def test_malformed_inventory_cannot_authorize_stop(payload) -> None:
    client = AsyncMock(request=AsyncMock(return_value=payload))
    with pytest.raises(NativeShellControlUnavailable, match="inventory_invalid"):
        await CodexShellControls(client, "thread").stop("one")
    assert client.request.await_count == 1


async def test_ephemeral_history_uses_captured_events_without_resuming_a_thread() -> None:
    client = AsyncMock(
        request=AsyncMock(
            side_effect=CodexAppServerResponseError(
                {"code": -32600, "message": "ephemeral threads do not support thread/turns/list"}
            )
        )
    )
    assert await CodexShellControls(client, "ephemeral").read("item", "chat") is None
    assert client.request.await_args.args[0] == "thread/turns/list"
    assert client.request.await_count == 1
