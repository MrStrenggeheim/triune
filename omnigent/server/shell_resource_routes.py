# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Authorize exact shell routes and retain output across runtime disconnection."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.native.shell_resources import (
    ENDED_SHELL_STATUSES,
    SHELL_SOURCES,
    is_agent_terminal_resource,
    shell_resource_path,
)
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
from omnigent.server.shell_resources import SessionShellResources, registered_shell_resource
from omnigent.terminals.history import ActivityEntry, ActivityPage

logger = logging.getLogger(__name__)


def _read_unavailable(error: HTTPException | OmnigentError, *, missing: bool = False) -> bool:
    """Recover live availability failures, keeping permission and routing errors intact."""
    if isinstance(error, OmnigentError):
        return error.code in {ErrorCode.RUNNER_UNAVAILABLE, ErrorCode.CONFLICT} or (
            missing and error.code == ErrorCode.NOT_FOUND
        )
    if error.status_code in {401, 403, 410}:
        return False
    if isinstance(error.detail, dict):
        payload = error.detail.get("error")
        code = payload.get("code") if isinstance(payload, dict) else payload
        if code in {ErrorCode.FORBIDDEN, ErrorCode.UNAUTHORIZED, ErrorCode.WRONG_REPLICA}:
            return False
        if code in {"native_shell_control_unavailable", "native_shell_unavailable"}:
            return True
        if code is not None and code != ErrorCode.RUNNER_UNAVAILABLE:
            return missing and code == ErrorCode.NOT_FOUND
    return error.status_code in {503, 504} or (missing and error.status_code == 404)


