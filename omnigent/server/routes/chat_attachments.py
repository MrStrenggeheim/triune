# Modified for Triune.
"""Read local Markdown references through the message's captured filesystem scope."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import mimetypes
import posixpath
import uuid
from typing import Any, TypedDict
from urllib.parse import quote, urlencode
from weakref import WeakValueDictionary

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.responses import JSONResponse

from omnigent.db.db_models import current_workspace_id
from omnigent.entities.conversation import MessageData
from omnigent.server.auth import LEVEL_OWNER
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.routes._host_launch import resolve_host_owner
from omnigent.server.routes._origin import require_trusted_origin
from omnigent.server.workbench_resources import HostWorkspaceResources, relative_path
from omnigent.server.workbench_workspace_service import WorkbenchWorkspaceService
from omnigent.stores.artifact_store import ArtifactStore
from omnigent.stores.workbench_workspace_store import WorkbenchWorkspace

_MAX_CAPTURE_BYTES = 50 * 1024 * 1024
_logger = logging.getLogger(__name__)


class SnapshotMetadata(TypedDict):
    filename: str
    mime: str | None
    bytes: int


def create_chat_attachments_router(
    service: WorkbenchWorkspaceService,
    artifact_store: ArtifactStore | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}/attachments")
    capture_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    def reference_snapshot_id(
        user: str | None,
        session_id: str,
        item_id: str,
        path: str,
        source_session_id: str,
        scope: dict[str, Any],
    ) -> str:
        # Preserve the original exact-path and reader-private capture identity.
        identity: list[Any] = [current_workspace_id(), user, session_id, item_id, path]
        if source_session_id != session_id:
            # Older peer captures may have read the recipient's workspace.
            identity.extend(["peer-source-v1", source_session_id, scope])
        return (
            "chat-reference-"
            + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        )

    async def stored_snapshot(snapshot_id: str, *, download: bool):
        if artifact_store is None:
            return None
        try:
            raw = await asyncio.to_thread(artifact_store.get, snapshot_id)
        except KeyError:
            try:
                raw = await asyncio.to_thread(artifact_store.get, snapshot_id + ".v2")
            except KeyError:
                return None
        cached = json.loads(raw)
        metadata: SnapshotMetadata
        if cached.get("version") == 2:
            metadata = {
                "filename": cached["filename"],
                "mime": cached["mime"],
                "bytes": cached["bytes"],
            }
            content = (
                await asyncio.to_thread(artifact_store.get, cached["content_key"])
                if download
                else None
            )
            if content is not None and len(content) != metadata["bytes"]:
                raise HTTPException(502, "Stored attachment is incomplete")
        else:
            # Existing captures stored the original bytes inline as base64 JSON.
            content = base64.b64decode(cached["content"], validate=True)
            metadata = {
                "filename": cached["filename"],
                "mime": cached["mime"],
                "bytes": len(content),
            }
        if metadata["bytes"] > _MAX_CAPTURE_BYTES:
            raise HTTPException(413, "Attachment exceeds 50 MiB")
        return metadata, content if download else None

    async def reference_scope(
        request: Request, session_id: str, item_id: str
    ) -> tuple[str | None, str, dict[str, Any]]:
        user = require_user(request, service.auth_provider)
        await require_access(
            user, session_id, LEVEL_OWNER, service.permission_store, service.conversation_store
        )
        item = await asyncio.to_thread(service.conversation_store.get_item, session_id, item_id)
        if item is None or not isinstance(item.data, MessageData):
            raise HTTPException(404, "Source message not found")
        source_session_id = session_id
        scope = item.data.resource_scope
        origin = item.data.communication
        if origin is not None:
            if origin.kind != "peer" or not origin.source_conversation_id:
                raise HTTPException(409, "This agent message has no captured source workspace")
            source_session_id = origin.source_conversation_id
            if source_session_id != session_id:
                if origin.destination_conversation_id != session_id:
                    raise HTTPException(409, "Peer message destination does not match this chat")
                await require_access(
                    user,
                    source_session_id,
                    LEVEL_OWNER,
                    service.permission_store,
                    service.conversation_store,
                )
                scope = origin.source_resource_scope
        if not scope or not scope.get("workspace"):
            raise HTTPException(
                409, "This message has no captured workspace; attach the file explicitly"
            )
        if source_session_id != session_id:
            # Cached peer bytes still require the source target's ownership.
            if scope.get("host_id"):
                if service.host_store is None:
                    raise HTTPException(503, "Host workspace support is unavailable")
                await asyncio.to_thread(
                    resolve_host_owner,
                    user_id=user,
                    host_id=scope["host_id"],
                    host_store=service.host_store,
                )
            elif service.tunnel_registry is not None and isinstance(scope.get("runner_id"), str):
                connection = service.tunnel_registry.get(scope["runner_id"])
                if connection is not None and user is not None and connection.owner != user:
                    raise HTTPException(403, "Workspace runner is not owned by caller")
        return user, source_session_id, scope

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
        user, source_session_id, scope = await reference_scope(request, session_id, item_id)
        snapshot_id = reference_snapshot_id(
            user, session_id, item_id, path, source_session_id, scope
        )
        captured = artifact_store is not None and (
            await asyncio.to_thread(artifact_store.exists, snapshot_id)
            or await asyncio.to_thread(artifact_store.exists, snapshot_id + ".v2")
        )
        try:
            workspace = await service.resolve_session(request, source_session_id, captured=scope)
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
        _, source_session_id, scope = await reference_scope(request, session_id, item_id)
        workspace, path = await resolve_reference_location(request, source_session_id, scope, path)
        return {"workspace": await service.metadata(workspace), "path": path}

    async def capture_reference(
        request: Request, session_id: str, item_id: str, path: str, *, download: bool
    ):
        user, source_session_id, scope = await reference_scope(request, session_id, item_id)
        if not download and artifact_store is None:
            raise HTTPException(503, "Attachment snapshot storage is unavailable")
        snapshot_id = reference_snapshot_id(
            user, session_id, item_id, path, source_session_id, scope
        )
        # Share one live read within this router; conditional publication also
        # protects the first original across processes and server replicas.
        async with capture_locks.setdefault(snapshot_id, asyncio.Lock()):
            try:
                stored = await stored_snapshot(snapshot_id, download=download)
            except HTTPException:
                raise
            except Exception as exc:
                _logger.exception("Attachment snapshot read failed")
                raise HTTPException(502, "Attachment snapshot could not be read") from exc
            if stored is not None:
                return stored
            return await capture_source(
                request, source_session_id, scope, path, snapshot_id, download
            )

    async def capture_source(
        request: Request,
        session_id: str,
        scope: dict[str, Any],
        path: str,
        snapshot_id: str,
        download: bool,
    ):
        """Write immutable .bin bytes and commit metadata at <legacy-key>.v2.

        The unsuffixed legacy key keeps its inline base64 JSON format.
        """
        workspace, path = await resolve_reference_location(request, session_id, scope, path)
        if workspace.target_kind == "runneronly":
            # Keep the runner's original identity; never fall back to the host.
            from starlette.requests import Request as StarletteRequest

            from omnigent.server.workbench_resources import RunnerWorkspaceResources

            scope_copy = dict(request.scope, method="GET", query_string=b"download=true")
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
            response = await adapter.download_file(path, max_bytes=_MAX_CAPTURE_BYTES)
            response.headers["Content-Type"] = (
                mimetypes.guess_type(path)[0] or "application/octet-stream"
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cache-Control"] = "private, no-store"
        if response.status_code >= 400:
            return response
        iterator = (
            response.body_iterator.__aiter__() if hasattr(response, "body_iterator") else None
        )
        try:
            try:
                length = response.headers.get("Content-Length")
                expected = int(length) if length is not None else None
                if expected is not None and expected < 0:
                    raise ValueError("Negative content length")
            except ValueError as exc:
                raise HTTPException(502, "Attachment download returned an invalid length") from exc
            if expected is not None and expected > _MAX_CAPTURE_BYTES:
                raise HTTPException(413, "Attachment exceeds 50 MiB")
            if iterator is not None:
                data = io.BytesIO()
                async for chunk in iterator:
                    chunk = chunk.encode() if isinstance(chunk, str) else chunk
                    if data.tell() + len(chunk) > _MAX_CAPTURE_BYTES:
                        raise HTTPException(413, "Attachment exceeds 50 MiB")
                    data.write(chunk)
                content = data.getvalue()
            else:
                content = bytes(response.body)
            if len(content) > _MAX_CAPTURE_BYTES:
                raise HTTPException(413, "Attachment exceeds 50 MiB")
            if expected is not None and len(content) != expected:
                raise HTTPException(502, "Attachment download is incomplete")
        finally:
            if iterator is not None:
                close = getattr(iterator, "aclose", None)
                if close is not None:
                    await close()
        filename = path.replace("\\", "/").split("/")[-1]
        mime = response.headers.get("Content-Type", "application/octet-stream")
        metadata: SnapshotMetadata = {"filename": filename, "mime": mime, "bytes": len(content)}
        if artifact_store is not None:

            def publish():
                content_key = snapshot_id + "-" + uuid.uuid4().hex + ".bin"
                published = False
                try:
                    artifact_store.put(content_key, content)
                    captured = {**metadata, "version": 2, "content_key": content_key}
                    try:
                        published = artifact_store.put_if_absent(
                            snapshot_id + ".v2", json.dumps(captured).encode()
                        )
                    except Exception:
                        # A remote write can commit before losing its response.
                        try:
                            committed = json.loads(artifact_store.get(snapshot_id + ".v2"))
                            published = committed.get("content_key") == content_key
                        except KeyError:
                            pass
                        except Exception:
                            published = True
                            _logger.exception("Could not verify attachment snapshot publication")
                        raise
                    return published
                finally:
                    if not published:
                        try:
                            artifact_store.delete(content_key)
                        except Exception:
                            _logger.exception("Unpublished attachment cleanup failed")

            try:
                published = await asyncio.to_thread(publish)
                if not published:
                    stored = await stored_snapshot(snapshot_id, download=download)
                    if stored is None:
                        raise RuntimeError("Published attachment disappeared")
                    return stored
            except Exception as exc:
                _logger.exception("Attachment snapshot publication failed")
                raise HTTPException(502, "Attachment snapshot could not be saved") from exc
        return metadata, content if download else None

    @router.post("/references/{item_id}/capture")
    async def capture(request: Request, session_id: str, item_id: str, path: str):
        require_trusted_origin(request)
        result = await capture_reference(request, session_id, item_id, path, download=False)
        if isinstance(result, Response):
            return result
        metadata, _ = result
        return JSONResponse(metadata, headers={"Cache-Control": "private, no-store"})

    @router.get("/references/{item_id}")
    async def reference(request: Request, session_id: str, item_id: str, path: str):
        result = await capture_reference(request, session_id, item_id, path, download=True)
        if isinstance(result, Response):
            return result
        metadata, content = result
        return Response(
            content,
            headers={
                "Content-Type": metadata["mime"] or "application/octet-stream",
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(metadata["filename"], safe=""),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
            },
        )

    return router
