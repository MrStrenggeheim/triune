# Modified for Triune.
"""Independent workspace metadata and resource endpoints."""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import UploadFile

from omnigent.server.feature_flags import Feature, resolve_feature_flags
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.routes._gzip_route import skip_gzip
from omnigent.server.routes._origin import require_trusted_origin
from omnigent.server.workbench_resources import HostWorkspaceResources, RunnerWorkspaceResources
from omnigent.server.workbench_workspace_service import WorkbenchWorkspaceService


class HostWorkspaceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    host_id: str = Field(min_length=1, max_length=128)
    root: str = Field(min_length=1, max_length=8192)


class ResolveWorkspaceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1, max_length=128)


def create_workbench_workspaces_router(service: WorkbenchWorkspaceService) -> APIRouter:
    router = APIRouter(prefix="/workbench-workspaces")

    @router.get("")
    async def list_workspaces(request: Request) -> dict[str, Any]:
        user_id = require_user(request, service.auth_provider)
        workspaces = await asyncio.to_thread(service.store.list, user_id)
        return {
            "object": "list",
            "data": await service.metadata_many(workspaces),
            "has_more": False,
        }

    @router.post("")
    async def create_workspace(request: Request, body: HostWorkspaceInput) -> dict[str, Any]:
        workspace = await service.create_host(request, body.host_id, body.root)
        return await service.metadata(workspace)

    @router.post("/resolve")
    async def resolve_workspace(request: Request, body: ResolveWorkspaceInput) -> dict[str, Any]:
        workspace = await service.resolve_session(request, body.session_id)
        return await service.metadata(workspace)

    @router.get("/{workspace_id}")
    async def get_workspace(request: Request, workspace_id: str) -> dict[str, Any]:
        return await service.metadata(await service.require_workspace(request, workspace_id))

    @router.api_route(
        "/{workspace_id}/resources/{resource:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        response_model=None,
    )
    async def workspace_resource(request: Request, workspace_id: str, resource: str) -> Any:
        workspace = await service.require_workspace(
            request, workspace_id, write=request.method != "GET"
        )
        if resource.endswith(("/content-search", "/content-replace")):
            flags = getattr(request.app.state, "feature_flags", None) or resolve_feature_flags()
            if not flags.enabled(Feature.WORKSPACE_CONTENT_SEARCH):
                raise HTTPException(404, "Workspace content search is disabled")
        body: dict[str, Any] = {}
        if resource == "github/attachments" and request.method == "POST":
            require_trusted_origin(request)
            async with request.form(max_files=1, max_fields=4) as form:
                file = form.get("file")
                pr_url = form.get("pr_url")
                if not isinstance(file, UploadFile) or not isinstance(pr_url, str):
                    raise HTTPException(400, "Expected a file and pull request URL")
                content = await file.read(70 * 1024 * 1024 + 1)
                if len(content) > 70 * 1024 * 1024:
                    raise HTTPException(413, "PR attachment exceeds 70 MiB")
                body = {
                    "pr_url": pr_url,
                    "name": file.filename or "",
                    "content_base64": base64.b64encode(content).decode("ascii"),
                }
        elif request.method in {"POST", "PUT", "PATCH"}:
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                raise HTTPException(415, "Expected application/json")
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 16 * 1024 * 1024:
                    raise HTTPException(413, "Workspace resource request exceeds 16 MiB")
            try:
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("Expected an object")
            except ValueError as exc:
                raise HTTPException(400, "Expected a JSON object") from exc
        adapter = (
            RunnerWorkspaceResources
            if workspace.target_kind == "runneronly"
            else HostWorkspaceResources
        )
        result = await adapter(service, workspace).dispatch(request, resource, body)
        if isinstance(result, dict) and result.get("encoding") == "base64":
            skip_gzip(request)
        return result

    return router
