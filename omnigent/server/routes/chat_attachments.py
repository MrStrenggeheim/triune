# Modified for Triune.
"""Read local Markdown references through the message's captured filesystem scope."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import posixpath
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, HTTPException, Request, Response

from omnigent.db.db_models import current_workspace_id
from omnigent.entities.conversation import MessageData
from omnigent.server.auth import LEVEL_OWNER
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.workbench_resources import HostWorkspaceResources, relative_path
from omnigent.server.workbench_workspace_service import WorkbenchWorkspaceService
from omnigent.stores.artifact_store import ArtifactStore
from omnigent.stores.workbench_workspace_store import WorkbenchWorkspace


def create_chat_attachments_router(
    service: WorkbenchWorkspaceService,
    artifact_store: ArtifactStore | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}/attachments")

    async def reference_scope(
        request: Request, session_id: str, item_id: str
    ) -> tuple[str | None, dict[str, Any]]:
        user = require_user(request, service.auth_provider)
        await require_access(
            user, session_id, LEVEL_OWNER, service.permission_store, service.conversation_store
        )
        item = await asyncio.to_thread(service.conversation_store.get_item, session_id, item_id)
        if item is None or not isinstance(item.data, MessageData):
            raise HTTPException(404, "Source message not found")
        scope = item.data.resource_scope
        if not scope or not scope.get("workspace"):
            raise HTTPException(
                409, "This message has no captured workspace; attach the file explicitly"
            )
        return user, scope

    async def resolve_reference_location(
        request: Request, session_id: str, scope: dict[str, Any], path: str
    ) -> tuple[WorkbenchWorkspace, str]:
        workspace = await service.resolve_session(request, session_id, captured=scope)
        if scope.get("generation") and workspace.generation != scope["generation"]:
            raise HTTPException(409, "The original workspace generation is no longer available")
        path = relative_path(workspace, path)
        if not path:
            raise HTTPException(400, "A file path is required")
        return workspace, path

    @router.get("/references/{item_id}/metadata")
    async def reference_metadata(
        request: Request, session_id: str, item_id: str, path: str
    ) -> dict[str, Any]:
        """Classify an authorized reference without transferring its file contents."""
        user, scope = await reference_scope(request, session_id, item_id)
        snapshot_id = (
            "chat-reference-"
            + hashlib.sha256(
                json.dumps([current_workspace_id(), user, session_id, item_id, path]).encode()
            ).hexdigest()
        )
        captured = artifact_store is not None and await asyncio.to_thread(
            artifact_store.exists, snapshot_id
        )
        try:
            workspace = await service.resolve_session(request, session_id, captured=scope)
            if scope.get("generation") and workspace.generation != scope["generation"]:
                raise HTTPException(
                    409, "The original workspace generation is no longer available"
                )
            resolved = relative_path(workspace, path)
            result = {"workspace": await service.metadata(workspace), "path": resolved}
            if not resolved:
                return {**result, "kind": "directory"}
            directory, name = posixpath.split(resolved.replace("\\", "/"))
            cursor = None
            for _ in range(8):
                params = {"limit": "1000", "order": "asc"}
                if cursor:
                    params["after"] = cursor
                if workspace.target_kind == "runneronly":
                    from starlette.requests import Request as StarletteRequest

                    from omnigent.server.workbench_resources import RunnerWorkspaceResources

                    delegated = StarletteRequest(
                        dict(request.scope, query_string=urlencode(params).encode())
                    )
                    response = await RunnerWorkspaceResources(service, workspace).dispatch(
                        delegated, "environments/default/filesystem/" + directory, {}
                    )
                    if response.status_code >= 400:
                        raise HTTPException(
                            response.status_code, "Original file location unavailable"
                        )
                    listing = json.loads(bytes(response.body))
                else:
                    listing = await HostWorkspaceResources(service, workspace).call(
                        "list_or_read", {**params, "path": directory}
                    )
                for entry in listing.get("data", []):
                    if (
                        entry.get("name") == name
                        or posixpath.basename(entry.get("path", "")) == name
                    ):
                        kind = entry.get("type")
                        return {
                            **result,
                            "kind": kind if kind in {"file", "directory"} else "unknown",
                        }
                if not listing.get("has_more"):
                    return {**result, "kind": "captured" if captured else "missing"}
                next_cursor = listing.get("last_id")
                if not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
            return {**result, "kind": "unknown"}
        except HTTPException as error:
            if captured and error.status_code in {400, 404, 409, 502, 503}:
                return {"kind": "captured", "path": path, "workspace": None}
            raise

    @router.get("/references/{item_id}/location")
    async def reference_location(
        request: Request, session_id: str, item_id: str, path: str
    ) -> dict[str, Any]:
        _, scope = await reference_scope(request, session_id, item_id)
        workspace, path = await resolve_reference_location(request, session_id, scope, path)
        return {"workspace": await service.metadata(workspace), "path": path}

    @router.get("/references/{item_id}")
    async def reference(request: Request, session_id: str, item_id: str, path: str):
        user, scope = await reference_scope(request, session_id, item_id)
        # Reference snapshots stay private to the reader; they must not turn a
        # private workspace path into a file shared with every chat participant.
        snapshot_id = (
            "chat-reference-"
            + hashlib.sha256(
                json.dumps([current_workspace_id(), user, session_id, item_id, path]).encode()
            ).hexdigest()
        )

        def stored_response(filename, mime, content):
            return Response(
                content,
                media_type=mime or "application/octet-stream",
                headers={
                    "Content-Disposition": "attachment; filename*=UTF-8''"
                    + quote(filename, safe=""),
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "private, no-store",
                },
            )

        if artifact_store is not None and await asyncio.to_thread(
            artifact_store.exists, snapshot_id
        ):
            cached = json.loads(await asyncio.to_thread(artifact_store.get, snapshot_id))
            return stored_response(
                cached["filename"],
                cached["mime"],
                base64.b64decode(cached["content"], validate=True),
            )
        workspace, path = await resolve_reference_location(request, session_id, scope, path)
        if workspace.target_kind == "runneronly":
            # Keep the runner's original identity; never fall back to the host.
            from starlette.requests import Request as StarletteRequest

            from omnigent.server.workbench_resources import RunnerWorkspaceResources

            scope_copy = dict(request.scope, query_string=b"download=true")
            response = await RunnerWorkspaceResources(service, workspace).dispatch(
                StarletteRequest(scope_copy),
                "environments/default/filesystem/" + path,
                {},
            )
            response.headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(
                path.replace("\\", "/").split("/")[-1], safe=""
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cache-Control"] = "private, no-store"
        else:
            adapter = HostWorkspaceResources(service, workspace)
            response = await adapter.download_file(path, max_bytes=50 * 1024 * 1024)
            response.headers["Content-Type"] = (
                mimetypes.guess_type(path)[0] or "application/octet-stream"
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cache-Control"] = "private, no-store"
        if artifact_store is None or response.status_code >= 400:
            return response
        if hasattr(response, "body_iterator"):
            data = bytearray()
            iterator = response.body_iterator.__aiter__()
            try:
                async for chunk in iterator:
                    data.extend(chunk.encode() if isinstance(chunk, str) else chunk)
                    if len(data) > 50 * 1024 * 1024:
                        raise HTTPException(413, "Attachment exceeds 50 MB")
            finally:
                close = getattr(iterator, "aclose", None)
                if close is not None:
                    await close()
            content = bytes(data)
        else:
            content = bytes(response.body)
        if len(content) > 50 * 1024 * 1024:
            raise HTTPException(413, "Attachment exceeds 50 MB")
        filename = path.replace("\\", "/").split("/")[-1]
        mime = response.headers.get("Content-Type", "application/octet-stream")
        cached = {
            "filename": filename,
            "mime": mime,
            "content": base64.b64encode(content).decode("ascii"),
        }
        await asyncio.to_thread(artifact_store.put, snapshot_id, json.dumps(cached).encode())
        return stored_response(filename, mime, content)

    return router
