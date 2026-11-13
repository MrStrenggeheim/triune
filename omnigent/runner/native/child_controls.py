"""Target mirrored children through their live parent's native connection."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

import httpx
from fastapi.responses import JSONResponse
from websockets.exceptions import WebSocketException

from omnigent.harnesses.claude_native.bridge import url_component
from omnigent.harnesses.codex_native import side_chat
from omnigent.harnesses.codex_native.app_server import (
    CodexAppServerResponseError,
    client_for_transport,
)
from omnigent.harnesses.codex_native.bridge import CodexNativeBridgeState
from omnigent.native.child_controls import native_child_provider, unavailable_child_capabilities
from omnigent.util.session_lifecycle import is_session_closed


class NativeChildControls:
    """Revalidate the server mapping and native parent before every action."""

    def __init__(
        self,
        server_client: httpx.AsyncClient,
        bridge_state: Callable[..., Awaitable[CodexNativeBridgeState | None]],
    ) -> None:
        self.server_client = server_client
        self.bridge_state = bridge_state

    async def _child(self, parent_id: str, child_id: str) -> dict[str, Any] | None:
        cursor = None
        for _ in range(4):
            params: dict[str, Any] = {"limit": 250}
            if cursor is not None:
                params["after"] = cursor
            response = await self.server_client.get(
                f"/v1/sessions/{url_component(parent_id)}/child_sessions", params=params
            )
            response.raise_for_status()
            page = response.json()
            for child in page.get("data", []):
                if child.get("id") == child_id and child.get("parent_session_id") == parent_id:
                    return child
            if not page.get("has_more") or not page.get("last_id"):
                break
            cursor = page["last_id"]
        return None

    async def handle(
        self, parent_id: str, child_id: str, body: dict[str, Any] | None = None
    ) -> JSONResponse:
        """Inspect availability, or execute a targeted action with bounded native I/O."""
        try:
            async with asyncio.timeout(5):
                return await self._handle(parent_id, child_id, body)
        except CodexAppServerResponseError as exc:
            detail = exc.message or "Native child control was rejected."
            missing = "thread not found" in detail.casefold()
            return JSONResponse(
                status_code=404 if missing else 409,
                content={"error": "native_child_rejected", "detail": detail},
            )
        except (httpx.HTTPError, ConnectionError, OSError, TimeoutError, WebSocketException):
            logging.getLogger(__name__).warning(
                "Native child control unavailable: parent=%s child=%s",
                parent_id,
                child_id,
                exc_info=True,
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": "native_child_unavailable",
                    "detail": "parent_runtime_unavailable",
                },
            )

    async def _handle(
        self, parent_id: str, child_id: str, body: dict[str, Any] | None
    ) -> JSONResponse:
        child = await self._child(parent_id, child_id)
        if child is None:
            return JSONResponse(
                status_code=404, content={"detail": "native_child_mapping_missing"}
            )
        labels = child.get("labels") or {}
        provider = native_child_provider(child.get("kind", ""), labels)
        capabilities = unavailable_child_capabilities(
            "native_child_provider_unknown", state="unknown"
        )
        if is_session_closed(labels, child.get("title")):
            capabilities = unavailable_child_capabilities("native_child_closed", state="closed")
        elif provider == "claude":
            from omnigent.harnesses.claude_native.bridge import child_control_capabilities

            capabilities = child_control_capabilities(child.get("tool"))
        elif provider == "codex":
            state = await self.bridge_state(parent_id, action="child control")
            thread_id = labels.get("omnigent.codex_native.subagent_thread_id")
            if state is None:
                capabilities = unavailable_child_capabilities("parent_runtime_unavailable")
            elif not isinstance(thread_id, str) or not thread_id:
                capabilities = unavailable_child_capabilities("native_child_mapping_missing")
            else:
                client = client_for_transport(
                    state.socket_path, client_name="omnigent-codex-native-runner"
                )
                try:
                    await client.connect()
                    capabilities = await side_chat.child_control_capabilities(
                        client, thread_id, state.thread_id
                    )
                    if body is not None:
                        return await self._act(client, thread_id, capabilities, body)
                finally:
                    await client.close()
        if body is None:
            return JSONResponse(content=capabilities)
        return JSONResponse(
            status_code=409,
            content={
                "error": "native_child_control_unavailable",
                "detail": capabilities["reason"],
                "native_child_capabilities": capabilities,
            },
        )

    async def _act(
        self, client: Any, thread_id: str, capabilities: dict[str, Any], body: dict[str, Any]
    ) -> JSONResponse:
        action = body.get("action")
        if action == "message":
            action = "steer" if capabilities["state"] == "active" else "reply"
        if action not in {"reply", "steer", "stop"}:
            return JSONResponse(status_code=400, content={"detail": "invalid_child_action"})
        if not capabilities[f"can_{action}"]:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "native_child_control_unavailable",
                    "detail": capabilities["reasons"][action],
                    "native_child_capabilities": capabilities,
                },
            )
        turn_id = capabilities.get("active_turn_id")
        if action in {"stop", "steer"} and (not isinstance(turn_id, str) or not turn_id):
            return JSONResponse(status_code=409, content={"detail": "active_turn_unknown"})
        expected = body.get("expected_turn_id")
        if expected is not None and expected != turn_id:
            return JSONResponse(status_code=409, content={"detail": "native_turn_changed"})
        if action == "stop":
            await client.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
        else:
            content = body.get("content")
            if (
                not isinstance(content, list)
                or not content
                or any(
                    not isinstance(block, dict)
                    or block.get("type") != "input_text"
                    or not isinstance(block.get("text"), str)
                    for block in content
                )
            ):
                return JSONResponse(
                    status_code=400, content={"detail": "native_child_requires_text"}
                )
            text = "\n".join(block["text"] for block in content).rstrip()
            if not text:
                return JSONResponse(
                    status_code=400, content={"detail": "native_child_requires_text"}
                )
            stable_id = body.get("stable_id")
            if action == "steer":
                await side_chat.steer_child_turn(
                    client, thread_id, cast(str, turn_id), text, stable_id=stable_id
                )
            else:
                turn_id = await side_chat.submit_side_turn(
                    client, thread_id, text, stable_id=stable_id
                )
        return JSONResponse(
            status_code=202,
            content={
                "accepted": True,
                "consumed": False,
                "action": action,
                "native_turn_id": turn_id,
            },
        )
