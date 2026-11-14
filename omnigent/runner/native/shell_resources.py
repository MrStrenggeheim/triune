# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Runner native shell routes using the existing live parent's Codex transport."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from websockets.exceptions import WebSocketException

from omnigent.harnesses.codex_native import side_chat
from omnigent.harnesses.codex_native.app_server import (
    CodexAppServerResponseError,
    client_for_transport,
)
from omnigent.harnesses.codex_native.bridge import CodexNativeBridgeState
from omnigent.harnesses.codex_native.shell_controls import (
    CodexShellControls,
    NativeShellControlUnavailable,
)
from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    is_agent_terminal_resource,
    shell_resource_fields,
)
from omnigent.server.shell_resources import registered_shell_resource

if TYPE_CHECKING:
    from omnigent.runner.resource_registry import SessionResourceRegistry

logger = logging.getLogger(__name__)


class NativeShellResources:
    """Resolve session ownership before reading or stopping one exact native shell."""

    def __init__(
        self,
        server_client: httpx.AsyncClient,
        bridge_state: Callable[..., Awaitable[CodexNativeBridgeState | None]],
        resource_registry: SessionResourceRegistry | None = None,
    ) -> None:
        self.server_client = server_client
        self.bridge_state = bridge_state
        self.resource_registry = resource_registry

    async def registered(self, session_id: str) -> list[dict[str, Any]]:
        """Use captured launches and explicit auxiliary ownership for terminal controls."""
        registry = self.resource_registry
        if registry is None or registry.terminal_registry is None:
            return []
        entries = await asyncio.to_thread(registry.terminal_registry.activity_entries, session_id)
        rows = []
        for entry in entries:
            if entry.kind != "terminal" or not entry.terminal_id:
                continue
            if is_agent_terminal_resource(
                entry.terminal_id, registry.terminal_resource_role(session_id, entry.terminal_id)
            ):
                continue
            live = await registry.get_terminal_resource(session_id, entry.terminal_id)
            can_stop = live is not None and registry.terminal_can_stop_independently(
                session_id, entry.terminal_id
            )
            row = registered_shell_resource(entry, can_stop=can_stop)
            if live is None and row["status"] not in ENDED_SHELL_STATUSES:
                row["status"] = "disconnected"
            rows.append(row)
        return rows

    async def page(self, session_id: str) -> JSONResponse:
        """Combine registered terminals with available native resources without hiding errors."""
        rows = await self.registered(session_id)
        native = await self.handle(session_id)
        payload = json.loads(bytes(native.body))
        if native.status_code == 200:
            rows.extend(payload["data"])
            return JSONResponse(content={"data": rows})
        return JSONResponse(content={"data": rows, "warning": payload})

    async def handle(
        self,
        session_id: str,
        source: str = "codex_native",
        resource_id: str | None = None,
        *,
        stop: bool = False,
    ) -> JSONResponse:
        """Bound native I/O and surface unsupported protocols as disabled controls."""
        if source == "registered_terminal":
            rows = await self.registered(session_id)
            row = next((row for row in rows if row["resource_id"] == resource_id), None)
            if stop:
                registry = self.resource_registry
                terminal_id = row.get("terminal_id") if row else None
                if (
                    row is None
                    or not row["can_stop"]
                    or registry is None
                    or not isinstance(terminal_id, str)
                    or not resource_id
                ):
                    return JSONResponse(
                        status_code=409, content={"detail": "terminal_launch_not_stoppable"}
                    )
                closed = await registry.close_terminal(
                    session_id, terminal_id, expected_activity_id=resource_id
                )
                if not closed:
                    return JSONResponse(
                        status_code=409, content={"detail": "terminal_launch_changed"}
                    )
                row.update(
                    status="stopped",
                    can_stop=False,
                    stop_url=None,
                    stop_method=None,
                    stop_disabled_reason="shell_ended",
                )
                return JSONResponse(content=row)
            return JSONResponse(
                status_code=200 if row is not None else 404,
                content=row or {"detail": "shell_resource_not_found"},
            )
        if source != "codex_native":
            return JSONResponse(
                status_code=409,
                content={
                    "error": "native_shell_control_unavailable",
                    "detail": "native_tui_control_transport_unavailable",
                },
            )
        try:
            async with asyncio.timeout(10):
                return await self._handle(session_id, resource_id, stop=stop)
        except NativeShellControlUnavailable as exc:
            return JSONResponse(
                status_code=409,
                content={"error": "native_shell_control_unavailable", "detail": str(exc)},
            )
        except CodexAppServerResponseError as exc:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "native_shell_rejected",
                    "detail": exc.message or "native_shell_protocol_rejected",
                },
            )
        except (httpx.HTTPError, ConnectionError, OSError, TimeoutError, WebSocketException):
            logger.warning(
                "Native shell runtime unavailable: session=%s", session_id, exc_info=True
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error": "native_shell_unavailable",
                    "detail": "native_runtime_unavailable",
                },
            )

    async def _handle(
        self, session_id: str, resource_id: str | None, *, stop: bool
    ) -> JSONResponse:
        response = await self.server_client.get(f"/v1/sessions/{quote(session_id, safe='')}")
        response.raise_for_status()
        session = response.json()
        if (
            not isinstance(session, dict)
            or session.get("id", session.get("session_id")) != session_id
        ):
            raise NativeShellControlUnavailable("native_session_mapping_missing")
        labels = session.get("labels") or {}
        child = labels.get("omnigent.wrapper") == "codex-native-ui-subagent"
        parent_id = session.get("parent_session_id") if child else session_id
        if not isinstance(parent_id, str) or not parent_id:
            raise NativeShellControlUnavailable("native_parent_mapping_missing")
        state = await self.bridge_state(parent_id, action="shell resource")
        if state is None or state.session_id != parent_id:
            raise NativeShellControlUnavailable("native_runtime_unavailable")
        thread_id = (
            labels.get("omnigent.codex_native.subagent_thread_id") if child else state.thread_id
        )
        if not isinstance(thread_id, str) or not thread_id:
            raise NativeShellControlUnavailable("native_thread_mapping_missing")
        client = client_for_transport(
            state.socket_path, client_name="triune-native-shell-resources"
        )
        try:
            await client.connect()
            if child:
                capabilities = await side_chat.child_control_capabilities(
                    client, thread_id, state.thread_id
                )
                if capabilities["state"] not in {"active", "idle"}:
                    raise NativeShellControlUnavailable(str(capabilities["reason"]))
            controls = CodexShellControls(client, thread_id)
            if stop:
                if not resource_id:
                    raise NativeShellControlUnavailable("native_shell_resource_id_required")
                terminated = await controls.stop(resource_id)
                if not terminated:
                    return JSONResponse(
                        status_code=409,
                        content={
                            "error": "native_shell_already_ended",
                            "source": "codex_native",
                            "resource_id": resource_id,
                        },
                    )
                return JSONResponse(
                    content={
                        "id": resource_id,
                        "type": "shell",
                        "status": "stopped",
                        **shell_resource_fields(
                            source="codex_native",
                            resource_id=resource_id,
                            session_id=session_id,
                            stop_disabled_reason="shell_ended",
                        ),
                    }
                )
            live = await controls.inventory(session_id)
            if resource_id is None:
                return JSONResponse(content={"data": live})
            recorded = await controls.read(resource_id, session_id)
            current = next((row for row in live if row["resource_id"] == resource_id), None)
            if recorded is None and current is None:
                return JSONResponse(
                    status_code=404, content={"detail": "native_shell_resource_not_found"}
                )
            row: dict[str, Any] = dict(recorded or {})
            if current is not None:
                # Live inventory supplies capability evidence, not captured output.
                row.update(
                    {key: value for key, value in current.items() if key != "output_preview"}
                )
            return JSONResponse(content=row)
        finally:
            await client.close()


def register_native_shell_resource_routes(app: FastAPI, controls: NativeShellResources) -> None:
    """Register runner routes; the server proxy must authorize session access first."""

    @app.get("/v1/sessions/{session_id}/resources/shells")
    async def list_native_shells(session_id: str) -> JSONResponse:
        return await controls.page(session_id)

    @app.get("/v1/sessions/{session_id}/resources/shells/{source}/{resource_id}")
    async def read_native_shell(session_id: str, source: str, resource_id: str) -> JSONResponse:
        return await controls.handle(session_id, source, resource_id)

    @app.post("/v1/sessions/{session_id}/resources/shells/{source}/{resource_id}/stop")
    async def stop_native_shell(session_id: str, source: str, resource_id: str) -> JSONResponse:
        return await controls.handle(session_id, source, resource_id, stop=True)
