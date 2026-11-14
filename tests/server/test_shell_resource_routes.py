# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Shell reads and exact Stop actions cross the same session authorization gate."""

from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.native.shell_resources import shell_resource_fields
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
from omnigent.server.shell_resource_routes import register_shell_resource_routes
from omnigent.server.shell_resources import SessionShellResources
from omnigent.terminals.history import ActivityEntry, activity_page


@pytest.mark.parametrize(
    "action",
    [
        "list",
        "read",
        "stop",
        "forbidden",
        "offline",
        "mismatch",
        "unsupported",
        "offline_typed",
        "offline_list",
        "offline_capture",
        "resource_missing",
        "denied_upstream",
        "replica",
        "protocol",
    ],
)
async def test_shell_routes_authorize_exact_target_and_retain_output(action: str) -> None:
    service = SessionShellResources()
    row = {
        "id": "one",
        "type": "shell",
        "status": "running",
        "command": "same",
        "output": "actual output\n",
        **shell_resource_fields(
            source="codex_native",
            resource_id="one",
            session_id="chat",
            output="actual output\n",
            can_stop=True,
        ),
    }
    await service.capture("chat", [row])
    validate = AsyncMock(return_value="conversation")
    if action == "forbidden":
        validate.side_effect = HTTPException(403, "Forbidden")
    get = AsyncMock(
        return_value={"data": [row]}
        if action == "list"
        else {**row, "output": None, "output_preview": None}
    )
    if action == "offline":
        get.side_effect = HTTPException(503, "Runner offline")
    if action in {"offline_typed", "offline_list"}:
        get.side_effect = OmnigentError(
            "runner_token_private chat_private", code=ErrorCode.RUNNER_UNAVAILABLE
        )
    if action == "resource_missing":
        get.side_effect = OmnigentError("private resource", code=ErrorCode.NOT_FOUND)
    if action == "denied_upstream":
        get.side_effect = HTTPException(403, {"error": {"code": "forbidden"}})
    if action == "replica":
        get.side_effect = OmnigentError("replica details", code=ErrorCode.WRONG_REPLICA)
    if action == "protocol":
        get.side_effect = HTTPException(502, "invalid protocol body")
    if action == "mismatch":
        get.return_value = {**row, "resource_id": "other"}
    post = AsyncMock(return_value=(200, {**row, "status": "stopped", "can_stop": False}))
    router = APIRouter(prefix="/v1")
    register_shell_resource_routes(
        router,
        service=service,
        validate_session=validate,
        proxy_get=get,
        proxy_post=post,
        activity_for_conversation=AsyncMock(
            side_effect=OmnigentError("offline capture", code=ErrorCode.RUNNER_UNAVAILABLE)
            if action == "offline_capture"
            else None,
            return_value=activity_page(
                [
                    ActivityEntry(
                        id="primary-launch",
                        session_id="chat",
                        terminal_id="terminal_codex_main",
                        name="codex:main",
                        state="running",
                        owner_id="chat",
                    )
                ],
                available=True,
            ),
        ),
    )
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def typed_error(_request, error: OmnigentError):
        return JSONResponse({"error": {"code": error.code}}, status_code=error.http_status)

    app.include_router(router)
    path = "/v1/sessions/chat/resources/shells"
    if action not in {"list", "offline_list", "offline_capture"}:
        path += "/codex_native/one"
    if action in {"stop", "unsupported"}:
        if action == "unsupported":
            path = path.replace("codex_native", "claude_native")
        path += "/stop"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        response = await (
            client.post(path) if action in {"stop", "unsupported"} else client.get(path)
        )
        if action == "stop":
            stale = await client.get(path.removesuffix("/stop"))
            assert stale.json()["status"] == "stopped"
            assert not stale.json()["can_stop"]
    expected = {
        "forbidden": 403,
        "mismatch": 502,
        "unsupported": 409,
        "denied_upstream": 403,
        "replica": OmnigentError("", code=ErrorCode.WRONG_REPLICA).http_status,
        "protocol": 502,
    }.get(action, 200)
    assert response.status_code == expected
    assert [(call.args[0], call.args[2]) for call in validate.await_args_list] == [
        ("chat", LEVEL_EDIT if action in {"stop", "unsupported"} else LEVEL_READ),
        *([("chat", LEVEL_READ)] if action == "stop" else []),
    ]
    if action == "forbidden":
        get.assert_not_awaited()
        post.assert_not_awaited()
    elif action == "stop":
        assert post.await_args.args == ("chat", path, {}, "conversation")
        assert (await service.get("chat", "codex_native", "one"))["status"] == "stopped"
    elif action in {"read", "offline", "offline_typed", "resource_missing"}:
        assert response.json()["output_preview"] == "actual output"
        if action != "read":
            assert response.json()["status"] == "disconnected"
            assert not response.json()["can_stop"]
            assert "private" not in response.text
    elif action in {"offline_list", "offline_capture"}:
        assert response.json()["availability"] == "offline"
        assert response.json()["data"][0]["status"] == "disconnected"
        assert not response.json()["data"][0]["can_stop"]
        assert "runner_token" not in response.text
    elif action == "list":
        assert response.json()["data"][0]["output_preview"] == "actual output"
        assert response.json()["data"][0]["can_stop"]
        assert len(response.json()["data"]) == 1


async def test_server_rejects_primary_cli_stop_even_if_an_old_runner_advertises_it() -> None:
    router = APIRouter(prefix="/v1")
    post = AsyncMock()
    register_shell_resource_routes(
        router,
        service=SessionShellResources(),
        validate_session=AsyncMock(return_value="conversation"),
        proxy_get=AsyncMock(
            return_value={
                "source": "registered_terminal",
                "resource_id": "primary-launch",
                "terminal_id": "terminal_codex_main",
                "can_stop": True,
            }
        ),
        proxy_post=post,
        activity_for_conversation=AsyncMock(),
    )
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/sessions/chat/resources/shells/registered_terminal/primary-launch/stop"
        )
    assert response.status_code == 409
    post.assert_not_awaited()