def _without_live_controls(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("status") not in ENDED_SHELL_STATUSES:
        row["status"] = "disconnected"
    row.update(can_stop=False, stop_url=None, stop_method=None)
    return row


def register_shell_resource_routes(
    router: APIRouter,
    *,
    service: SessionShellResources,
    validate_session: Callable[..., Awaitable[Any]],
    proxy_get: Callable[..., Awaitable[dict[str, Any]]],
    proxy_post: Callable[..., Awaitable[tuple[int, dict[str, Any]]]],
    activity_for_conversation: Callable[..., Awaitable[ActivityPage]],
) -> None:
    """Reuse the resource router's authorization, runner proxy and captured activity."""

    async def capture_terminals(session_id: str, conversation: Any) -> None:
        page = await activity_for_conversation(conversation)
        records: list[object] = []
        for raw in page["data"]:
            entry = ActivityEntry.model_validate(raw)
            if (
                entry.kind == "terminal"
                and entry.terminal_id
                and entry.session_id == session_id
                and not is_agent_terminal_resource(entry.terminal_id)
            ):
                records.append(registered_shell_resource(entry))
        await service.capture(session_id, records)

    @router.get("/sessions/{session_id}/resources/shells", response_model=None)
    async def list_shells(request: Request, session_id: str) -> dict[str, Any]:
        conversation = await validate_session(session_id, request, LEVEL_READ)
        live: list[dict[str, Any]] = []
        warning = None
        availability = "available"
        try:
            await capture_terminals(session_id, conversation)
            page = await proxy_get(
                session_id, f"/v1/sessions/{session_id}/resources/shells", conversation
            )
        except (HTTPException, OmnigentError) as exc:
            if not _read_unavailable(exc):
                raise
            logger.debug("Live shell inventory unavailable: session=%s", session_id, exc_info=True)
            warning = "Live shell controls are unavailable. Showing captured history."
            availability = "offline"
        else:
            if page.get("warning"):
                warning = "Some live shell controls are unavailable. Showing captured history."
                availability = "partial"
            data = page.get("data")
            if not isinstance(data, list):
                raise HTTPException(status_code=502, detail="Invalid runner shell inventory")
            live = data
            await service.capture(session_id, list(live))
        retained = await service.capture(session_id, [])
        by_id = {(row.get("source"), row.get("resource_id")): row for row in live}
        for row in retained:
            current = by_id.get((row["source"], row["resource_id"]))
            if current is not None and row.get("status") not in ENDED_SHELL_STATUSES:
                for key in ("can_stop", "stop_url", "stop_method", "stop_disabled_reason"):
                    row[key] = current.get(key)
            elif row.get("status") not in ENDED_SHELL_STATUSES:
                _without_live_controls(row)
        return {"data": retained, "warning": warning, "availability": availability}

    @router.get(
        "/sessions/{session_id}/resources/shells/{source}/{resource_id}", response_model=None
    )
    async def read_shell(
        request: Request, session_id: str, source: str, resource_id: str
    ) -> dict[str, Any]:
        conversation = await validate_session(session_id, request, LEVEL_READ)
        if source not in SHELL_SOURCES:
            raise HTTPException(status_code=404, detail="Unknown shell resource source")
        try:
            if source == "registered_terminal":
                await capture_terminals(session_id, conversation)
            current = await proxy_get(
                session_id, shell_resource_path(session_id, source, resource_id), conversation
            )
        except (HTTPException, OmnigentError) as exc:
            if not _read_unavailable(exc, missing=True):
                raise
            retained = await service.get(session_id, source, resource_id)
            if retained is None:
                raise
            logger.debug("Live shell read unavailable: session=%s", session_id, exc_info=True)
            return {
                **_without_live_controls(retained),
                "live_error": "Live shell controls are unavailable. Showing captured output.",
                "availability": "offline",
            }
        if current.get("source") != source or current.get("resource_id") != resource_id:
            raise HTTPException(status_code=502, detail="Runner shell identity mismatch")
        if source == "registered_terminal" and is_agent_terminal_resource(
            current.get("terminal_id")
        ):
            raise HTTPException(status_code=404, detail="Agent terminals are not shell resources")
        await service.capture(session_id, [current])
        retained = await service.get(session_id, source, resource_id)
        if retained is not None:
            if not current.get("output"):
                current["output"] = retained.get("output")
                current["output_preview"] = retained.get("output_preview")
            if retained.get("status") in ENDED_SHELL_STATUSES and (
                current.get("status") not in ENDED_SHELL_STATUSES
                or retained.get("status") == "stopped"
            ):
                for key in (
                    "status",
                    "can_stop",
                    "stop_url",
                    "stop_method",
                    "stop_disabled_reason",
                ):
                    current[key] = retained.get(key)
        return current

    @router.post(
        "/sessions/{session_id}/resources/shells/{source}/{resource_id}/stop", response_model=None
    )
    async def stop_shell(
        request: Request, session_id: str, source: str, resource_id: str
    ) -> JSONResponse:
        conversation = await validate_session(session_id, request, LEVEL_EDIT)
        if source not in {"codex_native", "registered_terminal"}:
            raise HTTPException(status_code=409, detail="Native targeted Stop is unavailable")
        if source == "registered_terminal":
            current = await proxy_get(
                session_id, shell_resource_path(session_id, source, resource_id), conversation
            )
            terminal_id = current.get("terminal_id")
            if (
                current.get("source") != source
                or current.get("resource_id") != resource_id
                or not isinstance(terminal_id, str)
                or not terminal_id
                or is_agent_terminal_resource(terminal_id)
                or current.get("can_stop") is not True
            ):
                raise HTTPException(
                    status_code=409, detail="Registered shell launch is not stoppable"
                )
        status, payload = await proxy_post(
            session_id,
            f"{shell_resource_path(session_id, source, resource_id)}/stop",
            {},
            conversation,
        )
        if status < 400:
            if payload.get("source") != source or payload.get("resource_id") != resource_id:
                raise HTTPException(status_code=502, detail="Runner shell identity mismatch")
            await service.capture(session_id, [payload])
        return JSONResponse(status_code=status, content=payload)
